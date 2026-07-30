/**
 * mp-generation.js — decides who generates, and when.
 *
 * The bug this fixes: MESSAGE_SENT fires identically for a normal send and
 * for Guided Generations' Simple Send (which is `/send {{input}} | /setinput`).
 * Inferring "a player spoke, therefore reply" from that event cannot tell them
 * apart, which is why the auto-reply toggle was all-or-nothing.
 *
 * The fix: don't infer. The client already knows, because ST itself knows —
 * a normal send reaches the generation pipeline and Simple Send never does.
 * So intent travels as its own packet.
 *
 * Pairs with mp-personas.js. That module ships text; this one ships turns.
 */

const MODULE_NAME = 'multiplayer';

const ctx = () => SillyTavern.getContext();

function settings() {
    const s = ctx().extensionSettings;
    s[MODULE_NAME] ??= {};
    s[MODULE_NAME].honorPlayerRequests ??= true;
    return s[MODULE_NAME];
}

/* ------------------------------------------------------------------ *
 * CLIENT
 *
 * manifest.json needs BOTH of these:
 *
 *   "generate_interceptor": "mpRelayInterceptor",
 *   "loading_order": 5
 *
 * Low loading_order matters. Interceptors run in ascending order, so a low
 * number means we abort before other extensions do work for a generation
 * that is never going to happen. (I said 100 earlier — that was backwards.)
 * ------------------------------------------------------------------ */

/**
 * Generation types that mean "produce a visible character reply".
 * Everything else — quiet prompts, impersonation — is a LOCAL tool and must
 * be left alone. GG's Thinking, Clothes and State guides can auto-trigger,
 * and Spellchecker runs /genraw. Without this filter every one of those
 * fires a host reply.
 */
const RELAY_TYPES = new Set([undefined, '', 'normal', 'continue', 'regenerate', 'swipe']);

/** Set by your connection layer. Host generates locally; clients delegate. */
let role = 'solo';        // 'solo' | 'host' | 'client'
let send = () => {};      // inject your socket send

export function configureRelay({ role: r, send: s }) {
    role = r;
    send = s;
}

globalThis.mpRelayInterceptor = async (chat, contextSize, abort, type) => {
    // Solo, or we ARE the host: generate normally.
    if (role !== 'client') return;

    // Local tool, not a turn. Let it run on this machine.
    if (!RELAY_TYPES.has(type)) return;

    send({ kind: 'request_generation', genType: type ?? 'normal' });
    abort(true);
};

/* ------------------------------------------------------------------ *
 * HOST
 * ------------------------------------------------------------------ */

let generating = false;
const queue = [];

/**
 * Call ONLY from your request_generation packet handler.
 *
 * Nothing in your player_message path should ever reach this. That
 * separation is the whole fix — if the host still generates on message
 * receipt, Simple Send will keep triggering replies no matter what the
 * client sends.
 */
export async function onRequestGeneration(playerId, packet) {
    if (!settings().honorPlayerRequests) return;

    if (generating) {
        // Two players hitting send at once would otherwise start two
        // concurrent generations against the same chat.
        queue.push({ playerId, packet });
        return;
    }

    generating = true;
    try {
        const type = packet.genType === 'normal' ? undefined : packet.genType;
        await ctx().generate(type);
    } catch (err) {
        console.error(`[${MODULE_NAME}] generation for ${playerId} failed`, err);
    } finally {
        generating = false;
        const next = queue.shift();
        if (next) await onRequestGeneration(next.playerId, next.packet);
    }
}

/**
 * Re-entrancy guard for injecting a relayed message on the host.
 *
 * addOneMessage() fires MESSAGE_SENT / USER_MESSAGE_RENDERED on the host too.
 * Without this, the host's own injection is indistinguishable from a local
 * send, and you get a second path to spurious replies that looks exactly
 * like the bug you just fixed.
 */
let injecting = false;
export const isInjecting = () => injecting;

export async function injectMessage(message) {
    const c = ctx();
    injecting = true;
    try {
        c.chat.push(message);
        c.addOneMessage(message);
        await c.saveChat();
    } finally {
        injecting = false;
    }
}
