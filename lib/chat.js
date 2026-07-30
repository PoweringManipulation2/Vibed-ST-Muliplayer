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
            this.deps.send({
                op: OP.CHAT_TURN,
                id,
                text: String(message.mes ?? ''),
                persona: this.#localPersona(),
                sentAt: Date.now(),
            });
            return;
        }

        this.deps.send({
            op: OP.CHAT_APPEND,
            message: this.#serialise(message, index),
        });
    }

    #onLocalEdit(index) {
        if (this.deps.role() !== 'host') return;
        const message = this.deps.getContext().chat?.[index];
        const id = message?.extra?.[TAG]?.id;
        if (!id) return;
        this.deps.send({ op: OP.CHAT_EDIT, id, text: String(message.mes ?? '') });
    }

    #onLocalDelete(index) {
        if (this.deps.role() !== 'host') return;
        this.deps.send({ op: OP.CHAT_DELETE, index });
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
    async acceptRemoteTurn({ id, text, persona }, peer) {
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
        context.chat[index].mes = String(text ?? '').slice(0, 100000);
        context.updateMessageBlock?.(index, context.chat[index]);
    }

    applyRemoteDelete({ index }) {
        const context = this.deps.getContext();
        if (!Number.isInteger(index) || index < 0 || index >= context.chat.length) return;
        context.chat.splice(index, 1);
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

    #localPersona() {
        const context = this.deps.getContext();
        return {
            name: context.substituteParams?.('{{user}}') || 'Player',
            description: String(context.powerUserSettings?.persona_description ?? '').slice(0, 4000),
            avatar: context.powerUserSettings?.default_persona ?? null,
        };
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
