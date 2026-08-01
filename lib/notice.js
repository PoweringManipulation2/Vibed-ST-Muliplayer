/**
 * Generation notices for the shared chat.
 *
 * Shows a banner above the transcript saying who asked for a reply and whether
 * it has started, e.g. "GreenHouse asked for a reply — waiting for the host".
 *
 * Why this needs to exist
 * ----------------------
 * In a single-player chat the state of the model is obvious: you pressed send,
 * so you know something is coming. In a shared room it is invisible. Another
 * player triggers a generation on the host's machine and everyone else sees
 * nothing at all until tokens start arriving, so they carry on typing and send
 * a turn into the middle of a reply that was already being written. The turn
 * then lands after the reply and reads as a non-sequitur, or worse, arrives
 * mid-generation and is not in the context the model actually saw.
 *
 * The typing indicator does not cover this: it says who is *composing*, which
 * stops at the moment the interesting part begins.
 *
 * Design notes
 * ------------
 * Nothing here touches the chat array, so a notice can never end up in a
 * transcript, a prompt or a token count.
 *
 * Every notice carries its own expiry. A host that crashes mid-generation, or a
 * GEN_END frame lost to a reconnect, would otherwise leave a banner claiming a
 * reply is coming forever — which is worse than no banner, because people would
 * stop trusting it.
 */

/** Phases a notice can be in. */
export const PHASE = Object.freeze({
    PENDING: 'pending',
    RUNNING: 'running',
    DONE: 'done',
});

/**
 * Safety expiry per phase.
 *
 * Pending is short: it only covers the gap between the host accepting a request
 * and SillyTavern actually starting, which is milliseconds unless something has
 * gone wrong. Running is generous, because a long reply on a slow local model
 * legitimately takes minutes and expiring early would be a lie in the other
 * direction.
 */
const EXPIRY_MS = Object.freeze({
    [PHASE.PENDING]: 30000,
    [PHASE.RUNNING]: 300000,
});

export class GenerationNotice {
    /**
     * @param {object} deps
     * @param {() => boolean} deps.isActive whether the shared session is live
     */
    constructor(deps = {}) {
        this.deps = deps;
        /** @type {{phase: string, by: string|null, expiresAt: number}|null} */
        this.current = null;
        this.bar = null;
        this._sweeper = null;
    }

    // -- mounting -----------------------------------------------------------

    mount() {
        if (this.bar) return;

        this.bar = document.createElement('div');
        this.bar.id = 'stmp_generation_bar';
        // polite rather than assertive: a screen reader should finish the
        // sentence it is on rather than interrupt for this.
        this.bar.setAttribute('aria-live', 'polite');
        this.bar.hidden = true;

        // Above the transcript rather than above the composer, where the typing
        // indicator already lives. Two bars stacked on the send box would compete,
        // and this one is about the state of the room rather than the state of
        // your own text box.
        const chat = document.querySelector('#chat');
        if (chat?.parentNode) chat.parentNode.insertBefore(this.bar, chat);
        else document.body.append(this.bar);

        this._sweeper = setInterval(() => this.sweep(), 1000);
        this.#render();
    }

    destroy() {
        clearInterval(this._sweeper);
        this._sweeper = null;
        this.bar?.remove();
        this.bar = null;
        this.current = null;
    }

    // -- state --------------------------------------------------------------

    /**
     * Applies a notice. Safe to call with anything that arrived off the wire.
     * @param {{phase?: string, by?: string|null}} payload
     */
    show(payload = {}) {
        const phase = payload.phase;
        if (phase === PHASE.DONE) return this.clear();
        if (phase !== PHASE.PENDING && phase !== PHASE.RUNNING) return;

        // A running notice must not be demoted back to pending by a late or
        // duplicated frame, or the banner flickers backwards mid-reply.
        if (this.current?.phase === PHASE.RUNNING && phase === PHASE.PENDING) {
            this.current.expiresAt = Date.now() + EXPIRY_MS[PHASE.RUNNING];
            return;
        }

        this.current = {
            phase,
            // The name is remembered across the pending -> running transition:
            // GENERATION_STARTED knows nothing about who asked, and losing the
            // attribution halfway through defeats the point of the banner.
            by: payload.by === undefined ? (this.current?.by ?? null) : this.#cleanName(payload.by),
            expiresAt: Date.now() + (EXPIRY_MS[phase] ?? EXPIRY_MS[PHASE.PENDING]),
        };
        this.#render();
    }

    clear() {
        if (!this.current) return;
        this.current = null;
        this.#render();
    }

    /** Called on disconnect and on chat change: any claim we were making is void. */
    reset() {
        this.clear();
    }

    #cleanName(value) {
        const name = String(value ?? '').trim().slice(0, 40);
        return name || null;
    }

    /**
     * Drops a notice that has outlived its expiry. Called on a timer while
     * mounted; public so it can be exercised without a DOM.
     */
    sweep() {
        if (!this.current) return;
        if (Date.now() < this.current.expiresAt) return;
        this.current = null;
        this.#render();
    }

    // -- rendering ----------------------------------------------------------

    /** The sentence shown to the user, or '' when there is nothing to say. */
    text() {
        if (!this.current) return '';
        const who = this.current.by;
        if (this.current.phase === PHASE.PENDING) {
            return who
                ? `${who} asked for a reply — waiting for the host…`
                : 'A reply was requested — waiting for the host…';
        }
        return who
            ? `Replying to ${who} — hold your turn…`
            : 'The model is replying — hold your turn…';
    }

    #render() {
        if (!this.bar) return;
        const text = this.text();

        if (!text || this.deps.isActive?.() === false) {
            this.bar.hidden = true;
            this.bar.textContent = '';
            this.bar.classList.remove('stmp-generation-visible');
            return;
        }

        this.bar.textContent = text;
        this.bar.hidden = false;
        this.bar.classList.toggle('stmp-generation-running', this.current?.phase === PHASE.RUNNING);
        this.bar.classList.add('stmp-generation-visible');
    }
}
