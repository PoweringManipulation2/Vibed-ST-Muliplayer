/**
 * The relay.
 *
 * Runs inside SillyTavern's Node process (as a server plugin) on the host's own
 * machine, and is the only part of the system that binds a port. It terminates
 * the encrypted session with every peer, arbitrates the room, and forwards
 * application frames — it never inspects chat content beyond the opcode.
 *
 * Trust model, stated plainly: the relay is host-owned infrastructure. The
 * encryption protects the traffic against the *network* — a shared Wi-Fi
 * network, a router, a tunnel provider — not against the host, who could read
 * everything anyway because they own the transcript and run the model. What the
 * handshake guarantees is that nobody without the connection code can join,
 * read or inject, and that nobody can silently sit in the middle of the path.
 */

import http from 'node:http';
import os from 'node:os';

import {
    CLIENT_ALLOWED_OPS,
    ECHO_TO_SENDER,
    OOC,
    STAMP_IDENTITY, HS, LIMITS, OP, PROTOCOL_REVISION, REJECT_REASON, ROLE,
    PSK_LENGTH, HANDSHAKE_NONCE_LENGTH, ROOM_ID_LENGTH, TO_HOST_ONLY,
} from './protocol.js';
import { PortMapper, isPrivateIPv4 } from './portmap.js';
import {
    ReplayWindow, TokenBucket, computeConfirmation, confirmationLabels,
    createEphemeralKeyPair, deriveRoomId, deriveSessionKeys, openFrame,
    randomBytes, sealFrame, timingSafeEqual,
} from './crypto.js';

/** Loaded lazily so a missing `ws` produces a clear message, not a load failure. */
let WebSocketServer = null;

async function loadWebSocketServer() {
    if (WebSocketServer) return WebSocketServer;
    try {
        ({ WebSocketServer } = await import('ws'));
        return WebSocketServer;
    } catch (error) {
        throw new Error(
            'The "ws" package could not be resolved. It ships with SillyTavern 1.13 and later; '
            + 'on an older install, run `npm install ws` in the SillyTavern root directory. '
            + `(${error.message})`,
        );
    }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isLoopback(address) {
    return LOOPBACK.has(String(address ?? ''));
}

/** Non-internal IPv4 addresses, so the host can tell people where to point. */
export function localAddresses() {
    const found = [];
    for (const entries of Object.values(os.networkInterfaces())) {
        for (const entry of entries ?? []) {
            if (entry.family === 'IPv4' && !entry.internal) found.push(entry.address);
        }
    }
    return found;
}

let peerCounter = 0;

class Peer {
    constructor(socket, ip) {
        this.id = `p${(++peerCounter).toString(36)}${randomBytes(3).toString('hex')}`;
        this.socket = socket;
        this.ip = ip;
        this.loopback = isLoopback(ip);

        this.role = ROLE.CLIENT;
        this.name = 'Player';
        this.admitted = false;

        this.keys = null;
        this.sendCounter = 0n;
        this.replay = new ReplayWindow();

        // Refill rates are expressed per millisecond so a burst is allowed but
        // the sustained rate stays bounded.
        this.messageBucket = new TokenBucket(LIMITS.RATE_MESSAGES, LIMITS.RATE_MESSAGES / LIMITS.RATE_WINDOW_MS);
        this.byteBucket = new TokenBucket(LIMITS.RATE_BYTES, LIMITS.RATE_BYTES / LIMITS.RATE_WINDOW_MS);

        this.parity = { status: 'pending', report: null };
        this.rtt = null;
        this.lastSeen = Date.now();
        this.joinedAt = Date.now();
        this.bytesIn = 0;
        this.bytesOut = 0;
    }

    summary() {
        return { id: this.id, name: this.name, role: this.role, rtt: this.rtt };
    }
}

export class Relay {
    /** @param {{log: (level: string, ...args: any[]) => void}} options */
    constructor({ log } = {}) {
        this.log = log ?? (() => {});

        /** @type {http.Server|null} */
        this.httpServer = null;
        this.wss = null;

        this.running = false;
        this.port = 0;
        this.bindLan = false;
        this.roomName = '';
        this.maxPeers = 4;
        this.requireParity = true;
        this.parityStrictness = 'manifest';

        /** @type {Buffer|null} */
        this.psk = null;
        /** @type {Buffer|null} */
        this.roomId = null;
        /** @type {Buffer|null} */
        this.hostToken = null;

        /** @type {Map<string, Peer>} */
        this.peers = new Map();
        /** @type {Peer|null} */
        this.host = null;
        /** Reference fingerprint every client is compared against. */
        this.hostReport = null;

        /**
         * Bounded ring buffer of out-of-character messages. Held by the relay
         * rather than the host because the OOC channel belongs to the room:
         * players keep their planning history even if the host reconnects.
         * Nothing here is ever forwarded into a chat payload.
         * @type {object[]}
         */
        this.oocHistory = [];

        /**
         * Last persona published by each peer, keyed by peer id.
         *
         * Held by the relay so a peer joining later learns who everyone is
         * playing. Personas were previously broadcast once at admission, which
         * meant the host's persona was announced before anyone was there to hear
         * it and no newcomer ever saw it.
         * @type {Map<string, object>}
         */
        this.personas = new Map();

        /**
         * Asks the router to open the port so players elsewhere can reach us
         * without anyone editing router settings or installing a VPN.
         */
        this.portMapper = new PortMapper({ log: (...args) => this.log(...args) });
        /** @type {null | {ok: boolean, method?: string, externalIp?: string|null, reason?: string, cgnat?: boolean}} */
        this.portMapping = null;

        /** Sockets that have connected but not finished the handshake. */
        this.pending = new Set();
        /** ip -> {failures, blockedUntil} */
        this.offenders = new Map();
        /** Manually blocked addresses. */
        this.bans = new Set();

        this.startedAt = 0;
        this._sweeper = null;
    }

    // =======================================================================
    // Lifecycle
    // =======================================================================

    async start(options = {}) {
        if (this.running) throw new Error('The relay is already running');

        const WSS = await loadWebSocketServer();

        this.port = clampInt(options.port, 1024, 65535, 8899);
        this.bindLan = Boolean(options.bindLan);
        this.roomName = String(options.roomName ?? 'SillyTavern room').slice(0, 60);
        this.maxPeers = clampInt(options.maxPeers, 2, LIMITS.MAX_PEERS, 4);
        this.requireParity = options.requireParity !== false;
        this.parityStrictness = options.parityStrictness === 'commit' ? 'commit' : 'manifest';

        this.#regenerateSecrets();

        const host = this.bindLan ? '0.0.0.0' : '127.0.0.1';

        this.httpServer = http.createServer((request, response) => {
            // Nothing here is a web server. Say so and close.
            response.writeHead(426, { 'content-type': 'text/plain', 'connection': 'close' });
            response.end('This port speaks the SillyTavern Multiplayer protocol over WebSocket.\n');
        });

        this.wss = new WSS({
            noServer: true,
            // Ciphertext does not compress, and permessage-deflate would only
            // add an attack surface and CPU cost, so it stays off.
            perMessageDeflate: false,
            maxPayload: LIMITS.MAX_FRAME_BYTES + 4096,
        });

        this.httpServer.on('upgrade', (request, socket, head) => {
            const ip = normaliseIp(request.socket.remoteAddress);

            if (this.bans.has(ip) || this.#isBlocked(ip)) {
                socket.destroy();
                return;
            }
            if (this.pending.size >= LIMITS.MAX_PENDING) {
                this.log('warn', `Refusing ${ip}: too many half-open connections`);
                socket.destroy();
                return;
            }
            this.wss.handleUpgrade(request, socket, head, ws => this.#onConnection(ws, ip));
        });

        await new Promise((resolve, reject) => {
            const onError = error => {
                this.httpServer?.off('listening', onListening);
                reject(error.code === 'EADDRINUSE'
                    ? new Error(`Port ${this.port} is already in use. Pick a different port in the Multiplayer settings.`)
                    : error);
            };
            const onListening = () => {
                this.httpServer?.off('error', onError);
                resolve();
            };
            this.httpServer.once('error', onError);
            this.httpServer.once('listening', onListening);
            this.httpServer.listen(this.port, host);
        });

        // Keep the process able to exit even with the relay running.
        this.httpServer.unref?.();

        // Ask the router for a mapping only once the socket is actually
        // listening, so a hole is never opened for a port nothing is serving.
        if (options.autoMap !== false && this.bindLan) {
            this.portMapping = await this.portMapper.open(this.port).catch(error => ({
                ok: false, reason: error?.message ?? 'port mapping failed',
            }));
            if (this.portMapping.ok) {
                this.log('info', `Router opened port ${this.port} via ${this.portMapping.method}`
                    + (this.portMapping.externalIp ? ` - public address ${this.portMapping.externalIp}` : ''));
            } else {
                this.log('info', `Automatic port mapping unavailable: ${this.portMapping.reason}`);
            }
        } else {
            this.portMapping = options.autoMap === false
                ? { ok: false, reason: 'disabled in settings' }
                : { ok: false, reason: 'the relay is bound to loopback, so there is nothing to map' };
        }

        this.running = true;
        this.startedAt = Date.now();
        this._sweeper = setInterval(() => this.sweep(), 5000);
        this._sweeper.unref?.();

        this.log('info', `Relay listening on ${host}:${this.port} (room "${this.roomName}")`);
        return this.describe();
    }

    async stop() {
        if (!this.running) return;
        this.running = false;
        clearInterval(this._sweeper);

        // Close the hole in the router before releasing the port.
        await this.portMapper.close().catch(() => {});
        this.portMapping = null;

        for (const peer of this.peers.values()) {
            this.#sendJson(peer.socket, { t: HS.REJECT, reason: REJECT_REASON.SERVER_CLOSING });
            try { peer.socket.close(1001, 'host stopped'); } catch { /* already gone */ }
        }
        for (const socket of this.pending) {
            try { socket.close(1001, 'host stopped'); } catch { /* already gone */ }
        }

        this.peers.clear();
        this.pending.clear();
        this.host = null;
        this.hostReport = null;
        this.oocHistory = [];
        this.personas.clear();

        // `close()` only fires once every connection is gone, and WebSocket
        // connections are long-lived. Terminating the sockets first means the
        // listener actually releases the port before this method resolves —
        // otherwise a stop/start cycle on the same port fails with EADDRINUSE.
        this.wss?.clients?.forEach(client => {
            try { client.terminate(); } catch { /* already gone */ }
        });
        this.wss?.close();
        this.wss = null;

        await new Promise(resolve => {
            const server = this.httpServer;
            if (!server) return resolve();

            let settled = false;
            const done = () => {
                if (settled) return;
                settled = true;
                resolve();
            };

            server.close(done);
            // Node 18.2+: drop keep-alive and upgraded sockets that would
            // otherwise hold the listener open indefinitely.
            server.closeAllConnections?.();
            // Last resort, so a wedged socket cannot hang SillyTavern's exit.
            setTimeout(done, 3000).unref?.();
        });

        this.httpServer = null;

        this.psk?.fill(0);
        this.hostToken?.fill(0);
        this.psk = null;
        this.hostToken = null;
        this.roomId = null;

        this.log('info', 'Relay stopped');
    }

    /**
     * Issues a fresh pre-shared key. Every existing session is dropped, because
     * their traffic keys were derived from the old one.
     */
    rotate() {
        if (!this.running) throw new Error('The relay is not running');

        for (const peer of this.peers.values()) {
            this.#sendJson(peer.socket, { t: HS.REJECT, reason: REJECT_REASON.SERVER_CLOSING });
            try { peer.socket.close(1000, 'code rotated'); } catch { /* already gone */ }
        }
        this.peers.clear();
        this.host = null;
        this.hostReport = null;

        this.#regenerateSecrets();
        this.log('info', 'Connection code rotated');
        return this.describe();
    }

    #regenerateSecrets() {
        this.psk?.fill(0);
        this.hostToken?.fill(0);
        this.psk = randomBytes(PSK_LENGTH);
        this.hostToken = randomBytes(16);
        this.roomId = deriveRoomId(this.psk);
    }

    /** Everything the host's browser needs in order to build a connection code. */
    describe() {
        const addresses = localAddresses();
        return {
            roomId: this.roomId.toString('hex'),
            psk: this.psk.toString('base64'),
            hostToken: this.hostToken.toString('base64'),
            port: this.port,
            advertiseHost: this.bindLan ? (addresses[0] ?? '127.0.0.1') : '127.0.0.1',
            addresses: this.bindLan
                ? addresses.map(address => `${address}:${this.port}`)
                : [`127.0.0.1:${this.port} (loopback only)`],
            portMapping: this.portMapping,
            /**
             * The address most likely to work for everyone. A router-confirmed
             * public IP beats the detected LAN address, which is useless to
             * anyone outside the building. This is what removes the setup step.
             */
            publicHost: this.portMapping?.ok && this.portMapping.externalIp
                && !isPrivateIPv4(this.portMapping.externalIp)
                ? this.portMapping.externalIp
                : null,
            roomName: this.roomName,
            requireParity: this.requireParity,
            parityStrictness: this.parityStrictness,
        };
    }

    status() {
        return {
            running: this.running,
            port: this.port,
            roomName: this.roomName,
            bindLan: this.bindLan,
            /** What the socket is actually bound to, as opposed to what is advertised. */
            boundTo: this.bindLan ? '0.0.0.0' : '127.0.0.1',
            portMapping: this.portMapping,
            /**
             * The address most likely to work for everyone. A router-confirmed
             * public IP beats a LAN address, which is useless to anyone who is
             * not in the building.
             */
            publicHost: this.portMapping?.ok && this.portMapping.externalIp
                && !isPrivateIPv4(this.portMapping.externalIp)
                ? this.portMapping.externalIp
                : null,
            uptimeMs: this.running ? Date.now() - this.startedAt : 0,
            maxPeers: this.maxPeers,
            requireParity: this.requireParity,
            hostConnected: Boolean(this.host),
            peers: [...this.peers.values()].map(peer => ({
                ...peer.summary(),
                admitted: peer.admitted,
                parity: peer.parity.status,
                bytesIn: peer.bytesIn,
                bytesOut: peer.bytesOut,
                joinedAt: peer.joinedAt,
            })),
            pending: this.pending.size,
            bans: [...this.bans],
        };
    }

    kick(peerId, { ban = false } = {}) {
        const peer = this.peers.get(peerId);
        if (!peer) return false;
        if (ban) this.bans.add(peer.ip);
        void this.#send(peer, { op: OP.KICK, reason: 'host' });
        setTimeout(() => {
            try { peer.socket.close(4403, 'removed by host'); } catch { /* already gone */ }
        }, 100).unref?.();
        return true;
    }

    unban(ip) {
        return this.bans.delete(String(ip));
    }

    // =======================================================================
    // Handshake
    // =======================================================================

    #onConnection(socket, ip) {
        socket.binaryType = 'nodebuffer';
        this.pending.add(socket);

        const state = { ip, stage: 'hello', ecdh: null, publicKeyRaw: null, nonce: null, keys: null, transcriptHash: null };

        const timer = setTimeout(() => {
            this.#rejectSocket(socket, REJECT_REASON.TIMEOUT);
        }, LIMITS.HANDSHAKE_TIMEOUT_MS);
        timer.unref?.();

        // Frame handling is asynchronous, so frames are chained per socket.
        // Otherwise a CONFIRM could be processed before the HELLO that derived
        // the keys it is meant to prove, and legitimate peers would be dropped.
        let inbound = Promise.resolve();
        socket.on('message', (data, isBinary) => {
            inbound = inbound
                .then(() => this.#onSocketMessage(socket, state, data, isBinary, timer))
                .catch(() => { /* #onSocketMessage already handled and closed */ });
        });

        socket.on('close', () => {
            clearTimeout(timer);
            this.pending.delete(socket);
            if (socket.__peerId) this.#removePeer(socket.__peerId);
        });

        socket.on('error', error => {
            this.log('debug', `Socket error from ${ip}: ${error.message}`);
        });
    }

    async #onSocketMessage(socket, state, data, isBinary, timer) {
        const peer = socket.__peerId ? this.peers.get(socket.__peerId) : null;

        try {
            if (peer) return await this.#onPeerFrame(peer, data, isBinary);

            if (isBinary) throw new Error('Binary frame before the handshake completed');
            const message = JSON.parse(data.toString('utf8'));

            if (message.t === HS.HELLO && state.stage === 'hello') {
                return await this.#onHello(socket, state, message);
            }
            if (message.t === HS.CONFIRM && state.stage === 'confirm') {
                return await this.#onConfirm(socket, state, message, timer);
            }
            throw new Error(`Unexpected handshake message "${message.t}"`);
        } catch (error) {
            if (peer) {
                // A peer that fails after authentication is not an attacker
                // guessing codes; drop the socket without penalising the IP.
                this.log('warn', `Dropping ${peer.name} (${peer.ip}): ${error.message}`);
                try { peer.socket.close(4400, 'protocol error'); } catch { /* already gone */ }
                return;
            }
            this.#noteFailure(state.ip);
            this.#rejectSocket(socket, REJECT_REASON.MALFORMED, error.message);
        }
    }

    async #onHello(socket, state, message) {
        if (message.revision !== PROTOCOL_REVISION) {
            this.#rejectSocket(socket, REJECT_REASON.BAD_REVISION,
                `Relay speaks ${PROTOCOL_REVISION}, peer speaks ${message.revision}`);
            return;
        }

        const peerPublicRaw = decodeBase64(message.pub, 65);
        const peerNonce = decodeBase64(message.nonce, HANDSHAKE_NONCE_LENGTH);
        const claimedRoom = decodeBase64(message.room, ROOM_ID_LENGTH);

        // Room id is a hash of the PSK, so this rejects wrong codes early
        // without the PSK itself ever appearing on the wire.
        if (!timingSafeEqual(claimedRoom, this.roomId)) {
            this.#noteFailure(state.ip);
            this.#rejectSocket(socket, REJECT_REASON.UNKNOWN_ROOM);
            return;
        }

        // Count admitted peers only. Using peers.size here meant anyone held at
        // the extension-parity gate occupied a seat, so a group who all needed to
        // sync would fill the room and lock out someone who was ready to play.
        if (this.#admittedCount() >= this.maxPeers) {
            this.#rejectSocket(socket, REJECT_REASON.ROOM_FULL);
            return;
        }

        // Separate, smaller cap so the lobby itself cannot be flooded.
        if (this.#lobbyCount() >= LIMITS.MAX_LOBBY) {
            this.#rejectSocket(socket, REJECT_REASON.RATE_LIMITED, 'too many peers are waiting to be admitted');
            return;
        }

        const { ecdh, publicKeyRaw } = createEphemeralKeyPair();
        const nonce = randomBytes(HANDSHAKE_NONCE_LENGTH);

        const { keys, transcriptHash } = deriveSessionKeys({
            ecdh,
            ownPublicRaw: publicKeyRaw,
            peerPublicRaw,
            ownNonce: nonce,
            peerNonce,
            psk: this.psk,
        });

        state.ecdh = ecdh;
        state.publicKeyRaw = publicKeyRaw;
        state.nonce = nonce;
        state.keys = keys;
        state.transcriptHash = transcriptHash;
        state.wantsHost = this.#checkHostToken(message.token) && isLoopback(state.ip);
        state.stage = 'confirm';

        this.#sendJson(socket, {
            t: HS.CHALLENGE,
            pub: publicKeyRaw.toString('base64'),
            nonce: nonce.toString('base64'),
        });
    }

    /**
     * The host slot is claimed with a token minted by `/start` and handed to the
     * host's own browser over SillyTavern's authenticated HTTP API. Requiring
     * loopback as well means the token alone is not enough from off-machine.
     */
    #checkHostToken(value) {
        if (typeof value !== 'string' || !this.hostToken) return false;
        try {
            return timingSafeEqual(Buffer.from(value, 'base64'), this.hostToken);
        } catch {
            return false;
        }
    }

    async #onConfirm(socket, state, message, timer) {
        const expected = computeConfirmation(state.keys.confirmKey, state.transcriptHash, confirmationLabels.client);
        let provided;
        try {
            provided = Buffer.from(String(message.mac ?? ''), 'base64');
        } catch {
            provided = Buffer.alloc(0);
        }

        if (!timingSafeEqual(expected, provided)) {
            // Wrong code, or something on the path substituted keys.
            this.#noteFailure(state.ip);
            this.#rejectSocket(socket, REJECT_REASON.BAD_MAC);
            return;
        }

        clearTimeout(timer);
        this.pending.delete(socket);
        this.#clearFailures(state.ip);

        const peer = new Peer(socket, state.ip);
        peer.keys = state.keys;

        if (state.wantsHost && !this.host) {
            peer.role = ROLE.HOST;
            this.host = peer;
            // Deliberately not admitted here: admission runs through #admit so
            // there is exactly one place that seats a peer and announces it.
            // With the parity check on, the host is seated once it reports its
            // own fingerprint (which becomes the room's baseline); with it off,
            // #onConfirm admits it directly a few lines below.
        } else if (state.wantsHost && this.host) {
            this.log('warn', 'A second connection tried to claim the host slot; seating it as a client');
        }

        socket.__peerId = peer.id;
        this.peers.set(peer.id, peer);

        // Prove to the peer that we know the PSK too, then open the channel.
        this.#sendJson(socket, {
            t: HS.ACCEPTED,
            mac: computeConfirmation(state.keys.confirmKey, state.transcriptHash, confirmationLabels.server).toString('base64'),
        });

        await this.#send(peer, {
            op: OP.WELCOME,
            peerId: peer.id,
            roomId: this.roomId.toString('hex'),
            roomName: this.roomName,
            role: peer.role,
            hostName: this.host?.name ?? 'Host',
            requireParity: this.requireParity,
            peers: this.#roster(),
        });

        if (this.requireParity) {
            await this.#send(peer, { op: OP.PARITY_CHALLENGE, strictness: this.parityStrictness });
        } else {
            peer.parity.status = 'ok';
            await this.#admit(peer);
        }

        this.log('info', `${peer.role} ${peer.id} connected from ${peer.ip}`);
    }

    #rejectSocket(socket, reason, detail) {
        this.#sendJson(socket, { t: HS.REJECT, reason, detail });
        setTimeout(() => {
            try { socket.close(4401, reason); } catch { /* already gone */ }
        }, 50).unref?.();
        this.pending.delete(socket);
    }

    // =======================================================================
    // Abuse controls
    // =======================================================================

    #noteFailure(ip) {
        const record = this.offenders.get(ip) ?? { failures: 0, blockedUntil: 0 };
        record.failures += 1;
        if (record.failures >= LIMITS.MAX_HANDSHAKE_FAILURES) {
            record.blockedUntil = Date.now() + LIMITS.HANDSHAKE_BLOCK_MS;
            record.failures = 0;
            this.log('warn', `Temporarily blocking ${ip} after repeated failed handshakes`);
        }
        this.offenders.set(ip, record);
    }

    #clearFailures(ip) {
        this.offenders.delete(ip);
    }

    #isBlocked(ip) {
        const record = this.offenders.get(ip);
        return Boolean(record && record.blockedUntil > Date.now());
    }

    // =======================================================================
    // Frames
    // =======================================================================

    async #onPeerFrame(peer, data, isBinary) {
        if (!isBinary) throw new Error('Text frame after the handshake completed');

        const size = data.length;
        if (!peer.messageBucket.take(1) || !peer.byteBucket.take(size)) {
            throw new Error('Rate limit exceeded');
        }

        const { counter, payload } = await openFrame(peer.keys, data);
        if (!peer.replay.accept(counter)) throw new Error('Replayed or out-of-window frame');

        peer.lastSeen = Date.now();
        peer.bytesIn += size;

        if (!payload || typeof payload.op !== 'string') throw new Error('Frame carried no opcode');
        const op = payload.op;

        if (peer.role !== ROLE.HOST && !CLIENT_ALLOWED_OPS.has(op)) {
            // A client cannot publish a card index, rewrite the transcript or
            // impersonate the host. Drop rather than forward.
            this.log('warn', `Client ${peer.id} attempted host-only opcode "${op}"`);
            return;
        }

        switch (op) {
            case OP.PING:
                return this.#send(peer, { op: OP.PONG, t: payload.t });

            case OP.PONG:
                if (typeof payload.t === 'number') peer.rtt = Math.max(0, Date.now() - payload.t);
                return;

            case OP.ROSTER:
                // Peers announce their display name with this opcode.
                peer.name = String(payload.name ?? 'Player').slice(0, 40) || 'Player';
                if (peer.role === ROLE.HOST) this.#broadcastHostName();
                return this.#broadcastRoster();

            case OP.PARITY_REPORT:
                return this.#onParityReport(peer, payload.report);

            default:
                break;
        }

        if (!peer.admitted) return; // still in the lobby: nothing is forwarded

        if (op === OP.OOC_MESSAGE) return this.#onOoc(peer, payload);

        if (op === OP.OOC_TYPING) {
            return this.#broadcast({ op: OP.OOC_TYPING, from: peer.id, name: peer.name }, { except: peer.id });
        }

        if (op === OP.PERSONA_STATE) return this.#onPersona(peer, payload);

        if (peer.role === ROLE.HOST) {
            // Host frames were forwarded verbatim, so anything identity-bearing
            // arrived anonymous. The roster keys personas by peer id, so the
            // host's own persona could never be matched to the host and clients
            // saw no profile for them at all.
            const outgoing = STAMP_IDENTITY.has(op)
                ? { ...payload, from: peer.id, name: peer.name }
                : payload;
            const target = payload.to ? this.peers.get(payload.to) : null;
            if (target) return this.#send(target, outgoing);
            return this.#broadcast(outgoing, { except: peer.id });
        }

        if (TO_HOST_ONLY.has(op)) {
            if (!this.host) return this.#send(peer, { op: OP.ERROR, message: 'The host is not connected right now.' });
            return this.#send(this.host, { ...payload, from: peer.id });
        }

        return this.#broadcast({ ...payload, from: peer.id }, { except: peer.id });
    }

    /**
     * Relays one persona to the room and remembers it.
     * The relay stamps the author, so a peer cannot publish a persona as somebody
     * else, and echoes to everyone including the sender so ordering is uniform.
     */
    async #onPersona(peer, payload) {
        const persona = payload?.persona;
        if (!persona || typeof persona !== 'object') return;

        const stamped = {
            op: OP.PERSONA_STATE,
            from: peer.id,
            name: peer.name,
            role: peer.role,
            persona,
        };
        this.personas.set(peer.id, stamped);
        return this.#broadcast(stamped, {});
    }

    // =======================================================================
    // Out-of-character channel
    // =======================================================================

    /**
     * Relays one OOC message to the whole room, sender included.
     *
     * The relay is the ordering authority here: it stamps the author, the id and
     * the timestamp, then echoes to everyone. That means no peer can post under
     * someone else's name, and every peer renders the same conversation in the
     * same order rather than seeing its own messages jump ahead.
     *
     * These payloads are never mixed into chat traffic. They exist so players
     * can plan without any of it entering the roleplay transcript or the prompt.
     */
    async #onOoc(peer, payload) {
        const text = String(payload.text ?? '')
            .replace(/\u0000/g, '')
            .slice(0, OOC.MAX_LENGTH)
            .trim();
        if (!text) return;

        const message = {
            op: OP.OOC_MESSAGE,
            id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            from: peer.id,
            name: peer.name,
            role: peer.role,
            text,
            sentAt: Date.now(),
        };

        this.oocHistory.push(message);
        if (this.oocHistory.length > OOC.HISTORY) {
            this.oocHistory.splice(0, this.oocHistory.length - OOC.HISTORY);
        }

        // ECHO_TO_SENDER: the author gets it back too, so ordering is uniform.
        const echo = ECHO_TO_SENDER.has(OP.OOC_MESSAGE);
        return this.#broadcast(message, echo ? {} : { except: peer.id });
    }

    // =======================================================================
    // Extension parity
    // =======================================================================

    async #onParityReport(peer, report) {
        if (!report || typeof report.hash !== 'string' || !Array.isArray(report.extensions)) {
            peer.parity.status = 'invalid';
            return this.#send(peer, { op: OP.PARITY_RESULT, ok: false, diff: emptyDiff() });
        }

        // Bound what a peer can push into relay memory.
        peer.parity.report = {
            strictness: report.strictness === 'commit' ? 'commit' : 'manifest',
            hash: report.hash.slice(0, 128),
            extensions: report.extensions.slice(0, 200).map(entry => ({
                id: String(entry.id ?? '').slice(0, 120),
                displayName: String(entry.displayName ?? '').slice(0, 120),
                version: String(entry.version ?? '').slice(0, 40),
                commit: String(entry.commit ?? '').slice(0, 40),
                branch: String(entry.branch ?? '').slice(0, 80),
                remoteUrl: String(entry.remoteUrl ?? '').slice(0, 400),
                // Carried through because it is often the only installable URL
                // available without an expensive git lookup on the host.
                homePage: String(entry.homePage ?? '').slice(0, 400),
            })),
        };

        if (peer.role === ROLE.HOST) {
            this.hostReport = peer.parity.report;
            peer.parity.status = 'ok';
            await this.#admit(peer);
            // Anyone who arrived before the host reported is now resolvable.
            for (const waiting of this.peers.values()) {
                if (waiting.parity.status === 'waiting-host') await this.#resolveParity(waiting);
            }
            return;
        }

        if (!this.hostReport) {
            peer.parity.status = 'waiting-host';
            return;
        }

        return this.#resolveParity(peer);
    }

    async #resolveParity(peer) {
        const diff = diffReports(this.hostReport, peer.parity.report);

        if (diff.ok) {
            peer.parity.status = 'ok';
            return this.#admit(peer); // #admit sends the PARITY_RESULT
        }

        peer.parity.status = 'mismatch';
        this.log('info', `${peer.id} failed the extension check `
            + `(${diff.missing.length} missing, ${diff.extra.length} extra, ${diff.mismatched.length} mismatched)`);
        await this.#send(peer, { op: OP.PARITY_RESULT, ok: false, diff });
    }

    async #admit(peer) {
        if (peer.admitted) return;
        peer.admitted = true;

        // Every admission path funnels through here, so this is the one place
        // that tells a peer it is seated. The host and peers admitted with the
        // parity check disabled reach admission without a parity comparison, and
        // they still need this — the extension treats it as "you are connected".
        await this.#send(peer, { op: OP.PARITY_RESULT, ok: true });

        await this.#broadcast({ op: OP.PEER_JOIN, peer: peer.summary() }, { except: peer.id });
        await this.#broadcastRoster();

        // Hand over the planning history so someone joining mid-session can see
        // what was already agreed rather than asking everyone to repeat it.
        if (this.oocHistory.length > 0) {
            await this.#send(peer, { op: OP.OOC_HISTORY, messages: this.oocHistory });
        }

        // Tell the newcomer who everyone is playing, and ask the room to
        // re-publish so the newcomer's own persona reaches everyone else.
        for (const [peerId, stamped] of this.personas) {
            if (peerId === peer.id) continue;
            await this.#send(peer, stamped);
        }

        // Bring the newcomer up to date with whatever the host is sharing.
        if (this.host && peer.role !== ROLE.HOST) {
            await this.#send(this.host, { op: OP.CARDS_WANT, want: 'republish', from: peer.id });
        }
    }

    // =======================================================================
    // Sending
    // =======================================================================

    async #send(peer, payload) {
        if (!peer || peer.socket.readyState !== 1) return;
        try {
            const counter = ++peer.sendCounter;
            const frame = await sealFrame(peer.keys, counter, payload);
            peer.socket.send(frame);
            peer.bytesOut += frame.length;
        } catch (error) {
            this.log('warn', `Failed to send to ${peer.id}: ${error.message}`);
        }
    }

    async #broadcast(payload, { except = null } = {}) {
        const targets = [...this.peers.values()].filter(peer => peer.admitted && peer.id !== except);
        await Promise.all(targets.map(peer => this.#send(peer, payload)));
    }

    #roster() {
        return [...this.peers.values()].filter(peer => peer.admitted).map(peer => peer.summary());
    }

    async #broadcastRoster() {
        await this.#broadcast({ op: OP.ROSTER, peers: this.#roster() });
    }

    async #broadcastHostName() {
        await this.#broadcast({ op: OP.WELCOME_UPDATE ?? 'welcome', hostName: this.host?.name });
    }

    #sendJson(socket, object) {
        if (socket.readyState !== 1) return;
        try { socket.send(JSON.stringify(object)); } catch { /* socket already closing */ }
    }

    // =======================================================================
    // Housekeeping
    // =======================================================================

    #removePeer(peerId) {
        const peer = this.peers.get(peerId);
        if (!peer) return;
        this.peers.delete(peerId);
        // Drop the cached persona too, or a departed player keeps appearing in
        // everyone's roster with a profile that can no longer be refreshed.
        this.personas.delete(peerId);

        if (this.host?.id === peerId) {
            this.host = null;
            this.hostReport = null;
            this.log('info', 'The host disconnected');
        }

        if (peer.admitted) {
            void this.#broadcast({ op: OP.PEER_LEAVE, peer: peer.summary() });
            void this.#broadcastRoster();
        }
    }

    #admittedCount() {
        let count = 0;
        for (const peer of this.peers.values()) if (peer.admitted) count += 1;
        return count;
    }

    #lobbyCount() {
        let count = 0;
        for (const peer of this.peers.values()) if (!peer.admitted) count += 1;
        return count;
    }

    /**
     * Drops silent peers, expires lobby waits, and clears temporary IP blocks.
     *
     * Public so tests can drive it directly: the intervals involved are tens of
     * seconds, and a test that waits them out in real time is a test nobody runs.
     */
    sweep() {
        const now = Date.now();

        for (const peer of this.peers.values()) {
            if (now - peer.lastSeen > LIMITS.PING_TIMEOUT_MS) {
                this.log('info', `Dropping ${peer.id}: no traffic for ${Math.round((now - peer.lastSeen) / 1000)}s`);
                try { peer.socket.close(4408, 'timeout'); } catch { /* already gone */ }
                continue;
            }

            // A peer that never gets admitted answers heartbeats forever, so a
            // liveness timeout alone would never remove it. Expire the wait.
            if (!peer.admitted && now - peer.joinedAt > LIMITS.LOBBY_TIMEOUT_MS) {
                this.log('info', `Dropping ${peer.name || peer.id}: never admitted within ${Math.round(LIMITS.LOBBY_TIMEOUT_MS / 1000)}s`);
                void this.#send(peer, {
                    op: OP.ERROR,
                    message: 'Timed out waiting to be admitted. Sync your extensions if needed, then rejoin.',
                });
                setTimeout(() => {
                    try { peer.socket.close(4403, 'not admitted'); } catch { /* already gone */ }
                }, 200);
                continue;
            }

            if (now - peer.lastSeen > LIMITS.PING_INTERVAL_MS) {
                void this.#send(peer, { op: OP.PING, t: now });
            }
        }

        for (const [ip, record] of this.offenders) {
            if (record.blockedUntil && record.blockedUntil < now) this.offenders.delete(ip);
        }
    }
}

// ---------------------------------------------------------------------------
// Parity diffing. Mirrors lib/parity.js#diffReports so the relay can decide
// admission without trusting either side's own verdict.
// ---------------------------------------------------------------------------

function emptyDiff() {
    return { ok: false, missing: [], extra: [], mismatched: [] };
}

export function diffReports(hostReport, clientReport) {
    if (!hostReport || !clientReport) return emptyDiff();

    const hostMap = new Map(hostReport.extensions.map(entry => [entry.id, entry]));
    const clientMap = new Map(clientReport.extensions.map(entry => [entry.id, entry]));
    const strict = hostReport.strictness === 'commit';

    const missing = [];
    const mismatched = [];

    for (const [id, hostEntry] of hostMap) {
        const clientEntry = clientMap.get(id);
        if (!clientEntry) {
            missing.push(hostEntry);
        } else if (clientEntry.version !== hostEntry.version || (strict && clientEntry.commit !== hostEntry.commit)) {
            mismatched.push({ ...hostEntry, clientVersion: clientEntry.version, clientCommit: clientEntry.commit });
        }
    }

    const extra = [...clientMap.values()].filter(entry => !hostMap.has(entry.id));

    return {
        ok: missing.length === 0 && extra.length === 0 && mismatched.length === 0,
        missing, extra, mismatched,
    };
}

// ---------------------------------------------------------------------------

function clampInt(value, min, max, fallback) {
    const number = Number.parseInt(value, 10);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, number));
}

function decodeBase64(value, expectedLength) {
    if (typeof value !== 'string') throw new Error('Expected a base64 string');
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length !== expectedLength) throw new Error(`Expected ${expectedLength} bytes, got ${bytes.length}`);
    return bytes;
}

function normaliseIp(address) {
    const value = String(address ?? '');
    return value.startsWith('::ffff:') ? value.slice(7) : value;
}
