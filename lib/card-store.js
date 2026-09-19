/** Idempotent disk materialisation. Remote definitions are NEVER passed to this module. */
import {
    MARKER, readMarker, makeStubCard, makeSessionCard, importCard, editCard,
} from './cards.js';
import { sharingState, sharedWrite, objectHash, contentHash, validIdentity, checkCurrent } from './identity.js';

function filename(value) {
    if (typeof value !== 'string' || !value.endsWith('.png') || /[\\/\x00-\x1f]/.test(value)) {
        throw new Error('Invalid local character filename');
    }
    return value;
}
export function cardKey(entry, roomId = '') {
    if (!validIdentity(entry?.cardId)) throw new Error('Invalid shared card ID');
    if (entry.ownerId !== undefined || entry.sourceId !== undefined) {
        if (!validIdentity(entry.ownerId) || !validIdentity(entry.sourceId)) throw new Error('Invalid shared card identity');
        return JSON.stringify([entry.ownerId, entry.sourceId]);
    }
    return JSON.stringify(['legacy', roomId, entry.cardId]);
}
export function markerMatches(marker, entry, roomId, session = false) {
    if (!marker || !(session ? marker.session : marker.remote)) return false;
    if (entry.ownerId && entry.sourceId) return marker.ownerId === entry.ownerId && marker.sourceId === entry.sourceId;
    return marker.cardId === entry.cardId && (session || marker.roomId === roomId);
}
const revisionOf = entry => objectHash({
    cardId: entry.cardId, ownerId: entry.ownerId, sourceId: entry.sourceId,
    name: entry.name, defHash: entry.defHash, creator: entry.creator,
    tags: entry.tags, avatar: entry.avatar, avatarHash: entry.avatarHash,
});

export class SharedCardStore {
    constructor(deps) {
        this.deps = deps;
        this.stats = { created: 0, updated: 0, reused: 0, recovered: 0, failed: 0 };
    }
    get state() { return sharingState(this.deps.settings(), this.deps.save); }

    async read(avatar) {
        const response = await fetch('/api/characters/get', {
            method: 'POST', headers: this.deps.getRequestHeaders(),
            body: JSON.stringify({ avatar_url: filename(avatar) }), cache: 'no-cache',
        });
        // Only a definite 404 is permission to create. Auth/network/server failures
        // must not be mistaken for a missing file.
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`Could not verify existing shared card (${response.status})`);
        const card = await response.json();
        if (!card || card.error || typeof card.name !== 'string') throw new Error('Invalid character lookup response');
        return { ...card, avatar };
    }

    async sync(entry, options = {}) {
        const { roomId = '', hostName = 'Host', original = null, isCurrent } = options;
        const session = Boolean(original);
        const key = cardKey(entry, roomId);
        return sharedWrite(`${session ? 'session' : 'card'}:${key}`, async () => {
            try {
                checkCurrent(isCurrent);
                const state = this.state;
                const records = session ? state.sessionCards : state.remoteCards;
                const registered = records[key];
                const characters = this.deps.getContext().characters ?? [];
                const expected = c => markerMatches(readMarker(c), entry, roomId, session);
                // Marker matches, never display-name matches. More than one existing
                // copy is reported in audit(); none is automatically deleted.
                const candidates = characters.filter(expected).sort((a, b) => a.avatar.localeCompare(b.avatar));
                const deterministic = `${session ? 'stmp_session' : 'stmp_card'}_${(await contentHash(key)).slice(0, 32)}.png`;
                const names = [...new Set([registered?.avatar, ...candidates.map(c => c.avatar), deterministic].filter(Boolean))];
                let existing = null;
                for (const avatar of names) {
                    checkCurrent(isCurrent);
                    const found = await this.read(avatar);
                    if (!found) continue;
                    if (expected(found)) { existing = found; break; }
                    // An unrelated file under our deterministic name is a conflict,
                    // not permission to overwrite the user's character.
                    if (avatar === deterministic) throw new Error(`Shared-card filename conflict: ${avatar}. Nothing was overwritten.`);
                }
                // Old builds have no owner/source IDs. Only same-room exact IDs
                // can be migrated automatically; cross-room matches need approval.
                if (!existing && entry.ownerId) {
                    const legacyId = (await contentHash(`${roomId}\u0000${entry.avatar}`)).slice(0, 32);
                    const legacy = characters.filter(c => {
                        const m = readMarker(c);
                        return m && !m.ownerId && (session ? m.session && m.originalAvatar === entry.avatar : m.remote && m.roomId === roomId)
                            && (m.cardId === entry.cardId || m.cardId === legacyId);
                    }).sort((a, b) => a.avatar.localeCompare(b.avatar));
                    for (const candidate of legacy) {
                        const disk = await this.read(candidate.avatar);
                        if (disk && !readMarker(disk)?.ownerId && (session ? readMarker(disk)?.session : readMarker(disk)?.remote && readMarker(disk)?.roomId === roomId)
                            && readMarker(disk)?.cardId === readMarker(candidate)?.cardId) { existing = disk; break; }
                    }
                }
                const revision = await revisionOf(entry);
                const old = readMarker(existing);
                const card = original
                    ? makeSessionCard(original, { ...entry, revision, roomName: options.roomName ?? 'this room' })
                    : makeStubCard({ ...entry, revision }, { roomId, hostName });
                const marker = readMarker(card);
                if (old?.installedAvatarHash) marker.installedAvatarHash = old.installedAvatarHash;
                if (old?.createdAt) marker.createdAt = old.createdAt;
                const unchanged = existing && old?.revision === revision && expected(existing);
                let avatar, action;
                checkCurrent(isCurrent);
                if (unchanged) {
                    avatar = existing.avatar;
                    action = 'reused';
                } else if (existing) {
                    await editCard(card, existing, this.deps);
                    avatar = existing.avatar;
                    action = 'updated';
                } else {
                    avatar = await importCard(card, deterministic.slice(0, -4), this.deps);
                    filename(avatar);
                    // An ambiguous success must never redirect future edits to an
                    // arbitrary file returned by a broken import adapter.
                    if (avatar !== deterministic) throw new Error('SillyTavern did not preserve the shared-card filename. Refresh before retrying.');
                    action = 'created';
                }
                if (action !== 'reused') {
                    const saved = await this.read(avatar);
                    if (!expected(saved) || readMarker(saved)?.revision !== revision) {
                        throw new Error('SillyTavern did not save the shared-card revision. Resync to retry.');
                    }
                }
                // Even when the connection drops during a successful write, keep
                // the mapping. A reconnect can recover it from the on-disk marker.
                const record = { avatar, revision, ownerId: entry.ownerId, sourceId: entry.sourceId };
                if (JSON.stringify(records[key]) !== JSON.stringify(record)) {
                    records[key] = record;
                    this.deps.save?.();
                }
                this.stats[action]++;
                if (!registered && existing) this.stats.recovered++;
                return {
                    avatar, action, revision,
                    needsAvatar: Boolean(entry.avatarHash ? old?.installedAvatarHash !== entry.avatarHash : !old?.installedAvatarHash),
                };
            } catch (error) {
                if (error.name !== 'AbortError') this.stats.failed++;
                throw error;
            }
        });
    }

    async avatar(entry, bytes, { roomId = '', original = false, isCurrent } = {}) {
        const key = cardKey(entry, roomId);
        return sharedWrite(`${original ? 'session' : 'card'}:${key}`, async () => {
            checkCurrent(isCurrent);
            const hash = await contentHash(bytes);
            if (entry.avatarHash && hash !== entry.avatarHash) throw new Error('Avatar content did not match its announced hash; retry sharing.');
            const record = (original ? this.state.sessionCards : this.state.remoteCards)[key];
            if (!record) throw new Error('No local copy exists for this avatar');
            const existing = await this.read(record.avatar);
            if (!markerMatches(readMarker(existing), entry, roomId, original)) throw new Error('Shared-card ownership marker changed; refusing avatar update');
            if (readMarker(existing).installedAvatarHash === hash) return false;
            checkCurrent(isCurrent);
            // Write image + marker together using ST's existing multipart edit
            // endpoint. Crucially, `existing` came from disk, not hydrated memory.
            const card = structuredClone(existing);
            card.data.extensions[MARKER].installedAvatarHash = hash;
            await editCard(card, existing, this.deps, bytes);
            const saved = await this.read(existing.avatar);
            if (!markerMatches(readMarker(saved), entry, roomId, original) || readMarker(saved)?.installedAvatarHash !== hash) {
                throw new Error('SillyTavern did not save the avatar revision. Resync to retry.');
            }
            return true;
        });
    }

    /** Explicitly bind a user-selected legacy stub, without deleting any other copies. */
    async adopt(entry, avatar, options = {}) {
        const key = cardKey(entry, options.roomId);
        return sharedWrite(`card:${key}`, async () => {
            checkCurrent(options.isCurrent);
            const existing = await this.read(avatar);
            const old = readMarker(existing);
            if (!old?.remote || old.session) throw new Error('Only a Multiplayer remote stub can be linked. Local characters are never eligible.');
            if (old.ownerId && !markerMatches(old, entry, options.roomId)) throw new Error('This stub already belongs to a different sharing identity.');
            const card = makeStubCard({ ...entry, revision: await revisionOf(entry) }, options);
            // No installed avatar hash is copied: the selected file must be refreshed.
            checkCurrent(options.isCurrent);
            await editCard(card, existing, this.deps);
            const saved = await this.read(avatar);
            if (!markerMatches(readMarker(saved), entry, options.roomId) || readMarker(saved)?.revision !== readMarker(card).revision) {
                throw new Error('SillyTavern did not save the recovery link. No mapping was changed.');
            }
            this.state.remoteCards[key] = { avatar, revision: readMarker(card).revision, ownerId: entry.ownerId, sourceId: entry.sourceId };
            this.deps.save?.();
            return avatar;
        });
    }

    audit() {
        const groups = new Map(), legacy = [];
        for (const c of this.deps.getContext().characters ?? []) {
            const m = readMarker(c);
            if (!m?.remote && !m?.session) continue;
            const kind = m.session ? 'session' : 'remote';
            const key = m.ownerId && m.sourceId ? JSON.stringify([kind, m.ownerId, m.sourceId]) : JSON.stringify([kind, m.roomId, m.cardId]);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push({ name: c.name, avatar: c.avatar, cardId: m.cardId, chatBytes: Number(c.chat_size ?? 0) });
            if (!m.ownerId) legacy.push({ name: c.name, avatar: c.avatar, cardId: m.cardId, roomId: m.roomId });
        }
        return {
            version: this.state.version,
            rememberedRemoteCards: Object.keys(this.state.remoteCards).length,
            rememberedSessionCards: Object.keys(this.state.sessionCards).length,
            operations: { ...this.stats },
            duplicateGroups: [...groups.values()].filter(group => group.length > 1),
            legacy,
            note: 'Read-only report. No cards, personas or chats have been deleted. Names are not identity.',
        };
    }
}
