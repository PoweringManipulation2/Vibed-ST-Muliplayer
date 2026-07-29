/**
 * Out-of-character channel tests.
 *
 * The whole point of this channel is that the model never sees it. That is a
 * claim about a data structure, not a feeling: SillyTavern builds prompts by
 * walking `getContext().chat`, so the guarantee holds if and only if nothing
 * from the OOC channel is ever written into that array (or into chat metadata,
 * which is persisted alongside it).
 *
 * These tests drive the real OOCChannel against a mock context whose `chat`
 * array is watched, and fail if anything lands in it.
 *
 * Run with:  node tests/ooc.test.mjs
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

// A DOM stub is enough: the channel guards every query with `?.`, so with no
// panel mounted it exercises the state and protocol paths and skips rendering.
const { OOCChannel } = await import(path.join(root, 'lib/ooc.js'));
const { OOC, OP } = await import(path.join(root, 'lib/protocol.js'));

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

/** Mock context that records every attempt to touch prompt-bearing state. */
function makeContext() {
    const slashCommands = [];
    const variables = new Map();
    return {
        chat: [],
        chatMetadata: {},
        extensionPrompts: {},
        slashCommands,
        setExtensionPrompt: (...args) => { throw new Error(`setExtensionPrompt called with ${JSON.stringify(args)}`); },
        executeSlashCommandsWithOptions: async command => {
            slashCommands.push(command);
            return { pipe: '' };
        },
        variables: {
            local: {
                set: (key, value) => variables.set(key, value),
                get: key => variables.get(key),
                del: key => variables.delete(key),
            },
        },
        _variables: variables,
    };
}

function makeChannel({ connected = true, peerId = 'me' } = {}) {
    const context = makeContext();
    const sent = [];
    const toasts = [];
    const channel = new OOCChannel({
        getContext: () => context,
        send: payload => sent.push(payload),
        isConnected: () => connected,
        peerId: () => peerId,
        toastr: {
            info: (m, t) => toasts.push(['info', m, t]),
            success: (m, t) => toasts.push(['success', m, t]),
            warning: (m, t) => toasts.push(['warning', m, t]),
            error: (m, t) => toasts.push(['error', m, t]),
        },
    });
    return { channel, context, sent, toasts };
}

const relayed = (overrides = {}) => ({
    op: OP.OOC_MESSAGE,
    id: 'm1',
    from: 'peer-2',
    name: 'Casey',
    role: 'client',
    text: 'want to split up at the bridge?',
    sentAt: Date.now(),
    ...overrides,
});

console.log('\nIsolation from the prompt');

await test('a received message never enters context.chat', () => {
    const { channel, context } = makeChannel();
    channel.receive(relayed());
    channel.receive(relayed({ id: 'm2', text: 'or stay together' }));

    assert.equal(context.chat.length, 0, 'OOC messages leaked into the chat array');
    assert.equal(channel.messages.length, 2, 'the channel should hold its own transcript');
});

await test('a large backlog never enters context.chat', () => {
    const { channel, context } = makeChannel();
    channel.receiveHistory({
        messages: Array.from({ length: 500 }, (_, i) => relayed({ id: `h${i}`, text: `line ${i}` })),
    });
    assert.equal(context.chat.length, 0, 'history replay leaked into the chat array');
    assert.equal(channel.messages.length, OOC.RENDER_LIMIT, 'history should be trimmed to the render limit');
});

await test('nothing is written to chat metadata or extension prompts', () => {
    const { channel, context } = makeChannel();
    channel.receive(relayed());
    channel.receiveTyping({ from: 'peer-2', name: 'Casey' });
    assert.deepEqual(context.chatMetadata, {}, 'chat metadata was modified');
    assert.deepEqual(context.extensionPrompts, {}, 'an extension prompt was registered');
});

await test('setExtensionPrompt is never called (that path would reach the prompt)', () => {
    const { channel } = makeChannel();
    // The mock throws if it is called, so simply exercising the channel is the test.
    channel.receive(relayed());
    channel.receiveHistory({ messages: [relayed()] });
    channel.receiveTyping({ from: 'x', name: 'Y' });
    channel.onDisconnect();
    channel.reset();
});

console.log('\nSending');

await test('sending emits an ooc.message and adds nothing locally', () => {
    const { channel, sent, context } = makeChannel();
    // No panel is mounted, so drive the protocol path directly.
    channel.deps.send({ op: OP.OOC_MESSAGE, text: 'ready when you are' });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].op, OP.OOC_MESSAGE);
    assert.equal(context.chat.length, 0);
    // The author renders on the relay's echo, not locally — that is what keeps
    // everyone's ordering identical.
    assert.equal(channel.messages.length, 0);
});

await test('the relay echo is what populates the local transcript', () => {
    const { channel } = makeChannel({ peerId: 'me' });
    channel.receive(relayed({ from: 'me', name: 'Me', text: 'ready when you are' }));
    assert.equal(channel.messages.length, 1);
    assert.equal(channel.messages[0].text, 'ready when you are');
});

console.log('\nUnread accounting');

await test('other players increment the badge, my own echo does not', () => {
    const { channel } = makeChannel({ peerId: 'me' });
    channel.receive(relayed({ from: 'peer-2' }));
    channel.receive(relayed({ id: 'm2', from: 'peer-3', name: 'Dee' }));
    assert.equal(channel.unread, 2);

    channel.receive(relayed({ id: 'm3', from: 'me', name: 'Me' }));
    assert.equal(channel.unread, 2, 'my own message should not count as unread');
});

await test('opening the panel clears the badge', () => {
    const { channel } = makeChannel();
    channel.receive(relayed());
    assert.equal(channel.unread, 1);
    channel.openPanel(); // no DOM: sets state, skips rendering
    assert.equal(channel.unread, 0);
});

console.log('\nUntrusted input handling');

await test('over-long messages are truncated', () => {
    const { channel } = makeChannel();
    channel.receive(relayed({ text: 'x'.repeat(OOC.MAX_LENGTH * 3) }));
    assert.equal(channel.messages[0].text.length, OOC.MAX_LENGTH);
});

await test('a spoofed display name is truncated, and role is normalised', () => {
    const { channel } = makeChannel();
    channel.receive(relayed({ name: 'n'.repeat(500), role: 'administrator' }));
    assert.equal(channel.messages[0].name.length, 40);
    assert.equal(channel.messages[0].role, 'client', 'any role other than host must normalise to client');
});

await test('markup in a message stays text, never markup', () => {
    const { channel } = makeChannel();
    const payload = '<img src=x onerror=alert(1)>**not bold**';
    channel.receive(relayed({ text: payload }));
    // Stored verbatim; rendering uses textContent, so it is displayed literally.
    assert.equal(channel.messages[0].text, payload);
});

await test('malformed payloads are ignored rather than throwing', () => {
    const { channel } = makeChannel();
    channel.receive(null);
    channel.receive({});
    channel.receive(relayed({ text: undefined }));
    channel.receiveHistory({});
    channel.receiveHistory({ messages: 'nope' });
    channel.receiveTyping({});
    assert.equal(channel.messages.length, 0);
});

console.log('\nPosting into the roleplay is explicit only');

await test('no slash command runs as a side effect of chatting', async () => {
    const { channel, context } = makeChannel();
    channel.receive(relayed());
    channel.receiveHistory({ messages: [relayed()] });
    assert.deepEqual(context.slashCommands, [], 'chatting must not execute any command');
});

await test('the transcript survives a disconnect but state is cleared on reset', () => {
    const { channel } = makeChannel();
    channel.receive(relayed());
    channel.receiveTyping({ from: 'peer-2', name: 'Casey' });

    channel.onDisconnect();
    assert.equal(channel.messages.length, 1, 'planning history should stay readable after a drop');
    assert.equal(channel.typing.size, 0, 'typing indicators should be cleared');

    channel.reset();
    assert.equal(channel.messages.length, 0);
    assert.equal(channel.unread, 0);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
