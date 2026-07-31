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

function makeBridge({ role = 'host', active = true, context = makeContext(), selfPeerId = 'me', persona = {} } = {}) {
    const sent = [];
    const bridge = new ChatBridge({
        getContext: () => context,
        send: payload => sent.push(payload),
        role: () => role,
        isActive: () => active,
        selfPeerId: () => selfPeerId,
        activePersonaAvatar: () => persona.avatarId ?? 'me.png',
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

console.log('\nPrompt injection');

function bridgeWithPersonas(personas, chatText = []) {
    const injected = [];
    const context = makeContext();
    context.setExtensionPrompt = (key, value, position, depth, scan, role) => {
        injected.push({ key, value, position, depth, scan, role });
    };
    context.extensionPromptTypes = { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 };
    context.extensionPromptRoles = { SYSTEM: 0, USER: 1, ASSISTANT: 2 };
    context.chat = chatText.map(mes => ({ mes, extra: {} }));

    const { bridge } = makeBridge({ role: 'host', active: true, context });
    for (const [peerId, persona] of Object.entries(personas)) bridge.rememberPersona(peerId, persona);
    return { bridge, injected };
}

await test('remote persona descriptions actually reach the prompt', () => {
    // The gap that made replies wrong: personas arrived and were stored, but
    // nothing ever put them in front of the model.
    const { bridge, injected } = bridgeWithPersonas({
        p2: { name: 'Casey', description: 'A tired archivist who distrusts machines.' },
        p3: { name: 'Riley', description: 'A weary captain.' },
    });

    const text = bridge.injectPersonas();
    assert.equal(injected.length, 1, 'nothing was registered as an extension prompt');
    assert.match(text, /Casey: A tired archivist who distrusts machines\./);
    assert.match(text, /Riley: A weary captain\./);
    assert.equal(injected[0].position, 0, 'should be injected in-prompt');
});

await test('lorebook content is handed to World Info, not inlined here', () => {
    // Superseded behaviour: this used to scan recent chat for each entry's
    // keywords and paste matches into the injected block. That silently ignored
    // secondary keys, selective logic, position, order, depth, probability,
    // inclusion groups, recursion and the token budget.
    //
    // Lorebooks now go through a session-bound World Info book (lib/lore.js), so
    // SillyTavern activates them on the same code path as any other lorebook.
    // The contract asserted here is the handoff: entry text must NOT appear in
    // the injected block, or it would be duplicated and bypass its own settings.
    // tests/lore.test.mjs covers the merge and binding.
    const persona = {
        name: 'Casey',
        description: 'An archivist.',
        lorebook: {
            entries: [
                { key: ['ledger'], content: 'MATCHED_LORE_MARKER' },
                { key: ['never-said'], constant: true, content: 'CONSTANT_LORE_MARKER' },
            ],
        },
    };

    const { bridge } = bridgeWithPersonas({ p2: persona }, ['I open the ledger carefully.']);
    const text = bridge.injectPersonas(6, 'host-1');

    assert.match(text, /Casey: An archivist\./, 'the description still belongs in the block');
    assert.ok(!text.includes('MATCHED_LORE_MARKER'), 'a keyword-matched entry must not be inlined');
    assert.ok(!text.includes('CONSTANT_LORE_MARKER'), 'a constant entry must not be inlined');
});

await test('a player with a lorebook but no description is still described as present', () => {
    const { bridge } = bridgeWithPersonas({
        p2: { name: 'Casey', description: '', lorebook: { entries: [{ key: ['a'], content: 'x' }] } },
    });
    const text = bridge.injectPersonas(6, 'host-1');
    assert.match(text, /Casey/, 'a player carrying only lore must still be named');
});

await test('with no remote personas the injection is cleared, not left stale', () => {
    const { bridge, injected } = bridgeWithPersonas({});
    assert.equal(bridge.injectPersonas(), '');
    assert.equal(injected.at(-1).value, '', 'a stale block would follow the host into other chats');

    bridge.clearPersonaInjection();
    assert.equal(injected.at(-1).value, '');
});

console.log('\nRemote message presentation');

await test('a remote turn carries the sender\'s portrait, not the receiver\'s', async () => {
    const { bridge } = makeBridge({ role: 'host', active: true });
    bridge.rememberPersona('p2', {
        name: 'Casey',
        description: 'An archivist.',
        avatarData: 'data:image/webp;base64,AAAA',
    });

    const message = await bridge.acceptRemoteTurn({ id: 't1', text: 'I check the ledger.', persona: { name: 'Casey' } }, { id: 'p2' });
    assert.equal(message.force_avatar, 'data:image/webp;base64,AAAA',
        'without force_avatar every remote player wears the local persona picture');
});

await test('a lightweight turn update does not wipe the stored portrait', async () => {
    // Turns carry a partial persona on purpose; treating it as the whole truth
    // made the face revert to the receiver's own after the first message.
    const { bridge } = makeBridge({ role: 'host', active: true });
    bridge.rememberPersona('p2', { name: 'Casey', description: 'Full.', avatarData: 'data:image/webp;base64,AAAA', lorebookName: 'CaseyLore' });
    await bridge.acceptRemoteTurn({ id: 't1', text: 'hi', persona: { name: 'Casey', description: 'Full.' } }, { id: 'p2' });

    const stored = bridge.personas.get('p2');
    assert.equal(stored.avatarData, 'data:image/webp;base64,AAAA');
    assert.equal(stored.lorebookName, 'CaseyLore');
});

await test('only data URLs are accepted as a portrait', () => {
    const { bridge } = makeBridge({ role: 'host', active: true });
    for (const bad of [
        'https://evil.example/track.png', '/local/path.png', 'javascript:alert(1)',
        'data:text/html;base64,AAAA', 42, null,
    ]) {
        bridge.rememberPersona('p2', { name: 'X', avatarData: bad });
        assert.equal(bridge.personas.get('p2').avatarData, null, `accepted ${String(bad)}`);
    }
});

await test('an oversized portrait is rejected rather than relayed', () => {
    const { bridge } = makeBridge({ role: 'host', active: true });
    bridge.rememberPersona('p2', { name: 'X', avatarData: `data:image/png;base64,${'A'.repeat(300 * 1024)}` });
    assert.equal(bridge.personas.get('p2').avatarData, null);
});

await test('a remote turn is flagged so it can be marked in the UI', async () => {
    const { bridge } = makeBridge({ role: 'host', active: true });
    const message = await bridge.acceptRemoteTurn(
        { id: 't1', text: 'hello', persona: { name: 'Casey' } },
        { id: 'p2', name: 'Friend' });

    // Schema note: attribution is now by author identity rather than a bare
    // "remote" flag, so a receiver can decide for itself whose message it is.
    assert.equal(message.extra.stmp.player, true, 'a player turn must be distinguishable from the model\'s output');
    assert.equal(message.extra.stmp.authorPeerId, 'p2');
    assert.equal(message.extra.stmp.author, 'Casey');
    assert.equal(message.extra.stmp.playerName, 'Friend');
});

console.log('\nStreaming: no duplicated reply');

function streamingClient() {
    const context = makeContext();
    const { bridge } = makeBridge({ role: 'client', active: true, context });
    return { bridge, context };
}

await test('a token arriving after the reply is ignored', async () => {
    // The duplication: the host coalesces tokens on an 80ms timer, so one could
    // land after GEN_END and after the finished message, and the receiver built a
    // fresh placeholder holding the full text — a second copy of the reply.
    const { bridge, context } = streamingClient();

    bridge.beginStream();
    bridge.applyStreamToken({ text: 'She no' });
    assert.equal(context.chat.length, 1, 'a placeholder should exist while streaming');

    await bridge.applyRemoteMessage({
        message: { name: 'Ada', is_user: false, mes: 'She nods slowly.', extra: { stmp: { id: 'r1' } } },
    });
    bridge.endStream();
    assert.equal(context.chat.length, 1, 'the placeholder should have been replaced, not kept');
    assert.equal(context.chat[0].mes, 'She nods slowly.');

    // The late frame.
    bridge.applyStreamToken({ text: 'She nods slowly.' });
    assert.equal(context.chat.length, 1, 'a stray token created a duplicate reply');
});

await test('tokens before a stream starts are ignored', () => {
    const { bridge, context } = streamingClient();
    bridge.applyStreamToken({ text: 'orphan' });
    assert.equal(context.chat.length, 0);
});

await test('a normal stream still renders and resolves once', async () => {
    const { bridge, context } = streamingClient();
    bridge.beginStream();
    bridge.applyStreamToken({ text: 'She' });
    bridge.applyStreamToken({ text: 'She nods' });
    assert.equal(context.chat.length, 1);

    await bridge.applyRemoteMessage({
        message: { name: 'Ada', is_user: false, mes: 'She nods.', extra: { stmp: { id: 'r2' } } },
    });
    bridge.endStream();
    assert.equal(context.chat.length, 1);
    assert.equal(context.chat[0].mes, 'She nods.');
});

await test('the same reply delivered twice is applied once', async () => {
    const { bridge, context } = streamingClient();
    const message = { name: 'Ada', is_user: false, mes: 'Once.', extra: { stmp: { id: 'dup' } } };
    await bridge.applyRemoteMessage({ message });
    await bridge.applyRemoteMessage({ message });
    assert.equal(context.chat.length, 1, 'id de-duplication failed');
});

console.log('\nClient turns produce a reply');

await test('a player turn on its own never triggers a reply', async () => {
    // Guided Generations' Simple Send is `/send {{input}} | /setinput`: it appends
    // a user message and fires MESSAGE_SENT exactly like a normal send, so a turn
    // arriving cannot mean "answer this". Inferring it here is what made Simple
    // Send always trigger the model.
    const commands = [];
    const context = makeContext();
    context.executeSlashCommandsWithOptions = async command => {
        commands.push(command);
        return { pipe: '' };
    };
    const { bridge } = makeBridge({ role: 'host', active: true, context });

    await bridge.acceptRemoteTurn({ id: 't1', text: 'I open the door.', persona: { name: 'Casey' } }, { id: 'p2' });
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.deepEqual(commands, [], 'appending a turn must not start a generation');
    assert.equal(context.chat.length, 1, 'the turn should still be appended');
});

await test('an explicit generation request asks the model to answer', async () => {
    // The client's generate_interceptor only runs when SillyTavern was genuinely
    // about to generate, so this is the signal a normal send produces and Simple
    // Send does not.
    const commands = [];
    const context = makeContext();
    context.executeSlashCommandsWithOptions = async command => {
        commands.push(command);
        return { pipe: '' };
    };
    const { bridge } = makeBridge({ role: 'host', active: true, context });

    await bridge.handleGenerationRequest({ id: 'p2', name: 'Casey' });
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.equal(commands.length, 1, 'no reply was requested');
    assert.match(commands[0], /^\/trigger/, 'a reply should be triggered without adding another user message');
});

await test('a client forwards its generation intent instead of generating', () => {
    const { bridge, sent } = makeBridge({ role: 'client', active: true });
    bridge.requestGenerationFromHost(undefined);

    const request = sent.find(payload => payload.op === 'gen.request');
    assert.ok(request, 'the client never asked the host for a reply');
    assert.equal(request.genType, 'normal', 'an untyped generation should normalise');
});

console.log('\nPortraits survive the turns that follow them');

const PORTRAIT = 'data:image/webp;base64,UklGRhoAAABXRUJQ';

await test('a turn without a portrait keeps the one already published', () => {
    // PERSONA_STATE delivers the portrait at admission; every CHAT_TURN after it
    // carries a lightweight persona. Those updates must merge, not replace.
    const { bridge } = makeBridge({ role: 'host' });
    bridge.rememberPersona('p2', { name: 'Casey', avatarData: PORTRAIT });
    bridge.rememberPersona('p2', { name: 'Casey' });

    assert.equal(bridge.personas.get('p2').avatarData, PORTRAIT, 'the portrait was lost');
});

await test('an explicit null does not clear a published portrait', () => {
    // The exact regression: #localPersona() used to emit `avatarData: null`, and
    // rememberPersona() only preserved the previous value when the field was
    // undefined — so the first message destroyed the portrait and every remote
    // message fell back to the receiver's own persona picture.
    const { bridge } = makeBridge({ role: 'host' });
    bridge.rememberPersona('p2', { name: 'Casey', avatarData: PORTRAIT });
    bridge.rememberPersona('p2', { name: 'Casey', avatarData: null });

    assert.equal(bridge.personas.get('p2').avatarData, PORTRAIT, 'a null wiped the portrait');
});

await test('a malformed portrait is rejected without destroying the good one', () => {
    const { bridge } = makeBridge({ role: 'host' });
    bridge.rememberPersona('p2', { name: 'Casey', avatarData: PORTRAIT });
    bridge.rememberPersona('p2', { name: 'Casey', avatarData: 'https://example.invalid/x.png' });

    assert.equal(bridge.personas.get('p2').avatarData, PORTRAIT, 'a bad value should be ignored, not applied');
});

await test('a remote turn renders with that player\'s own face', async () => {
    const context = makeContext();
    const { bridge } = makeBridge({ role: 'host', active: true, context });
    bridge.rememberPersona('p2', { name: 'Casey', avatarData: PORTRAIT });

    await bridge.acceptRemoteTurn({ id: 't1', text: 'I open the door.', persona: { name: 'Casey' } }, { id: 'p2' });

    const message = context.chat.at(-1);
    assert.equal(message.force_avatar, PORTRAIT, 'without force_avatar the host\'s own persona picture is used');
});

await test('the host\'s own message carries a portrait peers can render', () => {
    // The mirror of the reported bug. SillyTavern stamps a LOCAL thumbnail URL on
    // your own messages, naming a file only your machine has — so forwarding it
    // verbatim meant every peer stripped it and rendered the host wearing their
    // own persona picture.
    const { sent, context, fire } = makeBridge({ role: 'host', active: true });

    context.chat.push({
        name: 'Legoshi',
        is_user: true,
        mes: 'I lie still on the ground.',
        force_avatar: '/thumbnail?type=persona&file=1774920536592-Legoshi.png',
        extra: {},
    });
    fire('ms', 0);

    const append = sent.find(payload => payload.op === 'chat.append');
    assert.ok(append, 'the message was never broadcast');
    assert.ok(
        !String(append.message.force_avatar ?? '').includes('/thumbnail'),
        'a local thumbnail URL must never be forwarded — it cannot resolve on any other machine',
    );
    assert.ok(
        !append.message.force_avatar || append.message.force_avatar.startsWith('data:image/'),
        'only self-contained data URLs are portable between peers',
    );
});

await test('a rebroadcast player turn keeps that player\'s portrait', async () => {
    const context = makeContext();
    const { bridge, sent } = makeBridge({ role: 'host', active: true, context });
    bridge.rememberPersona('p2', { name: 'Casey', avatarData: PORTRAIT });

    await bridge.acceptRemoteTurn({ id: 't9', text: 'I get up.', persona: { name: 'Casey' } }, { id: 'p2' });

    const append = sent.find(payload => payload.op === 'chat.append');
    assert.equal(append.message.force_avatar, PORTRAIT, 'the player\'s face was lost on rebroadcast');
});

await test('a delete with an unknown id does not remove someone else\'s message', () => {
    const { bridge, context } = makeBridge({ role: 'client', active: true });
    context.chat.push({ name: 'Ada', mes: 'first', extra: { stmp: { id: 'a' } } });
    context.chat.push({ name: 'Casey', mes: 'second', extra: { stmp: { id: 'b' } } });

    // Diverged view: the id is real elsewhere but absent here. Falling back to the
    // index deleted whatever happened to sit at that position.
    bridge.applyRemoteDelete({ id: 'not-here', index: 0 });

    assert.equal(context.chat.length, 2, 'an unmatched id must delete nothing');
});

await test('a client turn omits avatarData rather than sending null', () => {
    // Belt and braces for the same bug from the sending side: even a host that
    // still had the old merge logic would not be poisoned by this payload.
    const { sent, context, fire } = makeBridge({ role: 'client', active: true });
    context.chat.push({ name: 'Casey', is_user: true, mes: 'I open the door.', extra: {} });
    fire('ms', 0);

    const turn = sent.find(payload => payload.op === 'chat.turn');
    assert.ok(turn, 'the turn was never forwarded');
    assert.ok(!('avatarData' in turn.persona), 'avatarData must be absent, not null');
});

await test('auto-reply off ignores generation requests', async () => {
    const commands = [];
    const context = makeContext();
    context.executeSlashCommandsWithOptions = async command => { commands.push(command); return { pipe: '' }; };

    const bridge = new ChatBridge({
        getContext: () => context,
        send: () => {},
        role: () => 'host',
        isActive: () => true,
        autoReply: () => false,
    });
    bridge.attach();

    await bridge.handleGenerationRequest({ id: 'p2', name: 'Casey' });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(commands, [], 'a reply was triggered with auto-reply disabled');
});

console.log('\nTyping indicators');

const { TypingIndicators, IDLE_MS } = await import(path.join(root, 'lib/typing.js'));

function indicators({ active = true, me = 'me' } = {}) {
    const sent = [];
    return {
        sent,
        typing: new TypingIndicators({
            send: payload => sent.push(payload),
            isActive: () => active,
            peerId: () => me,
        }),
    };
}

await test('the idle window is three seconds', () => {
    assert.equal(IDLE_MS, 3000);
});

await test('a remote notice names the player, and stopping clears it', () => {
    const { typing } = indicators();
    typing.receive({ from: 'p2', name: 'GreenHouse', typing: true });
    assert.equal(typing.describe(), 'GreenHouse is typing…');

    typing.receive({ from: 'p2', name: 'GreenHouse', typing: false });
    assert.equal(typing.describe(), '');
});

await test('several players are summarised, not listed forever', () => {
    const { typing } = indicators();
    typing.receive({ from: 'p2', name: 'GreenHouse', typing: true });
    assert.match(typing.describe(), /^GreenHouse is typing/);

    typing.receive({ from: 'p3', name: 'Casey', typing: true });
    assert.equal(typing.describe(), 'GreenHouse and Casey are typing…');

    typing.receive({ from: 'p4', name: 'Riley', typing: true });
    assert.equal(typing.describe(), 'GreenHouse, Casey and Riley are typing…');

    typing.receive({ from: 'p5', name: 'Dee', typing: true });
    assert.equal(typing.describe(), '4 players are typing…');
});

await test('my own notice is never shown back to me', () => {
    const { typing } = indicators({ me: 'p1' });
    typing.receive({ from: 'p1', name: 'Me', typing: true });
    assert.equal(typing.describe(), '');
});

await test('a notice with no stamped author is ignored', () => {
    // The relay stamps `from`, so an unstamped notice is malformed or forged.
    const { typing } = indicators();
    typing.receive({ name: 'Ghost', typing: true });
    typing.receive({});
    typing.receive(null);
    assert.equal(typing.describe(), '');
});

await test('a departing player leaves no phantom indicator', () => {
    const { typing } = indicators();
    typing.receive({ from: 'p2', name: 'GreenHouse', typing: true });
    typing.forget('p2');
    assert.equal(typing.describe(), '');
});

await test('a stale indicator expires even with no stop notice', () => {
    const { typing } = indicators();
    typing.receive({ from: 'p2', name: 'GreenHouse', typing: true });
    // Simulate a peer that crashed mid-sentence.
    typing.active.get('p2').expiresAt = Date.now() - 1;
    typing.reset();
    assert.equal(typing.describe(), '');
});

await test('names are capped so the bar cannot be stretched', () => {
    const { typing } = indicators();
    typing.receive({ from: 'p2', name: 'n'.repeat(500), typing: true });
    assert.ok(typing.describe().length < 80);
});

console.log('\nAuthorship attribution');

const marker = message => message?.extra?.stmp ?? {};

await test('my own turn records me as the author', () => {
    const { context, fire } = makeBridge({ role: 'host', active: true, selfPeerId: 'host-1' });
    context.chat.push({ name: 'Legoshi', is_user: true, mes: 'I lie still.', extra: {} });
    fire('ms', 0);

    const m = marker(context.chat[0]);
    assert.equal(m.player, true);
    assert.equal(m.authorPeerId, 'host-1', 'without an author id no receiver can attribute the message');
    assert.equal(m.author, 'Legoshi');
});

await test('a model reply is explicitly not a player turn', () => {
    // The badge landed on the model's message; this is the flag that prevents it.
    const { context, fire } = makeBridge({ role: 'host', active: true, selfPeerId: 'host-1' });
    context.chat.push({ name: 'Dragon Dungeon', is_user: false, mes: 'She descends.', extra: {} });
    fire('mr', 0);

    assert.equal(marker(context.chat[0]).player, false);
    assert.equal(marker(context.chat[0]).authorPeerId, undefined);
});

await test('an accepted player turn is attributed to that peer', async () => {
    const { bridge } = makeBridge({ role: 'host', active: true, selfPeerId: 'host-1' });
    const message = await bridge.acceptRemoteTurn(
        { id: 't1', text: 'I nudge Legoshi', persona: { name: 'GreenHouse' } },
        { id: 'peer-2', name: 'GreenHouse' });

    const m = marker(message);
    assert.equal(m.player, true);
    assert.equal(m.authorPeerId, 'peer-2');
    assert.equal(m.author, 'GreenHouse');
});

await test('a mirrored message keeps its original author, not the relayer', async () => {
    // On a client, the host's own turn must still be attributable to the host.
    const { bridge, context } = makeBridge({ role: 'client', active: true, selfPeerId: 'peer-3' });
    await bridge.applyRemoteMessage({
        message: {
            name: 'Legoshi', is_user: true, mes: 'I lie still.',
            extra: { stmp: { id: 'h1', player: true, author: 'Legoshi', authorPeerId: 'host-1' } },
        },
    });

    const m = marker(context.chat[0]);
    assert.equal(m.authorPeerId, 'host-1', 'the host should be attributable from a client');
    assert.equal(m.player, true);
});

await test('a mirrored model reply is not attributed to a player', async () => {
    const { bridge, context } = makeBridge({ role: 'client', active: true, selfPeerId: 'peer-3' });
    await bridge.applyRemoteMessage({
        message: {
            name: 'Dragon Dungeon', is_user: false, mes: 'She descends.',
            extra: { stmp: { id: 'b1', player: false } },
        },
    });
    assert.equal(marker(context.chat[0]).player, false, 'the model would be badged as another player');
});

await test('attribution survives a transcript snapshot', async () => {
    const { bridge, context } = makeBridge({ role: 'client', active: true, selfPeerId: 'peer-3' });
    await bridge.applySnapshot({
        messages: [
            { name: 'Legoshi', is_user: true, mes: 'a', extra: { stmp: { id: 's1', player: true, author: 'Legoshi', authorPeerId: 'host-1' } } },
            { name: 'Dragon', is_user: false, mes: 'b', extra: { stmp: { id: 's2', player: false } } },
        ],
    });

    // Past messages used to carry no attribution at all, so scrolling back showed
    // nothing; a snapshot must preserve it.
    assert.equal(marker(context.chat[0]).authorPeerId, 'host-1');
    assert.equal(marker(context.chat[0]).player, true);
    assert.equal(marker(context.chat[1]).player, false);
});

await test('decorateAll is safe with no DOM and does not throw', () => {
    const { bridge } = makeBridge({ role: 'host', active: true });
    bridge.decorateAll();
    bridge.decorateAll();
});

console.log('\nActive persona is read, not the favourite');

await test('the active persona avatar is used, not default_persona', async () => {
    // default_persona is the *favourite* and is null unless explicitly set, so
    // reading it meant no portrait was ever captured and every remote message
    // fell back to the receiver's own picture.
    const context = makeContext({ persona: { name: 'GreenHouse', description: 'A player.' } });
    context.powerUserSettings.default_persona = null;
    context.getThumbnailUrl = (type, file) => `/thumbnail?type=${type}&file=${file}`;

    const captured = [];
    const bridge = new ChatBridge({
        getContext: () => context,
        send: () => {},
        role: () => 'client',
        isActive: () => true,
        selfPeerId: () => 'peer-2',
        activePersonaAvatar: () => 'greenhouse.png',
    });
    bridge.capturePersonaPortrait = async id => { captured.push(id); return null; };

    const persona = await bridge.describeLocalPersona();
    assert.equal(persona.avatarId, 'greenhouse.png', 'the active persona avatar was not used');
    assert.deepEqual(captured, ['greenhouse.png']);
});

await test('a per-avatar description is used when none is applied', async () => {
    const context = makeContext({ persona: { name: 'GreenHouse' } });
    context.powerUserSettings.persona_description = '';
    context.powerUserSettings.persona_descriptions = {
        'greenhouse.png': { description: 'From the persona record.', lorebook: 'GHLore' },
    };

    const bridge = new ChatBridge({
        getContext: () => context,
        send: () => {},
        role: () => 'client',
        isActive: () => true,
        selfPeerId: () => 'p',
        activePersonaAvatar: () => 'greenhouse.png',
    });
    bridge.capturePersonaPortrait = async () => null;

    const persona = await bridge.describeLocalPersona();
    assert.equal(persona.description, 'From the persona record.');
    assert.equal(persona.lorebookName, 'GHLore');
});

await test('the injection excludes my own persona', () => {
    const { bridge, injected } = bridgeWithPersonas({
        'host-1': { name: 'Legoshi', description: 'The host.' },
        'peer-2': { name: 'GreenHouse', description: 'The other player.' },
    });

    const text = bridge.injectPersonas(6, 'host-1');
    assert.ok(!text.includes('The host.'), 'SillyTavern already injects our own persona');
    assert.match(text, /GreenHouse: The other player\./);
    assert.equal(injected.length, 1);
});

await test('with only my own persona known, nothing is injected', () => {
    const { bridge } = bridgeWithPersonas({ 'host-1': { name: 'Legoshi', description: 'The host.' } });
    assert.equal(bridge.injectPersonas(6, 'host-1'), '',
        'injecting only our own persona made the block look correct when no peer persona had arrived');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
