/**
 * Chat bridge.
 *
 * Authority model: the host owns the chat and the API connection. Clients never
 * call an inference endpoint — they send their turn to the host, the host
 * appends it, generates the reply with its own settings, and streams the result
 * back. That keeps one canonical transcript, means clients need no API keys,
 * and means the prompt is assembled exactly once.
 *
 * Personas stay local on purpose. Each peer picks their own persona and only
 * the resolved display name and description travel with a turn, so nobody has
 * to adopt anyone else's persona to join.
 */

import { OP } from './protocol.js';

/** Marks messages this extension has already accounted for. */
const TAG = 'stmp';

/** How many recent message ids to remember for echo de-duplication. */
const ID_MEMORY = 2000;

/**
 * A Set that forgets its oldest entries.
 *
 * These sets exist to recognise a message the relay is echoing back, which only
 * ever happens moments after it was sent. Remembering every id for the life of
 * the session was pure growth with no benefit — a marathon session with tens of
 * thousands of turns would accumulate all of them. A window of the most recent
 * few thousand covers echo detection with room to spare.
 */
class RecentIds {
    #set = new Set();
    #order = [];

    constructor(limit = ID_MEMORY) {
        this.limit = limit;
    }

    add(id) {
        if (!id || this.#set.has(id)) return;
        this.#set.add(id);
        this.#order.push(id);
        while (this.#order.length > this.limit) {
            this.#set.delete(this.#order.shift());
        }
    }

    has(id) {
        return this.#set.has(id);
    }

    clear() {
        this.#set.clear();
        this.#order.length = 0;
    }

    get size() {
        return this.#set.size;
    }
}

export class ChatBridge {
    /**
     * @param {object} deps
     * @param {() => object} deps.getContext SillyTavern's getContext
     * @param {(payload: object) => void} deps.send transport send
     * @param {() => string} deps.role 'host' | 'client'
     * @param {() => boolean} deps.isActive whether relaying should happen
     */
    constructor(deps) {
        this.deps = deps;
        this.bound = false;
        /** Ids this peer originated, so echoes are not rendered twice. */
        this.ownIds = new RecentIds();
        /** Ids already applied locally, guarding against duplicate broadcasts. */
        this.appliedIds = new RecentIds();
        this.streaming = new Map();
        /** Ids being applied from the network, so they are not echoed back. */
        this.suppress = new Set();
        this._handlers = [];
    }

    // -- wiring -------------------------------------------------------------

    attach() {
        if (this.bound) return;
        const { eventSource, eventTypes } = this.deps.getContext();

        const on = (type, handler) => {
            const wrapped = (...args) => {
                if (!this.deps.isActive()) return;
                try {
                    return handler(...args);
                } catch (error) {
                    console.error('[Multiplayer] chat bridge handler failed', error);
                }
            };
            eventSource.on(type, wrapped);
            this._handlers.push([type, wrapped]);
        };

        // Host broadcasts everything that lands in its chat.
        on(eventTypes.MESSAGE_SENT, index => this.#onLocalMessage(index, 'user'));
        on(eventTypes.MESSAGE_RECEIVED, index => this.#onLocalMessage(index, 'character'));
        on(eventTypes.MESSAGE_EDITED, index => this.#onLocalEdit(index));
        on(eventTypes.MESSAGE_DELETED, index => this.#onLocalDelete(index));
        on(eventTypes.STREAM_TOKEN_RECEIVED, text => this.#onStreamToken(text));
        on(eventTypes.GENERATION_STARTED, () => this.#onGenerationStarted());
        on(eventTypes.GENERATION_ENDED, () => this.#onGenerationEnded());

        this.bound = true;
    }

    detach() {
        if (!this.bound) return;
        const { eventSource } = this.deps.getContext();
        for (const [type, handler] of this._handlers) {
            eventSource.removeListener?.(type, handler);
        }
        this._handlers = [];
        this.bound = false;
        this.reset();
    }

    reset() {
        this.ownIds.clear();
        this.appliedIds.clear();
        this.streaming.clear();
        this.suppress.clear();
    }

    // -- outbound (local -> peers) -----------------------------------------

    #onLocalMessage(index, kind) {
        const context = this.deps.getContext();
        const message = context.chat?.[index];
        if (!message) return;

        message.extra ??= {};
        message.extra[TAG] ??= { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` };
        const id = message.extra[TAG].id;

        if (this.appliedIds.has(id)) return; // arrived from the network, not typed here
        this.appliedIds.add(id);

        if (this.deps.role() === 'client') {
            // Clients only ever forward their own turns; anything else in their
            // chat is a mirror of the host's transcript.
            if (kind !== 'user') return;
            this.ownIds.add(id);
            const persona = this.#localPersona();
            // Send immediately so the turn is not delayed by a lorebook read,
            // then follow up with the resolved persona if there is one.
            this.deps.send({ op: OP.CHAT_TURN, id, text: String(message.mes ?? ''), persona, sentAt: Date.now() });
            if (persona.lorebookName) {
                void this.attachPersonaLore(persona).then(resolved => {
                    this.deps.send({ op: OP.PERSONA_STATE, persona: resolved });
                });
            }
            return;
        }

        this.deps.send({
            op: OP.CHAT_APPEND,
            message: this.#serialise(message, index),
        });
    }

    /**
     * Edits propagate from either role. Everyone in the room can correct the
     * transcript — a typo in someone's turn should not need the host to fix it.
     * The relay confines these to the session chat.
     */
    #onLocalEdit(index) {
        const message = this.deps.getContext().chat?.[index];
        const id = message?.extra?.[TAG]?.id;
        if (!id) return;
        // Guard against echoing a change that arrived from the network.
        if (this.suppress.has(id)) return;
        this.deps.send({ op: OP.CHAT_EDIT, id, text: String(message.mes ?? '') });
    }

    #onLocalDelete(index) {
        const message = this.deps.getContext().chat?.[index];
        const id = message?.extra?.[TAG]?.id ?? null;
        if (id && this.suppress.has(id)) return;
        // Address by id where possible; index alone is ambiguous once peers have
        // diverged even slightly.
        this.deps.send({ op: OP.CHAT_DELETE, id, index });
    }

    #onGenerationStarted() {
        if (this.deps.role() !== 'host') return;
        this.deps.send({ op: OP.GEN_START, at: Date.now() });
    }

    #onGenerationEnded() {
        if (this.deps.role() !== 'host') return;
        this.deps.send({ op: OP.GEN_END, at: Date.now() });
    }

    #onStreamToken(text) {
        if (this.deps.role() !== 'host') return;
        // Coalesce: streaming fires per token, but one frame per animation
        // frame is plenty for a mirror and keeps the socket from thrashing.
        this._pendingStream = String(text ?? '');
        if (this._streamScheduled) return;
        this._streamScheduled = true;
        setTimeout(() => {
            this._streamScheduled = false;
            if (!this.deps.isActive()) return;
            this.deps.send({ op: OP.GEN_TOKEN, text: this._pendingStream });
        }, 80);
    }

    // -- inbound (peers -> local) ------------------------------------------

    /**
     * Host: a client asked to say something. Append it as that peer's persona
     * and let the normal SillyTavern flow take over from there.
     */
    /** peerId -> the persona that peer last presented. */
    personas = new Map();

    rememberPersona(peerId, persona) {
        if (!peerId || !persona) return;
        this.personas.set(peerId, {
            peerId,
            name: String(persona.name ?? 'Player').slice(0, 40),
            description: String(persona.description ?? '').slice(0, 8000),
            position: persona.position ?? null,
            depth: Number(persona.depth ?? 2),
            role: persona.role ?? 0,
            lorebookName: persona.lorebookName ? String(persona.lorebookName).slice(0, 120) : null,
            lorebook: persona.lorebook ?? null,
            updatedAt: Date.now(),
        });
    }

    async acceptRemoteTurn({ id, text, persona }, peer) {
        this.rememberPersona(peer?.id, persona);
        const context = this.deps.getContext();
        const clean = String(text ?? '').slice(0, 20000).trim();
        if (!clean) return;

        const message = {
            name: persona?.name || peer?.name || 'Player',
            is_user: true,
            is_system: false,
            send_date: context.humanizedDateTime?.() ?? new Date().toISOString(),
            mes: clean,
            extra: { [TAG]: { id, from: peer?.id ?? null, persona: persona ?? null } },
        };

        this.appliedIds.add(id);
        context.chat.push(message);
        context.addOneMessage(message);
        await context.saveChat?.();

        this.deps.send({ op: OP.CHAT_APPEND, message: this.#serialise(message, context.chat.length - 1) });
        return message;
    }

    /** Client: render a message the host says is canonical. */
    async applyRemoteMessage(payload) {
        const context = this.deps.getContext();
        const incoming = payload?.message;
        if (!incoming || typeof incoming.mes !== 'string') return;

        const id = incoming.extra?.[TAG]?.id;
        if (id && this.appliedIds.has(id)) {
            // Already on screen — this is the host echoing back our own turn.
            return;
        }
        if (id) this.appliedIds.add(id);

        const message = {
            name: String(incoming.name ?? 'Unknown').slice(0, 80),
            is_user: Boolean(incoming.is_user),
            is_system: Boolean(incoming.is_system),
            send_date: incoming.send_date ?? new Date().toISOString(),
            mes: incoming.mes.slice(0, 100000),
            extra: { [TAG]: { id, mirrored: true } },
        };

        context.chat.push(message);
        context.addOneMessage(message);
        this.#clearStreamPlaceholder();
    }

    applyRemoteEdit({ id, text }) {
        const context = this.deps.getContext();
        const index = context.chat.findIndex(message => message?.extra?.[TAG]?.id === id);
        if (index < 0) return;

        // Suppress briefly so applying this does not re-broadcast it as a local
        // edit, which would ping-pong between peers.
        this.suppress.add(id);
        context.chat[index].mes = String(text ?? '').slice(0, 100000);
        context.updateMessageBlock?.(index, context.chat[index]);
        setTimeout(() => this.suppress.delete(id), 2000);
    }

    applyRemoteDelete({ id, index }) {
        const context = this.deps.getContext();

        // Prefer the id: indices drift the moment any peer's view differs.
        let target = id ? context.chat.findIndex(message => message?.extra?.[TAG]?.id === id) : -1;
        if (target < 0 && Number.isInteger(index) && index >= 0 && index < context.chat.length) target = index;
        if (target < 0) return;

        if (id) {
            this.suppress.add(id);
            setTimeout(() => this.suppress.delete(id), 2000);
        }
        context.chat.splice(target, 1);
        context.printMessages?.();
    }

    /** Client: show the host's in-progress generation as live text. */
    applyStreamToken({ text }) {
        const context = this.deps.getContext();
        const placeholder = this.#ensureStreamPlaceholder(context);
        if (!placeholder) return;
        placeholder.message.mes = String(text ?? '').slice(0, 100000);
        context.updateMessageBlock?.(placeholder.index, placeholder.message);
        context.scrollChatToBottom?.();
    }

    #ensureStreamPlaceholder(context) {
        if (this._placeholderIndex != null && context.chat[this._placeholderIndex]?.extra?.[TAG]?.streaming) {
            return { index: this._placeholderIndex, message: context.chat[this._placeholderIndex] };
        }
        const message = {
            name: context.name2 ?? 'Assistant',
            is_user: false,
            is_system: false,
            send_date: new Date().toISOString(),
            mes: '',
            extra: { [TAG]: { streaming: true } },
        };
        context.chat.push(message);
        context.addOneMessage(message);
        this._placeholderIndex = context.chat.length - 1;
        return { index: this._placeholderIndex, message };
    }

    #clearStreamPlaceholder() {
        const context = this.deps.getContext();
        if (this._placeholderIndex == null) return;
        const message = context.chat[this._placeholderIndex];
        if (message?.extra?.[TAG]?.streaming) {
            context.chat.splice(this._placeholderIndex, 1);
            context.printMessages?.();
        }
        this._placeholderIndex = null;
    }

    endStream() {
        this.#clearStreamPlaceholder();
    }

    // -- helpers ------------------------------------------------------------

    #serialise(message, index) {
        return {
            index,
            name: message.name,
            is_user: Boolean(message.is_user),
            is_system: Boolean(message.is_system),
            send_date: message.send_date,
            mes: String(message.mes ?? ''),
            extra: { [TAG]: message.extra?.[TAG] ?? null },
        };
    }

    /**
     * Everything the host needs to render this player faithfully in the prompt.
     *
     * The description alone is not enough: SillyTavern injects it at a configured
     * position and depth, and a persona can have a lorebook bound to it. Without
     * those the host's model sees a name and a paragraph, which is why replies
     * came back not knowing who it was talking to.
     */
    #localPersona() {
        const context = this.deps.getContext();
        const power = context.powerUserSettings ?? {};
        return {
            name: context.substituteParams?.('{{user}}') || 'Player',
            description: String(power.persona_description ?? '').slice(0, 8000),
            position: power.persona_description_position ?? null,
            depth: Number(power.persona_description_depth ?? 2),
            role: power.persona_description_role ?? 0,
            avatarId: power.default_persona ?? context.userAvatar ?? null,
            lorebookName: String(power.persona_description_lorebook ?? '') || null,
            /** Filled in asynchronously by {@link attachPersonaLore}. */
            lorebook: null,
        };
    }

    /**
     * Resolves the persona's bound lorebook into actual entries.
     * Kept separate from {@link #localPersona} because it needs an await and the
     * synchronous callers cannot provide one.
     */
    async attachPersonaLore(persona) {
        if (!persona?.lorebookName) return persona;
        const context = this.deps.getContext();
        if (typeof context.loadWorldInfo !== 'function') return persona;
        try {
            const book = await context.loadWorldInfo(persona.lorebookName);
            if (book) persona.lorebook = book;
        } catch (error) {
            console.warn('[Multiplayer] Could not load the persona lorebook', persona.lorebookName, error);
        }
        return persona;
    }

    /** The persona this peer is presenting, resolved. Used by the profile panel. */
    async describeLocalPersona() {
        return this.attachPersonaLore(this.#localPersona());
    }

    /** Full transcript snapshot, used when a client joins mid-session. */
    snapshot(limit = 200) {
        const context = this.deps.getContext();
        const chat = context.chat ?? [];
        const start = Math.max(0, chat.length - limit);
        return chat.slice(start).map((message, offset) => this.#serialise(message, start + offset));
    }

    /** Client: replace the local transcript with the host's snapshot. */
    async applySnapshot({ messages }) {
        if (!Array.isArray(messages)) return;
        const context = this.deps.getContext();

        context.chat.length = 0;
        for (const incoming of messages) {
            const id = incoming?.extra?.[TAG]?.id;
            if (id) this.appliedIds.add(id);
            context.chat.push({
                name: String(incoming.name ?? 'Unknown').slice(0, 80),
                is_user: Boolean(incoming.is_user),
                is_system: Boolean(incoming.is_system),
                send_date: incoming.send_date ?? new Date().toISOString(),
                mes: String(incoming.mes ?? '').slice(0, 100000),
                extra: { [TAG]: { id, mirrored: true } },
            });
        }
        await context.printMessages?.();
    }
}
