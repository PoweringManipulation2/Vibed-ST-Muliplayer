/**
 * Cloud-hosted character cards.
 *
 * When the host shares a character, every client gets a *stub* card written to
 * their own character list: correct name and avatar, but no definition. The
 * stub carries a marker in `data.extensions.st_multiplayer`, which is what the
 * cloud badge and the click gate key off.
 *
 * Automatic persistence writes only a clean stub and its portrait. Full remote
 * definitions are held in memory during the session and restored on disconnect.
 * This is not DRM: admitted peers, manual saves, exports and other extensions
 * can copy received content. Shared session lore is a separate persisted feature.
 */

import { LIMITS, OP } from './protocol.js';
import { sha256 } from './crypto.js';
import { objectHash, contentHash } from './identity.js';

export const MARKER = 'st_multiplayer';

const encoder = new TextEncoder();

/** Fields that make up a character definition, i.e. what gets hydrated. */
const DEFINITION_FIELDS = [
    'description', 'personality', 'scenario', 'first_mes', 'mes_example',
    'creator_notes', 'system_prompt', 'post_history_instructions',
    'alternate_greetings', 'character_book', 'tags', 'creator',
    'character_version', 'extensions',
];

/**
 * Loads the character's embedded lorebook, plus any World Info book bound to it
 * by name, so a shared card behaves the same on a client as it does for the
 * host. `character_book` is part of the card, but a book attached through the
 * character's "world" setting lives outside it and has to be fetched.
 */
export async function loadCardLore(character, context) {
    const books = [];

    const embedded = character?.data?.character_book;
    if (embedded && Array.isArray(embedded.entries) && embedded.entries.length > 0) {
        books.push({ name: embedded.name ?? 'embedded', source: 'card', book: embedded });
    }

    const worldName = character?.data?.extensions?.world ?? character?.data?.world;
    if (worldName && typeof context.loadWorldInfo === 'function') {
        try {
            const book = await context.loadWorldInfo(worldName);
            if (book) books.push({ name: worldName, source: 'world', book });
        } catch (error) {
            console.warn('[Multiplayer] Could not load the lorebook', worldName, error);
        }
    }

    return books;
}

export function readMarker(character) {
    return character?.data?.extensions?.[MARKER] ?? character?.[MARKER] ?? null;
}

export function isRemoteCard(character) {
    return Boolean(readMarker(character)?.remote);
}

export function remoteCardId(character) {
    return readMarker(character)?.cardId ?? null;
}

async function hashText(text) {
    const digest = await sha256(encoder.encode(text));
    return Array.from(digest.subarray(0, 16), byte => byte.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Host side
// ---------------------------------------------------------------------------

/**
 * Builds the catalogue the host advertises to the room.
 * Only identifying metadata goes out here — no definition text.
 *
 * @param {object[]} characters SillyTavern's `characters` array
 * @param {string[]} sharedAvatars avatar filenames the host chose to share
 * @param {string} roomId
 */
export async function buildCardIndex(characters, sharedAvatars, roomId, options = {}) {
    const shared = new Set(sharedAvatars);
    const index = [];

    for (const character of characters) {
        if (!shared.has(character.avatar)) continue;

        if (isRemoteCard(character) || isSessionCopy(character)) continue;
        const definition = extractDefinition(character);
        const sourceId = options.sourceId?.(character.avatar);
        const ownerId = options.ownerId;
        const avatarHash = options.readAvatar ? await contentHash(await options.readAvatar(character.avatar)) : undefined;
        const entry = {
            cardId: ownerId && sourceId
                ? await hashText(`${ownerId}\u0000${sourceId}`)
                : await hashText(`${roomId}\u0000${character.avatar}`),
            ...(ownerId && sourceId ? { ownerId, sourceId } : {}),
            avatarHash,
            name: character.name,
            avatar: character.avatar,
            defHash: await objectHash(definition),
            creator: character.data?.creator ?? '',
            summary: String(character.data?.creator_notes ?? '').slice(0, 240),
            tags: Array.isArray(character.data?.tags) ? character.data.tags.slice(0, 12) : [],
        };
        entry.revision = await objectHash(entry);
        index.push(entry);
    }

    return index;
}

/** Pulls the definition fields out of a full SillyTavern character object. */
export function extractDefinition(character) {
    const data = character?.data ?? {};
    const definition = {};
    for (const field of DEFINITION_FIELDS) {
        const value = data[field] ?? character[field];
        if (value !== undefined) definition[field] = value;
    }
    // Never ship the host's private multiplayer bookkeeping to peers.
    if (definition.extensions && typeof definition.extensions === 'object') {
        definition.extensions = { ...definition.extensions };
        delete definition.extensions[MARKER];
    }
    return definition;
}

/**
 * Splits an avatar image into ordered chunks so a large PNG cannot stall the
 * socket or spike memory on either end.
 * @returns {AsyncGenerator<{op: string, cardId: string, seq: number, total: number, bytes: Uint8Array}>}
 */
export async function* streamAvatar(cardId, bytes) {
    const total = Math.max(1, Math.ceil(bytes.length / LIMITS.CHUNK_BYTES));
    for (let seq = 0; seq < total; seq++) {
        const start = seq * LIMITS.CHUNK_BYTES;
        yield {
            op: OP.CARDS_AVATAR,
            cardId,
            seq,
            total,
            bytes: bytes.subarray(start, start + LIMITS.CHUNK_BYTES),
        };
    }
}

/** Fetches a local avatar PNG as raw bytes, ready for {@link streamAvatar}. */
export async function readLocalAvatar(avatarFileName) {
    const response = await fetch(`/characters/${encodeURIComponent(avatarFileName)}`, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`Could not read avatar ${avatarFileName}`);
    return new Uint8Array(await response.arrayBuffer());
}

/** Local filename for the host's session copy of a shared card. */
export function sessionFileName(cardId) {
    return `stmp_session_${cardId.slice(0, 12)}`;
}

/** True for a host-side session copy (as opposed to a client-side stub). */
export function isSessionCopy(character) {
    return Boolean(readMarker(character)?.session);
}

/**
 * Creates the host's session copy of a shared character.
 *
 * The shared roleplay used the original character and therefore its existing
 * chat, which mixed a multiplayer session into a private history and meant the
 * "session" was indistinguishable from ordinary local play. A copy keeps the two
 * apart: the original is never touched, and the copy is unambiguously the shared
 * one — it carries the marker the session logic keys off.
 *
 * @param {object} character the local character being shared
 * @param {{cardId: string, roomName: string, getRequestHeaders: Function}} options
 * @returns {Promise<string>} the copy's avatar filename
 */
export function makeSessionCard(character, { cardId, roomName, ownerId, sourceId, revision, defHash }) {
    const definition = extractDefinition(character);

    const card = {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        name: `${character.name} (shared)`,
        description: definition.description ?? '',
        personality: definition.personality ?? '',
        scenario: definition.scenario ?? '',
        first_mes: definition.first_mes ?? '',
        mes_example: definition.mes_example ?? '',
        creatorcomment: `Multiplayer session copy of "${character.name}" for ${roomName}. The original is untouched.`,
        talkativeness: String(character.talkativeness ?? '0.5'),
        tags: Array.isArray(definition.tags) ? definition.tags : [],
        data: {
            ...definition,
            name: `${character.name} (shared)`,
            creator_notes: `Multiplayer session copy of "${character.name}". Chat here is shared with the room.`,
            extensions: {
                ...(definition.extensions ?? {}),
                [MARKER]: {
                    session: true,
                    ownerId, sourceId, revision, defHash,
                    cardId,
                    originalAvatar: character.avatar,
                    originalName: character.name,
                    createdAt: Date.now(),
                },
            },
        },
    };

    return card;
}

export async function createSessionCopy(character, options) {
    return importCard(makeSessionCard(character, options), sessionFileName(options.cardId), options);
}

export async function importCard(card, fileName, { getRequestHeaders }) {
    const form = new FormData();
    form.append('avatar', new File([JSON.stringify(card)], `${fileName}.json`, { type: 'application/json' }));
    form.append('file_type', 'json');
    form.append('preserved_name', fileName);

    const response = await fetch('/api/characters/import', {
        method: 'POST',
        body: form,
        headers: getRequestHeaders({ omitContentType: true }),
        cache: 'no-cache',
    });
    if (!response.ok) throw new Error(`Could not create the session copy (${response.status})`);
    const result = await response.json();
    if (result?.error || typeof result?.file_name !== 'string' || !result.file_name) {
        throw new Error('Character import did not confirm a saved filename; resync to recover safely.');
    }
    return `${result.file_name}.png`;
}

// ---------------------------------------------------------------------------
// Client side
// ---------------------------------------------------------------------------

/** Stable, collision-free local filename for a hosted card. */
export function stubFileName(roomId, cardId) {
    return `stmp_${roomId.slice(0, 8)}_${cardId.slice(0, 12)}`;
}

/**
 * Writes (or refreshes) the local stub card for one hosted character.
 * Returns the avatar filename SillyTavern assigned.
 */
export function makeStubCard(entry, { roomId, hostName }) {

    const card = {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        name: entry.name,
        description: '',
        personality: '',
        scenario: '',
        first_mes: '',
        mes_example: '',
        creatorcomment: `Hosted by ${hostName}. Connect to the Multiplayer session to use this character.`,
        talkativeness: '0.5',
        tags: [],
        data: {
            name: entry.name,
            description: '',
            personality: '',
            scenario: '',
            first_mes: '',
            mes_example: '',
            creator_notes: `Hosted by ${hostName}. Connect to the Multiplayer session to use this character.`,
            system_prompt: '',
            post_history_instructions: '',
            alternate_greetings: [],
            character_book: undefined,
            tags: Array.isArray(entry.tags) ? entry.tags : [],
            creator: entry.creator ?? hostName,
            character_version: '',
            extensions: {
                [MARKER]: {
                    remote: true,
                    ownerId: entry.ownerId, sourceId: entry.sourceId, revision: entry.revision,
                    roomId,
                    cardId: entry.cardId,
                    hostName,
                    defHash: entry.defHash,
                    updatedAt: Date.now(),
                },
            },
        },
    };

    return card;
}

export async function materialiseStub(entry, options) {
    const fileName = stubFileName(options.roomId, entry.cardId);
    try {
        return await importCard(makeStubCard(entry, options), fileName, options);
    } catch (error) {
        throw new Error(`Import failed for "${entry.name}": ${error.message}`);
    }
}

/** Edit the existing filename, preserving local chat/favourite metadata and portrait.
 * Never use a hydrated in-memory object here: callers supply a clean card body.
 */
export async function editCard(card, existing, { getRequestHeaders }, avatarBytes = null) {
    const data = card.data ?? {};
    const body = {
        avatar_url: existing.avatar,
        ch_name: card.name,
        description: data.description ?? '', personality: data.personality ?? '',
        scenario: data.scenario ?? '', first_mes: data.first_mes ?? '', mes_example: data.mes_example ?? '',
        creator_notes: data.creator_notes ?? '', system_prompt: data.system_prompt ?? '',
        post_history_instructions: data.post_history_instructions ?? '',
        alternate_greetings: data.alternate_greetings ?? [], tags: data.tags ?? [],
        creator: data.creator ?? '', character_version: data.character_version ?? '',
        talkativeness: existing.talkativeness ?? '0.5', fav: String(existing.fav ?? false),
        chat: existing.chat, create_date: existing.create_date,
        world: data.extensions?.world ?? '',
        depth_prompt_prompt: data.extensions?.depth_prompt?.prompt ?? '',
        depth_prompt_depth: data.extensions?.depth_prompt?.depth ?? 4,
        depth_prompt_role: data.extensions?.depth_prompt?.role ?? 'system',
        extensions: JSON.stringify({ ...(data.extensions ?? {}), fav: Boolean(existing.fav) }),
        group_only_greetings: data.group_only_greetings ?? [],
        // json_data preserves fields not exposed in the normal form, including the marker.
        json_data: JSON.stringify(card),
    };
    let requestBody = JSON.stringify(body);
    if (avatarBytes) {
        // The multipart edit endpoint also exists on ST 1.13, unlike edit-avatar.
        // Serialize the complete clean disk card, never the hydrated UI object.
        requestBody = new FormData();
        for (const [key, value] of Object.entries(body)) {
            if (value === undefined) continue;
            if (Array.isArray(value)) {
                // Express's multipart parser recognises indexed array fields.
                value.forEach((item, index) => requestBody.append(`${key}[${index}]`, String(item)));
            } else requestBody.append(key, String(value));
        }
        requestBody.append('avatar', new File([avatarBytes], 'avatar.png', { type: 'image/png' }));
    }
    const response = await fetch('/api/characters/edit', {
        method: 'POST', headers: getRequestHeaders({ omitContentType: Boolean(avatarBytes) }),
        body: requestBody, cache: 'no-cache',
    });
    if (!response.ok) throw new Error(`Character update failed (${response.status})`);
}

/** Replaces a stub's placeholder avatar with the host's real one. */
export async function applyStubAvatar(avatarFileName, bytes, { getRequestHeaders }) {
    const form = new FormData();
    form.append('avatar', new File([bytes], 'avatar.png', { type: 'image/png' }));
    form.append('avatar_url', avatarFileName);

    const response = await fetch('/api/characters/edit-avatar', {
        method: 'POST',
        body: form,
        headers: getRequestHeaders({ omitContentType: true }),
        cache: 'no-cache',
    });
    if (!response.ok) throw new Error(`Avatar update failed (${response.status})`);
}

/**
 * Tracks which in-memory characters have been hydrated so every field can be
 * restored exactly on disconnect.
 */
export class HydrationTracker {
    /** @type {Map<string, {avatar: string, original: object}>} */
    #hydrated = new Map();

    /**
     * Patches a received definition into the live character object.
     * Nothing is persisted — a page reload leaves the stub as it was.
     */
    hydrate(character, definition) {
        if (!character) return false;

        const previous = this.#hydrated.get(character.avatar);
        if (previous?.character !== character) {
            // ST or another extension may replace the list object without going
            // through our refresh hook. Restore the detached object before its
            // reference is displaced, so it cannot retain a session definition.
            if (previous?.character) {
                for (const field of DEFINITION_FIELDS) {
                    previous.character[field] = structuredCloneSafe(previous.original[field]);
                    if (previous.character.data) previous.character.data[field] = structuredCloneSafe(previous.original[`data.${field}`]);
                }
            }
            const original = {};
            for (const field of DEFINITION_FIELDS) {
                original[field] = structuredCloneSafe(character[field]);
                original[`data.${field}`] = structuredCloneSafe(character.data?.[field]);
            }
            this.#hydrated.set(character.avatar, { avatar: character.avatar, character, original });
        }

        character.data ??= {};
        // A new definition is a replacement, not a partial merge. Removed fields
        // must not survive from the previous revision.
        const baseline = this.#hydrated.get(character.avatar).original;
        for (const field of DEFINITION_FIELDS) {
            character[field] = structuredCloneSafe(baseline[field]);
            character.data[field] = structuredCloneSafe(baseline[`data.${field}`]);
        }
        for (const [field, value] of Object.entries(definition)) {
            if (!DEFINITION_FIELDS.includes(field)) continue;
            if (field === 'extensions') {
                // Local markers survive, but stub defaults must not override the
                // host's world/depth settings. Those fields are session-only.
                const marker = character.data.extensions?.[MARKER];
                character.data.extensions = { ...(character.data.extensions ?? {}), ...structuredCloneSafe(value ?? {}),
                    ...(marker ? { [MARKER]: marker } : {}) };
                character.extensions = structuredCloneSafe(character.data.extensions);
                continue;
            }
            character[field] = structuredCloneSafe(value);
            character.data[field] = structuredCloneSafe(value);
        }
        return true;
    }

    /** Reverses every hydration, leaving the stubs inert again. */
    dehydrateAll(characters) {
        for (const [avatar, record] of this.#hydrated) {
            const character = record.character ?? characters.find(candidate => candidate.avatar === avatar);
            if (!character) continue;
            for (const field of DEFINITION_FIELDS) {
                character[field] = record.original[field];
                if (character.data) character.data[field] = record.original[`data.${field}`];
            }
        }
        this.#hydrated.clear();
    }

    isHydrated(avatar) {
        return this.#hydrated.has(avatar);
    }

    get size() {
        return this.#hydrated.size;
    }
}

function structuredCloneSafe(value) {
    if (value === undefined || value === null) return value;
    try {
        return structuredClone(value);
    } catch {
        return value;
    }
}

/**
 * Reassembles chunked avatar transfers.
 * Bounded by the frame limit so a malicious `total` cannot exhaust memory.
 */
export class ChunkAssembler {
    #pending = new Map();
    #maxPending = 8;

    push({ cardId, seq, total, bytes }) {
        if (!Number.isInteger(total) || total < 1 || total > 4096) throw new Error('Invalid chunk count');
        if (!(bytes instanceof Uint8Array) || bytes.length > LIMITS.CHUNK_BYTES) throw new Error('Invalid avatar chunk');
        for (const [key, held] of this.#pending) {
            if (Date.now() - held.updatedAt > 120000) this.#pending.delete(key);
        }

        let record = this.#pending.get(cardId);
        if (!record) {
            if (this.#pending.size >= this.#maxPending) throw new Error('Too many incomplete avatar transfers');
            record = { total, received: 0, size: 0, parts: new Array(total), updatedAt: Date.now() };
            this.#pending.set(cardId, record);
        }
        if (record.total !== total) throw new Error('Chunk count changed mid-transfer');
        if (!Number.isInteger(seq) || seq < 0 || seq >= total) throw new Error('Chunk index out of range');
        if (record.parts[seq]) return null;

        record.updatedAt = Date.now();
        record.parts[seq] = bytes;
        record.received += 1;
        record.size += bytes.length;
        if (record.size > LIMITS.MAX_FRAME_BYTES * 8) {
            this.#pending.delete(cardId);
            throw new Error('Transfer exceeded the size limit');
        }
        if (record.received < record.total) return null;

        this.#pending.delete(cardId);
        const out = new Uint8Array(record.size);
        let offset = 0;
        for (const part of record.parts) {
            out.set(part, offset);
            offset += part.length;
        }
        return out;
    }

    clear() {
        this.#pending.clear();
    }
}
