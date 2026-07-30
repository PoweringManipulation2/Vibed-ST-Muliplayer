/**
 * Authenticated, encrypted WebSocket transport.
 *
 * The same class is used by the host's browser (connecting to its own relay on
 * loopback) and by every joining client, so there is exactly one handshake
 * implementation to audit. The relay is always the "server" side of the key
 * schedule; this class is always the "client" side.
 */

import {
    HS, LIMITS, PROTOCOL_REVISION, REJECT_REASON,
} from './protocol.js';
import {
    ReplayWindow, computeConfirmation, confirmationLabels, deriveRoomId,
    deriveSessionKeys, fromBase64, generateEphemeralKeyPair, openFrame,
    randomBytes, sealFrame, timingSafeEqual, toBase64,
} from './crypto.js';

export const STATE = Object.freeze({
    IDLE: 'idle',
    CONNECTING: 'connecting',
    HANDSHAKING: 'handshaking',
    OPEN: 'open',
    CLOSING: 'closing',
    CLOSED: 'closed',
});

/** Reject reasons where retrying would just fail again the same way. */
const FATAL_REASONS = new Set([
    REJECT_REASON.BAD_REVISION,
    REJECT_REASON.BAD_MAC,
    REJECT_REASON.BANNED,
    REJECT_REASON.PARITY_MISMATCH,
]);

export class SecureSocket extends EventTarget {
    /**
     * @param {object} options
     * @param {string} options.url        ws:// or wss:// endpoint
     * @param {Uint8Array} options.psk    16-byte pre-shared key from the connection code
     * @param {string} [options.hostToken] base64 token minted by the relay's
     *   /start endpoint. Only the host has one, and the relay additionally
     *   requires the connection to arrive over loopback before honouring it,
     *   so the token is never exposed to the network.
     * @param {boolean} [options.autoReconnect]
     */
    constructor({ url, psk, hostToken = null, autoReconnect = true }) {
        super();
        this.url = url;
        this.psk = psk;
        this.hostToken = hostToken;
        this.autoReconnect = autoReconnect;

        this.state = STATE.IDLE;
        this.peerId = null;
        this.rtt = null;

        /** @type {WebSocket|null} */
        this.socket = null;
        this.keys = null;
        this.sendCounter = 0n;
        this.replay = new ReplayWindow();

        this.attempts = 0;
        /** Consecutive attempts where the socket never reached OPEN. */
        this.failedDials = 0;
        this.everOpened = false;
        this.closedByUs = false;
        this.lastPongAt = 0;
        /** Serialises inbound frames so they are applied in arrival order. */
        this._receiveChain = Promise.resolve();

        this._reconnectTimer = null;
        this._heartbeatTimer = null;
        this._handshakeTimer = null;
        /** Serialises sends so counters are consumed in the order frames go out. */
        this._sendChain = Promise.resolve();
    }

    // -- lifecycle ----------------------------------------------------------

    async connect() {
        if (this.state === STATE.CONNECTING || this.state === STATE.HANDSHAKING || this.state === STATE.OPEN) return;
        this.closedByUs = false;
        this.#setState(STATE.CONNECTING);

        let socket;
        try {
            socket = new WebSocket(this.url);
        } catch (error) {
            this.#fail(`Could not open a socket to ${this.url}`, error);
            return;
        }

        socket.binaryType = 'arraybuffer';
        this.socket = socket;
        this._receiveChain = Promise.resolve();

        socket.addEventListener('open', () => void this.#startHandshake());
        // Handling a frame is asynchronous (key derivation, AES-GCM, inflate),
        // so frames must be chained rather than fired in parallel. Without this
        // the relay's WELCOME can be processed before the ACCEPTED that
        // installs the session keys, and a valid session dies on arrival.
        socket.addEventListener('message', event => {
            this._receiveChain = this._receiveChain
                .then(() => this.#onMessage(event))
                .catch(() => { /* #onMessage already reported and closed */ });
        });
        socket.addEventListener('error', () => this.#emit('transport-error', { url: this.url }));
        socket.addEventListener('close', event => this.#onClose(event));
    }

    close(reason = 'client closed') {
        this.closedByUs = true;
        this.autoReconnect = false;
        clearTimeout(this._reconnectTimer);
        clearInterval(this._heartbeatTimer);
        clearTimeout(this._handshakeTimer);
        if (this.socket && this.socket.readyState <= WebSocket.OPEN) {
            this.#setState(STATE.CLOSING);
            try { this.socket.close(1000, reason.slice(0, 120)); } catch { /* already gone */ }
        }
        this.#teardown();
        this.#setState(STATE.CLOSED);
    }

    // -- handshake ----------------------------------------------------------

    async #startHandshake() {
        this.#setState(STATE.HANDSHAKING);
        clearTimeout(this._handshakeTimer);
        this._handshakeTimer = setTimeout(() => {
            this.#emit('rejected', { reason: REJECT_REASON.TIMEOUT });
            try { this.socket?.close(4408, 'handshake timeout'); } catch { /* ignore */ }
        }, LIMITS.HANDSHAKE_TIMEOUT_MS);

        try {
            const { privateKey, publicKeyRaw } = await generateEphemeralKeyPair();
            const nonce = randomBytes(16);
            const roomId = await deriveRoomId(this.psk);

            this._pending = { privateKey, publicKeyRaw, nonce };

            const hello = {
                t: HS.HELLO,
                revision: PROTOCOL_REVISION,
                pub: toBase64(publicKeyRaw),
                nonce: toBase64(nonce),
                room: toBase64(roomId),
            };
            if (this.hostToken) hello.token = this.hostToken;
            this.#sendJson(hello);
        } catch (error) {
            this.#fail('Failed to start the secure handshake', error);
        }
    }

    async #handleChallenge(message) {
        const { privateKey, publicKeyRaw, nonce } = this._pending ?? {};
        if (!privateKey) throw new Error('Received a challenge before sending hello');

        const peerPublicRaw = fromBase64(message.pub);
        const peerNonce = fromBase64(message.nonce);
        if (peerPublicRaw.length !== 65 || peerNonce.length !== 16) throw new Error('Malformed challenge');

        const { keys, transcriptHash } = await deriveSessionKeys({
            privateKey,
            ownPublicRaw: publicKeyRaw,
            peerPublicRaw,
            ownNonce: nonce,
            peerNonce,
            psk: this.psk,
            isClient: true,
        });

        this._pendingKeys = { keys, transcriptHash };

        const mac = await computeConfirmation(keys.confirmKey, transcriptHash, confirmationLabels.client);
        this.#sendJson({ t: HS.CONFIRM, mac: toBase64(mac) });
    }

    async #handleAccepted(message) {
        const pending = this._pendingKeys;
        if (!pending) throw new Error('Unexpected acceptance');

        const expected = await computeConfirmation(pending.keys.confirmKey, pending.transcriptHash, confirmationLabels.server);
        if (!timingSafeEqual(expected, fromBase64(message.mac))) {
            // The relay could not prove it knows the pre-shared key: either the
            // code is wrong or something is sitting in the middle of the path.
            throw new Error('Relay failed authentication — the connection code may be wrong or the connection is being intercepted');
        }

        clearTimeout(this._handshakeTimer);
        this.everOpened = true;
        this.failedDials = 0;
        this.keys = pending.keys;
        this.sendCounter = 0n;
        this.replay = new ReplayWindow();
        this._pending = null;
        this._pendingKeys = null;
        this.attempts = 0;
        this.lastPongAt = Date.now();

        this.#setState(STATE.OPEN);
        this.#startHeartbeat();
        this.#emit('open', {});
    }

    // -- messaging ----------------------------------------------------------

    #sendJson(object) {
        if (this.socket?.readyState !== WebSocket.OPEN) return;
        this.socket.send(JSON.stringify(object));
    }

    /**
     * Encrypts and queues one application payload.
     * Sends are chained so counters are allocated and written in the same order
     * even though sealing is asynchronous.
     * @param {object|Uint8Array} payload
     */
    send(payload) {
        this._sendChain = this._sendChain.then(async () => {
            if (this.state !== STATE.OPEN || !this.keys) return;
            try {
                const counter = ++this.sendCounter;
                const frame = await sealFrame(this.keys, counter, payload);
                if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(frame);
            } catch (error) {
                this.#emit('error', { error, message: 'Failed to encrypt an outgoing frame' });
            }
        }).catch(() => { /* keep the chain alive */ });
        return this._sendChain;
    }

    /** Resolves once queued frames have drained out of the socket buffer. */
    async drain(timeoutMs = 30000) {
        await this._sendChain;
        const deadline = Date.now() + timeoutMs;
        while (this.socket && this.socket.bufferedAmount > 0 && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 25));
        }
    }

    get backlogBytes() {
        return this.socket?.bufferedAmount ?? 0;
    }

    async #onMessage(event) {
        try {
            if (typeof event.data === 'string') {
                const message = JSON.parse(event.data);
                switch (message.t) {
                    case HS.CHALLENGE: return await this.#handleChallenge(message);
                    case HS.ACCEPTED: return await this.#handleAccepted(message);
                    case HS.REJECT: return this.#onReject(message);
                    default: throw new Error(`Unexpected handshake message "${message.t}"`);
                }
            }

            if (this.state !== STATE.OPEN || !this.keys) throw new Error('Received data before the session was established');

            const { counter, payload } = await openFrame(this.keys, event.data);
            if (!this.replay.accept(counter)) throw new Error('Replayed or out-of-window frame rejected');

            if (payload?.op === 'pong') {
                this.rtt = Date.now() - Number(payload.t ?? Date.now());
                this.lastPongAt = Date.now();
                return;
            }
            this.#emit('message', { payload });
        } catch (error) {
            // Any decryption/parse failure means the stream is no longer
            // trustworthy. Drop it rather than trying to resynchronise.
            this.#fail(error.message ?? 'Malformed frame', error);
            try { this.socket?.close(4400, 'protocol error'); } catch { /* ignore */ }
        }
    }

    #onReject(message) {
        clearTimeout(this._handshakeTimer);
        const reason = message.reason ?? REJECT_REASON.MALFORMED;
        if (FATAL_REASONS.has(reason)) this.autoReconnect = false;
        this.#emit('rejected', { reason, detail: message.detail, data: message.data });
    }

    // -- heartbeat & reconnect ---------------------------------------------

    #startHeartbeat() {
        clearInterval(this._heartbeatTimer);
        this._heartbeatTimer = setInterval(() => {
            if (this.state !== STATE.OPEN) return;
            if (Date.now() - this.lastPongAt > LIMITS.PING_TIMEOUT_MS) {
                this.#emit('error', { message: 'The peer stopped responding' });
                try { this.socket?.close(4408, 'heartbeat timeout'); } catch { /* ignore */ }
                return;
            }
            void this.send({ op: 'ping', t: Date.now() });
        }, LIMITS.PING_INTERVAL_MS);
    }

    #onClose(event) {
        this.#teardown();
        const wasOpen = this.state === STATE.OPEN;
        // A close without ever reaching OPEN means the TCP/WebSocket dial itself
        // failed — nothing was reachable. That is a different problem from a
        // dropped session and needs a different message.
        const reachedHandshake = this.state === STATE.HANDSHAKING;
        if (!wasOpen) this.failedDials += 1;

        this.#setState(STATE.CLOSED);
        this.#emit('close', {
            code: event.code,
            reason: event.reason,
            wasOpen,
            reachedHandshake,
            failedDials: this.failedDials,
            everOpened: this.everOpened,
        });

        if (this.closedByUs || !this.autoReconnect) return;

        // Full jitter exponential backoff, capped at 30s.
        this.attempts += 1;
        const ceiling = Math.min(30000, 500 * 2 ** Math.min(this.attempts, 6));
        const delay = Math.floor(Math.random() * ceiling);
        this.#emit('reconnect-scheduled', { attempt: this.attempts, delay });
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = setTimeout(() => void this.connect(), delay);
    }

    #teardown() {
        clearInterval(this._heartbeatTimer);
        clearTimeout(this._handshakeTimer);
        this.keys = null;
        this._pending = null;
        this._pendingKeys = null;
        this.socket = null;
    }

    #fail(message, error) {
        console.warn('[Multiplayer]', message, error ?? '');
        this.#emit('error', { message, error });
    }

    #setState(state) {
        if (this.state === state) return;
        this.state = state;
        this.#emit('state', { state });
    }

    #emit(type, detail) {
        this.dispatchEvent(new CustomEvent(type, { detail }));
    }
}
