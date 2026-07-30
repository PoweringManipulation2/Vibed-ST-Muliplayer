/**
 * Session-scoping and persona tests.
 *
 * The reported symptom was a hosted character's greeting appearing in the
 * assistant chat that opens on startup. Cause: the chat bridge relayed whatever
 * chat happened to be open and wrote inbound messages into whatever chat the
 * receiver had open. Nothing tied traffic to a particular character.
 *
 * These tests pin the containment rule: chat only moves when both ends are in
 * the room's designated shared chat, and never touches anything else. They also
 * cover the persona payload, which previously carried only a name and a
 * description — not enough for the host's model to render a player properly.
 *
 * Run with:  node tests/session.test.mjs
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const { ChatBridge } = await import(path.join(root, 'lib/chat.js'));
const { OP } = await import(path.join(root, 'lib/protocol.js'));

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

/** Mock context whose open chat and persona can be swapped mid-test. */
function makeContext({ persona = {}, lorebooks = {} } = {}) {
    const handlers = new Map();
    return {
        chat: [],
        characters: [
            { name: 'Assistant', avatar: 'Assistant.png', data: {} },
            { name: 'Ada', avatar: 'Ada.png', data: {} },
        ],
        characterId: 0,
        name2: 'Assistant',
        eventSource: {
            on: (type, fn) => handlers.set(type, fn),
            removeListener: type => handlers.delete(type),
            emit: () => {},
        },
        eventTypes: {
            MESSAGE_SENT: 'ms', MESSAGE_RECEIVED: 'mr', MESSAGE_EDITED: 'me',
            MESSAGE_DELETED: 'md', STREAM_TOKEN_RECEIVED: 'st',
            GENERATION_STARTED: 'gs', GENERATION_ENDED: 'ge',
        },
        handlers,
        addOneMessage() {},
        printMessages: async () => {},
        updateMessageBlock() {},
        scrollChatToBottom() {},
        humanizedDateTime: () => 'now',
        saveChat: async () => {},
        substituteParams: () => persona.name ?? 'Player',
        powerUserSettings: {
            persona_description: persona.description ?? '',
            persona_description_position: persona.position ?? 0,
            persona_description_depth: persona.depth ?? 2,
            persona_description_role: persona.role ?? 0,
            persona_description_lorebook: persona.lorebookName ?? '',
            default_persona: 'me.png',
        },
        loadWorldInfo: async name => lorebooks[name] ?? null,
    };
}

function makeBridge({ role = 'host', active = true, context = makeContext() } = {}) {
    const sent = [];
    const bridge = new ChatBridge({
        getContext: () => context,
        send: payload => sent.push(payload),
        role: () => role,
        isActive: () => active,
    });
    bridge.attach();
    return { bridge, sent, context, fire: (type, ...args) => context.handlers.get(type)?.(...args) };
}

console.log('\nContainment: nothing escapes an unrelated chat');

await test('a message in a non-session chat is not broadcast', () => {
    // isActive() is what the session gates on inSessionChat(). False here means
    // the user is looking at some other chat — the assistant window, say.
    const { sent, context, fire } = makeBridge({ active: false });
    context.chat.push({ name: 'Ada', is_user: false, mes: 'Hello there.', extra: {} });
    fire('mr', 0);

    assert.deepEqual(sent, [], 'a message from an unrelated chat was broadcast to the room');
});

await test('a greeting in the session chat is broadcast', () => {
    const { sent, context, fire } = makeBridge({ active: true });
    context.chat.push({ name: 'Ada', is_user: false, mes: 'Hello there.', extra: {} });
    fire('mr', 0);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].op, OP.CHAT_APPEND);
    assert.equal(sent[0].message.mes, 'Hello there.');
});

await test('an inbound message is never written to an inactive chat', async () => {
    // The exact reported bug: a hosted greeting landing in the startup chat.
    const { bridge, context } = makeBridge({ role: 'client', active: false });
    // Session routing refuses to call this at all when out of session; assert
    // that the guard is the caller's, and that nothing was already written.
    assert.equal(context.chat.length, 0);

    // And when it is called in session, it does write.
    const inSession = makeBridge({ role: 'client', active: true });
    await inSession.bridge.applyRemoteMessage({
        message: { name: 'Ada', is_user: false, mes: 'Hello there.', extra: { stmp: { id: 'a1' } } },
    });
    assert.equal(inSession.context.chat.length, 1);
    assert.equal(inSession.context.chat[0].mes, 'Hello there.');
    void bridge;
});

await test('generation events do not leak from an unrelated chat', () => {
    const { sent, fire } = makeBridge({ active: false });
    fire('gs');
    fire('st', 'partial text');
    fire('ge');
    assert.deepEqual(sent, [], 'streaming from a local chat was relayed to the room');
});

console.log('\nEcho suppression');

await test('the host does not rebroadcast a message it received', async () => {
    const { bridge, sent, context } = makeBridge({ role: 'host', active: true });

    await bridge.acceptRemoteTurn({ id: 'peer-turn-1', text: 'I open the door.', persona: { name: 'Casey' } }, { id: 'p2' });
    const broadcasts = sent.filter(payload => payload.op === OP.CHAT_APPEND);
    assert.equal(broadcasts.length, 1, 'the turn should be announced exactly once');

    // Now the MESSAGE_SENT event fires for the same message SillyTavern just got.
    const before = sent.length;
    context.handlers.get('ms')?.(context.chat.length - 1);
    assert.equal(sent.length, before, 'the host echoed a message that came from a peer');
});

await test('a client only forwards its own turns, never mirrored content', () => {
    const { sent, context, fire } = makeBridge({ role: 'client', active: true });

    context.chat.push({ name: 'Me', is_user: true, mes: 'I look around.', extra: {} });
    fire('ms', 0);
    assert.equal(sent.filter(p => p.op === OP.CHAT_TURN).length, 1);

    // A mirrored character message must not be sent anywhere.
    context.chat.push({ name: 'Ada', is_user: false, mes: 'She nods.', extra: {} });
    fire('mr', 1);
    assert.equal(sent.filter(p => p.op === OP.CHAT_APPEND).length, 0);
});

console.log('\nEdits and deletes from any player');

await test('a client can edit, not just the host', () => {
    const { sent, context, fire } = makeBridge({ role: 'client', active: true });
    context.chat.push({ name: 'Me', is_user: true, mes: 'corrected', extra: { stmp: { id: 'e1' } } });
    fire('me', 0);

    const edit = sent.find(payload => payload.op === OP.CHAT_EDIT);
    assert.ok(edit, 'a client edit was not propagated');
    assert.equal(edit.id, 'e1');
    assert.equal(edit.text, 'corrected');
});

await test('deletes are addressed by id, not just index', () => {
    const { sent, context, fire } = makeBridge({ role: 'client', active: true });
    context.chat.push({ name: 'Me', is_user: true, mes: 'oops', extra: { stmp: { id: 'd1' } } });
    fire('md', 0);

    const del = sent.find(payload => payload.op === OP.CHAT_DELETE);
    assert.equal(del.id, 'd1', 'an index alone is ambiguous once peers diverge');
});

await test('applying a remote edit does not bounce it back', () => {
    const { bridge, sent, context } = makeBridge({ role: 'host', active: true });
    context.chat.push({ name: 'Me', is_user: true, mes: 'before', extra: { stmp: { id: 'x1' } } });

    bridge.applyRemoteEdit({ id: 'x1', text: 'after' });
    assert.equal(context.chat[0].mes, 'after');

    const before = sent.length;
    context.handlers.get('me')?.(0);
    assert.equal(sent.length, before, 'applying a remote edit was echoed back, which would ping-pong');
});

await test('a remote delete finds its target by id even if indices shifted', () => {
    const { bridge, context } = makeBridge({ role: 'client', active: true });
    context.chat.push(
        { name: 'A', mes: 'one', extra: { stmp: { id: 'i1' } } },
        { name: 'B', mes: 'two', extra: { stmp: { id: 'i2' } } },
        { name: 'C', mes: 'three', extra: { stmp: { id: 'i3' } } },
    );

    // Host says "delete index 0", but our copy has them in a different place.
    bridge.applyRemoteDelete({ id: 'i3', index: 0 });
    assert.deepEqual(context.chat.map(m => m.mes), ['one', 'two'], 'the id should win over a stale index');
});

console.log('\nPersona payload');

await test('a turn carries description, placement and depth, not just a name', async () => {
    const context = makeContext({
        persona: { name: 'Casey', description: 'A tired archivist.', position: 2, depth: 4, role: 1 },
    });
    const { sent, fire } = makeBridge({ role: 'client', active: true, context });

    context.chat.push({ name: 'Casey', is_user: true, mes: 'I check the ledger.', extra: {} });
    fire('ms', 0);

    const turn = sent.find(payload => payload.op === OP.CHAT_TURN);
    assert.equal(turn.persona.name, 'Casey');
    assert.equal(turn.persona.description, 'A tired archivist.');
    assert.equal(turn.persona.position, 2);
    assert.equal(turn.persona.depth, 4);
    assert.equal(turn.persona.role, 1);
});

await test('a persona lorebook is resolved into real entries', async () => {
    const book = { name: 'CaseyLore', entries: [{ key: ['ledger'], content: 'The ledger is cursed.' }] };
    const context = makeContext({
        persona: { name: 'Casey', description: 'An archivist.', lorebookName: 'CaseyLore' },
        lorebooks: { CaseyLore: book },
    });
    const { bridge } = makeBridge({ role: 'client', active: true, context });

    const persona = await bridge.describeLocalPersona();
    assert.equal(persona.lorebookName, 'CaseyLore');
    assert.deepEqual(persona.lorebook, book, 'the lorebook contents did not travel');
});

await test('a missing lorebook degrades instead of throwing', async () => {
    const context = makeContext({ persona: { name: 'Casey', lorebookName: 'Deleted' }, lorebooks: {} });
    const { bridge } = makeBridge({ role: 'client', active: true, context });

    const persona = await bridge.describeLocalPersona();
    assert.equal(persona.lorebook, null);
    assert.equal(persona.lorebookName, 'Deleted');
});

await test('the host remembers each peer persona and normalises it', async () => {
    const { bridge } = makeBridge({ role: 'host', active: true });

    await bridge.acceptRemoteTurn(
        { id: 't1', text: 'hello', persona: { name: 'x'.repeat(200), description: 'y'.repeat(20000), depth: '3' } },
        { id: 'p2' },
    );

    const stored = bridge.personas.get('p2');
    assert.ok(stored, 'the peer persona was not remembered');
    assert.equal(stored.name.length, 40, 'the name should be capped');
    assert.equal(stored.description.length, 8000, 'the description should be capped');
    assert.equal(stored.depth, 3, 'depth should be coerced to a number');
});

await test('a peer with no persona is still recorded under its own name', async () => {
    const { bridge } = makeBridge({ role: 'host', active: true });
    await bridge.acceptRemoteTurn({ id: 't1', text: 'hi', persona: null }, { id: 'p3', name: 'Guest' });
    assert.equal(bridge.personas.has('p3'), false, 'a null persona should not fabricate an entry');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
