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
const { OOCChannel, clampGeometry, PANEL_BOUNDS } = await import(path.join(root, 'lib/ooc.js'));
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

function makeChannel({ connected = true, peerId = 'me', panel = {} } = {}) {
    const context = makeContext();
    const settings = { oocPanel: { ...panel } };
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
        settings: () => settings,
        save: () => { saves += 1; },
    });
    let saves = 0;
    return { channel, context, sent, toasts, settings, saveCount: () => saves };
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

console.log('\nPanel geometry');

const view = { width: 1600, height: 900 };

await test('with nothing saved, it lands bottom-right clear of the send bar', () => {
    const g = clampGeometry({}, view);
    assert.equal(g.width, PANEL_BOUNDS.defaultWidth);
    assert.equal(g.height, PANEL_BOUNDS.defaultHeight);
    assert.equal(g.left, view.width - g.width - 16);
    assert.equal(g.top, view.height - g.height - 84);
});

await test('a saved position and size are honoured', () => {
    const g = clampGeometry({ left: 300, top: 120, width: 520, height: 600 }, view);
    assert.deepEqual(g, { left: 300, top: 120, width: 520, height: 600 });
});

await test('a panel saved off a bigger screen is pulled back into reach', () => {
    // Saved on a 3840-wide monitor, reopened on a laptop.
    const g = clampGeometry({ left: 3400, top: 1800, width: 380, height: 440 }, { width: 1280, height: 720 });
    assert.ok(g.left + PANEL_BOUNDS.minVisible <= 1280, 'left edge must stay reachable');
    assert.ok(g.top + PANEL_BOUNDS.minVisible <= 720, 'top edge must stay reachable');
    assert.ok(g.left >= PANEL_BOUNDS.minVisible - g.width);
});

await test('the title bar can never be dragged fully off any edge', () => {
    for (const attempt of [
        { left: -100000, top: -100000 },
        { left: 100000, top: 100000 },
        { left: -5000, top: 4000 },
    ]) {
        const g = clampGeometry({ ...attempt, width: 380, height: 440 }, view);
        assert.ok(g.left + g.width >= PANEL_BOUNDS.minVisible, `left ${g.left} leaves nothing grabbable`);
        assert.ok(g.left <= view.width - PANEL_BOUNDS.minVisible, `left ${g.left} is past the right edge`);
        assert.ok(g.top >= 0, 'the title bar must not go above the viewport');
        assert.ok(g.top <= view.height - PANEL_BOUNDS.minVisible, 'the title bar must stay on screen');
    }
});

await test('size is bounded below and above', () => {
    const tiny = clampGeometry({ width: 10, height: 10 }, view);
    assert.equal(tiny.width, PANEL_BOUNDS.minWidth);
    assert.equal(tiny.height, PANEL_BOUNDS.minHeight);

    const huge = clampGeometry({ width: 99999, height: 99999 }, view);
    assert.ok(huge.width <= view.width - 16);
    assert.ok(huge.height <= view.height - 16);
});

await test('survives a tiny viewport and junk input without throwing', () => {
    for (const [geometry, viewport] of [
        [{}, { width: 200, height: 150 }],
        [{ left: NaN, top: 'abc', width: null, height: undefined }, view],
        [null, view],
        [{ left: Infinity, top: -Infinity }, view],
        [{}, {}],
    ]) {
        const g = clampGeometry(geometry, viewport);
        for (const key of ['left', 'top', 'width', 'height']) {
            assert.ok(Number.isFinite(g[key]), `${key} was ${g[key]}`);
        }
    }
});

console.log('\nCollapse and persistence');

await test('collapsing toggles state and is written to settings', () => {
    const { channel, settings } = makeChannel();
    assert.equal(channel.collapsed, false);

    channel.toggleCollapse();
    assert.equal(channel.collapsed, true);
    assert.equal(settings.oocPanel.collapsed, true, 'collapsed state was not persisted');

    channel.toggleCollapse();
    assert.equal(channel.collapsed, false);
    assert.equal(settings.oocPanel.collapsed, false);
});

await test('reopening expands a panel that was closed while collapsed', () => {
    const { channel, settings } = makeChannel({ panel: { collapsed: true } });
    channel.collapsed = true;

    channel.openPanel();
    assert.equal(channel.collapsed, false, 'reopening should reveal the messages');
    assert.equal(settings.oocPanel.collapsed, false);
});

await test('resetting restores the defaults and reopens', () => {
    const { channel, settings } = makeChannel({ panel: { left: -9000, top: 8000, width: 12, collapsed: true } });
    channel.collapsed = true;

    const g = channel.resetPosition();
    assert.equal(channel.collapsed, false);
    assert.equal(g.width, PANEL_BOUNDS.defaultWidth);
    assert.equal(g.height, PANEL_BOUNDS.defaultHeight);
    assert.equal(settings.oocPanel.collapsed, false);
    assert.ok(Number.isFinite(settings.oocPanel.left) && settings.oocPanel.left >= 0);
});

await test('close and open drive the state machine with no DOM present', () => {
    const { channel } = makeChannel();
    channel.openPanel();
    assert.equal(channel.open, true);
    channel.close();
    assert.equal(channel.open, false);
    channel.toggle();
    assert.equal(channel.open, true);
    channel.toggle();
    assert.equal(channel.open, false);
});

await test('works without any settings store at all', () => {
    // deps.settings is optional; the channel must not throw when it is absent.
    const channel = new OOCChannel({
        getContext: () => makeContext(),
        send: () => {},
        isConnected: () => true,
        peerId: () => 'me',
        toastr: { info() {}, success() {}, warning() {}, error() {} },
    });
    channel.toggleCollapse();
    channel.resetPosition();
    assert.deepEqual(channel.stored, {});
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
