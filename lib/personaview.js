/**
 * The room view: who is here, who they are playing, and what the model can
 * actually see of them.
 *
 * What was wrong with the old profile popup
 * -----------------------------------------
 * It showed one player at a time, so comparing two personas meant closing and
 * reopening. It never showed the portrait, even once portraits started
 * travelling with personas. It flattened a 64-entry lorebook into a single
 * monospace block, joined by blank lines, silently capping at 40 entries and
 * truncating each one to 220 characters — so the heading said 64 and the body
 * showed part of 40, with nothing to search and no way to read the rest.
 *
 * And it ended on a line reporting the persona's `position` and `depth`, which
 * is the setting from the machine that *sent* the persona. Nothing on this side
 * uses it: remote descriptions reach the model through the multiplayer block
 * (see ChatBridge#injectPersonas), all together, at one depth. The one line
 * claiming to explain how a persona reaches the model was describing something
 * that does not happen here.
 *
 * What this shows instead
 * ----------------------
 * The organising question is not "what does this persona say" but "can the model
 * see it". Every persona and every lorebook is in one of a few states, and the
 * state is the first thing on screen rather than a footnote: a filled marker
 * means it is in the prompt right now, a hollow one means it is not. The roster
 * carries the same markers, so the state of the whole room reads at a glance.
 *
 * Everything here is built with textContent and DOM nodes. Every field arrived
 * from another player over the network, and none of it is ever parsed as HTML.
 */

/** Marker states, in the order they degrade. */
export const STATE = Object.freeze({
    LIVE: 'live',       // the model is being given this
    WAITING: 'waiting', // received, but not reaching the model yet
    ABSENT: 'absent',   // nothing to give
});

/**
 * Whether a persona's description is reaching the model, in the reader's terms.
 *
 * @param {object} persona
 * @param {{isMe?: boolean, injectDepth?: number}} options
 */
export function personaStatus(persona, { isMe = false, injectDepth = 4 } = {}) {
    if (!persona?.description) {
        return {
            state: STATE.ABSENT,
            label: 'Name only',
            detail: isMe
                ? 'Your persona has no description, so the room only learns your name. Add one in Persona Management.'
                : 'This player has not written a persona description, so the model only has their name.',
        };
    }

    if (isMe) {
        // SillyTavern injects your own persona itself, using your own settings,
        // which is why this branch does not mention the multiplayer block.
        return {
            state: STATE.LIVE,
            label: 'In the prompt',
            detail: 'SillyTavern injects your own persona using your Persona Management settings.',
        };
    }

    return {
        state: STATE.LIVE,
        label: 'In the prompt',
        detail: `Included in the multiplayer block, ${injectDepth} messages from the end, on every reply.`,
    };
}

/** Normalises a lorebook's entries, which arrive as either an array or a map. */
export function entriesOf(persona) {
    const raw = persona?.lorebook?.entries;
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === 'object') return Object.values(raw);
    return [];
}

/** The keys an entry matches on, as a clean array. */
export function keysOf(entry) {
    const keys = entry?.key ?? entry?.keys ?? [];
    return (Array.isArray(keys) ? keys : [keys])
        .map(key => String(key ?? '').trim())
        .filter(Boolean);
}

/**
 * Whether a lorebook is actually live in the shared chat.
 *
 * @param {object} persona
 * @param {{bound?: boolean, owners?: string[]}|null} sharedLore
 */
export function lorebookStatus(persona, sharedLore) {
    const count = entriesOf(persona).length;

    if (!persona?.lorebookName) {
        return { state: STATE.ABSENT, label: 'No lorebook', detail: '', count: 0 };
    }

    if (count === 0) {
        return {
            state: STATE.WAITING,
            label: 'Entries not shared',
            detail: `"${persona.lorebookName}" is bound on their machine, but its entries did not travel with the persona.`,
            count: 0,
        };
    }

    const bound = Boolean(sharedLore?.bound)
        && (sharedLore.owners ?? []).includes(persona.name);

    return bound
        ? {
            state: STATE.LIVE,
            label: 'Active in this chat',
            detail: 'Merged into the shared lorebook, so World Info activates these entries by keyword like any other book.',
            count,
        }
        : {
            state: STATE.WAITING,
            label: 'Received, not active',
            detail: 'These entries have arrived but are not in the shared lorebook yet, so nothing here can reach the model.',
            count,
        };
}

/** Case-insensitive match across an entry's keys and its content. */
export function matchesQuery(entry, query) {
    const needle = String(query ?? '').trim().toLowerCase();
    if (!needle) return true;
    if (keysOf(entry).some(key => key.toLowerCase().includes(needle))) return true;
    return String(entry?.content ?? '').toLowerCase().includes(needle);
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
};

function marker(state) {
    const dot = el('span', `stmp-state stmp-state-${state}`);
    dot.setAttribute('aria-hidden', 'true');
    return dot;
}

function initials(name) {
    return String(name ?? '?')
        .split(/\s+/)
        .slice(0, 2)
        .map(part => part[0] ?? '')
        .join('')
        .toUpperCase() || '?';
}

function portrait(persona, size) {
    const frame = el('div', `stmp-portrait stmp-portrait-${size}`);
    if (persona.avatarData) {
        const img = el('img');
        img.src = persona.avatarData;
        img.alt = '';
        frame.append(img);
    } else {
        // A missing portrait is normal for a peer on an older build, so this is a
        // fallback rather than an error state.
        frame.append(el('span', 'stmp-portrait-initials', initials(persona.name)));
    }
    return frame;
}

/** A labelled status line: marker, short label, plain-language explanation. */
function statusLine(status) {
    const row = el('div', 'stmp-status');
    row.append(marker(status.state), el('b', null, status.label));
    if (status.detail) row.append(el('span', 'stmp-status-detail', status.detail));
    return row;
}

function lorebookPanel(persona, status) {
    const panel = el('section', 'stmp-lore');
    const entries = entriesOf(persona);

    const head = el('div', 'stmp-lore-head');
    head.append(el('b', null, persona.lorebookName));
    head.append(el('span', 'stmp-count', `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`));
    panel.append(head, statusLine(status));

    if (entries.length === 0) return panel;

    // Search earns its place at this size: a 64-entry book is not something you
    // read, it is something you look things up in.
    const search = el('input', 'text_pole stmp-lore-search');
    search.type = 'search';
    search.placeholder = `Search ${entries.length} entries`;
    search.setAttribute('aria-label', `Search ${persona.lorebookName}`);
    panel.append(search);

    const list = el('div', 'stmp-lore-list');
    const empty = el('p', 'stmp-muted stmp-lore-empty', 'No entry matches that.');
    empty.hidden = true;

    const rows = entries.map(entry => {
        const keys = keysOf(entry);
        const content = String(entry?.content ?? '');

        // <details> rather than a click handler: keyboard support, screen-reader
        // semantics and open/close state all come for free and correct.
        const row = el('details', 'stmp-entry');
        const summary = el('summary');

        const chips = el('span', 'stmp-keys');
        if (keys.length === 0) {
            chips.append(el('code', 'stmp-key stmp-key-none', 'no keys'));
        } else {
            // Keys are literal strings the World Info engine matches on, so they
            // are set in the monospace face and the content is not. The old view
            // put both in mono, which said nothing about either.
            for (const key of keys.slice(0, 6)) chips.append(el('code', 'stmp-key', key));
            if (keys.length > 6) chips.append(el('span', 'stmp-muted', `+${keys.length - 6}`));
        }

        summary.append(chips);
        summary.append(el('span', 'stmp-entry-peek', content.replace(/\s+/g, ' ')));
        row.append(summary, el('div', 'stmp-entry-body', content));

        // Kept for filtering without re-reading the DOM.
        row._entry = entry;
        return row;
    });

    list.append(...rows, empty);
    panel.append(list);

    search.addEventListener('input', () => {
        let shown = 0;
        for (const row of rows) {
            const hit = matchesQuery(row._entry, search.value);
            row.hidden = !hit;
            if (hit) shown++;
        }
        empty.hidden = shown > 0;
    });

    return panel;
}

function detailPane(persona, { sharedLore, injectDepth }) {
    const pane = el('div', 'stmp-detail');
    const status = personaStatus(persona, { isMe: persona.isMe, injectDepth });

    const header = el('header', 'stmp-detail-head');
    header.append(portrait(persona, 'lg'));

    const titles = el('div', 'stmp-titles');
    titles.append(el('h3', null, persona.name || 'Unnamed persona'));

    const played = persona.isMe
        ? 'You'
        : `${persona.playerName}${persona.role === 'host' ? ' — host' : ''}`;
    titles.append(el('p', 'stmp-muted', `Played by ${played}`));
    header.append(titles);
    pane.append(header, statusLine(status));

    const description = el('section', 'stmp-section');
    description.append(el('b', null, 'Description'));
    description.append(persona.description
        ? el('div', 'stmp-persona-text', persona.description)
        : el('p', 'stmp-muted', 'Nothing written yet.'));
    pane.append(description);

    const lore = lorebookStatus(persona, sharedLore);
    if (persona.lorebookName) pane.append(lorebookPanel(persona, lore));

    return pane;
}

/**
 * Builds the whole room view.
 *
 * @param {object[]} personas from Session#personaList()
 * @param {{sharedLore?: object|null, injectDepth?: number, selected?: string|null}} options
 * @returns {HTMLElement}
 */
export function buildRoomView(personas, { sharedLore = null, injectDepth = 4, selected = null } = {}) {
    const root = el('div', 'stmp-room');

    if (!personas || personas.length === 0) {
        root.append(el('p', 'stmp-muted', 'Nobody has published a persona yet. They appear here as players join.'));
        return root;
    }

    // The host first, then everyone else as they are: the roster is a room, and
    // sorting it by anything else would make it move around under the reader.
    const ordered = [...personas].sort((a, b) => (b.role === 'host') - (a.role === 'host'));

    const rail = el('nav', 'stmp-rail');
    rail.setAttribute('aria-label', 'Players');
    const pane = el('div', 'stmp-pane');

    const show = persona => {
        pane.replaceChildren(detailPane(persona, { sharedLore, injectDepth }));
        for (const button of rail.children) {
            button.classList.toggle('stmp-rail-on', button.dataset.peer === persona.peerId);
            button.setAttribute('aria-current', button.dataset.peer === persona.peerId ? 'true' : 'false');
        }
    };

    for (const persona of ordered) {
        const button = el('button', 'stmp-rail-item');
        button.type = 'button';
        button.dataset.peer = persona.peerId;

        button.append(portrait(persona, 'sm'));

        const text = el('span', 'stmp-rail-text');
        text.append(el('span', 'stmp-rail-name', persona.name || 'Unnamed'));

        // Two markers, so the room's state reads without opening anyone: whether
        // the description is in the prompt, and whether the lorebook is live.
        const marks = el('span', 'stmp-rail-marks');
        marks.append(marker(personaStatus(persona, { isMe: persona.isMe, injectDepth }).state));
        if (persona.lorebookName) marks.append(marker(lorebookStatus(persona, sharedLore).state));
        text.append(marks);

        button.append(text);
        button.addEventListener('click', () => show(persona));
        rail.append(button);
    }

    root.append(rail, pane);

    const initial = ordered.find(persona => persona.peerId === selected) ?? ordered[0];
    show(initial);

    const legend = el('p', 'stmp-legend');
    for (const [state, meaning] of [
        [STATE.LIVE, 'the model sees this'],
        [STATE.WAITING, 'received, not reaching it yet'],
        [STATE.ABSENT, 'nothing to send'],
    ]) {
        const item = el('span', 'stmp-legend-item');
        item.append(marker(state), el('span', null, meaning));
        legend.append(item);
    }
    root.append(legend);

    return root;
}
