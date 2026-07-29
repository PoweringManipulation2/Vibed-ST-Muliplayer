/**
 * The out-of-character channel.
 *
 * A side chat for the players, which the model is not part of. Use it to agree
 * who acts next, sort out a continuity problem, or just talk, without any of it
 * becoming part of the roleplay.
 *
 * The one invariant that matters
 * -----------------------------
 * OOC messages are NEVER written into `getContext().chat`.
 *
 * That array is what SillyTavern walks to build a prompt, so anything placed in
 * it is context whether it is displayed or not — `is_system` messages still get
 * considered, and hidden messages still cost tokens on some paths. So this
 * module keeps its transcript in a plain array of its own and renders straight
 * to its own DOM. Nothing in here can reach a prompt, a token count, the chat
 * file on disk, or a summary, because it never enters the structure any of those
 * are derived from. `tests/ooc.test.mjs` asserts this against a mock context.
 *
 * The only route from OOC into the roleplay is the explicit "Send to RP" button,
 * which hands the text to SillyTavern's own `/send` command — the same
 * mechanism Guided Generations' Simple Send uses — so it is posted as a normal
 * user message without triggering a reply. That is a deliberate action with its
 * own button, never a side effect of chatting.
 */

import { OOC, OP } from './protocol.js';

export class OOCChannel {
    /**
     * @param {object} deps
     * @param {() => object} deps.getContext
     * @param {(payload: object) => void} deps.send
     * @param {() => boolean} deps.isConnected
     * @param {() => string|null} deps.peerId
     * @param {object} deps.toastr
     */
    constructor(deps) {
        this.deps = deps;

        /**
         * The OOC transcript. Deliberately a private array and not
         * `context.chat` — see the note at the top of this file.
         * @type {Array<{id: string, from: string, name: string, role: string, text: string, sentAt: number}>}
         */
        this.messages = [];

        this.unread = 0;
        this.open = false;
        this.typing = new Map(); // peerId -> expiry timestamp

        this.root = null;
        this.toggleButton = null;
        this._lastTypingSentAt = 0;
        this._typingSweeper = null;
    }

    // -- mounting -----------------------------------------------------------

    mount() {
        if (this.root) return;
        this.#buildToggle();
        this.#buildPanel();

        this._typingSweeper = setInterval(() => this.#renderTyping(), 1500);
    }

    destroy() {
        clearInterval(this._typingSweeper);
        this.root?.remove();
        this.toggleButton?.remove();
        this.root = null;
        this.toggleButton = null;
    }

    /** Adds the toggle to SillyTavern's send bar, next to the send button. */
    #buildToggle() {
        const bar = document.querySelector('#rightSendForm');
        if (!bar) {
            console.warn('[Multiplayer] Send bar not found; the OOC toggle will not be shown.');
            return;
        }

        const button = document.createElement('div');
        button.id = 'stmp_ooc_toggle';
        button.className = 'fa-solid fa-comments interactable';
        button.title = 'Player chat (out of character) — the model never sees this';
        button.tabIndex = 0;
        button.innerHTML = '<span class="stmp-ooc-badge" hidden>0</span>';

        const activate = event => {
            event.preventDefault();
            this.toggle();
        };
        button.addEventListener('click', activate);
        button.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') activate(event);
        });

        // Before #send_but so the send button stays the rightmost control.
        bar.insertBefore(button, document.querySelector('#send_but') ?? null);
        this.toggleButton = button;
    }

    #buildPanel() {
        const panel = document.createElement('div');
        panel.id = 'stmp_ooc_panel';
        panel.hidden = true;
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', 'Player chat, out of character');
        panel.innerHTML = `
            <div class="stmp-ooc-header" data-drag-handle>
                <i class="fa-solid fa-comments"></i>
                <span class="stmp-ooc-title">Player chat</span>
                <small class="stmp-ooc-hint">Out of character — not sent to the model</small>
                <span class="flex1"></span>
                <div class="stmp-ooc-close fa-solid fa-xmark interactable" title="Close" tabindex="0"></div>
            </div>
            <div class="stmp-ooc-log" aria-live="polite"></div>
            <div class="stmp-ooc-typing"></div>
            <div class="stmp-ooc-compose">
                <textarea class="stmp-ooc-input text_pole" rows="2" maxlength="${OOC.MAX_LENGTH}"
                    placeholder="Plan with the other players… (Enter to send, Shift+Enter for a new line)"></textarea>
                <div class="stmp-ooc-actions">
                    <div class="stmp-ooc-send menu_button" title="Send to the other players">
                        <i class="fa-solid fa-paper-plane"></i>
                    </div>
                    <div class="stmp-ooc-promote menu_button" title="Post this into the roleplay as a normal message, without asking for a reply">
                        <i class="fa-solid fa-share"></i> To RP
                    </div>
                </div>
            </div>`;

        document.body.append(panel);
        this.root = panel;

        const input = panel.querySelector('.stmp-ooc-input');

        panel.querySelector('.stmp-ooc-close').addEventListener('click', () => this.close());
        panel.querySelector('.stmp-ooc-send').addEventListener('click', () => this.#sendFromInput());
        panel.querySelector('.stmp-ooc-promote').addEventListener('click', () => void this.#promoteToRoleplay());

        input.addEventListener('keydown', event => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                this.#sendFromInput();
                return;
            }
            // Keep SillyTavern's global hotkeys out of this box.
            event.stopPropagation();
        });
        input.addEventListener('input', () => this.#announceTyping());

        this.#makeDraggable(panel, panel.querySelector('[data-drag-handle]'));
        this.#render();
    }

    #makeDraggable(panel, handle) {
        let startX = 0, startY = 0, originLeft = 0, originTop = 0, dragging = false;

        const onMove = event => {
            if (!dragging) return;
            const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
            const maxTop = Math.max(0, window.innerHeight - panel.offsetHeight);
            panel.style.left = `${Math.min(maxLeft, Math.max(0, originLeft + event.clientX - startX))}px`;
            panel.style.top = `${Math.min(maxTop, Math.max(0, originTop + event.clientY - startY))}px`;
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
        };

        const onUp = () => {
            dragging = false;
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
        };

        handle.addEventListener('pointerdown', event => {
            if (event.target.closest('.stmp-ooc-close')) return;
            dragging = true;
            startX = event.clientX;
            startY = event.clientY;
            const box = panel.getBoundingClientRect();
            originLeft = box.left;
            originTop = box.top;
            document.addEventListener('pointermove', onMove);
            document.addEventListener('pointerup', onUp);
        });
    }

    // -- open / close -------------------------------------------------------

    toggle() {
        this.open ? this.close() : this.openPanel();
    }

    openPanel() {
        // State first, DOM second: the channel's behaviour should not depend on
        // whether the panel happens to be mounted yet.
        this.open = true;
        this.unread = 0;

        if (!this.root) return;
        this.root.hidden = false;
        this.#renderBadge();
        this.#scrollToBottom();
        this.root.querySelector('.stmp-ooc-input')?.focus();
    }

    close() {
        this.open = false;
        if (this.root) this.root.hidden = true;
    }

    // -- outbound -----------------------------------------------------------

    #sendFromInput() {
        const input = this.root?.querySelector('.stmp-ooc-input');
        const text = input?.value?.trim();
        if (!text) return;

        if (!this.deps.isConnected()) {
            this.deps.toastr.warning('Join or host a session to use player chat.', 'Not connected');
            return;
        }

        // Nothing is added locally: the relay echoes the message back, which is
        // what keeps everyone's ordering identical.
        this.deps.send({ op: OP.OOC_MESSAGE, text: text.slice(0, OOC.MAX_LENGTH) });
        input.value = '';
        input.focus();
    }

    #announceTyping() {
        if (!this.deps.isConnected()) return;
        const now = Date.now();
        if (now - this._lastTypingSentAt < OOC.TYPING_INTERVAL_MS) return;
        this._lastTypingSentAt = now;
        this.deps.send({ op: OP.OOC_TYPING });
    }

    /**
     * Deliberate escape hatch: post the composed text into the roleplay as a
     * normal user message, without asking the model for a reply.
     *
     * This uses SillyTavern's built-in `/send`, the same command Guided
     * Generations' Simple Send wraps, so behaviour matches the button people
     * already know. Requires a host, since the host owns the transcript.
     */
    async #promoteToRoleplay() {
        const input = this.root?.querySelector('.stmp-ooc-input');
        const text = input?.value?.trim();
        if (!text) {
            this.deps.toastr.info('Type something first.', 'Player chat');
            return;
        }

        const context = this.deps.getContext();
        if (typeof context.executeSlashCommandsWithOptions !== 'function') {
            this.deps.toastr.error('This build of SillyTavern does not expose the slash command runner.', 'Cannot post');
            return;
        }

        const VAR = 'stmpOocOutbound';
        try {
            // Routed through a variable rather than interpolated into the
            // command string, so text containing pipes, braces or quotes cannot
            // be parsed as script. Cleared immediately afterwards.
            context.variables.local.set(VAR, text);
            await context.executeSlashCommandsWithOptions(`/send {{getvar::${VAR}}}`, { handleParserErrors: true });
            input.value = '';
            this.deps.toastr.success('Posted to the roleplay without asking for a reply.', 'Player chat');
        } catch (error) {
            console.error('[Multiplayer] Could not post to the roleplay', error);
            this.deps.toastr.error(error?.message ?? String(error), 'Could not post');
        } finally {
            try { context.variables.local.del(VAR); } catch { /* nothing to clean up */ }
        }
    }

    // -- inbound ------------------------------------------------------------

    /** One message relayed from the room. */
    receive(payload) {
        if (!payload || typeof payload.text !== 'string') return;

        this.messages.push({
            id: String(payload.id ?? ''),
            from: String(payload.from ?? ''),
            name: String(payload.name ?? 'Player').slice(0, 40),
            role: payload.role === 'host' ? 'host' : 'client',
            text: payload.text.slice(0, OOC.MAX_LENGTH),
            sentAt: Number(payload.sentAt) || Date.now(),
        });
        if (this.messages.length > OOC.RENDER_LIMIT) {
            this.messages.splice(0, this.messages.length - OOC.RENDER_LIMIT);
        }

        this.typing.delete(payload.from);

        const mine = payload.from && payload.from === this.deps.peerId();
        if (!this.open && !mine) {
            this.unread += 1;
            this.#renderBadge();
        }

        this.#appendMessage(this.messages[this.messages.length - 1]);
        this.#renderTyping();
        this.#scrollToBottom();
    }

    /** Backlog handed over by the relay when this peer is seated. */
    receiveHistory(payload) {
        if (!Array.isArray(payload?.messages)) return;
        this.messages = [];
        for (const message of payload.messages.slice(-OOC.RENDER_LIMIT)) {
            this.messages.push({
                id: String(message.id ?? ''),
                from: String(message.from ?? ''),
                name: String(message.name ?? 'Player').slice(0, 40),
                role: message.role === 'host' ? 'host' : 'client',
                text: String(message.text ?? '').slice(0, OOC.MAX_LENGTH),
                sentAt: Number(message.sentAt) || Date.now(),
            });
        }
        this.#render();
    }

    receiveTyping(payload) {
        if (!payload?.from) return;
        this.typing.set(payload.from, {
            name: String(payload.name ?? 'Someone').slice(0, 40),
            expiresAt: Date.now() + OOC.TYPING_EXPIRY_MS,
        });
        this.#renderTyping();
    }

    /** Session ended: keep the transcript on screen but stop accepting input. */
    onDisconnect() {
        this.typing.clear();
        this.#renderTyping();
        this.#render();
    }

    reset() {
        this.messages = [];
        this.typing.clear();
        this.unread = 0;
        this.#renderBadge();
        this.#render();
    }

    // -- rendering ----------------------------------------------------------

    #render() {
        const log = this.root?.querySelector('.stmp-ooc-log');
        if (!log) return;
        log.textContent = '';

        if (this.messages.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'stmp-ooc-empty';
            empty.textContent = this.deps.isConnected()
                ? 'Nothing here yet. Anything you type stays between the players.'
                : 'Join or host a session to chat with the other players.';
            log.append(empty);
        } else {
            for (const message of this.messages) this.#appendMessage(message, log);
        }
        this.#renderBadge();
        this.#scrollToBottom();
    }

    /**
     * Builds each row with createElement and textContent rather than innerHTML.
     * Message text comes from other people over the network, so it is treated as
     * data and never parsed as markup.
     */
    #appendMessage(message, container = null) {
        const log = container ?? this.root?.querySelector('.stmp-ooc-log');
        if (!log) return;
        log.querySelector('.stmp-ooc-empty')?.remove();

        const mine = message.from && message.from === this.deps.peerId();

        const row = document.createElement('div');
        row.className = `stmp-ooc-row${mine ? ' stmp-ooc-mine' : ''}`;

        const meta = document.createElement('div');
        meta.className = 'stmp-ooc-meta';

        const who = document.createElement('span');
        who.className = 'stmp-ooc-who';
        who.textContent = message.name;
        if (message.role === 'host') {
            const crown = document.createElement('i');
            crown.className = 'fa-solid fa-crown stmp-ooc-crown';
            crown.title = 'Host';
            who.append(' ', crown);
        }

        const when = document.createElement('span');
        when.className = 'stmp-ooc-when';
        when.textContent = new Date(message.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        const body = document.createElement('div');
        body.className = 'stmp-ooc-text';
        body.textContent = message.text;

        meta.append(who, when);
        row.append(meta, body);
        log.append(row);

        while (log.childElementCount > OOC.RENDER_LIMIT) log.firstElementChild.remove();
    }

    #renderTyping() {
        const element = this.root?.querySelector('.stmp-ooc-typing');
        if (!element) return;

        const now = Date.now();
        for (const [peerId, record] of this.typing) {
            if (record.expiresAt < now) this.typing.delete(peerId);
        }

        const names = [...this.typing.values()].map(record => record.name);
        element.textContent = names.length === 0 ? ''
            : names.length === 1 ? `${names[0]} is typing…`
                : names.length === 2 ? `${names[0]} and ${names[1]} are typing…`
                    : 'Several players are typing…';
    }

    #renderBadge() {
        const badge = this.toggleButton?.querySelector('.stmp-ooc-badge');
        if (!badge) return;
        badge.textContent = String(Math.min(99, this.unread));
        badge.hidden = this.unread === 0;
        this.toggleButton.classList.toggle('stmp-ooc-has-unread', this.unread > 0);
    }

    #scrollToBottom() {
        const log = this.root?.querySelector('.stmp-ooc-log');
        if (log) log.scrollTop = log.scrollHeight;
    }
}
