/**
 * Server-side mirror of ../../lib/protocol.js.
 *
 * ============================ KEEP IN SYNC ============================
 * Both files must agree byte-for-byte on PROTOCOL_REVISION, the frame
 * layout, the KDF labels and the opcode table. PROTOCOL_REVISION is
 * checked during the handshake, so a desync fails closed.
 * =====================================================================
 */

export const PROTOCOL_REVISION = 'STMP/1.2.0';

export const FRAME_VERSION = 0x01;
export const HEADER_SIZE = 10;
export const FLAG_COMPRESSED = 0x01;
export const FLAG_BINARY = 0x02;

export const LABEL_TRANSCRIPT = 'STMP/1 handshake';
export const LABEL_KEYS = 'STMP/1 keys';
export const LABEL_ROOM_ID = 'STMP/1 room-id';
export const CONFIRM_CLIENT = 'client';
export const CONFIRM_SERVER = 'server';

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

export const HS = Object.freeze({
    HELLO: 'hello',
    CHALLENGE: 'challenge',
    CONFIRM: 'confirm',
    ACCEPTED: 'accepted',
    REJECT: 'reject',
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

export const OP = Object.freeze({
    WELCOME: 'welcome',
    ROSTER: 'roster',
    PEER_JOIN: 'peer.join',
    PEER_LEAVE: 'peer.leave',
    KICK: 'peer.kick',
    PING: 'ping',
    PONG: 'pong',

    PARITY_CHALLENGE: 'parity.challenge',
    PARITY_REPORT: 'parity.report',
    PARITY_RESULT: 'parity.result',
    /** Client -> host: read the real git remotes for these extensions. */
    PARITY_URLS_REQUEST: 'parity.urls.request',
    /** Host -> client: the answer. Only issued when someone presses Sync. */
    PARITY_URLS: 'parity.urls',

    CARDS_INDEX: 'cards.index',
    CARDS_WANT: 'cards.want',
    CARDS_AVATAR: 'cards.avatar',
    CARDS_DEFINITION: 'cards.definition',

    /**
     * Host -> peers: which shared card this room is roleplaying in. Chat traffic
     * is confined to that card's chat, so a message can never land in an
     * unrelated chat such as the assistant window that opens on startup.
     */
    SESSION_STATE: 'session.state',
    /** Client -> host: I have opened the session chat, send me the transcript. */
    SESSION_JOIN: 'session.join',

    CHAT_STATE: 'chat.state',
    CHAT_APPEND: 'chat.append',
    CHAT_TURN: 'chat.turn',
    CHAT_TYPING: 'chat.typing',

    /** A peer publishing its persona, so the room can see who it is playing. */
    PERSONA_STATE: 'persona.state',

    OOC_MESSAGE: 'ooc.message',
    OOC_HISTORY: 'ooc.history',
    OOC_TYPING: 'ooc.typing',
    CHAT_EDIT: 'chat.edit',
    CHAT_DELETE: 'chat.delete',

    /**
     * Client -> host: the turn I just sent was meant to produce a reply.
     * Sent from the client's generate_interceptor, which only runs when
     * SillyTavern was genuinely about to generate — the only reliable signal,
     * since a normal send and Guided Generations' Simple Send are identical on
     * the wire. Never infer this from CHAT_TURN.
     */
    GEN_REQUEST: 'gen.request',

    /**
     * Host -> peers: a reply is coming, and who asked for it.
     *
     * Purely advisory and never written to the chat. It exists because in a
     * shared room the seconds between someone pressing send and the first token
     * arriving are invisible to everyone else, so two players routinely type over
     * each other. Phases: 'pending' (accepted, not started), 'running'
     * (generating), 'done'.
     */
    GEN_NOTICE: 'gen.notice',

    GEN_START: 'gen.start',
    GEN_TOKEN: 'gen.token',
    GEN_END: 'gen.end',
    GEN_ABORT: 'gen.abort',

    ERROR: 'error',
});

export const ROLE = Object.freeze({ HOST: 'host', CLIENT: 'client' });

export const LIMITS = Object.freeze({
    MAX_FRAME_BYTES: 4 * 1024 * 1024,
    COMPRESS_THRESHOLD: 1024,
    CHUNK_BYTES: 256 * 1024,
    HANDSHAKE_TIMEOUT_MS: 8000,
    PING_INTERVAL_MS: 15000,
    PING_TIMEOUT_MS: 45000,
    RATE_MESSAGES: 60,
    RATE_WINDOW_MS: 10000,
    RATE_BYTES: 8 * 1024 * 1024,
    MAX_PEERS: 8,
    /**
     * Peers that authenticated but have not been admitted (they are reading an
     * extension diff, or waiting on the host's baseline). Capped separately from
     * MAX_PEERS so a group who all need to sync cannot fill the room and lock
     * out someone who is ready to play.
     */
    MAX_LOBBY: 6,
    /**
     * How long a peer may sit unadmitted. Long enough to read a diff and start a
     * sync, short enough that abandoned attempts release their slot. Syncing
     * needs a reload and a rejoin anyway, and the diff is kept client-side, so
     * closing the socket does not lose anything.
     */
    LOBBY_TIMEOUT_MS: 90000,
    MAX_PENDING: 16,
    MAX_HANDSHAKE_FAILURES: 5,
    HANDSHAKE_BLOCK_MS: 60000,
    COUNTER_WINDOW: 64,
});

export const DEFAULT_PORT = 8899;

/**
 * Opcodes a non-host peer is allowed to originate. Anything else from a client
 * is dropped by the relay rather than forwarded, so a client cannot impersonate
 * the host by, for example, publishing its own card index or rewriting the
 * transcript on everyone else's screen.
 */
export const CLIENT_ALLOWED_OPS = new Set([
    OP.PING, OP.PONG, OP.ROSTER, OP.PARITY_REPORT,
    OP.CARDS_WANT, OP.CHAT_TURN, OP.CHAT_TYPING,
    // The out-of-character channel is peer-to-peer by design: it is where
    // players plan, so it is not the host's to control or gate.
    OP.OOC_MESSAGE, OP.OOC_TYPING,
    OP.PARITY_URLS_REQUEST,
    OP.SESSION_JOIN,
    // Asking for a reply is a client's whole purpose in the room.
    OP.GEN_REQUEST,
    // Personas are peer-to-peer: everyone should be able to see who everyone
    // else is playing, not only the host.
    OP.PERSONA_STATE,
    // Correcting the transcript. The client has always sent these and the host
    // has always known how to apply and rebroadcast them — they were simply never
    // allowed through, so a client's edit or delete applied locally, reached
    // nobody, and left that peer quietly out of step with the room.
    OP.CHAT_EDIT,
    OP.CHAT_DELETE,
]);

/** Opcodes the relay forwards to the host only, rather than broadcasting. */
export const TO_HOST_ONLY = new Set([
    OP.CARDS_WANT, OP.CHAT_TURN, OP.PARITY_URLS_REQUEST, OP.SESSION_JOIN,
    // Only the host owns an API connection, so only the host can act on this.
    OP.GEN_REQUEST,
    // The host owns the canonical transcript, so it applies the change and
    // rebroadcasts it. Broadcasting directly would let two peers edit the same
    // message into different states with nothing to reconcile them.
    OP.CHAT_EDIT,
    OP.CHAT_DELETE,
]);

/**
 * Opcodes echoed back to the sender as well as everyone else. The relay
 * assigns the order, so every peer renders the same conversation in the same
 * sequence instead of each seeing its own messages in local order.
 */
export const ECHO_TO_SENDER = new Set([OP.OOC_MESSAGE]);

/** Opcodes the relay stamps with the sender's name as well as its id. */
export const STAMP_IDENTITY = new Set([OP.OOC_MESSAGE, OP.PERSONA_STATE, OP.CHAT_TYPING]);

/** Caps for the out-of-character channel. Mirrors lib/protocol.js. */
export const OOC = Object.freeze({
    MAX_LENGTH: 2000,
    HISTORY: 200,
    TYPING_INTERVAL_MS: 2500,
    TYPING_EXPIRY_MS: 6000,
});
