/**
 * Card-sharing chain tests.
 *
 * Sharing failed at the very first step: the picker read its checkboxes after
 * the popup had resolved, and SillyTavern removes the dialog from the DOM before
 * `show()` settles — so the selection was always empty and every subsequent step
 * did exactly what it was told, which was nothing.
 *
 * With that fixed, the rest of the chain deserves pinning down, because it spans
 * a lot of SillyTavern surface: which characters get indexed, what the import
 * request looks like, whether the marker survives a round trip, and whether a
 * hydrated card can be returned to being inert.
 *
 * Run with:  node tests/cards.test.mjs
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const cards = await import(path.join(root, 'lib/cards.js'));
const {
    MARKER, buildCardIndex, extractDefinition, isRemoteCard, remoteCardId,
    materialiseStub, stubFileName, streamAvatar, ChunkAssembler, HydrationTracker,
} = cards;

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  \u2713 ${name}`);
        passed += 1;
    } catch (error) {
        console.error(`  \u2717 ${name}\n      ${error.message}`);
        failed += 1;
    }
}

const character = (name, over = {}) => ({
    name,
    avatar: `${name}.png`,
    description: `${name} description`,
    personality: 'curious',
    first_mes: 'Hello there.',
    data: {
        name,
        description: `${name} description`,
        personality: 'curious',
        first_mes: 'Hello there.',
        creator: 'someone',
        creator_notes: 'notes',
        alternate_greetings: ['Hi!'],
        tags: ['fantasy'],
        extensions: { depth_prompt: { depth: 4 } },
    },
    ...over,
});

const ROOM = 'abcdef0123456789';

console.log('\nHost: building the shared index');

await test('only the selected characters are indexed', async () => {
    const all = [character('Ada'), character('Bea'), character('Cyd')];
    const index = await buildCardIndex(all, ['Ada.png', 'Cyd.png'], ROOM);

    assert.equal(index.length, 2);
    assert.deepEqual(index.map(entry => entry.name), ['Ada', 'Cyd']);
});

await test('an empty selection produces an empty index, not everything', async () => {
    // The bug reported "Sharing 0 characters" — this asserts 0 means 0 here, so
    // the fault could be localised to the picker rather than the index builder.
    const index = await buildCardIndex([character('Ada')], [], ROOM);
    assert.deepEqual(index, []);
});

await test('a selection naming an absent character is ignored, not fatal', async () => {
    const index = await buildCardIndex([character('Ada')], ['Ada.png', 'Deleted.png'], ROOM);
    assert.equal(index.length, 1);
});

await test('the index carries metadata but never the definition', async () => {
    const [entry] = await buildCardIndex([character('Ada')], ['Ada.png'], ROOM);

    assert.equal(entry.name, 'Ada');
    assert.equal(entry.avatar, 'Ada.png');
    assert.ok(entry.cardId && entry.defHash, 'ids and hashes are required');
    assert.deepEqual(entry.tags, ['fantasy']);

    const serialised = JSON.stringify(entry);
    assert.ok(!serialised.includes('Ada description'), 'the description leaked into the index');
    assert.ok(!serialised.includes('Hello there'), 'the greeting leaked into the index');
});

await test('card ids are stable per room and unique per character', async () => {
    const all = [character('Ada'), character('Bea')];
    const first = await buildCardIndex(all, ['Ada.png', 'Bea.png'], ROOM);
    const again = await buildCardIndex(all, ['Ada.png', 'Bea.png'], ROOM);
    const otherRoom = await buildCardIndex(all, ['Ada.png'], 'ffffffffffffffff');

    assert.equal(first[0].cardId, again[0].cardId, 'ids must be stable across publishes');
    assert.notEqual(first[0].cardId, first[1].cardId, 'ids must differ per character');
    assert.notEqual(first[0].cardId, otherRoom[0].cardId, 'ids must be scoped to the room');
});

await test('editing a character changes its defHash', async () => {
    const before = await buildCardIndex([character('Ada')], ['Ada.png'], ROOM);
    const edited = character('Ada');
    edited.data.description = 'rewritten';
    const after = await buildCardIndex([edited], ['Ada.png'], ROOM);

    assert.equal(before[0].cardId, after[0].cardId);
    assert.notEqual(before[0].defHash, after[0].defHash);
});

console.log('\nHost: the definition it sends');

await test('the definition carries the fields a card needs to work', () => {
    const definition = extractDefinition(character('Ada'));
    for (const field of ['description', 'personality', 'first_mes', 'alternate_greetings', 'creator']) {
        assert.ok(field in definition, `${field} is missing from the definition`);
    }
    assert.equal(definition.description, 'Ada description');
});

await test('the host\'s own multiplayer bookkeeping is stripped', () => {
    const host = character('Ada');
    host.data.extensions[MARKER] = { remote: true, secret: 'should not travel' };
    const definition = extractDefinition(host);

    assert.ok(!(MARKER in (definition.extensions ?? {})), 'the marker was sent to peers');
    assert.ok(definition.extensions.depth_prompt, 'unrelated extension data should survive');
    // And the original must not be mutated as a side effect.
    assert.ok(host.data.extensions[MARKER], 'extractDefinition mutated the host\'s character');
});

console.log('\nClient: materialising a stub');

await test('the import request matches what SillyTavern expects', async () => {
    let captured = null;
    globalThis.fetch = async (url, options) => {
        captured = { url, options };
        return { ok: true, json: async () => ({ file_name: 'stmp_abcdef01_0011223344' }) };
    };

    const avatar = await materialiseStub(
        { cardId: '0011223344556677', name: 'Ada', defHash: 'h', creator: 'someone', tags: ['fantasy'] },
        { roomId: ROOM, hostName: 'Riley', getRequestHeaders: () => ({ 'X-CSRF-Token': 't' }) },
    );

    assert.equal(captured.url, '/api/characters/import');
    assert.equal(captured.options.method, 'POST');

    const form = captured.options.body;
    // The global multer middleware is .single('avatar'), so the file field must
    // be called "avatar" no matter what it actually contains.
    assert.ok(form.get('avatar'), 'the file must be sent under the field name "avatar"');
    assert.equal(form.get('file_type'), 'json');
    assert.equal(form.get('preserved_name'), stubFileName(ROOM, '0011223344556677'));

    // file_name comes back without an extension; character.avatar has one.
    assert.equal(avatar, 'stmp_abcdef01_0011223344.png');
});

await test('the stub carries the marker and no borrowed text', async () => {
    let body = null;
    globalThis.fetch = async (url, options) => {
        body = JSON.parse(await options.body.get('avatar').text());
        return { ok: true, json: async () => ({ file_name: 'stub' }) };
    };

    await materialiseStub(
        { cardId: 'cafe', name: 'Ada', defHash: 'h', tags: [] },
        { roomId: ROOM, hostName: 'Riley', getRequestHeaders: () => ({}) },
    );

    assert.equal(body.spec, 'chara_card_v2');
    assert.equal(body.name, 'Ada');
    assert.equal(body.description, '', 'a stub must not contain the definition');
    assert.equal(body.data.first_mes, '');

    const marker = body.data.extensions[MARKER];
    assert.equal(marker.remote, true);
    assert.equal(marker.cardId, 'cafe');
    assert.equal(marker.hostName, 'Riley');
    assert.match(body.data.creator_notes, /Riley/);
});

await test('a failed import is reported rather than swallowed', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    await assert.rejects(
        () => materialiseStub({ cardId: 'x', name: 'Ada' }, { roomId: ROOM, hostName: 'R', getRequestHeaders: () => ({}) }),
        /Import failed/);
});

await test('stub filenames are stable, scoped, and filesystem-safe', () => {
    const name = stubFileName(ROOM, '0011223344556677');
    assert.equal(name, stubFileName(ROOM, '0011223344556677'));
    assert.notEqual(name, stubFileName('ffffffffffffffff', '0011223344556677'));
    assert.match(name, /^[a-z0-9_]+$/, 'the name must contain nothing needing escaping');
});

console.log('\nClient: recognising a hosted card');

await test('the marker survives a round trip and is detected', () => {
    // ST's unsetPrivateFields only clears fav and chat, so data.extensions
    // survives import — which is what the badge and the click gate rely on.
    const stub = {
        name: 'Ada',
        avatar: 'stmp_abcdef01_0011223344.png',
        data: { extensions: { [MARKER]: { remote: true, cardId: 'cafe', hostName: 'Riley' } } },
    };
    assert.equal(isRemoteCard(stub), true);
    assert.equal(remoteCardId(stub), 'cafe');
});

await test('ordinary characters are not mistaken for hosted ones', () => {
    for (const candidate of [character('Ada'), {}, null, undefined, { data: {} }, { data: { extensions: {} } }]) {
        assert.equal(isRemoteCard(candidate), false);
        assert.equal(remoteCardId(candidate), null);
    }
});

console.log('\nClient: hydration is session-only');

await test('a hydrated card works, and dehydration leaves it inert again', () => {
    const tracker = new HydrationTracker();
    const stub = {
        name: 'Ada',
        avatar: 'stub.png',
        description: '',
        first_mes: '',
        data: { description: '', first_mes: '', extensions: { [MARKER]: { remote: true, cardId: 'cafe' } } },
    };

    tracker.hydrate(stub, { description: 'the real thing', first_mes: 'Hello.', extensions: { depth_prompt: {} } });

    assert.equal(stub.description, 'the real thing');
    assert.equal(stub.data.first_mes, 'Hello.');
    assert.ok(stub.data.extensions[MARKER], 'the local marker must survive hydration');
    assert.equal(tracker.isHydrated('stub.png'), true);

    tracker.dehydrateAll([stub]);

    assert.equal(stub.description, '', 'the definition must not persist past a disconnect');
    assert.equal(stub.data.first_mes, '');
    assert.equal(tracker.isHydrated('stub.png'), false);
});

await test('dehydration copes with a character that vanished mid-session', () => {
    const tracker = new HydrationTracker();
    const stub = { name: 'Ada', avatar: 'gone.png', description: '', data: { description: '' } };
    tracker.hydrate(stub, { description: 'x' });
    tracker.dehydrateAll([]); // user deleted the card
    assert.equal(tracker.size, 0);
});

console.log('\nAvatar transfer');

await test('a large avatar survives chunking and reassembly', async () => {
    const original = new Uint8Array(700 * 1024);
    for (let i = 0; i < original.length; i++) original[i] = i % 251;

    const assembler = new ChunkAssembler();
    let reassembled = null;
    let chunks = 0;

    for await (const chunk of streamAvatar('cafe', original)) {
        chunks += 1;
        reassembled = assembler.push(chunk) ?? reassembled;
    }

    assert.ok(chunks > 1, 'a 700KB avatar should be split');
    assert.ok(reassembled, 'reassembly never completed');
    assert.equal(reassembled.length, original.length);
    assert.deepEqual([...reassembled.subarray(0, 64)], [...original.subarray(0, 64)]);
    assert.deepEqual([...reassembled.subarray(-64)], [...original.subarray(-64)]);
});

await test('a duplicated chunk does not corrupt the result', async () => {
    const original = new Uint8Array(400 * 1024).fill(9);
    const all = [];
    for await (const chunk of streamAvatar('cafe', original)) all.push(chunk);

    const assembler = new ChunkAssembler();
    let done = null;
    for (const chunk of [all[0], all[0], ...all.slice(1)]) {
        done = assembler.push(chunk) ?? done;
    }
    assert.equal(done.length, original.length);
});

await test('hostile chunk metadata is rejected', () => {
    const assembler = new ChunkAssembler();
    for (const bad of [
        { cardId: 'a', seq: 0, total: 0, bytes: new Uint8Array(1) },
        { cardId: 'a', seq: 0, total: 99999, bytes: new Uint8Array(1) },
        { cardId: 'a', seq: -1, total: 2, bytes: new Uint8Array(1) },
        { cardId: 'a', seq: 5, total: 2, bytes: new Uint8Array(1) },
    ]) {
        assert.throws(() => assembler.push(bad), undefined, `accepted ${JSON.stringify({ ...bad, bytes: undefined })}`);
    }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
