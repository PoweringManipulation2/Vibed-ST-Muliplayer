/** Persistent sharing identities and ordered, retryable writes. No card text is stored here. */
import { randomBytes, sha256 } from './crypto.js';

export const STORAGE_VERSION = 1;
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
export const newIdentity = () => hex(randomBytes(16));
export const validIdentity = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);

/** Object keys are sorted; array order remains meaningful. */
export function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(v => canonicalJson(v ?? null)).join(',')}]`;
    if (plain(value)) return `{${Object.keys(value).sort().filter(k => value[k] !== undefined)
        .map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
    return JSON.stringify(value ?? null);
}
export async function contentHash(value) {
    return hex(await sha256(typeof value === 'string' ? new TextEncoder().encode(value) : value));
}
export const objectHash = value => contentHash(canonicalJson(value));

export function sharingState(settings, save = () => {}) {
    let changed = false;
    if (!plain(settings.sharing)) { settings.sharing = {}; changed = true; }
    const state = settings.sharing;
    // Never reset a newer schema: doing so would discard identities and create duplicates.
    if (state.version > STORAGE_VERSION) throw new Error('Shared storage was written by a newer Multiplayer version. Update the extension.');
    if (state.version !== STORAGE_VERSION) { state.version = STORAGE_VERSION; changed = true; }
    if (!validIdentity(state.ownerId)) { state.ownerId = newIdentity(); changed = true; }
    for (const key of ['cardSources', 'personaSources', 'remoteCards', 'sessionCards', 'remotePersonas']) {
        if (!plain(state[key])) { state[key] = {}; changed = true; }
    }
    if (changed) save();
    return state;
}

export function sourceIdentity(state, kind, filename, save = () => {}) {
    const map = kind === 'persona' ? state.personaSources : state.cardSources;
    // JSON encoding makes even '__proto__' an ordinary own property.
    const key = JSON.stringify(String(filename ?? 'default'));
    if (!Object.hasOwn(map, key) || !validIdentity(map[key])) { map[key] = newIdentity(); save(); }
    return map[key];
}

export function renameSource(state, oldAvatar, newAvatar, save = () => {}) {
    const oldKey = JSON.stringify(oldAvatar), newKey = JSON.stringify(newAvatar);
    if (!Object.hasOwn(state.cardSources, oldKey)) return false;
    state.cardSources[newKey] = state.cardSources[oldKey];
    delete state.cardSources[oldKey];
    save();
    return true;
}

export class KeyedQueue {
    pending = new Map();
    run(key, work) {
        const next = (this.pending.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
        this.pending.set(key, next);
        const clear = () => { if (this.pending.get(key) === next) this.pending.delete(key); };
        next.then(clear, clear);
        return next;
    }
}
const writes = new KeyedQueue();
/** Also coordinate tabs on browsers supporting Web Locks. Disk markers remain authoritative. */
export function sharedWrite(key, work) {
    return writes.run(key, () => globalThis.navigator?.locks?.request
        ? globalThis.navigator.locks.request(`stmp:${key}`, work)
        : work());
}
export function checkCurrent(isCurrent = () => true) {
    if (!isCurrent()) throw new DOMException('The multiplayer connection changed.', 'AbortError');
}
