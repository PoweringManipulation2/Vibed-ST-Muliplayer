/**
 * Cloud-hosted character cards.
 *
 * When the host shares a character, every client gets a *stub* card written to
 * their own character list: correct name and avatar, but no definition. The
 * stub carries a marker in `data.extensions.st_multiplayer`, which is what the
 * cloud badge and the click gate key off.
 *
 * The real definition never touches the client's disk. It is streamed over the
 * encrypted session when the card is opened, patched into the in-memory
 * `characters[]` entry for the duration of the session, and wiped on
 * disconnect. That gives the behaviour asked for — the card is visible offline
 * but unusable — and it also means the host's writing does not silently end up
 * copied into someone else's library.
 */

import { LIMITS, OP } from './protocol.js';
import { sha256 } from './crypto.js';

export const MARKER = 'st_multiplayer';

const encoder = new TextEncoder();

/** Fields that make up a character definition, i.e. what gets hydrated. */
const DEFINITION_FIELDS = [
    'description', 'personality', 'scenario', 'first_mes', 'mes_example',
    'creator_notes', 'system_prompt', 'post_history_instructions',
    'alternate_greetings', 'character_book', 'tags', 'creator',
    'character_version', 'extensions',
];

function readMarker(character) {
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
export async function buildCardIndex(characters, sharedAvatars, roomId) {
    const shared = new Set(sharedAvatars);
    const index = [];

    for (const character of characters) {
        if (!shared.has(character.avatar)) continue;

        const definition = extractDefinition(character);
        index.push({
            cardId: await hashText(`${roomId}\u0000${character.avatar}`),
            name: character.name,
            avatar: character.avatar,
            defHash: await hashText(JSON.stringify(definition)),
            creator: character.data?.creator ?? '',
            summary: String(character.data?.creator_notes ?? '').slice(0, 240),
            tags: Array.isArray(character.data?.tags) ? character.data.tags.slice(0, 12) : [],
        });
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
    const response = await fetch(`/characters/${encodeURIComponent(avatarFileName)}`, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`Could not read avatar ${avatarFileName}`);
    return new Uint8Array(await response.arrayBuffer());
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
export async function materialiseStub(entry, { roomId, hostName, getRequestHeaders }) {
    const fileName = stubFileName(roomId, entry.cardId);

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
                    roomId,
                    cardId: entry.cardId,
                    hostName,
                    defHash: entry.defHash,
                    updatedAt: Date.now(),
                },
            },
        },
    };

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
    if (!response.ok) throw new Error(`Import failed for "${entry.name}" (${response.status})`);

    const result = await response.json();
    if (result?.error) throw new Error(`Import failed for "${entry.name}"`);

    return `${result.file_name ?? fileName}.png`;
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

        if (!this.#hydrated.has(character.avatar)) {
            const original = {};
            for (const field of DEFINITION_FIELDS) {
                original[field] = structuredCloneSafe(character[field]);
                original[`data.${field}`] = structuredCloneSafe(character.data?.[field]);
            }
            this.#hydrated.set(character.avatar, { avatar: character.avatar, original });
        }

        character.data ??= {};
        for (const [field, value] of Object.entries(definition)) {
            if (field === 'extensions') {
                // Merge so the local marker survives hydration.
                character.data.extensions = { ...(value ?? {}), ...(character.data.extensions ?? {}) };
                continue;
            }
            character[field] = value;
            character.data[field] = value;
        }
        return true;
    }

    /** Reverses every hydration, leaving the stubs inert again. */
    dehydrateAll(characters) {
        for (const [avatar, record] of this.#hydrated) {
            const character = characters.find(candidate => candidate.avatar === avatar);
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

    push({ cardId, seq, total, bytes }) {
        if (!Number.isInteger(total) || total < 1 || total > 4096) throw new Error('Invalid chunk count');

        let record = this.#pending.get(cardId);
        if (!record) {
            record = { total, received: 0, size: 0, parts: new Array(total) };
            this.#pending.set(cardId, record);
        }
        if (record.total !== total) throw new Error('Chunk count changed mid-transfer');
        if (!Number.isInteger(seq) || seq < 0 || seq >= total) throw new Error('Chunk index out of range');
        if (record.parts[seq]) return null;

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
