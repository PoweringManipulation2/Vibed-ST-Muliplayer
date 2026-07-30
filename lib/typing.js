/**
 * Typing indicators for the shared chat.
 *
 * Shows "GreenHouse is typing…" while another player has the send box active,
 * clearing after a short idle period. Two problems it solves in a shared chat:
 * you stop talking over each other, and the room stops feeling dead while
 * somebody composes a long turn.
 *
 * Design notes
 * ------------
 * Keystrokes are not sent. Only two edge events go on the wire — "started" and
 * "stopped" — plus a keepalive while typing continues. Sending on every keypress
 * would be a frame per character.
 *
 * Receivers expire an indicator on their own timer as well, so a peer that
 * crashes mid-sentence does not leave a phantom "still typing" forever.
 *
 * Nothing here touches the chat array, so a typing notice can never end up in a
 * transcript or a prompt.
 */

import { OP } from './protocol.js';

/** Idle time before "stopped typing" is sent and shown. */
export const IDLE_MS = 3000;
/** Minimum gap between keepalives while typing continues. */
const KEEPALIVE_MS = 2000;
/** Safety expiry, in case a "stopped" notice never arrives. */
const EXPIRY_MS = IDLE_MS + 5000;

export class TypingIndicators {
    /**
     * @param {object} deps
     * @param {(payload: object) => void} deps.send
     * @param {() => boolean} deps.isActive whether the shared session is live
     * @param {() => string|null} deps.peerId
     */
    constructor(deps) {
        this.deps = deps;
        /** peerId -> {name, expiresAt} */
        this.active = new Map();

        this.bar = null;
        this.textarea = null;
        this.typing = false;

        this._lastSentAt = 0;
        this._idleTimer = null;
        this._sweeper = null;
        this._onInput = null;
    }

    // -- mounting -----------------------------------------------------------

    mount() {
        if (this.bar) return;

        this.bar = document.createElement('div');
        this.bar.id = 'stmp_typing_bar';
        this.bar.setAttribute('aria-live', 'polite');
        this.bar.hidden = true;

        // Directly above the send form, so it reads as part of the composer
        // rather than as a chat message.
        const form = document.querySelector('#send_form');
        if (form?.parentNode) form.parentNode.insertBefore(this.bar, form);
        else document.body.append(this.bar);

        this.textarea = document.querySelector('#send_textarea');
        if (this.textarea) {
            // `input` rather than `keydown`: it also covers paste, dictation and
            // mobile keyboards, and it does not fire for arrow keys.
            this._onInput = () => this.#onLocalActivity();
            this.textarea.addEventListener('input', this._onInput);
        }

        this._sweeper = setInterval(() => this.#expire(), 1000);
        this.#render();
    }

    destroy() {
        clearInterval(this._sweeper);
        clearTimeout(this._idleTimer);
        if (this.textarea && this._onInput) this.textarea.removeEventListener('input', this._onInput);
        this.bar?.remove();
        this.bar = null;
        this.textarea = null;
        this.active.clear();
        this.typing = false;
    }

    // -- local activity -----------------------------------------------------

    #onLocalActivity() {
        if (!this.deps.isActive()) return;

        // An emptied box means the turn was sent or abandoned.
        if (!this.textarea?.value) {
            this.#stopTyping();
            return;
        }

        const now = Date.now();
        if (!this.typing) {
            this.typing = true;
            this.#send(true);
        } else if (now - this._lastSentAt > KEEPALIVE_MS) {
            this.#send(true);
        }

        clearTimeout(this._idleTimer);
        this._idleTimer = setTimeout(() => this.#stopTyping(), IDLE_MS);
    }

    #stopTyping() {
        clearTimeout(this._idleTimer);
        if (!this.typing) return;
        this.typing = false;
        this.#send(false);
    }

    #send(typing) {
        this._lastSentAt = Date.now();
        this.deps.send({ op: OP.CHAT_TYPING, typing });
    }

    /** Called when a turn is sent, so the indicator clears immediately. */
    onMessageSent() {
        this.#stopTyping();
    }

    /** Called when the session ends or the chat changes. */
    reset() {
        clearTimeout(this._idleTimer);
        this.typing = false;
        this.active.clear();
        this.#render();
    }

    // -- remote activity ----------------------------------------------------

    /**
     * @param {{from?: string, name?: string, typing?: boolean}} payload
     *   `from` and `name` are stamped by the relay, so a peer cannot claim to be
     *   somebody else here.
     */
    receive(payload) {
        const peerId = payload?.from;
        if (!peerId || peerId === this.deps.peerId()) return;

        if (payload.typing === false) {
            this.active.delete(peerId);
        } else {
            this.active.set(peerId, {
                name: String(payload.name ?? 'Someone').slice(0, 40),
                expiresAt: Date.now() + EXPIRY_MS,
            });
        }
        this.#render();
    }

    /** Forgets a peer that has left, so its indicator does not linger. */
    forget(peerId) {
        if (this.active.delete(peerId)) this.#render();
    }

    #expire() {
        const now = Date.now();
        let changed = false;
        for (const [peerId, record] of this.active) {
            if (record.expiresAt < now) {
                this.active.delete(peerId);
                changed = true;
            }
        }
        if (changed) this.#render();
    }

    // -- rendering ----------------------------------------------------------

    /** The sentence shown, or an empty string when nobody is typing. */
    describe() {
        const names = [...this.active.values()].map(record => record.name);
        if (names.length === 0) return '';
        if (names.length === 1) return `${names[0]} is typing…`;
        if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
        if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]} are typing…`;
        return `${names.length} players are typing…`;
    }

    #render() {
        if (!this.bar) return;
        const text = this.describe();

        // textContent, not innerHTML: these names came from other players.
        this.bar.textContent = text;
        this.bar.hidden = text === '';
        this.bar.classList.toggle('stmp-typing-visible', text !== '');
    }
}
