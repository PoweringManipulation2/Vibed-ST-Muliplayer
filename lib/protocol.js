/**
 * SillyTavern-Multiplayer — wire protocol definition.
 *
 * ============================ KEEP IN SYNC ============================
 * This file is mirrored by `server/lib/protocol.js`. Any change to
 * PROTOCOL_REVISION, the frame layout, the KDF labels or the opcode table
 * MUST be applied to both copies. Both peers exchange PROTOCOL_REVISION
 * during the handshake and refuse to continue on mismatch, so a desync
 * fails closed (connection refused) rather than silently corrupting state.
 * =====================================================================
 */

/** Bumped whenever anything below changes in a non-backwards-compatible way. */
export const PROTOCOL_REVISION = 'STMP/1.0.0';

/** Plugin id — must match `info.id` in server/index.js and /^[a-z0-9_-]+$/. */
export const PLUGIN_ID = 'st-multiplayer';

/** Base path for the host-side control API, mounted by SillyTavern's plugin loader. */
export const PLUGIN_API = `/api/plugins/${PLUGIN_ID}`;

/**
 * Fallback only. SillyTavern addresses an extension by its *folder* name, which
 * is derived from the repository name at install time — so the real value is not
 * knowable when this file is written. A fork, a rename, or ST's own filename
 * sanitising all change it. Use {@link parseExtensionFolder} instead; this
 * constant exists purely so there is something sane to fall back to.
 */
export const EXTENSION_NAME = 'third-party/SillyTavern-Multiplayer';

/**
 * Recovers the extension's real folder name from the URL its own module was
 * loaded from, e.g.
 *
 *   http://127.0.0.1:8000/scripts/extensions/third-party/My-Fork/index.js
 *      -> "third-party/My-Fork"
 *
 * Both install layouts (per-user `data/<user>/extensions/…` and global
 * `public/scripts/extensions/third-party/…`) are served under the same URL
 * prefix, so one pattern covers both. Getting this wrong is quiet and
 * confusing: the extension loads, then `settings.html` 404s and no panel ever
 * appears, with nothing obviously broken in the console.
 *
 * @param {string} moduleUrl typically `import.meta.url`
 * @param {string} [fallback]
 * @returns {string} folder name including the `third-party/` prefix
 */
export function parseExtensionFolder(moduleUrl, fallback = EXTENSION_NAME) {
    const match = /\/scripts\/extensions\/(third-party\/[^/?#]+)\//.exec(String(moduleUrl ?? ''));
    if (!match) return fallback;
    try {
        return `third-party/${decodeURIComponent(match[1].slice('third-party/'.length))}`;
    } catch {
        return match[1];
    }
}

/** Key used inside `extension_settings`. */
export const SETTINGS_KEY = 'multiplayer';

// ---------------------------------------------------------------------------
// Binary frame layout (post-handshake traffic, sent as WebSocket binary frames)
// ---------------------------------------------------------------------------
//
//   offset  size  field
//   ------  ----  ---------------------------------------------------------
//   0       1     frame version (FRAME_VERSION)
//   1       1     flags (see FLAG_*)
//   2       8     counter, uint64 big-endian, strictly increasing per direction
//   10      ..    AES-256-GCM ciphertext with a trailing 16-byte auth tag
//
// The 10-byte header is authenticated as AAD but never encrypted, so a peer can
// reject a replayed / out-of-window counter before doing any crypto work.
// The GCM nonce is `directionSalt(4) || counter(8)`; because the counter never
// repeats within a session and each direction has its own key + salt, no
// (key, nonce) pair is ever reused.

export const FRAME_VERSION = 0x01;
export const HEADER_SIZE = 10;

/** Payload was deflate-raw compressed before encryption. */
export const FLAG_COMPRESSED = 0x01;
/** Payload is an opaque byte blob rather than UTF-8 JSON. */
export const FLAG_BINARY = 0x02;

// ---------------------------------------------------------------------------
// Key derivation labels — byte-for-byte identical on both sides
// ---------------------------------------------------------------------------

export const LABEL_TRANSCRIPT = 'STMP/1 handshake';
export const LABEL_KEYS = 'STMP/1 keys';
export const LABEL_ROOM_ID = 'STMP/1 room-id';
export const CONFIRM_CLIENT = 'client';
export const CONFIRM_SERVER = 'server';

/**
 * Single HKDF-SHA256 expansion, sliced into every secret the session needs.
 * Layout (byte offsets into the 104-byte output):
 *   0..32    key,  client -> server
 *   32..64   key,  server -> client
 *   64..68   nonce salt, client -> server
 *   68..72   nonce salt, server -> client
 *   72..104  confirmation MAC key
 */
export const KDF_LENGTH = 104;
export const KDF_SLICES = Object.freeze({
    keyC2S: [0, 32],
    keyS2C: [32, 64],
    saltC2S: [64, 68],
    saltS2C: [68, 72],
    confirm: [72, 104],
});

export const NONCE_LENGTH = 12;
export const PSK_LENGTH = 16;
export const HANDSHAKE_NONCE_LENGTH = 16;
export const ROOM_ID_LENGTH = 8;

// ---------------------------------------------------------------------------
// Handshake (plaintext JSON, sent as WebSocket *text* frames)
// ---------------------------------------------------------------------------

export const HS = Object.freeze({
    HELLO: 'hello',       // client -> server: revision, ephemeral pubkey, nonce, roomId
    CHALLENGE: 'challenge', // server -> client: ephemeral pubkey, nonce
    CONFIRM: 'confirm',   // client -> server: HMAC proving PSK knowledge
    ACCEPTED: 'accepted', // server -> client: HMAC proving PSK knowledge
    REJECT: 'reject',     // either direction: fatal, with a reason code
});

export const REJECT_REASON = Object.freeze({
    BAD_REVISION: 'bad_revision',
    UNKNOWN_ROOM: 'unknown_room',
    BAD_MAC: 'bad_mac',
    RATE_LIMITED: 'rate_limited',
    ROOM_FULL: 'room_full',
    BANNED: 'banned',
    TIMEOUT: 'timeout',
    MALFORMED: 'malformed',
    PARITY_MISMATCH: 'parity_mismatch',
    SERVER_CLOSING: 'server_closing',
});

// ---------------------------------------------------------------------------
// Application opcodes (encrypted JSON payloads: { op, ...fields })
// ---------------------------------------------------------------------------

export const OP = Object.freeze({
    // session lifecycle
    WELCOME: 'welcome',           // relay -> peer: your peerId, room settings, roster
    ROSTER: 'roster',             // relay -> all: full roster after any change
    PEER_JOIN: 'peer.join',
    PEER_LEAVE: 'peer.leave',
    KICK: 'peer.kick',            // relay -> peer: you are being removed
    PING: 'ping',
    PONG: 'pong',

    // extension parity
    PARITY_CHALLENGE: 'parity.challenge', // relay -> peer: send me your fingerprint
    PARITY_REPORT: 'parity.report',       // peer -> relay: fingerprint + manifest
    PARITY_RESULT: 'parity.result',       // relay -> peer: ok / diff to reconcile

    // shared character cards
    CARDS_INDEX: 'cards.index',           // host -> peers: catalogue of shared cards
    CARDS_WANT: 'cards.want',             // peer -> host: send me avatar/definition
    CARDS_AVATAR: 'cards.avatar',         // host -> peer: avatar bytes (binary frame)
    CARDS_DEFINITION: 'cards.definition', // host -> peer: session-only card body

    // chat
    CHAT_STATE: 'chat.state',     // host -> peers: authoritative chat snapshot
    CHAT_APPEND: 'chat.append',   // host -> peers: one new message
    CHAT_TURN: 'chat.turn',       // peer -> host: I want to say this
    CHAT_TYPING: 'chat.typing',

    // Out-of-character side channel. These payloads are deliberately never
    // written into SillyTavern's `chat` array, so nothing here can reach a
    // prompt, a token count, or the context window.
    OOC_MESSAGE: 'ooc.message',
    OOC_HISTORY: 'ooc.history',
    OOC_TYPING: 'ooc.typing',
    CHAT_EDIT: 'chat.edit',
    CHAT_DELETE: 'chat.delete',

    // generation relayed from the host's API connection
    GEN_START: 'gen.start',
    GEN_TOKEN: 'gen.token',
    GEN_END: 'gen.end',
    GEN_ABORT: 'gen.abort',

    ERROR: 'error',
});

/** Peer roles. Exactly one HOST per room. */
export const ROLE = Object.freeze({ HOST: 'host', CLIENT: 'client' });

// ---------------------------------------------------------------------------
// Defaults / hard limits. The relay enforces these server-side; the client
// mirrors them so it can fail fast instead of getting disconnected.
// ---------------------------------------------------------------------------

export const LIMITS = Object.freeze({
    /** Largest single decrypted payload. Avatars are chunked below this. */
    MAX_FRAME_BYTES: 4 * 1024 * 1024,
    /** Payloads above this are deflate-raw compressed before encryption. */
    COMPRESS_THRESHOLD: 1024,
    /** Binary asset chunk size. Keeps memory flat on both ends. */
    CHUNK_BYTES: 256 * 1024,
    /** Handshake must complete within this window or the socket is destroyed. */
    HANDSHAKE_TIMEOUT_MS: 8000,
    /** Application-level heartbeat. */
    PING_INTERVAL_MS: 15000,
    PING_TIMEOUT_MS: 45000,
    /** Token-bucket message rate per peer. */
    RATE_MESSAGES: 60,
    RATE_WINDOW_MS: 10000,
    /** Token-bucket bytes per peer. */
    RATE_BYTES: 8 * 1024 * 1024,
    /** Concurrent peers per room, host included. */
    MAX_PEERS: 8,
    /** Unauthenticated sockets allowed to be mid-handshake at once. */
    MAX_PENDING: 16,
    /** Failed handshakes from one IP before it is temporarily blocked. */
    MAX_HANDSHAKE_FAILURES: 5,
    HANDSHAKE_BLOCK_MS: 60000,
    /** Replay window: how far out of order a counter may arrive. */
    COUNTER_WINDOW: 64,
});

export const DEFAULT_PORT = 8899;

/** Caps for the out-of-character channel. Enforced by the relay too. */
export const OOC = Object.freeze({
    /** Longest single OOC message. */
    MAX_LENGTH: 2000,
    /** How many messages the relay keeps to replay to people who join late. */
    HISTORY: 200,
    /** How many the panel renders before trimming the oldest from the DOM. */
    RENDER_LIMIT: 300,
    /** Typing notices are throttled to at most one per this interval. */
    TYPING_INTERVAL_MS: 2500,
    TYPING_EXPIRY_MS: 6000,
});

// ---------------------------------------------------------------------------
// Connection code (Crockford base32, ambiguity-free alphabet)
// ---------------------------------------------------------------------------

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CROCKFORD_MAP = (() => {
    const m = new Map();
    for (let i = 0; i < CROCKFORD.length; i++) m.set(CROCKFORD[i], i);
    // Human-friendly aliases: O->0, I/L->1.
    m.set('O', 0); m.set('I', 1); m.set('L', 1);
    return m;
})();

export const CODE_PREFIX = 'STMP1';
const ADDR_IPV4 = 0x01;
const ADDR_HOST = 0x02;

function crc16(bytes) {
    let crc = 0xffff;
    for (const b of bytes) {
        crc ^= b << 8;
        for (let i = 0; i < 8; i++) {
            crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
        }
    }
    return crc;
}

function base32Encode(bytes) {
    let out = '', buffer = 0, bits = 0;
    for (const b of bytes) {
        buffer = (buffer << 8) | b;
        bits += 8;
        while (bits >= 5) {
            out += CROCKFORD[(buffer >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += CROCKFORD[(buffer << (5 - bits)) & 31];
    return out;
}

function base32Decode(text) {
    let buffer = 0, bits = 0;
    const out = [];
    for (const ch of text) {
        const v = CROCKFORD_MAP.get(ch);
        if (v === undefined) throw new Error(`Invalid character "${ch}" in connection code`);
        buffer = (buffer << 5) | v;
        bits += 5;
        if (bits >= 8) {
            out.push((buffer >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Uint8Array.from(out);
}

/**
 * Pack host address + pre-shared key into a short, typo-resistant code.
 * @param {{host: string, port: number, psk: Uint8Array}} params
 * @returns {string} e.g. "STMP1-4T2M9-KX0BW-..."
 */
export function encodeConnectionCode({ host, port, psk }) {
    if (!(psk instanceof Uint8Array) || psk.length !== PSK_LENGTH) {
        throw new Error(`psk must be ${PSK_LENGTH} bytes`);
    }
    const body = [];
    const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (ipv4) {
        const octets = ipv4.slice(1).map(Number);
        if (octets.some(o => o > 255)) throw new Error('Invalid IPv4 address');
        body.push(ADDR_IPV4, ...octets);
    } else {
        const encoded = new TextEncoder().encode(host);
        if (encoded.length > 255) throw new Error('Host name too long');
        body.push(ADDR_HOST, encoded.length, ...encoded);
    }
    body.push((port >>> 8) & 0xff, port & 0xff, ...psk);

    const payload = Uint8Array.from(body);
    const sum = crc16(payload);
    const full = Uint8Array.from([...payload, (sum >>> 8) & 0xff, sum & 0xff]);

    const raw = base32Encode(full);
    const groups = raw.match(/.{1,5}/g) ?? [];
    return `${CODE_PREFIX}-${groups.join('-')}`;
}

/**
 * Inverse of {@link encodeConnectionCode}. Tolerates lowercase, spaces and
 * missing dashes so people can paste codes out of chat apps.
 * @param {string} code
 * @returns {{host: string, port: number, psk: Uint8Array}}
 */
export function decodeConnectionCode(code) {
    const cleaned = String(code ?? '').toUpperCase().replace(/[\s-]/g, '');
    if (!cleaned.startsWith(CODE_PREFIX)) throw new Error('Not a Multiplayer connection code');

    const full = base32Decode(cleaned.slice(CODE_PREFIX.length));
    if (full.length < 4) throw new Error('Connection code is truncated');

    const payload = full.subarray(0, full.length - 2);
    const expected = (full[full.length - 2] << 8) | full[full.length - 1];
    if (crc16(payload) !== expected) throw new Error('Connection code failed its checksum — check for typos');

    let offset = 0;
    const kind = payload[offset++];
    let host;
    if (kind === ADDR_IPV4) {
        host = Array.from(payload.subarray(offset, offset + 4)).join('.');
        offset += 4;
    } else if (kind === ADDR_HOST) {
        const len = payload[offset++];
        host = new TextDecoder().decode(payload.subarray(offset, offset + len));
        offset += len;
    } else {
        throw new Error('Unsupported address type in connection code');
    }

    const port = (payload[offset] << 8) | payload[offset + 1];
    offset += 2;

    const psk = payload.subarray(offset, offset + PSK_LENGTH);
    if (psk.length !== PSK_LENGTH) throw new Error('Connection code is truncated');

    return { host, port, psk: new Uint8Array(psk) };
}
