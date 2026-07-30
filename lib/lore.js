/**
 * Shared persona lorebooks.
 *
 * Players commonly attach a lorebook to their persona, and that lore matters as
 * much as the description — it is where "my character is afraid of water" or "my
 * sword is named X" lives. Sending the description alone gives the model half a
 * person.
 *
 * Why this uses SillyTavern's own engine
 * -------------------------------------
 * The obvious approach is to scan the recent chat for each entry's keywords and
 * paste the matches into the prompt. That is what this extension did first, and
 * it is wrong in ways that matter: it ignores secondary keys and selective logic,
 * per-entry scan depth, whole-word and case-sensitivity settings, insertion
 * position and order, depth for at-depth entries, probability, inclusion groups,
 * recursion, and the token budget. An entry configured to sit at depth 4 as an
 * assistant note would instead be dumped inline as system text.
 *
 * So instead of approximating World Info, this merges the peers' entries into a
 * genuine World Info book, saves it, and binds it to the session chat. From that
 * point SillyTavern activates it exactly as it would any other lorebook, and
 * every one of those settings is honoured because it is the same code path.
 *
 * Binding to the *chat* rather than globally is deliberate: the shared session is
 * its own chat, so the book applies there and provably nowhere else.
 */

/** SillyTavern's key for a chat-bound lorebook (world-info.js METADATA_KEY). */
export const METADATA_KEY = 'world_info';

/** Stable book name, so repeated syncs overwrite rather than accumulate files. */
export const SESSION_BOOK_NAME = 'Multiplayer Session';

/**
 * A complete World Info entry, so merged entries behave like hand-authored ones.
 * Anything the peer supplied wins; these only fill gaps.
 */
const ENTRY_DEFAULTS = Object.freeze({
    key: [],
    keysecondary: [],
    comment: '',
    content: '',
    constant: false,
    vectorized: false,
    selective: true,
    selectiveLogic: 0,
    addMemo: true,
    order: 100,
    position: 0,
    disable: false,
    excludeRecursion: false,
    preventRecursion: false,
    delayUntilRecursion: false,
    probability: 100,
    useProbability: true,
    depth: 4,
    group: '',
    groupOverride: false,
    groupWeight: 100,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    useGroupScoring: null,
    automationId: '',
    role: 0,
    sticky: 0,
    cooldown: 0,
    delay: 0,
});

/** Normalises whatever shape a peer's book arrived in into an array. */
export function readEntries(book) {
    if (!book) return [];
    if (Array.isArray(book.entries)) return book.entries;
    if (book.entries && typeof book.entries === 'object') return Object.values(book.entries);
    if (Array.isArray(book)) return book;
    return [];
}

function toStringArray(value, limit = 64) {
    if (typeof value === 'string') return value ? [value] : [];
    if (!Array.isArray(value)) return [];
    return value.map(item => String(item ?? '')).filter(Boolean).slice(0, limit);
}

/**
 * Merges every peer's persona lorebook into one book.
 *
 * UIDs are reassigned sequentially: two peers' books both start at 0, so keeping
 * the originals would silently overwrite entries. Each entry's comment is
 * prefixed with the owner so the merged book is readable in the editor.
 *
 * @param {Iterable<object>} personas
 * @param {{excludePeerId?: string|null, maxEntries?: number}} [options]
 * @returns {{entries: Record<string, object>, count: number, owners: string[]}}
 */
export function buildSessionBook(personas, { excludePeerId = null, maxEntries = 500 } = {}) {
    const entries = {};
    const owners = [];
    let uid = 0;

    for (const persona of personas ?? []) {
        if (!persona || persona.peerId === excludePeerId) continue;

        const source = readEntries(persona.lorebook);
        if (source.length === 0) continue;
        owners.push(persona.name ?? 'Player');

        for (const raw of source) {
            if (uid >= maxEntries) break;
            if (!raw || typeof raw !== 'object') continue;

            const content = String(raw.content ?? '').slice(0, 20000).trim();
            const keys = toStringArray(raw.key ?? raw.keys);
            // An entry with neither keys nor constant can never fire; a
            // contentless one has nothing to contribute.
            if (!content) continue;
            if (keys.length === 0 && raw.constant !== true) continue;

            entries[uid] = {
                ...ENTRY_DEFAULTS,
                ...raw,
                uid,
                key: keys,
                keysecondary: toStringArray(raw.keysecondary),
                content,
                comment: `[${persona.name ?? 'Player'}] ${String(raw.comment ?? '').slice(0, 200)}`.trim(),
                // Never let a peer's book drive automation on this machine.
                automationId: '',
            };
            uid += 1;
        }
    }

    return { entries, count: uid, owners };
}

/**
 * Saves the merged book and binds it to the current chat.
 *
 * @param {object} context SillyTavern's getContext()
 * @param {Iterable<object>} personas
 * @param {{excludePeerId?: string|null, name?: string}} [options]
 * @returns {Promise<{bound: boolean, count: number, owners: string[], reason?: string}>}
 */
export async function syncSessionBook(context, personas, { excludePeerId = null, name = SESSION_BOOK_NAME } = {}) {
    if (typeof context?.saveWorldInfo !== 'function') {
        return { bound: false, count: 0, owners: [], reason: 'this SillyTavern build does not expose the World Info API' };
    }

    const { entries, count, owners } = buildSessionBook(personas, { excludePeerId });

    if (count === 0) {
        await unbindSessionBook(context, name);
        return { bound: false, count: 0, owners: [] };
    }

    try {
        await context.saveWorldInfo(name, { entries }, true);
        // The name has to be in world_names before a chat can reference it.
        await context.updateWorldInfoList?.();

        const metadata = context.chatMetadata;
        if (metadata) {
            metadata[METADATA_KEY] = name;
            await context.saveMetadata?.();
        }
        return { bound: true, count, owners };
    } catch (error) {
        return { bound: false, count, owners, reason: error?.message ?? String(error) };
    }
}

/**
 * Unbinds the session book from the current chat.
 *
 * The book file is left on disk on purpose: it is overwritten on the next sync,
 * and deleting it would remove something the user might be mid-way through
 * reading in the World Info editor.
 */
export async function unbindSessionBook(context, name = SESSION_BOOK_NAME) {
    const metadata = context?.chatMetadata;
    if (!metadata || metadata[METADATA_KEY] !== name) return false;
    delete metadata[METADATA_KEY];
    await context.saveMetadata?.();
    return true;
}

/** Human-readable summary for the panel. */
export function describeSessionBook({ bound, count, owners, reason }) {
    if (reason) return `Shared lorebooks unavailable: ${reason}`;
    if (!bound || count === 0) return 'No player lorebooks shared.';
    const who = owners.length === 1 ? owners[0] : `${owners.length} players`;
    return `${count} lorebook ${count === 1 ? 'entry' : 'entries'} from ${who}, active in this chat.`;
}
