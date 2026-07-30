/**
 * Adversarial bug hunt.
 *
 * The other suites check that things work. This one deliberately tries to break
 * them: fill the room with peers who never get admitted, disconnect the host and
 * come back, claim the host slot twice, abandon a transfer halfway, run a long
 * session and watch for unbounded growth.
 *
 * Failures here are findings, not regressions — the point is to discover them.
 *
 * Run with:  node tests/hunt.test.mjs
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const { Relay } = await import(path.join(root, 'server/lib/relay.js'));
const { SecureSocket } = await import(path.join(root, 'lib/transport.js'));
const { LIMITS, OP } = await import(path.join(root, 'lib/protocol.js'));
const { fromBase64 } = await import(path.join(root, 'lib/crypto.js'));
const { ChunkAssembler } = await import(path.join(root, 'lib/cards.js'));

let nextPort = 20500;
const PORT = () => nextPort++;
const silent = () => {};

let passed = 0;
const findings = [];

async function probe(name, fn) {
    try {
        await fn();
        console.log(`  \u2713 ${name}`);
        passed += 1;
    } catch (error) {
        console.log(`  \u2717 ${name}`);
        console.log(`      ${error.message.split('\n')[0]}`);
        findings.push({ name, message: error.message });
    }
}

function collect(socket) {
    const seen = [];
    socket.addEventListener('message', event => seen.push(event.detail.payload));
    seen.waitForOp = (op, ms = 5000) => new Promise((resolve, reject) => {
        const started = Date.now();
        const poll = setInterval(() => {
            const found = seen.find(p => p?.op === op);
            if (found) { clearInterval(poll); resolve(found); }
            else if (Date.now() - started > ms) {
                clearInterval(poll);
                reject(new Error(`no "${op}"; saw: ${seen.map(p => p?.op).join(', ') || 'nothing'}`));
            }
        }, 20);
    });
    return seen;
}

const report = extensions => ({
    strictness: 'manifest',
    hash: extensions.map(e => `${e.id}@${e.version}`).sort().join('|'),
    extensions,
});

const HOST_EXT = [{ id: 'Ext-A', displayName: 'A', version: '1.0.0', commit: '', branch: 'main', remoteUrl: 'https://e.test/a.git' }];

async function bootRoom({ maxPeers = 4, requireParity = true } = {}) {
    const relay = new Relay({ log: silent });
    const info = await relay.start({
        port: PORT(), bindLan: false, roomName: 'hunt', maxPeers, requireParity, parityStrictness: 'manifest',
    });
    const psk = fromBase64(info.psk);

    const host = new SecureSocket({ url: `ws://127.0.0.1:${info.port}/`, psk, hostToken: info.hostToken, autoReconnect: false });
    const hostSeen = collect(host);
    await host.connect();
    await hostSeen.waitForOp(OP.WELCOME);
    host.send({ op: OP.ROSTER, name: 'Host' });
    if (requireParity) {
        await hostSeen.waitForOp(OP.PARITY_CHALLENGE);
        host.send({ op: OP.PARITY_REPORT, report: report(HOST_EXT) });
    }
    await hostSeen.waitForOp(OP.PARITY_RESULT);
    return { relay, info, psk, host, hostSeen };
}

async function joinClient({ info, psk }, { extensions = HOST_EXT, name = 'Guest', autoReconnect = false } = {}) {
    const client = new SecureSocket({ url: `ws://127.0.0.1:${info.port}/`, psk, autoReconnect });
    const seen = collect(client);
    const rejections = [];
    client.addEventListener('rejected', e => rejections.push(e.detail));
    await client.connect();
    await seen.waitForOp(OP.WELCOME);
    client.send({ op: OP.ROSTER, name });
    const challenge = await seen.waitForOp(OP.PARITY_CHALLENGE, 2500).catch(() => null);
    if (challenge) client.send({ op: OP.PARITY_REPORT, report: report(extensions) });
    return { client, seen, rejections };
}

async function shutdown(relay, ...sockets) {
    for (const s of sockets) { try { s?.close('done'); } catch { /* ignore */ } }
    await relay.stop();
    await new Promise(r => setTimeout(r, 60));
}

const settle = (ms = 300) => new Promise(r => setTimeout(r, ms));

// ===========================================================================
console.log('\nCapacity accounting');

await probe('peers stuck at the parity gate do not consume room capacity', async () => {
    const room = await bootRoom({ maxPeers: 3 });

    // Two peers with the wrong extensions: connected, never admitted.
    const a = await joinClient(room, { extensions: [], name: 'Mismatch1' });
    const b = await joinClient(room, { extensions: [], name: 'Mismatch2' });
    await a.seen.waitForOp(OP.PARITY_RESULT);
    await b.seen.waitForOp(OP.PARITY_RESULT);

    // A legitimate player should still be able to take the free seat.
    const good = await joinClient(room, { name: 'Legit' });
    const result = await good.seen.waitForOp(OP.PARITY_RESULT, 4000).catch(() => null);

    assert.ok(good.rejections.every(r => r.reason !== 'room_full'),
        'a legitimate player was refused because unadmitted peers were holding seats');
    assert.ok(result?.ok, 'the legitimate player was not admitted');

    await shutdown(room.relay, room.host, a.client, b.client, good.client);
});

await probe('a peer left in the lobby is eventually dropped', async () => {
    const room = await bootRoom();
    const held = await joinClient(room, { extensions: [], name: 'Held' });
    await held.seen.waitForOp(OP.PARITY_RESULT);

    const peer = [...room.relay.peers.values()].find(p => p.name === 'Held');
    assert.ok(peer, 'the held peer is not in the relay');
    assert.equal(peer.admitted, false);

    // The real timeout is 90s. Rather than wait it out, age the peer and drive
    // the sweeper directly — a heartbeat timeout alone can never remove it,
    // because an unadmitted peer answers pings perfectly well.
    peer.joinedAt = Date.now() - (LIMITS.LOBBY_TIMEOUT_MS + 5000);
    peer.lastSeen = Date.now();
    room.relay.sweep();
    await settle(600);

    const stillThere = [...room.relay.peers.values()].some(p => p.name === 'Held');
    assert.equal(stillThere, false, 'a peer that failed the extension check stays connected indefinitely');

    await shutdown(room.relay, room.host, held.client);
});

await probe('the lobby itself is capped so it cannot be flooded', async () => {
    const room = await bootRoom({ maxPeers: 2 });
    const waiting = [];

    // More mismatched peers than MAX_LOBBY allows.
    for (let i = 0; i < LIMITS.MAX_LOBBY + 2; i++) {
        waiting.push(await joinClient(room, { extensions: [], name: `Wait${i}` }).catch(() => null));
    }
    await settle(500);

    assert.ok(room.relay.peers.size <= LIMITS.MAX_LOBBY + 1,
        `lobby grew to ${room.relay.peers.size}, cap is ${LIMITS.MAX_LOBBY} plus the host`);

    await shutdown(room.relay, room.host, ...waiting.filter(Boolean).map(w => w.client));
});

// ===========================================================================
console.log('\nHost lifecycle');

await probe('the host reclaims its role after reconnecting', async () => {
    const room = await bootRoom();
    const guest = await joinClient(room, { name: 'Guest' });
    await guest.seen.waitForOp(OP.PARITY_RESULT);

    // Simulate the host's browser dropping and coming back.
    room.host.close('simulated drop');
    await settle(400);
    assert.equal(room.relay.host, null, 'the host slot should be free after a disconnect');

    const again = new SecureSocket({
        url: `ws://127.0.0.1:${room.info.port}/`,
        psk: room.psk,
        hostToken: room.info.hostToken,
        autoReconnect: false,
    });
    const seen = collect(again);
    await again.connect();
    const welcome = await seen.waitForOp(OP.WELCOME);

    assert.equal(welcome.role, 'host', 'a reconnecting host was not given the host role back');
    await shutdown(room.relay, again, guest.client);
});

await probe('a second host claim is refused while a host is connected', async () => {
    const room = await bootRoom();
    const impostor = new SecureSocket({
        url: `ws://127.0.0.1:${room.info.port}/`,
        psk: room.psk,
        hostToken: room.info.hostToken, // the real token, but the slot is taken
        autoReconnect: false,
    });
    const seen = collect(impostor);
    const rejections = [];
    impostor.addEventListener('rejected', e => rejections.push(e.detail));
    await impostor.connect();
    await settle(600);

    const welcome = seen.find(p => p?.op === OP.WELCOME);
    assert.ok(welcome?.role !== 'host' || rejections.length > 0,
        'two peers were both given the host role');
    assert.equal(room.relay.host?.name, 'Host', 'the original host lost its slot');

    await shutdown(room.relay, room.host, impostor);
});

await probe('clients are told when the host goes away', async () => {
    const room = await bootRoom();
    const guest = await joinClient(room, { name: 'Guest' });
    await guest.seen.waitForOp(OP.PARITY_RESULT);
    const before = guest.seen.length;

    room.host.close('host leaving');
    await settle(500);

    const gotSomething = guest.seen.length > before;
    assert.ok(gotSomething, 'a client is left with no indication that the host disappeared');

    await shutdown(room.relay, guest.client);
});

await probe('a client turn after the host leaves gets an error, not silence', async () => {
    const room = await bootRoom();
    const guest = await joinClient(room, { name: 'Guest' });
    await guest.seen.waitForOp(OP.PARITY_RESULT);

    room.host.close('host leaving');
    await settle(400);

    guest.client.send({ op: OP.CHAT_TURN, id: 't1', text: 'anyone there?', persona: { name: 'Guest' } });
    const error = await guest.seen.waitForOp(OP.ERROR, 3000).catch(() => null);
    assert.ok(error, 'a turn sent with no host connected vanished with no feedback');

    await shutdown(room.relay, guest.client);
});

// ===========================================================================
console.log('\nResource cleanup');

await probe('stop() completes while peers are mid-session', async () => {
    const room = await bootRoom();
    const guest = await joinClient(room, { name: 'Guest' });
    await guest.seen.waitForOp(OP.PARITY_RESULT);

    for (let i = 0; i < 20; i++) guest.client.send({ op: OP.OOC_MESSAGE, text: `chatter ${i}` });

    const started = Date.now();
    await room.relay.stop();
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 4000, `stop() took ${elapsed}ms with traffic in flight`);
    assert.equal(room.relay.running, false);
    assert.equal(room.relay.peers.size, 0, 'peers were left in the map after stop');
    assert.equal(room.relay.psk, null, 'the pre-shared key was not scrubbed');

    await settle(80);
    try { room.host.close(); guest.client.close(); } catch { /* ignore */ }
});

await probe('an abandoned avatar transfer does not leak forever', async () => {
    const assembler = new ChunkAssembler();
    // Start ten transfers and never finish any of them.
    for (let i = 0; i < 10; i++) {
        assembler.push({ cardId: `card-${i}`, seq: 0, total: 5, bytes: new Uint8Array(1024) });
    }
    assembler.clear();
    // After clear() nothing should remain; a fresh push must start clean.
    const done = assembler.push({ cardId: 'card-0', seq: 0, total: 1, bytes: new Uint8Array(8) });
    assert.ok(done instanceof Uint8Array, 'assembler state survived clear()');
    assert.equal(done.length, 8);
});

await probe('rate-limited peers are dropped without wedging the relay', async () => {
    const room = await bootRoom();
    const flooder = await joinClient(room, { name: 'Flood' });
    await flooder.seen.waitForOp(OP.PARITY_RESULT);

    for (let i = 0; i < LIMITS.RATE_MESSAGES * 4; i++) {
        flooder.client.send({ op: OP.OOC_MESSAGE, text: `x${i}` });
    }
    await settle(2500);

    // The room must still work for someone else afterwards.
    const good = await joinClient(room, { name: 'Good' });
    const result = await good.seen.waitForOp(OP.PARITY_RESULT, 5000).catch(() => null);
    assert.ok(result?.ok, 'the relay stopped accepting peers after handling a flood');

    await shutdown(room.relay, room.host, flooder.client, good.client);
});

// ===========================================================================
console.log('\nMalformed input from an authenticated peer');

await probe('junk payloads from an admitted peer do not kill the room', async () => {
    const room = await bootRoom();
    const guest = await joinClient(room, { name: 'Guest' });
    await guest.seen.waitForOp(OP.PARITY_RESULT);

    for (const payload of [
        { op: OP.OOC_MESSAGE },
        { op: OP.OOC_MESSAGE, text: { nested: 'object' } },
        { op: OP.CHAT_TURN, id: null, text: 12345 },
        { op: OP.CARDS_WANT, cardId: null, want: 'definition' },
        { op: OP.PARITY_REPORT, report: 'not an object' },
        { op: 'totally.unknown.opcode', payload: 'x'.repeat(5000) },
        { op: OP.ROSTER, name: '\u0000\u0000\u0000' },
    ]) {
        guest.client.send(payload);
    }
    await settle(600);

    assert.equal(room.relay.running, true, 'the relay stopped running');
    // A well-behaved peer must still be able to talk afterwards.
    guest.client.send({ op: OP.OOC_MESSAGE, text: 'still here' });
    const ooc = await guest.seen.waitForOp(OP.OOC_MESSAGE, 3000).catch(() => null);
    assert.ok(ooc, 'the peer could not send a valid message after sending junk');

    await shutdown(room.relay, room.host, guest.client);
});

await probe('a peer cannot address a frame to another peer with "to"', async () => {
    const room = await bootRoom();
    const a = await joinClient(room, { name: 'A' });
    const b = await joinClient(room, { name: 'B' });
    await a.seen.waitForOp(OP.PARITY_RESULT);
    await b.seen.waitForOp(OP.PARITY_RESULT);

    const bWelcome = b.seen.find(p => p?.op === OP.WELCOME);
    const before = b.seen.length;

    // Host-only routing field, used by a client.
    a.client.send({ op: OP.CARDS_DEFINITION, cardId: 'x', definition: { description: 'injected' }, to: bWelcome.peerId });
    await settle(500);

    const leaked = b.seen.slice(before).some(p => p?.op === OP.CARDS_DEFINITION);
    assert.equal(leaked, false, 'a client delivered a host-only frame straight to another client');

    await shutdown(room.relay, room.host, a.client, b.client);
});

// ===========================================================================
console.log('\nLong-session growth');

await probe('per-session bookkeeping does not grow without bound', async () => {
    const { ChatBridge } = await import(path.join(root, 'lib/chat.js'));

    const chat = [];
    const context = {
        chat,
        eventSource: { on() {}, removeListener() {} },
        eventTypes: {},
        addOneMessage() {},
        humanizedDateTime: () => 'now',
        saveChat: async () => {},
        substituteParams: () => 'Player',
        powerUserSettings: {},
        printMessages: async () => {},
    };

    const bridge = new ChatBridge({
        getContext: () => context,
        send: () => {},
        role: () => 'host',
        isActive: () => true,
    });

    // Simulate a very long session: 5000 turns from remote peers.
    for (let i = 0; i < 5000; i++) {
        await bridge.acceptRemoteTurn({ id: `turn-${i}`, text: `line ${i}`, persona: { name: 'P' } }, { id: 'p1' });
    }

    const tracked = bridge.appliedIds.size;
    assert.ok(tracked <= 2000,
        `appliedIds grew to ${tracked} entries over 5000 turns — the de-duplication set never forgets`);
});

// ===========================================================================
console.log(`\n${passed} passed, ${findings.length} findings\n`);

if (findings.length) {
    console.log('FINDINGS');
    for (const [i, f] of findings.entries()) {
        console.log(`  ${i + 1}. ${f.name}`);
        for (const line of f.message.split('\n').slice(0, 3)) console.log(`     ${line}`);
    }
    console.log();
}
process.exit(0); // findings are informational; this suite is a hunt, not a gate
