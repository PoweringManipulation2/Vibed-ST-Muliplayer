/**
 * Session orchestrator.
 *
 * One object owns the whole multiplayer lifecycle for this browser tab, in
 * either role:
 *
 *   Host   — asks the server plugin to start a relay on the local machine,
 *            receives the connection code, then joins its own relay over
 *            loopback as a privileged peer. Serves character definitions and
 *            broadcasts the authoritative chat.
 *
 *   Client — decodes a connection code, performs the authenticated handshake,
 *            passes the extension-parity check, materialises stub cards and
 *            mirrors the host's chat.
 *
 * Using the same transport for both roles means there is a single handshake and
 * a single frame path to reason about.
 */

import {
    LIMITS, OP, PLUGIN_API, PROTOCOL_REVISION, REJECT_REASON, ROLE,
    classifyAddress, connectionUrl, decodeConnectionCode, encodeConnectionCode,
} from './protocol.js';
import { SecureSocket, STATE } from './transport.js';
import { fromBase64, toBase64 } from './crypto.js';
import { buildReport, buildSyncPlan, diffReports } from './parity.js';
import {
    ChunkAssembler, HydrationTracker, applyStubAvatar, buildCardIndex,
    extractDefinition, materialiseStub, readLocalAvatar, remoteCardId, streamAvatar,
} from './cards.js';
import { ChatBridge } from './chat.js';
import { OOCChannel } from './ooc.js';

export class MultiplayerSession extends EventTarget {
    /**
     * @param {object} deps SillyTavern bindings injected from index.js
     */
    constructor(deps) {
        super();
        this.deps = deps;

        /** @type {'idle'|'starting'|'connecting'|'verifying'|'connected'|'error'} */
        this.status = 'idle';
        /** @type {'host'|'client'|null} */
        this.role = null;

        /** @type {SecureSocket|null} */
        this.socket = null;

        this.code = '';
        this.roomId = '';
        /** Proves to the relay that this browser is the host that started it. */
        this.hostToken = null;
        this.peerId = null;
        this.peers = [];
        this.hostName = 'Host';
        this.lastError = '';
        this.pendingDiff = null;

        /** Catalogue of cards the host is sharing (both roles hold a copy). */
        this.cardIndex = [];
        /** cardId -> local avatar filename, client side only. */
        this.stubs = new Map();

        this.hydration = new HydrationTracker();
        this.assembler = new ChunkAssembler();

        // Player-to-player channel. Kept on the session so it is available in
        // both roles and torn down with the connection.
        this.ooc = new OOCChannel({
            getContext: deps.getContext,
            send: payload => this.socket?.send(payload),
            isConnected: () => this.status === 'connected',
            peerId: () => this.peerId,
            toastr: deps.toastr,
            // Panel position, size and collapsed state are remembered between
            // sessions, so they live in the extension's own settings.
            settings: deps.settings,
            save: deps.save,
        });

        this.chat = new ChatBridge({
            getContext: deps.getContext,
            send: payload => this.socket?.send(payload),
            role: () => this.role,
            isActive: () => this.status === 'connected',
        });
    }

    get settings() {
        return this.deps.settings();
    }

    get connected() {
        return this.status === 'connected';
    }

    // =======================================================================
    // Host
    // =======================================================================

    /** Confirms the server plugin is installed and reachable. */
    async probePlugin() {
        try {
            const response = await fetch(`${PLUGIN_API}/probe`, { headers: this.deps.getRequestHeaders() });

            if (!response.ok) {
                // A bare status code tells the user nothing they can act on, and
                // each of these means something quite different, so spell it out.
                if (response.status === 404) {
                    return {
                        ok: false,
                        code: 404,
                        reason: [
                            'The relay is not loaded, so this copy of SillyTavern cannot host.',
                            '',
                            'Joining someone else\'s room still works — only hosting needs the relay.',
                            '',
                            'To enable hosting, check these three things in order:',
                            '  1. Run the installer once, from this extension\'s folder:',
                            '       node install.mjs --enable',
                            '  2. Confirm config.yaml in your SillyTavern folder has:',
                            '       enableServerPlugins: true',
                            '  3. Fully restart SillyTavern — reloading the page is not enough,',
                            '     because plugins are only loaded when the server starts.',
                            '',
                            'After restarting, the SillyTavern console (the black window, not',
                            'the browser) should print a line containing "st-multiplayer".',
                        ].join('\n'),
                    };
                }
                if (response.status === 403) {
                    return { ok: false, code: 403, reason: 'Hosting requires an admin account. You are signed in as a non-admin user.' };
                }
                if (response.status === 401) {
                    return { ok: false, code: 401, reason: 'SillyTavern rejected the request as unauthenticated. Reload the page and sign in again.' };
                }
                return { ok: false, code: response.status, reason: `The relay responded with HTTP ${response.status}.` };
            }

            const data = await response.json();
            if (data.revision !== PROTOCOL_REVISION) {
                return {
                    ok: false,
                    code: 'revision',
                    reason: `Version mismatch: the relay speaks ${data.revision}, this extension speaks ${PROTOCOL_REVISION}.\n`
                        + 'Re-run "node install.mjs" so the relay matches the extension, then restart SillyTavern.',
                };
            }
            return { ok: true, ...data };
        } catch (error) {
            return {
                ok: false,
                code: 'network',
                reason: `Could not reach SillyTavern's own API (${error?.message ?? 'network error'}). Reload the page and try again.`,
            };
        }
    }

    async startHosting(options = {}) {
        if (this.status !== 'idle') throw new Error('A session is already running');
        this.#setStatus('starting');
        this.role = ROLE.HOST;

        const probe = await this.probePlugin();
        if (!probe.ok) {
            this.#fail(probe.reason);
            const error = new Error(probe.reason);
            error.code = probe.code;
            throw error;
        }

        const settings = this.settings;
        const advertiseHost = String(options.advertiseHost ?? settings.advertiseHost ?? '').trim();
        const bindLan = Boolean(options.bindLan ?? settings.bindLan);

        // Advertising an address that is not loopback while the relay listens on
        // loopback only is a guaranteed failure: the code looks right, and every
        // joiner hangs on "Connecting" forever. Refuse it up front.
        if (advertiseHost && !bindLan && !/^(127\.|localhost$|::1$)/.test(advertiseHost)) {
            const message = `You have set the connect address to "${advertiseHost}", but `
                + '"Allow players on my local network" is off, so the relay will only listen on '
                + '127.0.0.1 and nobody outside this machine can reach it.\n\n'
                + 'Turn that option on, or clear the address if everyone is on your own network.\n'
                + 'The only exception is a tunnel that terminates locally, such as "ssh -L", where '
                + 'loopback is correct — in that case advertise a 127.0.0.1 address.';
            this.#fail(message);
            throw new Error(message);
        }
        const body = {
            port: Number(options.port ?? settings.port),
            bindLan: Boolean(options.bindLan ?? settings.bindLan),
            roomName: String(options.roomName ?? settings.roomName ?? 'SillyTavern room').slice(0, 60),
            maxPeers: Math.min(LIMITS.MAX_PEERS, Number(options.maxPeers ?? settings.maxPeers)),
            requireParity: Boolean(options.requireParity ?? settings.requireParity),
            autoMap: Boolean(options.autoMap ?? settings.autoPortForward),
            parityStrictness: options.parityStrictness ?? settings.parityStrictness,
        };

        let started;
        try {
            const response = await fetch(`${PLUGIN_API}/start`, {
                method: 'POST',
                headers: this.deps.getRequestHeaders(),
                body: JSON.stringify(body),
            });
            if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
            started = await response.json();
        } catch (error) {
            this.#fail(`Could not start the relay: ${error.message}`);
            throw error;
        }

        this.roomId = started.roomId;
        this.hostName = this.deps.getContext().substituteParams?.('{{user}}') || 'Host';

        // The relay hands back the raw PSK over SillyTavern's own authenticated
        // API. The host browser needs it to run the same handshake every client
        // runs, so there is exactly one code path.
        const psk = fromBase64(started.psk);
        this.hostToken = started.hostToken;
        // An explicit address always wins: the relay can only ever detect a local
        // one, which is unreachable for anyone outside this network.
        // Preference order: what the user typed, then the public address the
        // router confirmed, then the detected LAN address. The middle option is
        // what removes the setup step — a working code with nothing configured.
        const codeHost = advertiseHost || started.publicHost || started.advertiseHost;
        this.portMapping = started.portMapping ?? null;
        const secure = Boolean(options.advertiseSecure ?? settings.advertiseSecure);
        // With a TLS tunnel the public port is usually 443, which is the scheme
        // default, so 0 means "leave the port out of the URL entirely".
        const advertisePort = Number(options.advertisePort ?? settings.advertisePort) || 0;
        const codePort = advertisePort || (secure ? 0 : started.port);

        this.code = encodeConnectionCode({ host: codeHost, port: codePort, psk, secure });
        this.addresses = started.addresses ?? [];
        this.codeHost = codeHost;
        this.codeUrl = connectionUrl({ host: codeHost, port: codePort, secure });

        const kind = classifyAddress(codeHost);
        if (kind === 'loopback') {
            this.#emit('log', { level: 'warn', message: 'This code points at loopback — only this machine can use it.' });
        } else if (kind === 'lan' && !advertiseHost) {
            this.#emit('log', {
                level: 'warn',
                message: `This code points at ${codeHost}, a local-network address. Players elsewhere cannot reach it — `
                    + 'set "Address players connect to" (a Tailscale address is the easiest option) and start again.',
            });
        } else if (kind === 'tailnet') {
            this.#emit('log', { level: 'info', message: `Advertising ${codeHost} — players on the same Tailscale network can join from anywhere.` });
        }

        const mapping = started.portMapping;
        if (mapping?.ok) {
            this.#emit('log', {
                level: 'success',
                message: `Your router opened port ${started.port} automatically (${mapping.method}). `
                    + 'Players anywhere should be able to join with this code.',
            });
        } else if (mapping?.cgnat) {
            this.#emit('log', { level: 'error', message: mapping.reason });
        } else if (mapping?.reason && !advertiseHost && kind === 'lan') {
            this.#emit('log', {
                level: 'warn',
                message: `Could not open the port automatically: ${mapping.reason}`,
            });
        }

        // Loopback on purpose: the host's browser and the relay are the same
        // machine, so nothing about this connection touches the network.
        await this.#openSocket(`ws://127.0.0.1:${started.port}/`, psk, {
            autoReconnect: true,
            hostToken: this.hostToken,
        });
        this.#emit('code', { code: this.code, addresses: this.addresses });
    }

    async stopHosting() {
        try {
            await fetch(`${PLUGIN_API}/stop`, { method: 'POST', headers: this.deps.getRequestHeaders() });
        } catch (error) {
            console.warn('[Multiplayer] Relay stop request failed', error);
        }
        await this.leave();
    }

    /** Invalidates the current code and drops everyone. */
    async rotateCode() {
        // Tear down our own socket first. The relay drops every peer when it
        // rotates, and if this socket were still live its auto-reconnect would
        // start retrying with the now-dead pre-shared key.
        if (this.socket) {
            this.socket.autoReconnect = false;
            this.socket.close('code rotated');
            this.socket = null;
        }

        const response = await fetch(`${PLUGIN_API}/rotate`, { method: 'POST', headers: this.deps.getRequestHeaders() });
        if (!response.ok) throw new Error(await response.text());
        const data = await response.json();
        const psk = fromBase64(data.psk);
        this.hostToken = data.hostToken;
        const settings = this.settings;
        const rotateHost = String(settings.advertiseHost ?? '').trim() || data.advertiseHost;
        const rotateSecure = Boolean(settings.advertiseSecure);
        const rotatePort = Number(settings.advertisePort) || (rotateSecure ? 0 : data.port);
        this.code = encodeConnectionCode({ host: rotateHost, port: rotatePort, psk, secure: rotateSecure });
        this.codeUrl = connectionUrl({ host: rotateHost, port: rotatePort, secure: rotateSecure });
        this.roomId = data.roomId;
        this.addresses = data.addresses ?? this.addresses;

        await this.#openSocket(`ws://127.0.0.1:${data.port}/`, psk, {
            autoReconnect: true,
            hostToken: this.hostToken,
        });
        this.#emit('code', { code: this.code, addresses: this.addresses });
        return this.code;
    }

    async kick(peerId) {
        await fetch(`${PLUGIN_API}/kick`, {
            method: 'POST',
            headers: this.deps.getRequestHeaders(),
            body: JSON.stringify({ peerId }),
        });
    }

    /** Publishes the current share selection to everyone in the room. */
    async publishCards() {
        if (this.role !== ROLE.HOST) return;
        const context = this.deps.getContext();
        this.cardIndex = await buildCardIndex(context.characters ?? [], this.settings.sharedCards ?? [], this.roomId);
        this.socket?.send({ op: OP.CARDS_INDEX, hostName: this.hostName, cards: this.cardIndex });
        this.#emit('cards', { cards: this.cardIndex });
    }

    // =======================================================================
    // Client
    // =======================================================================

    async join(code) {
        if (this.status !== 'idle') throw new Error('A session is already running');

        let target;
        try {
            target = decodeConnectionCode(code);
        } catch (error) {
            this.#fail(error.message);
            throw error;
        }

        // Browsers block plain WebSocket connections from an HTTPS page as mixed
        // content. A code marked secure points at wss, which is fine from either
        // kind of page; a plain code from an HTTPS page can never work.
        if (location.protocol === 'https:' && !target.secure) {
            const message = 'Your SillyTavern is served over HTTPS, and browsers refuse plain WebSocket '
                + 'connections from an HTTPS page. Open SillyTavern over http://localhost instead, or ask '
                + 'the host to put the relay behind an HTTPS reverse proxy.';
            this.#fail(message);
            throw new Error(message);
        }

        this.role = ROLE.CLIENT;
        this.code = code;
        this.target = target;
        this.#setStatus('connecting');

        const kind = classifyAddress(target.host);
        if (kind === 'lan' || kind === 'loopback') {
            this.#emit('log', {
                level: 'warn',
                message: `This code points at ${target.host}, a local-network address. `
                    + 'It only works if you are on the same network as the host.',
            });
        } else if (kind === 'tailnet') {
            this.#emit('log', {
                level: 'info',
                message: `${target.host} is a Tailscale-style address — you both need to be on the same tailnet.`,
            });
        }

        const url = connectionUrl(target);
        this.#emit('log', { level: 'info', message: `Connecting to ${url}` });
        await this.#openSocket(url, target.psk, { autoReconnect: true });
    }

    async leave() {
        this.socket?.close('leaving');
        this.socket = null;
        this.chat.detach();
        this.chat.reset();
        this.assembler.clear();
        this.#dehydrateAll();
        this.role = null;
        this.peers = [];
        this.peerId = null;
        this.pendingDiff = null;
        this.cardIndex = [];
        this.hostToken = null;
        this.stubs.clear();
        this.ooc.onDisconnect();
        this.#setStatus('idle');
    }

    // =======================================================================
    // Transport plumbing
    // =======================================================================

    async #openSocket(url, psk, options) {
        const socket = new SecureSocket({ url, psk, ...options });
        this.socket = socket;

        socket.addEventListener('open', () => {
            this.#setStatus('verifying');
            this.#emit('log', { level: 'info', message: 'Secure channel established' });
        });
        socket.addEventListener('message', event => void this.#route(event.detail.payload));
        socket.addEventListener('rejected', event => this.#onRejected(event.detail));
        socket.addEventListener('close', event => {
            if (this.status === 'idle') return;
            this.#dehydrateAll();

            if (event.detail.wasOpen) {
                this.#setStatus('connecting');
                this.#emit('log', { level: 'warn', message: 'Connection lost — retrying' });
                return;
            }
            // Never reached OPEN: the dial failed. Retrying silently forever is
            // what produced "stuck on connecting" with nothing to act on.
            this.#reportUnreachable(event.detail, url);
        });

        // The transport emits this when the browser reports a socket error. It
        // used to go nowhere, so a failed connection produced no message at all.
        socket.addEventListener('transport-error', () => {
            this.#emit('log', { level: 'warn', message: `Could not reach ${url}` });
        });

        socket.addEventListener('error', event => {
            if (event.detail?.message) this.#emit('log', { level: 'error', message: event.detail.message });
        });
        socket.addEventListener('reconnect-scheduled', event => {
            this.#emit('log', { level: 'info', message: `Reconnecting in ${Math.round(event.detail.delay / 100) / 10}s (attempt ${event.detail.attempt})` });
        });

        await socket.connect();
    }

    /**
     * Explains a dial that never connected. The first couple of failures are
     * reported quietly, since a transient blip resolves itself; after that the
     * session moves to an error state with a checklist, because at that point it
     * is a configuration problem and no amount of waiting will fix it.
     */
    #reportUnreachable(detail, url) {
        const attempts = detail.failedDials ?? 1;

        if (detail.reachedHandshake) {
            this.#emit('log', { level: 'warn', message: 'Reached the host but the handshake did not finish — retrying' });
            return;
        }

        if (attempts < 3) {
            this.#setStatus('connecting');
            this.#emit('log', { level: 'warn', message: `Cannot reach the host yet (attempt ${attempts})` });
            return;
        }

        const host = this.target?.host ?? 'the host';
        const port = this.target?.port ?? '';
        const kind = this.target ? classifyAddress(this.target.host) : 'unknown';
        const isPrivate = kind === 'lan' || kind === 'loopback';

        const lines = [
            `Cannot reach ${host}:${port} after ${attempts} attempts. Nothing is answering, so this is a`,
            'network or address problem rather than a password or version problem.',
            '',
        ];

        if (isPrivate) {
            lines.push(
                `${host} is a local-network address. If you are not on the same Wi-Fi or LAN as the host,`,
                'it can never work — ask them for a code made with their public address or a tunnel',
                'address, which they can set in "Address players connect to" before hosting.',
                '',
            );
        }

        if (kind === 'tailnet') {
            lines.push(
                `${host} is a Tailscale-style address. Check that Tailscale is running on both`,
                'machines and that both show as connected in the same tailnet, then try again.',
                '',
            );
        }

        lines.push(
            'Ask the host to check, in order:',
            '  1. The room is still open — the panel should show a connection code.',
            '  2. Their firewall allows incoming connections to node.exe on this port.',
            '     On Windows this is the most common cause and it fails silently.',
            `  3. The code was made for an address you can actually reach (currently ${host}).`,
            '  4. If they are behind a router and you are not on their network, the port needs',
            '     forwarding or a tunnel such as Tailscale, WireGuard or Cloudflare Tunnel.',
        );

        this.#fail(lines.join('\n'));
        if (this.socket) this.socket.autoReconnect = false;
    }

    #onRejected({ reason, detail, data }) {
        const messages = {
            [REJECT_REASON.BAD_REVISION]: 'Protocol mismatch — the host is running a different version of the Multiplayer extension.',
            [REJECT_REASON.UNKNOWN_ROOM]: 'No room matches that connection code. It may have been rotated or the host may have stopped.',
            [REJECT_REASON.BAD_MAC]: 'Authentication failed. Check the code — if it is definitely correct, something on the network may be intercepting the connection.',
            [REJECT_REASON.RATE_LIMITED]: 'Too many attempts from this address. Wait a minute and try again.',
            [REJECT_REASON.ROOM_FULL]: 'That room is full.',
            [REJECT_REASON.BANNED]: 'The host has blocked this device.',
            [REJECT_REASON.TIMEOUT]: 'The handshake timed out.',
            [REJECT_REASON.PARITY_MISMATCH]: 'Your extensions do not match the host\'s.',
            [REJECT_REASON.SERVER_CLOSING]: 'The host closed the session.',
        };

        if (reason === REJECT_REASON.PARITY_MISMATCH && data) {
            this.pendingDiff = data;
            this.#setStatus('error');
            this.lastError = messages[reason];
            this.#emit('parity-mismatch', { diff: data, plan: buildSyncPlan(data, { removeExtras: false }) });
            return;
        }

        this.#fail(messages[reason] ?? detail ?? `Connection rejected (${reason})`);
    }

    // =======================================================================
    // Opcode routing
    // =======================================================================

    async #route(payload) {
        if (!payload || typeof payload.op !== 'string') return;

        switch (payload.op) {
            case OP.PING:
                this.socket?.send({ op: OP.PONG, t: payload.t });
                return;

            case OP.WELCOME:
                return this.#onWelcome(payload);

            case OP.ROSTER:
                this.peers = Array.isArray(payload.peers) ? payload.peers : [];
                this.#emit('roster', { peers: this.peers });
                return;

            case OP.PEER_JOIN:
                this.#emit('log', { level: 'info', message: `${payload.peer?.name ?? 'A player'} joined` });
                return;

            case OP.PEER_LEAVE:
                this.#emit('log', { level: 'info', message: `${payload.peer?.name ?? 'A player'} left` });
                return;

            case OP.KICK:
                this.#fail(payload.reason === 'host' ? 'The host removed you from the session.' : 'You were disconnected.');
                if (this.socket) this.socket.autoReconnect = false;
                await this.leave();
                return;

            case OP.PARITY_CHALLENGE:
                return this.#onParityChallenge(payload);

            case OP.PARITY_RESULT:
                return this.#onParityResult(payload);

            case OP.CARDS_INDEX:
                return this.#onCardIndex(payload);

            case OP.CARDS_WANT:
                return this.#onCardWant(payload);

            case OP.CARDS_AVATAR:
                return this.#onCardAvatar(payload);

            case OP.CARDS_DEFINITION:
                return this.#onCardDefinition(payload);

            case OP.CHAT_TURN:
                if (this.role === ROLE.HOST) {
                    const peer = this.peers.find(candidate => candidate.id === payload.from);
                    await this.chat.acceptRemoteTurn(payload, peer);
                }
                return;

            case OP.OOC_MESSAGE:
                return this.ooc.receive(payload);

            case OP.OOC_HISTORY:
                return this.ooc.receiveHistory(payload);

            case OP.OOC_TYPING:
                return this.ooc.receiveTyping(payload);

            case OP.CHAT_APPEND:
                if (this.role === ROLE.CLIENT) await this.chat.applyRemoteMessage(payload);
                return;

            case OP.CHAT_STATE:
                if (this.role === ROLE.CLIENT) await this.chat.applySnapshot(payload);
                return;

            case OP.CHAT_EDIT:
                if (this.role === ROLE.CLIENT) this.chat.applyRemoteEdit(payload);
                return;

            case OP.CHAT_DELETE:
                if (this.role === ROLE.CLIENT) this.chat.applyRemoteDelete(payload);
                return;

            case OP.GEN_TOKEN:
                if (this.role === ROLE.CLIENT) this.chat.applyStreamToken(payload);
                return;

            case OP.GEN_END:
            case OP.GEN_ABORT:
                if (this.role === ROLE.CLIENT) this.chat.endStream();
                return;

            case OP.ERROR:
                this.#emit('log', { level: 'error', message: String(payload.message ?? 'Relay error').slice(0, 300) });
                return;

            default:
                console.debug('[Multiplayer] Ignoring unknown opcode', payload.op);
        }
    }

    #onWelcome(payload) {
        this.peerId = payload.peerId;
        this.roomId = payload.roomId ?? this.roomId;
        this.hostName = payload.hostName ?? this.hostName;
        this.peers = payload.peers ?? [];
        this.socket?.send({
            op: OP.ROSTER,
            name: this.deps.getContext().substituteParams?.('{{user}}') || 'Player',
        });
        this.#emit('roster', { peers: this.peers });
    }

    // -- parity -------------------------------------------------------------

    async #onParityChallenge(payload) {
        const strictness = payload.strictness === 'commit' ? 'commit' : 'manifest';
        try {
            const report = await buildReport(this.deps.extensionApi, strictness);
            this.socket?.send({ op: OP.PARITY_REPORT, report });
        } catch (error) {
            this.#emit('log', { level: 'error', message: `Could not build the extension fingerprint: ${error.message}` });
            this.socket?.send({ op: OP.PARITY_REPORT, report: { strictness, hash: '', extensions: [] } });
        }
    }

    #onParityResult(payload) {
        if (payload.ok) {
            this.pendingDiff = null;
            this.#setStatus('connected');
            this.chat.attach();
            this.#emit('log', { level: 'success', message: 'Extension check passed' });
            if (this.role === ROLE.HOST) void this.publishCards();
            return;
        }

        this.pendingDiff = payload.diff;
        this.#setStatus('error');
        this.lastError = 'Your extensions do not match the host\'s.';
        this.#emit('parity-mismatch', {
            diff: payload.diff,
            plan: buildSyncPlan(payload.diff, { removeExtras: false }),
        });
    }

    /** Recomputes the local diff against the host's last published report. */
    syncPlan({ removeExtras = false } = {}) {
        if (!this.pendingDiff) return [];
        return buildSyncPlan(this.pendingDiff, { removeExtras });
    }

    // -- cards --------------------------------------------------------------

    async #onCardIndex(payload) {
        this.cardIndex = Array.isArray(payload.cards) ? payload.cards : [];
        this.hostName = payload.hostName ?? this.hostName;
        this.#emit('cards', { cards: this.cardIndex });

        if (this.role !== ROLE.CLIENT) return;

        const context = this.deps.getContext();
        let created = 0;

        for (const entry of this.cardIndex) {
            const existing = (context.characters ?? []).find(character => remoteCardId(character) === entry.cardId);
            if (existing) {
                this.stubs.set(entry.cardId, existing.avatar);
                continue;
            }
            try {
                const avatar = await materialiseStub(entry, {
                    roomId: this.roomId,
                    hostName: this.hostName,
                    getRequestHeaders: this.deps.getRequestHeaders,
                });
                this.stubs.set(entry.cardId, avatar);
                this.socket?.send({ op: OP.CARDS_WANT, cardId: entry.cardId, want: 'avatar' });
                created += 1;
            } catch (error) {
                this.#emit('log', { level: 'error', message: `Could not add "${entry.name}": ${error.message}` });
            }
        }

        if (created > 0) {
            await context.getCharacters?.();
            this.#emit('log', { level: 'success', message: `Added ${created} hosted character${created === 1 ? '' : 's'}` });
        }
        this.#emit('cards-materialised', { cards: this.cardIndex });
    }

    /** Host: a peer asked for an avatar or a definition. */
    async #onCardWant(payload) {
        if (this.role !== ROLE.HOST) return;

        // The relay asks the host to re-announce whenever someone new is seated.
        if (payload.want === 'republish') {
            await this.publishCards();
            this.socket?.send({
                op: OP.CHAT_STATE,
                messages: this.chat.snapshot(),
                to: payload.from,
            });
            return;
        }

        const entry = this.cardIndex.find(candidate => candidate.cardId === payload.cardId);
        if (!entry) return;

        if (payload.want === 'avatar') {
            try {
                const bytes = await readLocalAvatar(entry.avatar);
                for await (const chunk of streamAvatar(entry.cardId, bytes)) {
                    // Envelope the binary chunk as base64 inside a JSON frame so
                    // the routing layer stays uniform; the frame itself is still
                    // compressed and encrypted as one unit.
                    this.socket?.send({
                        op: OP.CARDS_AVATAR,
                        cardId: chunk.cardId,
                        seq: chunk.seq,
                        total: chunk.total,
                        bytes: toBase64(chunk.bytes),
                        to: payload.from,
                    });
                    if (this.socket.backlogBytes > 8 * 1024 * 1024) await this.socket.drain(15000);
                }
            } catch (error) {
                this.#emit('log', { level: 'error', message: `Avatar transfer failed: ${error.message}` });
            }
            return;
        }

        if (payload.want === 'definition') {
            const context = this.deps.getContext();
            const character = (context.characters ?? []).find(candidate => candidate.avatar === entry.avatar);
            if (!character) return;
            this.socket?.send({
                op: OP.CARDS_DEFINITION,
                cardId: entry.cardId,
                definition: extractDefinition(character),
                to: payload.from,
            });
        }
    }

    async #onCardAvatar(payload) {
        if (this.role !== ROLE.CLIENT) return;
        try {
            const complete = this.assembler.push({
                cardId: payload.cardId,
                seq: payload.seq,
                total: payload.total,
                bytes: fromBase64(payload.bytes),
            });
            if (!complete) return;

            const avatar = this.stubs.get(payload.cardId);
            if (!avatar) return;
            await applyStubAvatar(avatar, complete, { getRequestHeaders: this.deps.getRequestHeaders });
            await this.deps.getContext().getCharacters?.();
            this.#emit('cards-materialised', { cards: this.cardIndex });
        } catch (error) {
            this.#emit('log', { level: 'error', message: `Avatar transfer failed: ${error.message}` });
        }
    }

    #onCardDefinition(payload) {
        if (this.role !== ROLE.CLIENT) return;
        const avatar = this.stubs.get(payload.cardId);
        const context = this.deps.getContext();
        const character = (context.characters ?? []).find(candidate => candidate.avatar === avatar);
        if (!character) return;

        this.hydration.hydrate(character, payload.definition ?? {});
        this.#emit('card-hydrated', { cardId: payload.cardId, avatar });
    }

    /**
     * Called when the user opens a hosted card. Pulls the definition if it is
     * not already in memory for this session.
     */
    requestDefinition(cardId) {
        if (!this.connected || this.role !== ROLE.CLIENT) return false;
        this.socket?.send({ op: OP.CARDS_WANT, cardId, want: 'definition' });
        return true;
    }

    #dehydrateAll() {
        const context = this.deps.getContext();
        this.hydration.dehydrateAll(context.characters ?? []);
    }

    // =======================================================================

    #setStatus(status) {
        if (this.status === status) return;
        this.status = status;
        this.#emit('status', { status, role: this.role });
    }

    #fail(message) {
        this.lastError = message;
        this.#setStatus('error');
        this.#emit('log', { level: 'error', message });
    }

    #emit(type, detail) {
        this.dispatchEvent(new CustomEvent(type, { detail }));
    }
}

export { STATE };
