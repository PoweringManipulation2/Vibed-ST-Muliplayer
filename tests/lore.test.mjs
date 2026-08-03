/**
 * Shared lorebook tests.
 *
 * Two claims are being pinned down here.
 *
 * First, that persona lorebooks reach the model *properly*. The earlier approach
 * scanned recent chat for keywords and pasted matches inline, which quietly
 * ignored secondary keys, selective logic, insertion position, order, depth,
 * probability, inclusion groups, recursion and the token budget. Merging into a
 * real World Info book and letting SillyTavern activate it means all of that is
 * handled by the same code path as any other lorebook — so what is tested here is
 * that the merged book is *valid and faithful*, not that scanning works.
 *
 * Second, that the model is told how many players are present, including anyone
 * whose persona has no description. Filtering those out left the model unaware of
 * people who were nonetheless speaking.
 *
 * Run with:  node tests/lore.test.mjs
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const lore = await import(path.join(root, 'lib/lore.js'));
const { buildSessionBook, describeSessionBook, readEntries, syncSessionBook, unbindSessionBook, METADATA_KEY, SESSION_BOOK_NAME } = lore;
const { ChatBridge } = await import(path.join(root, 'lib/chat.js'));

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

const persona = (peerId, name, entries, extra = {}) => ({
    peerId,
    name,
    description: `${name} description`,
    lorebook: entries ? { entries } : null,
    ...extra,
});

console.log('\nReading whatever shape a book arrives in');

await test('accepts array entries, object entries, or a bare array', () => {
    const entry = { key: ['a'], content: 'x' };
    assert.equal(readEntries({ entries: [entry] }).length, 1);
    assert.equal(readEntries({ entries: { 0: entry, 1: entry } }).length, 2);
    assert.equal(readEntries([entry]).length, 1);
    assert.deepEqual(readEntries(null), []);
    assert.deepEqual(readEntries({}), []);
});

console.log('\nMerging');

await test('entries from two players are merged with unique uids', () => {
    // Both books start at uid 0, so keeping the originals would have one player's
    // entries silently overwrite the other's.
    const book = buildSessionBook([
        persona('p2', 'Casey', [{ uid: 0, key: ['ledger'], content: 'The ledger is cursed.' }]),
        persona('p3', 'Riley', [{ uid: 0, key: ['ship'], content: 'The ship is named Verity.' }]),
    ]);

    assert.equal(book.count, 2);
    const uids = Object.values(book.entries).map(entry => entry.uid);
    assert.deepEqual(uids, [0, 1]);
    assert.equal(new Set(uids).size, 2, 'uid collision would lose an entry');
    assert.deepEqual(book.owners, ['Casey', 'Riley']);
});

await test('every entry keeps the settings that govern how it fires', () => {
    // These are exactly the fields a keyword-scan approach threw away.
    const source = {
        uid: 7,
        key: ['ledger'],
        keysecondary: ['cursed', 'old'],
        selective: true,
        selectiveLogic: 1,
        constant: false,
        position: 4,
        order: 250,
        depth: 2,
        role: 1,
        probability: 60,
        useProbability: true,
        caseSensitive: true,
        matchWholeWords: true,
        scanDepth: 10,
        group: 'ledgers',
        groupWeight: 300,
        preventRecursion: true,
        content: 'The ledger is cursed.',
    };
    const [entry] = Object.values(buildSessionBook([persona('p2', 'Casey', [source])]).entries);

    for (const field of ['keysecondary', 'selective', 'selectiveLogic', 'position', 'order',
        'depth', 'role', 'probability', 'useProbability', 'caseSensitive', 'matchWholeWords',
        'scanDepth', 'group', 'groupWeight', 'preventRecursion']) {
        assert.deepEqual(entry[field], source[field], `${field} was not preserved`);
    }
});

await test('missing fields are filled with sane World Info defaults', () => {
    const [entry] = Object.values(buildSessionBook([
        persona('p2', 'Casey', [{ key: ['x'], content: 'y' }]),
    ]).entries);

    assert.equal(entry.disable, false);
    assert.equal(entry.selective, true);
    assert.equal(entry.probability, 100);
    assert.equal(typeof entry.order, 'number');
    assert.equal(typeof entry.position, 'number');
    assert.ok('keysecondary' in entry);
});

await test('the owner is recorded in the comment so the merged book is readable', () => {
    const [entry] = Object.values(buildSessionBook([
        persona('p2', 'Casey', [{ key: ['x'], content: 'y', comment: 'the ledger' }]),
    ]).entries);
    assert.match(entry.comment, /^\[Casey\]/);
    assert.match(entry.comment, /the ledger/);
});

await test('automation ids are stripped from peer entries', () => {
    // A peer must not be able to drive automation on the host's machine.
    const [entry] = Object.values(buildSessionBook([
        persona('p2', 'Casey', [{ key: ['x'], content: 'y', automationId: 'run-something' }]),
    ]).entries);
    assert.equal(entry.automationId, '');
});

await test('unfireable and empty entries are dropped', () => {
    const book = buildSessionBook([persona('p2', 'Casey', [
        { key: ['ok'], content: 'kept' },
        { key: [], content: 'no keys and not constant' },
        { key: [], constant: true, content: 'constant is fine' },
        { key: ['x'], content: '   ' },
        { key: ['x'] },
        null,
        'not an object',
    ])]);
    assert.equal(book.count, 2);
    const contents = Object.values(book.entries).map(entry => entry.content);
    assert.deepEqual(contents, ['kept', 'constant is fine']);
});

await test('my own lorebook is excluded', () => {
    // SillyTavern already applies the local persona's own book.
    const book = buildSessionBook([
        persona('me', 'Legoshi', [{ key: ['a'], content: 'mine' }]),
        persona('p2', 'Casey', [{ key: ['b'], content: 'theirs' }]),
    ], { excludePeerId: 'me' });

    assert.equal(book.count, 1);
    assert.deepEqual(book.owners, ['Casey']);
});

await test('a player with no lorebook contributes nothing and is not listed', () => {
    const book = buildSessionBook([
        persona('p2', 'Casey', null),
        persona('p3', 'Riley', [{ key: ['a'], content: 'x' }]),
    ]);
    assert.deepEqual(book.owners, ['Riley']);
    assert.equal(book.count, 1);
});

await test('the entry count is capped', () => {
    const many = Array.from({ length: 900 }, (_, i) => ({ key: [`k${i}`], content: `c${i}` }));
    const book = buildSessionBook([persona('p2', 'Casey', many)], { maxEntries: 50 });
    assert.equal(book.count, 50);
});

await test('oversized content is truncated rather than relayed whole', () => {
    const [entry] = Object.values(buildSessionBook([
        persona('p2', 'Casey', [{ key: ['x'], content: 'z'.repeat(50000) }]),
    ]).entries);
    assert.equal(entry.content.length, 20000);
});

console.log('\nBinding to the session chat');

function makeContext() {
    const saved = {};
    const metadata = {};
    return {
        chatMetadata: metadata,
        saved,
        savedMetadata: 0,
        listUpdated: 0,
        saveWorldInfo: async (name, data) => { saved[name] = data; },
        updateWorldInfoList: async function () { this.listUpdated += 1; },
        saveMetadata: async function () { this.savedMetadata += 1; },
    };
}

await test('the book is saved, registered, and bound to this chat only', async () => {
    const context = makeContext();
    const result = await syncSessionBook(context, [
        persona('p2', 'Casey', [{ key: ['ledger'], content: 'cursed' }]),
    ], { excludePeerId: 'me' });

    assert.equal(result.bound, true);
    assert.equal(result.count, 1);
    assert.ok(context.saved[SESSION_BOOK_NAME], 'the book was not saved');
    assert.equal(context.listUpdated, 1, 'the name must be registered before a chat can reference it');
    assert.equal(context.chatMetadata[METADATA_KEY], SESSION_BOOK_NAME);
    assert.equal(context.savedMetadata, 1);
});

await test('with no peer lore, nothing is bound', async () => {
    const context = makeContext();
    const result = await syncSessionBook(context, [persona('p2', 'Casey', null)]);
    assert.equal(result.bound, false);
    assert.equal(context.chatMetadata[METADATA_KEY], undefined);
});

await test('a sync that finds no lore unbinds a previous book', async () => {
    const context = makeContext();
    await syncSessionBook(context, [persona('p2', 'Casey', [{ key: ['a'], content: 'x' }])]);
    assert.equal(context.chatMetadata[METADATA_KEY], SESSION_BOOK_NAME);

    // Casey leaves.
    await syncSessionBook(context, []);
    assert.equal(context.chatMetadata[METADATA_KEY], undefined, 'a stale book stayed bound');
});

await test('unbinding leaves an unrelated chat lorebook alone', async () => {
    const context = makeContext();
    context.chatMetadata[METADATA_KEY] = 'My Own Book';
    const removed = await unbindSessionBook(context);
    assert.equal(removed, false);
    assert.equal(context.chatMetadata[METADATA_KEY], 'My Own Book',
        'the user\'s own chat lorebook must never be unbound');
});

await test('a build without the World Info API degrades with a reason', async () => {
    const result = await syncSessionBook({}, [persona('p2', 'Casey', [{ key: ['a'], content: 'x' }])]);
    assert.equal(result.bound, false);
    assert.match(result.reason, /World Info/);
    assert.match(describeSessionBook(result), /unavailable/);
});

await test('a save failure is reported, not swallowed', async () => {
    const context = makeContext();
    context.saveWorldInfo = async () => { throw new Error('disk full'); };
    const result = await syncSessionBook(context, [persona('p2', 'Casey', [{ key: ['a'], content: 'x' }])]);
    assert.equal(result.bound, false);
    assert.equal(result.reason, 'disk full');
});

console.log('\nThe roster the model is given');

function bridgeWith(personas, selfName = 'Legoshi') {
    const injected = [];
    const context = {
        chat: [],
        eventSource: { on() {}, removeListener() {}, emit() {} },
        eventTypes: {},
        substituteParams: () => selfName,
        powerUserSettings: {},
        setExtensionPrompt: (key, value) => injected.push({ key, value }),
        extensionPromptTypes: { IN_PROMPT: 0 },
        extensionPromptRoles: { SYSTEM: 0 },
    };
    const bridge = new ChatBridge({
        getContext: () => context,
        send: () => {},
        role: () => 'host',
        isActive: () => true,
        selfPeerId: () => 'me',
    });
    for (const [peerId, value] of Object.entries(personas)) bridge.rememberPersona(peerId, value);
    return { bridge, injected };
}

await test('the model is told how many people are present, and their names', () => {
    const { bridge } = bridgeWith({
        p2: { name: 'GreenHouse', description: 'A player.' },
        p3: { name: 'Casey', description: 'Another.' },
    });
    const text = bridge.injectPersonas(6, 'me');

    assert.match(text, /3 people in this scene/, 'the host counts too');
    assert.match(text, /Legoshi/);
    assert.match(text, /GreenHouse/);
    assert.match(text, /Casey/);
});

await test('a player with no description is still counted and named', () => {
    // Previously these were filtered out entirely, so the model had no idea they
    // existed even as they spoke.
    const { bridge } = bridgeWith({
        p2: { name: 'GreenHouse', description: 'A player.' },
        p3: { name: 'Quiet', description: '' },
    });
    const text = bridge.injectPersonas(6, 'me');

    assert.match(text, /3 people in this scene/);
    assert.match(text, /Quiet/, 'a description-less player must still be named');
    assert.ok(!/Quiet:/.test(text), 'but should not get an empty description block');
});

await test('the block instructs the model to keep the players distinct', () => {
    const { bridge } = bridgeWith({ p2: { name: 'GreenHouse', description: 'A player.' } });
    const text = bridge.injectPersonas(6, 'me');
    assert.match(text, /do not merge them into one character/i);
});

await test('lorebook text is not duplicated into the injected block', () => {
    // It reaches the prompt through World Info instead; inlining it here as well
    // would both duplicate tokens and bypass position and depth settings.
    const { bridge } = bridgeWith({
        p2: {
            name: 'Casey',
            description: 'An archivist.',
            lorebook: { entries: [{ key: ['ledger'], content: 'UNIQUE_LORE_STRING' }] },
        },
    });
    const text = bridge.injectPersonas(6, 'me');
    assert.ok(!text.includes('UNIQUE_LORE_STRING'), 'lore should come from the World Info engine');
});

await test('with nobody else present the injection is cleared', () => {
    const { bridge, injected } = bridgeWith({ me: { name: 'Legoshi', description: 'The host.' } });
    assert.equal(bridge.injectPersonas(6, 'me'), '');
    assert.equal(injected.at(-1).value, '');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
