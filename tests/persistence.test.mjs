import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeStorage, clone } from './helpers/storage.mjs';
import { sharingState, sourceIdentity, renameSource, objectHash, contentHash, KeyedQueue } from '../lib/identity.js';
import { SharedCardStore, cardKey } from '../lib/card-store.js';
import { MARKER, readMarker, buildCardIndex, HydrationTracker, ChunkAssembler, makeStubCard } from '../lib/cards.js';

let env, store, nativeFetch;
beforeEach(() => { env = makeStorage(); store = new SharedCardStore(env.deps); nativeFetch = globalThis.fetch; globalThis.fetch = env.fetch; });
afterEach(() => { globalThis.fetch = nativeFetch; });
const entry = (overrides = {}) => ({ ownerId: 'owner-a', sourceId: 'source-a', cardId: 'card-a',
    avatar: 'original.png', name: 'Ada', creator: 'Creator', tags: ['test'], defHash: 'definition-1', ...overrides });
const options = { roomId: 'room-one', hostName: 'Host' };

await test('source identity survives a serialized settings reload, a room change, and an ST rename', async () => {
    const state = sharingState(env.settings, env.deps.save);
    const id = sourceIdentity(state, 'card', 'Ada.png', env.deps.save);
    const original = { name: 'Ada', avatar: 'Ada.png', data: { description: 'private definition' } };
    const a = (await buildCardIndex([original], ['Ada.png'], 'room-one', { ownerId: state.ownerId,
        sourceId: file => sourceIdentity(state, 'card', file) }))[0];
    const settings = JSON.parse(JSON.stringify(env.settings));
    const loaded = sharingState(settings);
    assert.equal(sourceIdentity(loaded, 'card', 'Ada.png'), id);
    const b = (await buildCardIndex([original], ['Ada.png'], 'room-two', { ownerId: loaded.ownerId,
        sourceId: file => sourceIdentity(loaded, 'card', file) }))[0];
    assert.equal(a.cardId, b.cardId);
    assert.equal(renameSource(loaded, 'Ada.png', 'Renamed.png'), true);
    assert.equal(sourceIdentity(loaded, 'card', 'Renamed.png'), id);
    assert.equal(sourceIdentity(loaded, 'persona', 'Ada.png') === id, false);
});

await test('canonical revisions ignore object key order but retain array order and equal-length changes', async () => {
    assert.equal(await objectHash({ b: 2, a: 1 }), await objectHash({ a: 1, b: 2 }));
    assert.notEqual(await objectHash(['a', 'b']), await objectHash(['b', 'a']));
    assert.notEqual(await contentHash('abc'), await contentHash('abd'));
});

await test('newer storage schemas are refused rather than silently reset', () => {
    const settings = { sharing: { version: 200, ownerId: 'existing' } };
    assert.throws(() => sharingState(settings), /newer/);
    assert.equal(settings.sharing.ownerId, 'existing');
});

await test('100 simultaneous deliveries through independent stores create exactly one remote file', async () => {
    const result = await Promise.all(Array.from({ length: 100 }, () => new SharedCardStore(env.deps).sync(entry(), options)));
    assert.equal(new Set(result.map(r => r.avatar)).size, 1);
    assert.equal(env.disk.size, 1);
    assert.equal(env.count('/api/characters/import'), 1);
    assert.equal(env.count('/api/characters/edit'), 0);
    assert.equal(result.filter(r => r.action === 'reused').length, 99);
});

await test('100 repeated room joins with stale UI lists make no additional import or edit', async () => {
    const first = await store.sync(entry(), options);
    for (let i = 0; i < 100; i++) {
        const result = await new SharedCardStore(env.deps).sync(entry(), { ...options, roomId: `different-${i}` });
        assert.equal(result.avatar, first.avatar);
        assert.equal(result.action, 'reused');
    }
    assert.equal(env.count('/api/characters/import'), 1);
    assert.equal(env.count('/api/characters/edit'), 0);
});

await test('a new definition/metadata revision edits the existing filename and preserves its chat and favorite', async () => {
    const first = await store.sync(entry(), options);
    const onDisk = env.disk.get(first.avatar);
    Object.assign(onDisk, { chat: 'important-chat', create_date: 'original-date', fav: true, chat_size: 7300 });
    const next = await store.sync(entry({ name: 'Ada Renamed', tags: ['new'], defHash: 'definition-2' }), options);
    assert.equal(next.avatar, first.avatar);
    assert.equal(next.action, 'updated');
    assert.equal(env.count('/api/characters/import'), 1);
    assert.equal(env.disk.size, 1);
    const saved = env.disk.get(first.avatar);
    assert.equal(saved.name, 'Ada Renamed');
    assert.equal(saved.chat, 'important-chat');
    assert.equal(saved.create_date, 'original-date');
    assert.equal(saved.fav, true);
    assert.equal(saved.chat_size, 7300);
    assert.deepEqual(saved.data.tags, ['new']);
    assert.equal(saved.data.description, '');
});

await test('same display name from different owners or sources never merges', async () => {
    const a = await store.sync(entry(), options);
    const b = await store.sync(entry({ ownerId: 'other-owner', cardId: 'other-card' }), options);
    const c = await store.sync(entry({ sourceId: 'other-source', cardId: 'third-card' }), options);
    assert.equal(new Set([a.avatar, b.avatar, c.avatar]).size, 3);
    assert.equal(env.disk.size, 3);
});

await test('lost settings can recover a deterministic owned file even before the UI refresh', async () => {
    const a = await store.sync(entry(), options);
    delete env.settings.sharing;
    env.context.characters = [];
    const b = await new SharedCardStore(env.deps).sync(entry(), { ...options, roomId: 'new-room' });
    assert.equal(b.avatar, a.avatar);
    assert.equal(b.action, 'reused');
    assert.equal(env.count('/api/characters/import'), 1);
});

await test('lost create response recovers on retry without creating a second file', async () => {
    env.loseNextReply('/api/characters/import');
    await assert.rejects(store.sync(entry(), options), /network loss/);
    assert.equal(env.disk.size, 1);
    const retry = await store.sync(entry(), options);
    assert.equal(retry.action, 'reused');
    assert.equal(env.count('/api/characters/import'), 1);
});

await test('definitively deleted file is recreated at its same deterministic name', async () => {
    const a = await store.sync(entry(), options);
    env.disk.delete(a.avatar);
    const b = await store.sync(entry(), options);
    assert.equal(b.avatar, a.avatar);
    assert.equal(b.action, 'created');
    assert.equal(env.disk.size, 1);
});

await test('401, 403, and 500 lookups never grant permission to create or replace', async () => {
    for (const status of [401, 403, 500]) {
        env.failNext('/api/characters/get', status);
        await assert.rejects(store.sync(entry(), options), new RegExp(String(status)));
    }
    assert.equal(env.count('/api/characters/import'), 0);
    assert.equal(env.count('/api/characters/edit'), 0);
});

await test('failed update does not advance the successful revision; next attempt succeeds', async () => {
    const a = await store.sync(entry(), options);
    const old = clone(store.state.remoteCards[cardKey(entry())]);
    env.failNext('/api/characters/edit');
    await assert.rejects(store.sync(entry({ defHash: 'new' }), options), /500/);
    assert.deepEqual(store.state.remoteCards[cardKey(entry())], old);
    const b = await store.sync(entry({ defHash: 'new' }), options);
    assert.equal(b.avatar, a.avatar);
    assert.equal(b.action, 'updated');
    assert.equal(env.disk.size, 1);
});

await test('HTTP 200 without a saved revision is not recorded as a successful update', async () => {
    await store.sync(entry(), options);
    const old = clone(store.state.remoteCards[cardKey(entry())]);
    env.silentlyFailNext('/api/characters/edit');
    await assert.rejects(store.sync(entry({ defHash: 'new' }), options), /did not save/);
    assert.deepEqual(store.state.remoteCards[cardKey(entry())], old);
});

await test('a forged registry link does not overwrite an unrelated local character', async () => {
    env.add({ avatar: 'private.png', name: 'Private', data: { description: 'keep me' } });
    store.state.remoteCards[cardKey(entry())] = { avatar: 'private.png' };
    const result = await store.sync(entry(), options);
    assert.notEqual(result.avatar, 'private.png');
    assert.equal(env.disk.get('private.png').data.description, 'keep me');
});

await test('an unrelated file occupying the deterministic destination fails closed', async () => {
    const filename = `stmp_card_${(await contentHash(cardKey(entry()))).slice(0, 32)}.png`;
    env.add({ name: 'Private', avatar: filename, data: { description: 'keep me' } });
    await assert.rejects(store.sync(entry(), options), /conflict/);
    assert.equal(env.disk.get(filename).data.description, 'keep me');
    assert.equal(env.count('/api/characters/edit'), 0);
});

await test('equal-length avatar edits replace the same image; identical bytes do not write again', async () => {
    const one = new Uint8Array([1, 2, 3]), two = new Uint8Array([1, 2, 4]);
    const e1 = entry({ avatarHash: await contentHash(one) });
    const a = await store.sync(e1, options);
    assert.equal(await store.avatar(e1, one, options), true);
    assert.equal(await store.avatar(e1, one, options), false);
    assert.equal((await store.sync(e1, options)).needsAvatar, false);
    const e2 = entry({ avatarHash: await contentHash(two) });
    const b = await store.sync(e2, options);
    assert.equal(b.avatar, a.avatar);
    assert.equal(b.needsAvatar, true);
    assert.equal(await store.avatar(e2, two, options), true);
    assert.deepEqual(env.images.get(a.avatar), two);
    assert.equal(env.disk.size, 1);
});

await test('avatar failures remain retryable and wrong content hashes never write', async () => {
    const bytes = new Uint8Array([1]);
    const e = entry({ avatarHash: await contentHash(bytes) });
    const a = await store.sync(e, options);
    env.failNext('/api/characters/edit');
    await assert.rejects(store.avatar(e, bytes, options), /500/);
    assert.equal(readMarker(env.disk.get(a.avatar)).installedAvatarHash, undefined);
    await assert.rejects(store.avatar(e, new Uint8Array([2]), options), /hash/);
    assert.equal(await store.avatar(e, bytes, options), true);
});

await test('image writes use clean disk data rather than a hydrated client definition', async () => {
    const bytes = new Uint8Array([5]);
    const e = entry({ avatarHash: await contentHash(bytes) });
    const a = await store.sync(e, options);
    await env.context.getCharacters();
    const tracker = new HydrationTracker();
    tracker.hydrate(env.context.characters[0], { description: 'HOST PRIVATE TEXT', scenario: 'SECRET' });
    await store.avatar(e, bytes, options);
    assert.equal(env.disk.get(a.avatar).data.description, '');
    assert.equal(JSON.stringify(env.settings).includes('HOST PRIVATE TEXT'), false);
    assert.equal(env.context.characters[0].data.description, 'HOST PRIVATE TEXT');
    tracker.dehydrateAll(env.context.characters);
    assert.equal(env.context.characters[0].data.description, '');
});

await test('host session copies also update once and never modify the source card', async () => {
    const original = env.add({ avatar: 'original.png', name: 'Ada', data: { description: 'old text' } });
    const a = await store.sync(entry(), { ...options, original });
    const updated = { ...original, data: { description: 'new text' } };
    const b = await store.sync(entry({ defHash: 'new' }), { ...options, original: updated, roomId: 'new-room' });
    assert.equal(a.avatar, b.avatar);
    assert.equal(env.disk.get(a.avatar).data.description, 'new text');
    assert.equal(env.disk.get('original.png').data.description, 'old text');
    assert.equal(env.disk.size, 2);
});

await test('same-room legacy stub is adopted, preserving the old filename and chats', async () => {
    const legacyId = (await contentHash(`${options.roomId}\u0000original.png`)).slice(0, 32);
    const legacy = makeStubCard({ cardId: legacyId, name: 'Ada' }, options);
    env.add({ ...legacy, avatar: 'old-stub.png', chat: 'legacy-chat' });
    const result = await store.sync(entry(), options);
    assert.equal(result.avatar, 'old-stub.png');
    assert.equal(result.action, 'updated');
    assert.equal(env.disk.get('old-stub.png').chat, 'legacy-chat');
    assert.equal(env.count('/api/characters/import'), 0);
});

await test('cross-room legacy matching requires explicit selection, not equal display names', async () => {
    const legacy = makeStubCard({ cardId: 'legacy', name: 'Ada' }, { roomId: 'old-room', hostName: 'Host' });
    env.add({ ...legacy, avatar: 'legacy.png' });
    const generated = await store.sync(entry(), options);
    assert.notEqual(generated.avatar, 'legacy.png');
    const linked = await store.adopt(entry(), 'legacy.png', options);
    assert.equal(linked, 'legacy.png');
    assert.equal((await store.sync(entry(), options)).avatar, 'legacy.png');
    assert.equal(env.disk.size, 2, 'recovery must not delete any file');
});

await test('recovery refuses originals and files belonging to another stable owner', async () => {
    env.add({ avatar: 'private.png', name: 'Private', data: {} });
    await assert.rejects(store.adopt(entry(), 'private.png', options), /Only a Multiplayer/);
    const a = await store.sync(entry({ ownerId: 'someone-else' }), options);
    await assert.rejects(store.adopt(entry(), a.avatar, options), /different sharing identity/);
});

await test('audit reports duplicates and legacy copies without mutations or deletions', async () => {
    const a = await store.sync(entry(), options);
    const card = env.disk.get(a.avatar);
    env.add({ ...card, avatar: 'copy.png', chat_size: 100 });
    const before = clone([...env.disk]);
    const report = store.audit();
    assert.equal(report.duplicateGroups.length, 1);
    assert.equal(report.duplicateGroups[0].length, 2);
    assert.deepEqual([...env.disk], before);
});

await test('stale queued work is cancelled before creation and failures do not poison the queue', async () => {
    await assert.rejects(store.sync(entry(), { ...options, isCurrent: () => false }), { name: 'AbortError' });
    assert.equal(env.disk.size, 0);
    assert.equal((await store.sync(entry(), options)).action, 'created');
    const queue = new KeyedQueue();
    const bad = queue.run('x', () => { throw new Error('first'); });
    const good = queue.run('x', () => 42);
    await assert.rejects(bad, /first/);
    assert.equal(await good, 42);
    assert.equal(queue.pending.size, 0);
});

await test('invalid identities and unsafe local filenames are refused before disk mutation', async () => {
    for (const item of [entry({ cardId: '__bad/../' }), entry({ sourceId: '../' }), entry({ ownerId: '' })]) {
        await assert.rejects(store.sync(item, options), /Invalid/);
    }
    await assert.rejects(store.read('../private.png'), /Invalid/);
    assert.equal(env.disk.size, 0);
});

await test('hydration replaces removed fields and host extension settings but keeps the ownership marker', () => {
    const c = { avatar: 'stub.png', description: '', data: { description: '',
        extensions: { world: '', [MARKER]: { remote: true } } } };
    const hydration = new HydrationTracker();
    hydration.hydrate(c, { description: 'old', scenario: 'remove this', extensions: { world: 'Host World' } });
    assert.equal(c.data.extensions.world, 'Host World');
    assert.equal(c.data.extensions[MARKER].remote, true);
    hydration.hydrate(c, { description: 'new' });
    assert.equal(c.data.description, 'new');
    assert.equal(c.data.scenario, undefined);
    assert.equal(c.data.extensions.world, '');
    const detached = c;
    hydration.dehydrateAll([]);
    assert.equal(detached.data.description, '');
});

await test('avatar assembler bounds simultaneous incomplete transfers and accepts a normal transfer', () => {
    const assembler = new ChunkAssembler();
    for (let i = 0; i < 8; i++) assembler.push({ cardId: String(i), seq: 0, total: 2, bytes: new Uint8Array([1]) });
    assert.throws(() => assembler.push({ cardId: 'overflow', seq: 0, total: 2, bytes: new Uint8Array([1]) }), /Too many/);
    assert.deepEqual(assembler.push({ cardId: '0', seq: 1, total: 2, bytes: new Uint8Array([2]) }), new Uint8Array([1, 2]));
    assembler.clear();
    assert.deepEqual(assembler.push({ cardId: 'fresh', seq: 0, total: 1, bytes: new Uint8Array([3]) }), new Uint8Array([3]));
});

await test('replacing a hydrated list object restores detached references and cannot mutate the definition cache', () => {
    const first = { avatar: 'same.png', data: { description: '' } };
    const replacement = { avatar: 'same.png', data: { description: '' } };
    const h = new HydrationTracker();
    const definition = { description: 'private', alternate_greetings: ['original'], extensions: { nested: { value: 1 } } };
    h.hydrate(first, definition);
    first.data.alternate_greetings.push('edited in UI');
    first.data.extensions.nested.value = 2;
    assert.deepEqual(definition.alternate_greetings, ['original']);
    assert.equal(definition.extensions.nested.value, 1);
    h.hydrate(replacement, { description: 'new private' });
    assert.equal(first.data.description, '');
    assert.equal(replacement.data.description, 'new private');
    h.dehydrateAll([replacement]);
    assert.equal(replacement.data.description, '');
});
