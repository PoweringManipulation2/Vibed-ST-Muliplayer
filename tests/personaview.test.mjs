/**
 * Room view tests.
 *
 * The DOM half is not covered here — there is no document in Node, and the
 * useful assertions are about the *claims* the panel makes, not its markup. The
 * old view's real failure was not that it was ugly: it was that it told the
 * reader something untrue about how a persona reaches the model, and hid how
 * much of a lorebook it was not showing.
 *
 * Run with:  node tests/personaview.test.mjs
 */

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const {
    STATE, personaStatus, lorebookStatus, entriesOf, keysOf, matchesQuery,
} = await import(path.join(root, 'lib/personaview.js'));

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (error) {
        failed++;
        console.log(`  ✗ ${name}`);
        console.log(`      ${error.message}`);
    }
}

console.log('\nWhat the panel claims about reaching the model');

await test('a remote description is described by how it is actually injected', () => {
    // The old view ended on "Injected at position 0, depth 2", read off the
    // persona's own fields. Nothing on this side uses those: remote descriptions
    // go into the multiplayer block, together, at one depth. The line explaining
    // how a persona reaches the model was describing something that never happens.
    const status = personaStatus(
        { name: 'GreenHouse', description: 'A runner.', position: 0, depth: 2 },
        { isMe: false, injectDepth: 4 },
    );

    assert.equal(status.state, STATE.LIVE);
    assert.match(status.detail, /multiplayer block/i);
    assert.match(status.detail, /4/, 'it should state the depth actually used');
    assert.ok(!/position 0/.test(status.detail), 'the sender\'s own position must not be reported as ours');
    assert.ok(!/depth 2/.test(status.detail), 'the sender\'s own depth must not be reported as ours');
});

await test('your own persona is described as SillyTavern handles it', () => {
    // Your own is the one case where position and depth genuinely apply, because
    // SillyTavern injects it itself.
    const status = personaStatus(
        { name: 'Legoshi', description: 'The host.' },
        { isMe: true },
    );

    assert.equal(status.state, STATE.LIVE);
    assert.match(status.detail, /Persona Management/i);
    assert.ok(!/multiplayer block/i.test(status.detail), 'your own persona does not go through the shared block');
});

await test('an empty description is called out rather than shown as fine', () => {
    const mine = personaStatus({ name: 'Legoshi', description: '' }, { isMe: true });
    assert.equal(mine.state, STATE.ABSENT);
    assert.match(mine.detail, /Persona Management/, 'tell me where to fix it');

    const theirs = personaStatus({ name: 'GreenHouse', description: '' }, { isMe: false });
    assert.equal(theirs.state, STATE.ABSENT);
    assert.ok(!/Persona Management/.test(theirs.detail), 'do not tell me to fix someone else\'s machine');
});

console.log('\nLorebook state');

const book = entries => ({ name: 'Casey', lorebookName: 'casey_v3', lorebook: { entries } });

await test('a book merged into the session is reported as active', () => {
    const status = lorebookStatus(
        book([{ key: ['ledger'], content: 'x' }]),
        { bound: true, owners: ['Casey'] },
    );
    assert.equal(status.state, STATE.LIVE);
    assert.equal(status.count, 1);
});

await test('a received but unmerged book is honest about reaching nothing', () => {
    const status = lorebookStatus(
        book([{ key: ['ledger'], content: 'x' }]),
        { bound: true, owners: ['Someone else'] },
    );
    assert.equal(status.state, STATE.WAITING);
    assert.match(status.label, /not active/i);
});

await test('a bound book whose entries never travelled is distinguished from an empty one', () => {
    // These look identical in a flat text dump, and they mean different things:
    // one is a transfer that did not happen, the other is a player with no book.
    const withheld = lorebookStatus({ name: 'Casey', lorebookName: 'casey_v3', lorebook: {} }, null);
    assert.equal(withheld.state, STATE.WAITING);
    assert.match(withheld.detail, /did not travel/i);

    const none = lorebookStatus({ name: 'Casey' }, null);
    assert.equal(none.state, STATE.ABSENT);
});

console.log('\nEntries');

await test('entries are read whether they arrive as an array or a map', () => {
    assert.equal(entriesOf(book([{ content: 'a' }, { content: 'b' }])).length, 2);
    assert.equal(entriesOf(book({ 0: { content: 'a' }, 1: { content: 'b' } })).length, 2);
    assert.deepEqual(entriesOf({}), []);
});

await test('both key field spellings are understood', () => {
    assert.deepEqual(keysOf({ key: ['Mike', "Mike's"] }), ['Mike', "Mike's"]);
    assert.deepEqual(keysOf({ keys: ['sergal'] }), ['sergal']);
    assert.deepEqual(keysOf({}), []);
    assert.deepEqual(keysOf({ key: ['  ', 'real'] }), ['real'], 'blank keys should not render as chips');
});

await test('search covers keys and content, case-insensitively', () => {
    const entry = { key: ['Mike', "Mike's"], content: 'TIMELINE: currently active in Downtown.' };

    assert.ok(matchesQuery(entry, 'mike'), 'a key should match');
    assert.ok(matchesQuery(entry, 'downtown'), 'content should match');
    assert.ok(matchesQuery(entry, ''), 'an empty query shows everything');
    assert.ok(!matchesQuery(entry, 'sergal'));
});

await test('every entry is reachable, not the first forty', () => {
    // The old view sliced to 40 while its heading said 64, and cut each entry at
    // 220 characters — both silently.
    const many = Array.from({ length: 64 }, (unused, index) => ({
        key: [`k${index}`],
        content: 'x'.repeat(500),
    }));
    const status = lorebookStatus(book(many), null);

    assert.equal(status.count, 64, 'the count must be the real one');
    assert.equal(entriesOf(book(many)).length, 64, 'and every entry must be available to render');
    assert.ok(matchesQuery(many[63], 'k63'), 'the last entry must still be findable');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
