/**
 * Generation notice tests.
 *
 * The banner exists so that a player does not send a turn into the middle of a
 * reply someone else already triggered. What it must never do is lie: a stale
 * "a reply is coming" is worse than no banner at all, because people stop
 * trusting it and go back to typing over each other.
 *
 * Run with:  node tests/notice.test.mjs
 */

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const { GenerationNotice, PHASE } = await import(path.join(root, 'lib/notice.js'));
const { ChatBridge } = await import(path.join(root, 'lib/chat.js'));

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

console.log('\nGeneration notice');

await test('says who asked while the request is queued', () => {
    const notice = new GenerationNotice({ isActive: () => true });
    notice.show({ phase: PHASE.PENDING, by: 'GreenHouse' });

    assert.match(notice.text(), /GreenHouse/);
    assert.match(notice.text(), /waiting/i);
});

await test('keeps the attribution once generation starts', () => {
    // GENERATION_STARTED knows only that generation began. Losing the name at the
    // transition would leave the banner saying something is happening without the
    // one detail that makes it actionable.
    const notice = new GenerationNotice({ isActive: () => true });
    notice.show({ phase: PHASE.PENDING, by: 'GreenHouse' });
    notice.show({ phase: PHASE.RUNNING });

    assert.match(notice.text(), /GreenHouse/, 'the requester was forgotten mid-reply');
    assert.match(notice.text(), /hold your turn/i);
});

await test('a late pending frame cannot demote a running reply', () => {
    const notice = new GenerationNotice({ isActive: () => true });
    notice.show({ phase: PHASE.RUNNING, by: 'GreenHouse' });
    notice.show({ phase: PHASE.PENDING, by: 'GreenHouse' });

    assert.match(notice.text(), /hold your turn/i, 'the banner flickered backwards');
});

await test('done clears it', () => {
    const notice = new GenerationNotice({ isActive: () => true });
    notice.show({ phase: PHASE.RUNNING, by: 'GreenHouse' });
    notice.show({ phase: PHASE.DONE });

    assert.equal(notice.text(), '');
});

await test('a lost GEN_END does not leave the banner up forever', () => {
    // A host that crashes mid-generation, or a GEN_END lost to a reconnect, would
    // otherwise leave a permanent claim that a reply is coming — which is worse
    // than no banner, because people stop trusting it.
    const notice = new GenerationNotice({ isActive: () => true });
    notice.show({ phase: PHASE.RUNNING, by: 'GreenHouse' });

    notice.sweep();
    assert.notEqual(notice.text(), '', 'a live reply must not be swept away early');

    notice.current.expiresAt = Date.now() - 1;
    notice.sweep();
    assert.equal(notice.text(), '', 'an expired notice should have been dropped');
});

await test('a queued request expires sooner than a running one', () => {
    // Pending only covers the milliseconds between the host accepting and
    // SillyTavern starting. Running legitimately takes minutes on a slow local
    // model, and expiring that early would be a lie in the other direction.
    const notice = new GenerationNotice({ isActive: () => true });

    notice.show({ phase: PHASE.PENDING, by: 'GreenHouse' });
    const pendingFor = notice.current.expiresAt - Date.now();

    notice.clear();
    notice.show({ phase: PHASE.RUNNING, by: 'GreenHouse' });
    const runningFor = notice.current.expiresAt - Date.now();

    assert.ok(runningFor > pendingFor, 'a running reply needs the longer grace period');
});

await test('garbage off the wire is ignored', () => {
    const notice = new GenerationNotice({ isActive: () => true });
    notice.show({ phase: 'not-a-phase', by: 'x' });
    assert.equal(notice.text(), '');

    notice.show({});
    assert.equal(notice.text(), '');
});

await test('a name from a peer cannot be unbounded', () => {
    const notice = new GenerationNotice({ isActive: () => true });
    notice.show({ phase: PHASE.PENDING, by: 'A'.repeat(500) });
    assert.ok(notice.text().length < 120, 'a hostile name should not blow out the banner');
});

console.log('\nHost announces generation state');

function makeContext() {
    const handlers = new Map();
    return {
        chat: [],
        characters: [],
        characterId: 0,
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
        powerUserSettings: {},
        handlers,
        executeSlashCommandsWithOptions: async () => ({ pipe: '' }),
        saveChat: async () => {},
        addOneMessage: () => {},
        humanizedDateTime: () => 'now',
    };
}

function hostBridge() {
    const sent = [];
    const local = [];
    const context = makeContext();
    const bridge = new ChatBridge({
        getContext: () => context,
        send: payload => sent.push(payload),
        role: () => 'host',
        isActive: () => true,
        selfPeerId: () => 'me',
        autoReply: () => true,
        activePersonaAvatar: () => 'me.png',
        onNotice: payload => local.push(payload),
    });
    bridge.attach();
    return { bridge, sent, local, context, fire: (t, ...a) => context.handlers.get(t)?.(...a) };
}

await test('accepting a request announces who asked, to the room and locally', async () => {
    const { bridge, sent, local } = hostBridge();
    await bridge.handleGenerationRequest({ id: 'p2', name: 'GreenHouse' });

    const notice = sent.find(p => p.op === 'gen.notice');
    assert.ok(notice, 'the room was never told a reply was coming');
    assert.equal(notice.phase, 'pending');
    assert.equal(notice.by, 'GreenHouse');

    // The host is as likely to type over a reply as anyone else, so it has to see
    // its own announcement rather than only broadcasting it.
    assert.ok(local.some(p => p.phase === 'pending'), 'the host does not show its own notice');
});

await test('the running and done phases follow the generation', () => {
    const { bridge, sent, fire } = hostBridge();
    bridge._replyRequestedBy = 'GreenHouse';

    fire('gs');
    fire('ge');

    const phases = sent.filter(p => p.op === 'gen.notice').map(p => p.phase);
    assert.deepEqual(phases, ['running', 'done']);
});

await test('a host generating for itself still announces, with no name', () => {
    const { bridge, sent, fire } = hostBridge();
    void bridge;
    fire('gs');

    const notice = sent.find(p => p.op === 'gen.notice');
    assert.ok(notice, 'a host-initiated reply is just as disruptive to type over');
    assert.equal(notice.phase, 'running');
});

await test('a client never announces on behalf of the room', () => {
    const sent = [];
    const context = makeContext();
    const bridge = new ChatBridge({
        getContext: () => context,
        send: payload => sent.push(payload),
        role: () => 'client',
        isActive: () => true,
        selfPeerId: () => 'me',
        activePersonaAvatar: () => 'me.png',
    });
    bridge.attach();

    context.handlers.get('gs')?.();
    assert.ok(!sent.some(p => p.op === 'gen.notice'), 'only the host knows the true state');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
