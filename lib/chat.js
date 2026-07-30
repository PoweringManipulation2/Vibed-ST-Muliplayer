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

/** Joins names as "a, b and c". */
function formatList(names) {
    if (names.length <= 1) return names[0] ?? '';
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Key under which the shared-persona block is registered. */
const PROMPT_KEY = 'STMP_PLAYER_PERSONAS';

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
        /** True between GEN_START and GEN_END on a client. */
        this.streamActive = false;
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
        this.streamActive = false;
        clearTimeout(this._streamTimer);
        this._streamScheduled = false;
    }

    // -- outbound (local -> peers) -----------------------------------------

    #onLocalMessage(index, kind) {
        const context = this.deps.getContext();
        const message = context.chat?.[index];
        if (!message) return;

        message.extra ??= {};
        message.extra[TAG] ??= { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` };
        const id = message.extra[TAG].id;

        // Stamp who wrote it, so every receiver can decide for itself whether the
        // author was somebody else. Previously nothing recorded authorship, so a
        // host's own turn arrived at clients indistinguishable from the model's
        // output and could not be attributed.
        if (kind === 'user' && !message.extra[TAG].authorPeerId) {
            message.extra[TAG].player = true;
            message.extra[TAG].author = message.name;
            message.extra[TAG].authorPeerId = this.deps.selfPeerId?.() ?? null;
        } else if (kind === 'character') {
            message.extra[TAG].player = false;
        }

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
        // Cancel any coalesced token still waiting on its timer. Otherwise a
        // frame lands up to 80ms after GEN_END and after the finished message,
        // and the receiver builds a fresh streaming placeholder containing the
        // full text — which reads as the reply appearing twice.
        clearTimeout(this._streamTimer);
        this._streamScheduled = false;
        this.deps.send({ op: OP.GEN_END, at: Date.now() });
    }

    #onStreamToken(text) {
        if (this.deps.role() !== 'host') return;
        // Coalesce: streaming fires per token, but one frame per animation
        // frame is plenty for a mirror and keeps the socket from thrashing.
        this._pendingStream = String(text ?? '');
        if (this._streamScheduled) return;
        this._streamScheduled = true;
        this._streamTimer = setTimeout(() => {
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

    /**
     * Records a peer's persona, merging rather than replacing.
     *
     * A chat turn carries a lightweight persona so it is not delayed by a
     * lorebook read or a portrait capture. Treating that as the whole truth meant
     * every message overwrote the full persona published earlier and threw away
     * the portrait and lorebook — so the face reverted after the first turn.
     * Fields absent from the update keep their previous value.
     */
    rememberPersona(peerId, persona) {
        if (!peerId || !persona) return;
        const previous = this.personas.get(peerId) ?? {};
        const keep = (incoming, fallback) => (incoming === undefined || incoming === null ? fallback : incoming);

        this.personas.set(peerId, {
            peerId,
            name: String(persona.name ?? previous.name ?? 'Player').slice(0, 40),
            description: String(keep(persona.description, previous.description) ?? '').slice(0, 8000),
            position: keep(persona.position, previous.position ?? null),
            depth: Number(keep(persona.depth, previous.depth ?? 2)),
            role: keep(persona.role, previous.role ?? 0),
            lorebookName: persona.lorebookName
                ? String(persona.lorebookName).slice(0, 120)
                : (previous.lorebookName ?? null),
            lorebook: persona.lorebook ?? previous.lorebook ?? null,
            // Only data URLs are accepted: a remote peer must not be able to make
            // everyone's browser fetch an arbitrary URL by supplying it here.
            avatarData: typeof persona.avatarData === 'string'
                && /^data:image\/(png|jpeg|webp|gif);base64,/.test(persona.avatarData)
                && persona.avatarData.length < 256 * 1024
                ? persona.avatarData
                // An update without a portrait keeps the one already published.
                : (persona.avatarData === undefined ? (previous.avatarData ?? null) : null),
            updatedAt: Date.now(),
        });
    }

    async acceptRemoteTurn({ id, text, persona }, peer) {
        this.rememberPersona(peer?.id, persona);
        const context = this.deps.getContext();
        const clean = String(text ?? '').slice(0, 20000).trim();
        if (!clean) return;

        const stored = this.personas.get(peer?.id);
        const message = {
            name: persona?.name || peer?.name || 'Player',
            is_user: true,
            is_system: false,
            send_date: context.humanizedDateTime?.() ?? new Date().toISOString(),
            mes: clean,
            // force_avatar overrides the local persona picture for this message,
            // which is what stops every remote player wearing the host's face.
            ...(stored?.avatarData ? { force_avatar: stored.avatarData } : {}),
            extra: {
                [TAG]: {
                    id,
                    player: true,
                    author: persona?.name || peer?.name || 'Player',
                    authorPeerId: peer?.id ?? null,
                    playerName: peer?.name ?? null,
                },
            },
        };

        this.appliedIds.add(id);
        context.chat.push(message);
        context.addOneMessage(message);
        this.decorateAll();
        await context.saveChat?.();

        this.deps.send({ op: OP.CHAT_APPEND, message: this.#serialise(message, context.chat.length - 1) });

        // Appending the turn was only half the job: nothing asked the model to
        // answer it, so a client could speak and nothing ever happened.
        //
        // `/trigger` is the right mechanism — it generates a reply without adding
        // another user message, and it waits for any generation already running
        // rather than colliding with it.
        if (this.deps.autoReply?.() !== false) {
            void this.#requestReply();
        }
        return message;
    }

    async #requestReply() {
        const context = this.deps.getContext();
        if (typeof context.executeSlashCommandsWithOptions !== 'function') {
            console.warn('[Multiplayer] Cannot trigger a reply: no slash command runner');
            return;
        }
        if (this._replyPending) return; // one queued trigger is enough
        this._replyPending = true;
        try {
            await context.executeSlashCommandsWithOptions('/trigger await=true', { handleParserErrors: true });
        } catch (error) {
            console.error('[Multiplayer] Could not trigger a reply to a player turn', error);
        } finally {
            this._replyPending = false;
        }
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

        const incomingMarker = incoming.extra?.[TAG] ?? {};
        const message = {
            name: String(incoming.name ?? 'Unknown').slice(0, 80),
            is_user: Boolean(incoming.is_user),
            is_system: Boolean(incoming.is_system),
            send_date: incoming.send_date ?? new Date().toISOString(),
            mes: incoming.mes.slice(0, 100000),
            ...(incoming.force_avatar && /^data:image\//.test(incoming.force_avatar)
                ? { force_avatar: incoming.force_avatar } : {}),
            extra: {
                [TAG]: {
                    id,
                    mirrored: true,
                    player: Boolean(incomingMarker.player),
                    author: incomingMarker.author ?? null,
                    authorPeerId: incomingMarker.authorPeerId ?? null,
                    playerName: incomingMarker.playerName ?? null,
                },
            },
        };

        context.chat.push(message);
        context.addOneMessage(message);
        this.#clearStreamPlaceholder();
        this.decorateAll();
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
        // Indices shift, so previously-correct badges are now on the wrong rows.
        this.decorateAll();
    }

    /** Client: a generation started, so live tokens are expected. */
    beginStream() {
        this.streamActive = true;
    }

    /** Client: show the host's in-progress generation as live text. */
    applyStreamToken({ text }) {
        // Refuse tokens outside an active generation. Belt and braces alongside
        // the host-side timer cancel: a stray token must never be able to create
        // a second copy of a reply that has already been delivered.
        if (!this.streamActive) return;
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
        this.streamActive = false;
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
            // Carried so every peer renders the same face for the same speaker.
            ...(message.force_avatar ? { force_avatar: message.force_avatar } : {}),
            extra: { [TAG]: message.extra?.[TAG] ?? null },
        };
    }

    /**
     * Marks the message that was just rendered as coming from another player.
     *
     * Without this a remote turn is indistinguishable from your own: same bubble,
     * same styling, only a different name — easy to miss and easy to mistake for
     * your own text.
     */
    /**
     * Marks every message written by another player.
     *
     * This used to decorate "whatever is last in the DOM" on the next animation
     * frame, which was wrong twice over: an auto-reply could render in between, so
     * the badge landed on the model's message instead of the player's, and nothing
     * ever decorated messages that were already on screen — so scrolling back
     * showed no attribution at all.
     *
     * Addressing by `mesid` fixes the first, and sweeping the whole chat fixes the
     * second. It is cheap: a handful of DOM lookups over the rendered window, and
     * already-decorated rows are skipped.
     */
    decorateAll() {
        if (typeof document === 'undefined') return;

        const run = () => {
            try {
                const context = this.deps.getContext();
                const self = this.deps.selfPeerId?.() ?? null;
                const chat = context.chat ?? [];

                for (const element of document.querySelectorAll('#chat .mes')) {
                    const index = Number(element.getAttribute('mesid'));
                    if (!Number.isInteger(index)) continue;

                    const marker = chat[index]?.extra?.[TAG];
                    // Someone else's turn: a player message whose author is not us.
                    const byAnotherPlayer = Boolean(marker?.player)
                        && marker.authorPeerId != null
                        && marker.authorPeerId !== self;

                    const existing = element.querySelector('.stmp-from-player');
                    if (!byAnotherPlayer) {
                        // Clear stale decoration, e.g. after messages are deleted
                        // and indices shift underneath the rendered rows.
                        element.classList.remove('stmp-remote-message');
                        existing?.remove();
                        continue;
                    }

                    element.classList.add('stmp-remote-message');
                    if (existing) continue;

                    const badge = document.createElement('span');
                    badge.className = 'stmp-from-player';
                    const who = marker.playerName && marker.playerName !== marker.author
                        ? `${marker.playerName} \u00b7 another player`
                        : 'another player';
                    badge.textContent = who;
                    badge.title = 'Sent by another player in this multiplayer session';
                    element.querySelector('.mes_block .ch_name')?.append(badge);
                }
            } catch (error) {
                console.warn('[Multiplayer] Could not mark remote messages', error);
            }
        };

        // Coalesce: several messages can land in one tick, and ST re-renders the
        // whole chat on delete, so one pass per frame is plenty.
        if (this._decorateQueued) return;
        this._decorateQueued = true;
        const schedule = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn => setTimeout(fn, 0));
        schedule(() => {
            this._decorateQueued = false;
            run();
        });
    }

    #localPersona() {
        const context = this.deps.getContext();
        const power = context.powerUserSettings ?? {};

        // The ACTIVE persona's avatar filename. This used to read
        // `default_persona`, which is the *favourite* persona and stays null
        // unless the user explicitly sets one — so avatarId was almost always
        // null, no portrait was ever captured, and every remote message fell back
        // to whatever persona picture the *receiver* had. That is why everyone saw
        // their own face on other people's messages.
        const avatarId = this.deps.activePersonaAvatar?.() || power.default_persona || null;

        // Prefer the applied values, falling back to the stored per-avatar record.
        const stored = power.persona_descriptions?.[avatarId] ?? {};

        return {
            name: context.substituteParams?.('{{user}}') || 'Player',
            description: String(power.persona_description || stored.description || '').slice(0, 8000),
            position: power.persona_description_position ?? null,
            depth: Number(power.persona_description_depth ?? 2),
            role: power.persona_description_role ?? 0,
            avatarId,
            lorebookName: String(power.persona_description_lorebook || stored.lorebook || '') || null,
            /** Filled in asynchronously by {@link attachPersonaLore}. */
            lorebook: null,
            /** Small data-URL portrait, so peers can show the right face. */
            avatarData: null,
        };
    }

    /**
     * Captures the local persona portrait as a small data URL.
     *
     * Needed because a peer's avatar file only exists on that peer's machine.
     * Without it, every remote player's message rendered with the *receiver's*
     * own persona picture, which is what made two different players look like the
     * same person. Downscaled to 96px and re-encoded so the payload stays a few
     * kilobytes rather than shipping a full-size portrait.
     */
    async capturePersonaPortrait(avatarId) {
        if (!avatarId) return null;
        const context = this.deps.getContext();
        try {
            const url = context.getThumbnailUrl('persona', avatarId);
            const response = await fetch(url, { cache: 'force-cache' });
            if (!response.ok) return null;

            const bitmap = await createImageBitmap(await response.blob());
            const size = 96;
            const canvas = document.createElement('canvas');
            canvas.width = size;
            canvas.height = size;
            const ctx = canvas.getContext('2d');

            // Cover-crop to a square so portraits are not distorted.
            const scale = Math.max(size / bitmap.width, size / bitmap.height);
            const width = bitmap.width * scale;
            const height = bitmap.height * scale;
            ctx.drawImage(bitmap, (size - width) / 2, (size - height) / 2, width, height);
            bitmap.close?.();

            const data = canvas.toDataURL('image/webp', 0.8);
            return data.length > 96 * 1024 ? canvas.toDataURL('image/jpeg', 0.6) : data;
        } catch (error) {
            console.warn('[Multiplayer] Could not capture the persona portrait', error);
            return null;
        }
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

    /** The persona this peer is presenting, fully resolved. */
    async describeLocalPersona() {
        const persona = await this.attachPersonaLore(this.#localPersona());
        persona.avatarData = await this.capturePersonaPortrait(persona.avatarId);
        return persona;
    }

    // -- prompt injection --------------------------------------------------

    /**
     * Injects every remote player's persona into the prompt.
     *
     * This was the missing half of persona sharing. The descriptions arrived at
     * the host and were stored, but nothing ever put them in front of the model —
     * so the model saw several different speaker names with no idea who any of
     * them were, and replied as though talking to one anonymous user.
     *
     * SillyTavern injects the *local* persona itself; this covers everyone else.
     * Entries from a player's bound lorebook are included when their keywords
     * appear in recent chat, which is a deliberate approximation of World Info
     * scanning rather than a reimplementation of it.
     *
     * @param {number} [scanDepth] how many recent messages to scan for keywords
     */
    injectPersonas(scanDepth = 6, selfPeerId = null) {
        const context = this.deps.getContext();
        if (typeof context.setExtensionPrompt !== 'function') return '';

        // Exclude our own persona: SillyTavern already injects that, and adding it
        // again both wastes tokens and made the block look correct when in fact no
        // remote persona had arrived at all.
        const others = [...this.personas.values()].filter(persona => persona.peerId !== selfPeerId);

        if (others.length === 0) {
            context.setExtensionPrompt(PROMPT_KEY, '', context.extensionPromptTypes?.IN_PROMPT ?? 0, 0);
            return '';
        }

        // A roster line first. Every player is named here, including anyone whose
        // persona has no description — they are still in the scene and still
        // speaking, and filtering them out left the model with no idea how many
        // people it was talking to.
        const selfName = context.substituteParams?.('{{user}}') || 'the host';
        const names = [selfName, ...others.map(persona => persona.name || 'a player')];
        const roster = `There are ${names.length} people in this scene: ${formatList(names)}. `
            + 'Each speaks for themselves; address them by name and do not merge them into one character.';

        const described = others.filter(persona => persona.description);
        const blocks = described.map(persona => `${persona.name}: ${persona.description}`);

        // Lorebook entries are deliberately absent here. They are handled by
        // SillyTavern's own World Info engine via a session-bound book (see
        // lib/lore.js), which honours position, order, depth, selective logic and
        // the token budget — none of which a hand-rolled keyword scan does.
        const text = blocks.length > 0
            ? `[Players in this scene]\n${roster}\n\n${blocks.join('\n\n')}`
            : `[Players in this scene]\n${roster}`;

        context.setExtensionPrompt(
            PROMPT_KEY,
            text,
            context.extensionPromptTypes?.IN_PROMPT ?? 0,
            0,
            false,
            context.extensionPromptRoles?.SYSTEM ?? 0,
        );
        void scanDepth;
        return text;
    }

    /** Removes the injection, so it cannot bleed into unrelated chats. */
    clearPersonaInjection() {
        const context = this.deps.getContext();
        context.setExtensionPrompt?.(PROMPT_KEY, '', context.extensionPromptTypes?.IN_PROMPT ?? 0, 0);
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
            // Attribution has to survive the snapshot, or scrolling back through
            // restored history shows no indication of who said what — which is
            // most of the transcript for anyone who joined mid-session.
            const incomingMarker = incoming?.extra?.[TAG] ?? {};
            context.chat.push({
                name: String(incoming.name ?? 'Unknown').slice(0, 80),
                is_user: Boolean(incoming.is_user),
                is_system: Boolean(incoming.is_system),
                send_date: incoming.send_date ?? new Date().toISOString(),
                mes: String(incoming.mes ?? '').slice(0, 100000),
                ...(incoming.force_avatar && /^data:image\//.test(incoming.force_avatar)
                    ? { force_avatar: incoming.force_avatar } : {}),
                extra: {
                    [TAG]: {
                        id,
                        mirrored: true,
                        player: Boolean(incomingMarker.player),
                        author: incomingMarker.author ?? null,
                        authorPeerId: incomingMarker.authorPeerId ?? null,
                        playerName: incomingMarker.playerName ?? null,
                    },
                },
            });
        }
        await context.printMessages?.();
        this.decorateAll();
    }
}
