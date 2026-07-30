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
    resolveAdvertisement,
} from './protocol.js';
import { SecureSocket, STATE } from './transport.js';
import { fromBase64, toBase64 } from './crypto.js';
import { buildReport, buildSyncPlan, diffReports, enrichRemotes } from './parity.js';
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
        /**
         * The shared card this room is currently roleplaying in, or null.
         *
         * Everything chat-related is gated on this. Without it, the bridge
         * relayed whatever chat happened to be open, so a hosted character's
         * greeting could land in the assistant chat that opens on startup — and
         * a client's unrelated local roleplay would be broadcast to the room.
         */
        this.activeCardId = null;
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
            // Both conditions matter: connected, and looking at the shared chat.
            isActive: () => this.status === 'connected' && this.inSessionChat(),
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
        // One decision, made in one place, so hosting and rotation cannot drift.
        const advert = resolveAdvertisement({
            advertiseHost,
            advertisePort: settings.advertisePort,
            advertiseSecure: settings.advertiseSecure,
            bindLan,
            publicHost: started.publicHost,
            detectedHost: started.advertiseHost,
            listenPort: started.port,
        });

        if (advert.error) {
            await this.stopHosting().catch(() => {});
            this.#fail(advert.error);
            throw new Error(advert.error);
        }

        this.code = encodeConnectionCode({ host: advert.host, port: advert.port, psk, secure: advert.secure });
        this.codeUrl = connectionUrl(advert);
        this.codeHost = advert.host;
        this.addresses = started.addresses ?? [];
        this.portMapping = started.portMapping ?? null;

        for (const warning of advert.warnings) {
            this.#emit('log', { level: 'warn', message: warning });
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
        // Reuses the same resolver as startHosting. Previously this recomputed
        // the address itself and ignored the router-supplied public one, so
        // rotating a working code silently downgraded it to a LAN address.
        const rotated = resolveAdvertisement({
            advertiseHost: this.settings.advertiseHost,
            advertisePort: this.settings.advertisePort,
            advertiseSecure: this.settings.advertiseSecure,
            bindLan: this.settings.bindLan,
            publicHost: data.publicHost,
            detectedHost: data.advertiseHost,
            listenPort: data.port,
        });
        if (rotated.error) throw new Error(rotated.error);

        this.code = encodeConnectionCode({ host: rotated.host, port: rotated.port, psk, secure: rotated.secure });
        this.codeUrl = connectionUrl(rotated);
        this.codeHost = rotated.host;
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
        this.activeCardId = null;
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
    // Session scoping
    // =======================================================================

    /**
     * The shared card id for whatever character is currently open, or null.
     * The host matches by avatar against its own catalogue; a client reads the
     * marker its stub carries.
     */
    currentCardId() {
        const context = this.deps.getContext();
        const character = context.characters?.[context.characterId];
        if (!character) return null;

        if (this.role === ROLE.HOST) {
            return this.cardIndex.find(entry => entry.avatar === character.avatar)?.cardId ?? null;
        }
        return remoteCardId(character);
    }

    /** True when the open chat is the room's shared session. */
    inSessionChat() {
        return Boolean(this.activeCardId) && this.currentCardId() === this.activeCardId;
    }

    /**
     * Host: called when the open chat changes. Opening a shared character makes
     * it the room's session; opening anything else ends the session, so local
     * roleplay stays local.
     */
    announceSession() {
        if (this.role !== ROLE.HOST || !this.connected) return;

        const cardId = this.currentCardId();
        if (cardId === this.activeCardId) return;

        this.activeCardId = cardId;
        const entry = this.cardIndex.find(candidate => candidate.cardId === cardId);
        this.socket?.send({
            op: OP.SESSION_STATE,
            cardId,
            name: entry?.name ?? null,
            chatId: this.deps.getContext().getCurrentChatId?.() ?? null,
        });

        this.chat.reset();
        this.#emit('session', { cardId, name: entry?.name ?? null });
        this.#emit('log', {
            level: 'info',
            message: cardId
                ? `Room session is now "${entry?.name ?? 'shared character'}" — messages here are shared.`
                : 'Left the shared character. Messages here stay local to you.',
        });
    }

    /** Client: the host told us which card the room is in. */
    #onSessionState(payload) {
        this.activeCardId = payload.cardId ?? null;
        this.chat.reset();
        this.#emit('session', { cardId: this.activeCardId, name: payload.name ?? null });

        if (!this.activeCardId) {
            this.#emit('log', { level: 'info', message: 'The host is not in a shared character right now.' });
            return;
        }
        if (this.inSessionChat()) {
            this.requestSessionTranscript();
        } else {
            this.#emit('log', {
                level: 'info',
                message: `The room is roleplaying as "${payload.name ?? 'a shared character'}". `
                    + 'Open that character to take part — messages elsewhere stay local to you.',
            });
        }
    }

    /**
     * Publishes this peer's persona to the room. Called on admission and whenever
     * the local persona changes, so the roster stays truthful without anyone
     * having to send a message first.
     */
    async publishPersona() {
        if (!this.connected) return;
        try {
            const persona = await this.chat.describeLocalPersona();
            this.chat.rememberPersona(this.peerId ?? 'me', persona);
            this.socket?.send({ op: OP.PERSONA_STATE, persona });
            this.#emit('personas', { personas: this.personaList() });
        } catch (error) {
            this.#emit('log', { level: 'warn', message: `Could not publish your persona: ${error.message}` });
        }
    }

    /** Everyone's persona, newest first, for the profile panel. */
    personaList() {
        const byPeer = new Map(this.peers.map(peer => [peer.id, peer]));
        return [...this.chat.personas.values()].map(persona => ({
            ...persona,
            playerName: byPeer.get(persona.peerId)?.name ?? persona.name,
            role: byPeer.get(persona.peerId)?.role ?? 'client',
            isMe: persona.peerId === this.peerId,
        }));
    }

    /** Client: ask for the transcript, used on entering the session chat. */
    requestSessionTranscript() {
        if (this.role !== ROLE.CLIENT || !this.connected || !this.activeCardId) return;
        this.socket?.send({ op: OP.SESSION_JOIN, cardId: this.activeCardId });
    }

    /**
     * Called from the CHAT_CHANGED handler in both roles. The host announces,
     * the client checks whether it has just walked into the session.
     */
    onChatChanged() {
        if (!this.connected) return;
        if (this.role === ROLE.HOST) return this.announceSession();
        if (this.inSessionChat()) this.requestSessionTranscript();
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

            case OP.PERSONA_STATE: {
                const persona = payload.persona ?? null;
                if (persona) {
                    this.chat.rememberPersona(payload.from ?? payload.peerId ?? 'host', persona);
                    this.#emit('personas', { personas: this.personaList() });
                }
                return;
            }

            case OP.PARITY_CHALLENGE:
                return this.#onParityChallenge(payload);

            case OP.PARITY_RESULT:
                return this.#onParityResult(payload);

            case OP.PARITY_URLS_REQUEST:
                return this.#onParityUrlsRequest(payload);

            case OP.PARITY_URLS:
                return this.#onParityUrls(payload);

            case OP.CARDS_INDEX:
                return this.#onCardIndex(payload);

            case OP.CARDS_WANT:
                return this.#onCardWant(payload);

            case OP.CARDS_AVATAR:
                return this.#onCardAvatar(payload);

            case OP.CARDS_DEFINITION:
                return this.#onCardDefinition(payload);

            case OP.CHAT_TURN:
                if (this.role === ROLE.HOST && this.inSessionChat()) {
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

            case OP.SESSION_STATE:
                if (this.role === ROLE.CLIENT) this.#onSessionState(payload);
                return;

            case OP.SESSION_JOIN:
                // Host: a client just opened the shared chat and wants the
                // transcript. Only answer for the card the room is actually in.
                if (this.role === ROLE.HOST && payload.cardId === this.activeCardId) {
                    this.socket?.send({
                        op: OP.CHAT_STATE,
                        cardId: this.activeCardId,
                        messages: this.chat.snapshot(),
                        to: payload.from,
                    });
                }
                return;

            case OP.CHAT_APPEND:
                // Refusing when the open chat is not the session is the whole
                // point: this is what stopped a hosted greeting from being
                // written into an unrelated chat.
                if (this.role === ROLE.CLIENT && this.inSessionChat()) {
                    await this.chat.applyRemoteMessage(payload);
                }
                return;

            case OP.CHAT_STATE:
                if (this.role === ROLE.CLIENT && this.inSessionChat()) await this.chat.applySnapshot(payload);
                return;

            case OP.CHAT_EDIT:
                // Edits and deletes travel both ways so every player can correct
                // the transcript, but only ever inside the session chat.
                if (this.inSessionChat()) {
                    this.chat.applyRemoteEdit(payload);
                    if (this.role === ROLE.HOST) this.socket?.send({ ...payload, from: undefined });
                }
                return;

            case OP.CHAT_DELETE:
                if (this.inSessionChat()) {
                    this.chat.applyRemoteDelete(payload);
                    if (this.role === ROLE.HOST) this.socket?.send({ ...payload, from: undefined });
                }
                return;

            case OP.GEN_TOKEN:
                if (this.role === ROLE.CLIENT && this.inSessionChat()) this.chat.applyStreamToken(payload);
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
            void this.publishPersona();
            if (this.role === ROLE.HOST) {
                void this.publishCards();
                this.announceSession();
            }
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

    /**
     * Host: somebody pressed Sync and needs real install URLs. This runs a git
     * lookup per extension, which is why it is on demand rather than part of the
     * handshake — it would otherwise add seconds to every join.
     */
    async #onParityUrlsRequest(payload) {
        if (this.role !== ROLE.HOST) return;
        let urls = {};
        try {
            urls = await enrichRemotes(this.deps.extensionApi, Array.isArray(payload.ids) ? payload.ids.slice(0, 200) : []);
        } catch (error) {
            this.#emit('log', { level: 'warn', message: `Could not read git remotes: ${error.message}` });
        }
        this.socket?.send({ op: OP.PARITY_URLS, urls, to: payload.from });
    }

    /** Client: merge the host's answer into the stored diff. */
    #onParityUrls(payload) {
        const urls = payload?.urls ?? {};
        this._urlWaiters?.forEach(resolve => resolve(urls));
        this._urlWaiters = [];

        if (!this.pendingDiff) return;
        for (const bucket of ['missing', 'mismatched']) {
            for (const entry of this.pendingDiff[bucket] ?? []) {
                const found = urls[entry.id];
                if (!found) continue;
                if (found.remoteUrl) entry.remoteUrl = found.remoteUrl;
                if (found.branch) entry.branch = found.branch;
            }
        }
    }

    /**
     * Asks the host for install URLs for everything the plan could not resolve.
     * Resolves either way — a timeout just means the plan keeps whatever URLs it
     * already had, and unresolvable entries become manual steps.
     */
    async requestSyncUrls(timeoutMs = 30000) {
        if (!this.connected || this.role !== ROLE.CLIENT || !this.pendingDiff) return {};

        const ids = [...(this.pendingDiff.missing ?? []), ...(this.pendingDiff.mismatched ?? [])]
            .map(entry => entry.id)
            .filter(Boolean);
        if (ids.length === 0) return {};

        this._urlWaiters ??= [];
        const answered = new Promise(resolve => {
            this._urlWaiters.push(resolve);
            setTimeout(() => resolve({}), timeoutMs);
        });

        this.socket?.send({ op: OP.PARITY_URLS_REQUEST, ids });
        return answered;
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

        // Pull every definition now rather than waiting for a click. A card with
        // no description, no greeting and no lorebook is not usable, and the
        // fields were the reported symptom. Still session-only: held in memory
        // and wiped on disconnect, never written to the client's disk.
        for (const entry of this.cardIndex) {
            this.socket?.send({ op: OP.CARDS_WANT, cardId: entry.cardId, want: 'definition' });
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

        // If this is the card on screen, re-render so the fields appear without
        // the user having to reselect it.
        if (String(context.characterId) !== '' && context.characters?.[context.characterId]?.avatar === avatar) {
            context.eventSource?.emit?.(context.eventTypes.CHARACTER_EDITED, { detail: { id: context.characterId, character } });
        }
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
