/**
 * End-to-end test against a real relay.
 *
 * Starts the actual server plugin relay on a loopback port and drives it with
 * the actual browser transport (Node 22 exposes a global WebSocket, so
 * lib/transport.js runs unmodified). This exercises the parts that unit tests
 * cannot: the upgrade path, role assignment via the host token, the parity gate,
 * opcode authority, and forwarding.
 *
 * Run with:  node --experimental-global-webcrypto tests/e2e.test.mjs
 * On Node 20+ no flag is needed. `ws` must be resolvable — inside a real
 * SillyTavern install it is, since ws is one of its dependencies.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const { Relay } = await import(path.join(root, 'server/lib/relay.js'));
const { SecureSocket } = await import(path.join(root, 'lib/transport.js'));
const { LIMITS, OP, OOC, decodeConnectionCode, encodeConnectionCode } = await import(path.join(root, 'lib/protocol.js'));
const { fromBase64 } = await import(path.join(root, 'lib/crypto.js'));

assert.ok(typeof globalThis.WebSocket === 'function',
    'This test needs a global WebSocket (Node 20+).');

/** Fresh port per case, so one slow teardown cannot cascade into the next. */
let nextPort = 18900;
const PORT = () => nextPort++;

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  \u2713 ${name}`);
        passed += 1;
    } catch (error) {
        console.error(`  \u2717 ${name}\n      ${error.stack?.split('\n').slice(0, 3).join('\n      ')}`);
        failed += 1;
    }
}

const silent = () => {};

/** Waits for a named event, or rejects after `ms`. */
function waitFor(target, type, ms = 5000, predicate = () => true) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            target.removeEventListener(type, handler);
            reject(new Error(`Timed out waiting for "${type}"`));
        }, ms);
        const handler = event => {
            if (!predicate(event.detail)) return;
            clearTimeout(timer);
            target.removeEventListener(type, handler);
            resolve(event.detail);
        };
        target.addEventListener(type, handler);
    });
}

/** Collects every application payload a socket receives. */
function collect(socket) {
    const seen = [];
    socket.addEventListener('message', event => seen.push(event.detail.payload));
    seen.waitForOp = (op, ms = 5000) => new Promise((resolve, reject) => {
        const existing = seen.find(payload => payload?.op === op);
        if (existing) return resolve(existing);
        const started = Date.now();
        const poll = setInterval(() => {
            const found = seen.find(payload => payload?.op === op);
            if (found) {
                clearInterval(poll);
                resolve(found);
            } else if (Date.now() - started > ms) {
                clearInterval(poll);
                reject(new Error(`No "${op}" arrived. Saw: ${seen.map(p => p?.op).join(', ') || '(nothing)'}`));
            }
        }, 20);
    });
    return seen;
}

/** Waits until at least `count` payloads with `op` have arrived. */
function waitForCount(seen, op, count, ms = 5000) {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const poll = setInterval(() => {
            const found = seen.filter(payload => payload?.op === op);
            if (found.length >= count) {
                clearInterval(poll);
                resolve(found);
            } else if (Date.now() - started > ms) {
                clearInterval(poll);
                reject(new Error(`Only ${found.length}/${count} "${op}" arrived`));
            }
        }, 20);
    });
}

const manifestReport = extensions => ({
    strictness: 'manifest',
    hash: extensions.map(e => `${e.id}@${e.version}`).sort().join('|'),
    extensions,
});

const HOST_EXTENSIONS = [
    { id: 'Extension-A', displayName: 'A', version: '1.2.0', commit: '', branch: 'main', remoteUrl: 'https://example.test/a.git' },
    { id: 'Extension-B', displayName: 'B', version: '0.9.1', commit: '', branch: 'main', remoteUrl: 'https://example.test/b.git' },
];

/** Brings up a relay and connects a host peer that has cleared parity. */
async function bootRoom({ requireParity = true, maxPeers = 4 } = {}) {
    const relay = new Relay({ log: silent });
    const info = await relay.start({
        port: PORT(), bindLan: false, roomName: 'test room', maxPeers, requireParity,
        parityStrictness: 'manifest',
    });

    const psk = fromBase64(info.psk);
    const host = new SecureSocket({
        url: `ws://127.0.0.1:${info.port}/`,
        psk,
        hostToken: info.hostToken,
        autoReconnect: false,
    });
    const hostSeen = collect(host);

    const opened = waitFor(host, 'open');
    await host.connect();
    await opened;

    const welcome = await hostSeen.waitForOp(OP.WELCOME);
    host.send({ op: OP.ROSTER, name: 'TheHost', hostToken: info.hostToken });

    if (requireParity) {
        await hostSeen.waitForOp(OP.PARITY_CHALLENGE);
        host.send({ op: OP.PARITY_REPORT, report: manifestReport(HOST_EXTENSIONS) });
    }

    // The host is only usable once the relay confirms admission: that is the
    // signal the extension uses to attach its chat bridge and publish cards.
    await hostSeen.waitForOp(OP.PARITY_RESULT);
    await hostSeen.waitForOp(OP.ROSTER);

    return { relay, info, psk, host, hostSeen, welcome };
}

/** Connects a client peer with a chosen extension set. */
async function joinClient({ info, psk, extensions = HOST_EXTENSIONS, name = 'Guest' }) {
    const client = new SecureSocket({
        url: `ws://127.0.0.1:${info.port}/`,
        psk,
        autoReconnect: false,
    });
    const seen = collect(client);
    const rejections = [];
    client.addEventListener('rejected', event => rejections.push(event.detail));

    const opened = waitFor(client, 'open');
    await client.connect();
    await opened;

    await seen.waitForOp(OP.WELCOME);
    client.send({ op: OP.ROSTER, name });

    const challenge = await seen.waitForOp(OP.PARITY_CHALLENGE).catch(() => null);
    if (challenge) client.send({ op: OP.PARITY_REPORT, report: manifestReport(extensions) });

    return { client, seen, rejections };
}

async function shutdown(relay, ...sockets) {
    for (const socket of sockets) {
        try { socket?.close('test over'); } catch { /* ignore */ }
    }
    await relay.stop();
    // Let the OS release the port between cases.
    await new Promise(resolve => setTimeout(resolve, 60));
}

console.log('\nRelay lifecycle');

await test('starts, reports itself, and stops cleanly', async () => {
    const relay = new Relay({ log: silent });
    const info = await relay.start({ port: PORT(), bindLan: false, roomName: 'lifecycle' });

    assert.equal(relay.running, true);
    assert.ok(info.port >= 18900);
    assert.match(info.roomId, /^[0-9a-f]{16}$/);
    assert.equal(fromBase64(info.psk).length, 16);
    assert.ok(info.hostToken.length > 20);
    assert.deepEqual(info.addresses, [`127.0.0.1:${info.port} (loopback only)`]);

    await relay.stop();
    assert.equal(relay.running, false);
    assert.equal(relay.psk, null, 'the pre-shared key must be dropped on stop');
    await new Promise(resolve => setTimeout(resolve, 60));
});

await test('a second start on the same port reports the conflict', async () => {
    const port = PORT();
    const first = new Relay({ log: silent });
    const second = new Relay({ log: silent });
    await first.start({ port, bindLan: false });
    await assert.rejects(() => second.start({ port, bindLan: false }), /already in use/);
    await shutdown(first);
});

await test('stop releases the port, so restarting on it works', async () => {
    const port = PORT();
    const relay = new Relay({ log: silent });

    await relay.start({ port, bindLan: false, roomName: 'restart' });
    // Hold a live connection open: this is what used to keep the listener bound.
    const psk = fromBase64(relay.describe().psk);
    const peer = new SecureSocket({ url: `ws://127.0.0.1:${port}/`, psk, autoReconnect: false });
    await waitFor(peer, 'open', 5000, () => true, await peer.connect());
    await relay.stop();

    // No sleep: if stop() resolved honestly the port is free right now.
    await relay.start({ port, bindLan: false, roomName: 'restart again' });
    assert.equal(relay.running, true);
    await shutdown(relay, peer);
});

console.log('\nHandshake and roles');

await test('the host is told it has been admitted', async () => {
    // Regression: the host used to be seated silently, so its UI never left
    // the "checking extensions" state and never published its shared cards.
    const room = await bootRoom();
    const result = room.hostSeen.find(p => p?.op === OP.PARITY_RESULT);
    assert.ok(result, 'the host received no admission confirmation');
    assert.equal(result.ok, true);
    await shutdown(room.relay, room.host);
});

await test('the host token seats the host', async () => {
    const room = await bootRoom();
    assert.equal(room.welcome.role, 'host');
    assert.equal(room.relay.host?.name, 'TheHost');
    assert.equal(room.relay.status().hostConnected, true);
    await shutdown(room.relay, room.host);
});

await test('a peer without the token is seated as a client', async () => {
    const room = await bootRoom();
    const guest = await joinClient(room);
    const result = await guest.seen.waitForOp(OP.PARITY_RESULT);
    assert.equal(result.ok, true);

    const roster = await guest.seen.waitForOp(OP.ROSTER);
    assert.equal(roster.peers.length, 2);
    assert.deepEqual(roster.peers.map(p => p.role).sort(), ['client', 'host']);

    await shutdown(room.relay, room.host, guest.client);
});

await test('a wrong connection code never reaches a session', async () => {
    const room = await bootRoom();

    const wrong = new SecureSocket({
        url: `ws://127.0.0.1:${room.info.port}/`,
        psk: new Uint8Array(16).fill(0xab),
        autoReconnect: false,
    });
    const rejected = waitFor(wrong, 'rejected');
    await wrong.connect();
    const detail = await rejected;

    // The room id is a hash of the PSK, so a wrong code is caught at hello.
    assert.equal(detail.reason, 'unknown_room');
    assert.notEqual(wrong.state, 'open');

    await shutdown(room.relay, room.host, wrong);
});

await test('a forged host token is refused and the peer becomes a client', async () => {
    const room = await bootRoom();
    const impostor = await joinClient({
        ...room,
        name: 'Impostor',
    });
    // Claim the host slot after the fact with a fabricated token.
    impostor.client.send({ op: OP.ROSTER, name: 'Impostor', hostToken: Buffer.alloc(32, 7).toString('base64') });
    await impostor.seen.waitForOp(OP.PARITY_RESULT);

    assert.equal(room.relay.host?.name, 'TheHost', 'the host slot must not change hands');
    await shutdown(room.relay, room.host, impostor.client);
});

console.log('\nExtension parity gate');

await test('a matching extension set is admitted', async () => {
    const room = await bootRoom();
    const guest = await joinClient(room);
    const result = await guest.seen.waitForOp(OP.PARITY_RESULT);
    assert.equal(result.ok, true);

    const seated = room.relay.status().peers.filter(peer => peer.admitted);
    assert.equal(seated.length, 2);
    await shutdown(room.relay, room.host, guest.client);
});

await test('a missing extension is reported as a diff, not admitted', async () => {
    const room = await bootRoom();
    const guest = await joinClient({ ...room, extensions: [HOST_EXTENSIONS[0]] });

    const result = await guest.seen.waitForOp(OP.PARITY_RESULT);
    assert.equal(result.ok, false);
    assert.equal(result.diff.missing.length, 1);
    assert.equal(result.diff.missing[0].id, 'Extension-B');
    // The diff carries the git URL, which is what makes one-click sync possible.
    assert.equal(result.diff.missing[0].remoteUrl, 'https://example.test/b.git');

    const guestPeer = room.relay.status().peers.find(peer => peer.name === 'Guest');
    assert.equal(guestPeer.admitted, false, 'a mismatched peer must not be admitted');
    await shutdown(room.relay, room.host, guest.client);
});

await test('an extra extension is reported', async () => {
    const room = await bootRoom();
    const guest = await joinClient({
        ...room,
        extensions: [...HOST_EXTENSIONS, { id: 'Extension-C', displayName: 'C', version: '1.0.0', commit: '', branch: '', remoteUrl: '' }],
    });
    const result = await guest.seen.waitForOp(OP.PARITY_RESULT);
    assert.equal(result.ok, false);
    assert.deepEqual(result.diff.extra.map(e => e.id), ['Extension-C']);
    await shutdown(room.relay, room.host, guest.client);
});

await test('a version difference is reported with both sides', async () => {
    const room = await bootRoom();
    const guest = await joinClient({
        ...room,
        extensions: [HOST_EXTENSIONS[0], { ...HOST_EXTENSIONS[1], version: '0.8.0' }],
    });
    const result = await guest.seen.waitForOp(OP.PARITY_RESULT);
    assert.equal(result.ok, false);
    assert.equal(result.diff.mismatched.length, 1);
    assert.equal(result.diff.mismatched[0].version, '0.9.1');
    assert.equal(result.diff.mismatched[0].clientVersion, '0.8.0');
    await shutdown(room.relay, room.host, guest.client);
});

await test('with the check disabled, a mismatched peer is admitted', async () => {
    const room = await bootRoom({ requireParity: false });
    const guest = await joinClient({ ...room, extensions: [] });
    const result = await guest.seen.waitForOp(OP.PARITY_RESULT);
    assert.equal(result.ok, true, 'a peer admitted without a parity check must still be told');
    const guestPeer = room.relay.status().peers.find(peer => peer.name === 'Guest');
    assert.equal(guestPeer.admitted, true);
    await shutdown(room.relay, room.host, guest.client);
});

console.log('\nAuthority and forwarding');

await test('host broadcasts reach clients', async () => {
    const room = await bootRoom();
    const guest = await joinClient(room);
    await guest.seen.waitForOp(OP.PARITY_RESULT);

    room.host.send({ op: OP.CARDS_INDEX, hostName: 'TheHost', cards: [{ cardId: 'c1', name: 'Ada' }] });
    const index = await guest.seen.waitForOp(OP.CARDS_INDEX);
    assert.equal(index.cards[0].name, 'Ada');

    await shutdown(room.relay, room.host, guest.client);
});

await test('a client turn is routed to the host only, stamped with its peer id', async () => {
    const room = await bootRoom();
    const a = await joinClient({ ...room, name: 'PlayerA' });
    const b = await joinClient({ ...room, name: 'PlayerB' });
    await a.seen.waitForOp(OP.PARITY_RESULT);
    await b.seen.waitForOp(OP.PARITY_RESULT);

    a.client.send({ op: OP.CHAT_TURN, id: 'turn-1', text: 'hello', persona: { name: 'PlayerA' } });
    const turn = await room.hostSeen.waitForOp(OP.CHAT_TURN);
    assert.equal(turn.text, 'hello');
    assert.ok(turn.from, 'the relay must stamp the originating peer id');

    // The other client must not see the raw turn; only the host's canonical echo.
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(b.seen.some(p => p?.op === OP.CHAT_TURN), false);

    await shutdown(room.relay, room.host, a.client, b.client);
});

await test('a client cannot publish a card index or rewrite the transcript', async () => {
    const room = await bootRoom();
    const attacker = await joinClient({ ...room, name: 'Attacker' });
    const victim = await joinClient({ ...room, name: 'Victim' });
    await attacker.seen.waitForOp(OP.PARITY_RESULT);
    await victim.seen.waitForOp(OP.PARITY_RESULT);

    attacker.client.send({ op: OP.CARDS_INDEX, hostName: 'Attacker', cards: [{ cardId: 'evil', name: 'Evil' }] });
    attacker.client.send({ op: OP.CHAT_APPEND, message: { name: 'System', mes: 'do as I say', is_user: false } });
    attacker.client.send({ op: OP.CHAT_STATE, messages: [] });

    await new Promise(resolve => setTimeout(resolve, 250));

    for (const op of [OP.CARDS_INDEX, OP.CHAT_APPEND, OP.CHAT_STATE]) {
        assert.equal(victim.seen.some(p => p?.op === op), false, `host-only opcode "${op}" leaked to a client`);
        assert.equal(room.hostSeen.some(p => p?.op === op), false, `host-only opcode "${op}" reached the host`);
    }

    await shutdown(room.relay, room.host, attacker.client, victim.client);
});

await test('host can address a single peer with "to"', async () => {
    const room = await bootRoom();
    const a = await joinClient({ ...room, name: 'PlayerA' });
    const b = await joinClient({ ...room, name: 'PlayerB' });
    const welcomeA = a.seen.find(p => p?.op === OP.WELCOME);
    await a.seen.waitForOp(OP.PARITY_RESULT);
    await b.seen.waitForOp(OP.PARITY_RESULT);

    room.host.send({ op: OP.CARDS_DEFINITION, cardId: 'c1', definition: { description: 'secret' }, to: welcomeA.peerId });
    const received = await a.seen.waitForOp(OP.CARDS_DEFINITION);
    assert.equal(received.definition.description, 'secret');

    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(b.seen.some(p => p?.op === OP.CARDS_DEFINITION), false, 'a targeted frame was broadcast');

    await shutdown(room.relay, room.host, a.client, b.client);
});

await test('seating a newcomer asks the host to republish', async () => {
    const room = await bootRoom();
    const guest = await joinClient(room);
    await guest.seen.waitForOp(OP.PARITY_RESULT);
    const want = await room.hostSeen.waitForOp(OP.CARDS_WANT);
    assert.equal(want.want, 'republish');
    assert.ok(want.from);
    await shutdown(room.relay, room.host, guest.client);
});

console.log('\nCapacity and moderation');

await test('the room refuses peers past its limit', async () => {
    const room = await bootRoom({ maxPeers: 2 });
    const guest = await joinClient(room);
    await guest.seen.waitForOp(OP.PARITY_RESULT);

    const extra = new SecureSocket({
        url: `ws://127.0.0.1:${room.info.port}/`,
        psk: room.psk,
        autoReconnect: false,
    });
    const rejected = waitFor(extra, 'rejected');
    await extra.connect();
    assert.equal((await rejected).reason, 'room_full');

    await shutdown(room.relay, room.host, guest.client, extra);
});

await test('kick removes a peer and tells it why', async () => {
    const room = await bootRoom();
    const guest = await joinClient(room);
    await guest.seen.waitForOp(OP.PARITY_RESULT);

    const peerId = room.relay.status().peers.find(peer => peer.name === 'Guest').id;
    assert.equal(room.relay.kick(peerId), true);

    const kick = await guest.seen.waitForOp(OP.KICK);
    assert.equal(kick.reason, 'host');

    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(room.relay.status().peers.some(peer => peer.name === 'Guest'), false);

    await shutdown(room.relay, room.host, guest.client);
});

await test('rotating the code invalidates the old one', async () => {
    const room = await bootRoom();
    const guest = await joinClient(room);
    await guest.seen.waitForOp(OP.PARITY_RESULT);

    const oldPsk = room.psk;
    const rotated = room.relay.rotate();
    assert.notEqual(rotated.psk, room.info.psk);

    await new Promise(resolve => setTimeout(resolve, 200));

    const stale = new SecureSocket({
        url: `ws://127.0.0.1:${room.info.port}/`,
        psk: oldPsk,
        autoReconnect: false,
    });
    const rejected = waitFor(stale, 'rejected');
    await stale.connect();
    assert.equal((await rejected).reason, 'unknown_room');

    await shutdown(room.relay, room.host, guest.client, stale);
});

console.log('\nOut-of-character channel');

await test('an OOC message reaches every peer, sender included', async () => {
    const room = await bootRoom();
    const a = await joinClient({ ...room, name: 'PlayerA' });
    const b = await joinClient({ ...room, name: 'PlayerB' });
    await a.seen.waitForOp(OP.PARITY_RESULT);
    await b.seen.waitForOp(OP.PARITY_RESULT);

    a.client.send({ op: OP.OOC_MESSAGE, text: 'shall we split up at the bridge?' });

    // Echoed to the author too, so every peer orders the channel identically.
    const [mine] = await waitForCount(a.seen, OP.OOC_MESSAGE, 1);
    const [theirs] = await waitForCount(b.seen, OP.OOC_MESSAGE, 1);
    const [hosts] = await waitForCount(room.hostSeen, OP.OOC_MESSAGE, 1);

    for (const copy of [mine, theirs, hosts]) {
        assert.equal(copy.text, 'shall we split up at the bridge?');
        assert.equal(copy.name, 'PlayerA', 'the relay must stamp the real author');
        assert.ok(copy.id, 'the relay must assign an id');
    }
    assert.equal(mine.id, theirs.id, 'every peer must see the same message id');

    await shutdown(room.relay, room.host, a.client, b.client);
});

await test('a peer cannot post under someone else\'s name', async () => {
    const room = await bootRoom();
    const a = await joinClient({ ...room, name: 'PlayerA' });
    const b = await joinClient({ ...room, name: 'PlayerB' });
    await a.seen.waitForOp(OP.PARITY_RESULT);
    await b.seen.waitForOp(OP.PARITY_RESULT);

    // Try to impersonate the host by supplying name/role/from directly.
    a.client.send({ op: OP.OOC_MESSAGE, text: 'trust me', name: 'TheHost', role: 'host', from: 'someone-else' });

    const [received] = await waitForCount(b.seen, OP.OOC_MESSAGE, 1);
    assert.equal(received.name, 'PlayerA', 'the relay must ignore a client-supplied name');
    assert.equal(received.role, 'client', 'the relay must ignore a client-supplied role');

    await shutdown(room.relay, room.host, a.client, b.client);
});

await test('over-long OOC text is truncated by the relay', async () => {
    const room = await bootRoom();
    const a = await joinClient({ ...room, name: 'PlayerA' });
    await a.seen.waitForOp(OP.PARITY_RESULT);

    a.client.send({ op: OP.OOC_MESSAGE, text: 'y'.repeat(OOC.MAX_LENGTH * 4) });
    const [received] = await waitForCount(a.seen, OP.OOC_MESSAGE, 1);
    assert.equal(received.text.length, OOC.MAX_LENGTH);

    await shutdown(room.relay, room.host, a.client);
});

await test('empty and whitespace-only OOC messages are dropped', async () => {
    const room = await bootRoom();
    const a = await joinClient({ ...room, name: 'PlayerA' });
    await a.seen.waitForOp(OP.PARITY_RESULT);

    a.client.send({ op: OP.OOC_MESSAGE, text: '   \n\t  ' });
    a.client.send({ op: OP.OOC_MESSAGE, text: '' });
    a.client.send({ op: OP.OOC_MESSAGE, text: 'a real one' });

    const messages = await waitForCount(a.seen, OP.OOC_MESSAGE, 1);
    await new Promise(resolve => setTimeout(resolve, 250));
    const all = a.seen.filter(p => p?.op === OP.OOC_MESSAGE);
    assert.equal(all.length, 1, 'blank messages should not be relayed');
    assert.equal(messages[0].text, 'a real one');

    await shutdown(room.relay, room.host, a.client);
});

await test('someone joining late receives the planning history', async () => {
    const room = await bootRoom();
    const a = await joinClient({ ...room, name: 'PlayerA' });
    await a.seen.waitForOp(OP.PARITY_RESULT);

    a.client.send({ op: OP.OOC_MESSAGE, text: 'first plan' });
    a.client.send({ op: OP.OOC_MESSAGE, text: 'second plan' });
    await waitForCount(a.seen, OP.OOC_MESSAGE, 2);

    const late = await joinClient({ ...room, name: 'LateJoiner' });
    const history = await late.seen.waitForOp(OP.OOC_HISTORY);

    assert.equal(history.messages.length, 2);
    assert.deepEqual(history.messages.map(m => m.text), ['first plan', 'second plan']);

    await shutdown(room.relay, room.host, a.client, late.client);
});

await test('the history is bounded, so it cannot grow without limit', async () => {
    const room = await bootRoom();
    const a = await joinClient({ ...room, name: 'PlayerA' });
    await a.seen.waitForOp(OP.PARITY_RESULT);

    // Lift this peer's rate limit for the duration of the test. The limiter has
    // its own coverage below; what is under test here is the history cap, and
    // the two would otherwise mask each other.
    const peer = [...room.relay.peers.values()].find(candidate => candidate.name === 'PlayerA');
    peer.messageBucket = { take: () => true };
    peer.byteBucket = { take: () => true };

    const total = OOC.HISTORY + 25;
    for (let i = 0; i < total; i++) {
        a.client.send({ op: OP.OOC_MESSAGE, text: `line ${i}` });
    }
    await a.client.drain(20000);
    await new Promise(resolve => setTimeout(resolve, 500));

    assert.ok(room.relay.oocHistory.length <= OOC.HISTORY,
        `history grew to ${room.relay.oocHistory.length}, cap is ${OOC.HISTORY}`);
    assert.equal(room.relay.oocHistory.length, OOC.HISTORY, 'the cap should be reached exactly');
    // The newest messages are the ones kept, not the oldest.
    assert.equal(room.relay.oocHistory.at(-1).text, `line ${total - 1}`);
    assert.equal(room.relay.oocHistory[0].text, `line ${total - OOC.HISTORY}`);

    await shutdown(room.relay, room.host, a.client);
});

await test('flooding the OOC channel trips the rate limit and drops the peer', async () => {
    const room = await bootRoom();
    const a = await joinClient({ ...room, name: 'Flooder' });
    await a.seen.waitForOp(OP.PARITY_RESULT);

    const closed = new Promise(resolve => a.client.addEventListener('close', () => resolve(true)));

    // Well past LIMITS.RATE_MESSAGES within one window.
    for (let i = 0; i < LIMITS.RATE_MESSAGES * 3; i++) {
        a.client.send({ op: OP.OOC_MESSAGE, text: `spam ${i}` });
    }

    const wasClosed = await Promise.race([
        closed,
        new Promise(resolve => setTimeout(() => resolve(false), 6000)),
    ]);
    assert.equal(wasClosed, true, 'a flooding peer should be disconnected');

    // And it did not get to fill the room's history first.
    assert.ok(room.relay.oocHistory.length <= LIMITS.RATE_MESSAGES,
        `history absorbed ${room.relay.oocHistory.length} messages before the limiter engaged`);

    await shutdown(room.relay, room.host, a.client);
});

await test('OOC traffic never appears as chat traffic', async () => {
    const room = await bootRoom();
    const a = await joinClient({ ...room, name: 'PlayerA' });
    const b = await joinClient({ ...room, name: 'PlayerB' });
    await a.seen.waitForOp(OP.PARITY_RESULT);
    await b.seen.waitForOp(OP.PARITY_RESULT);

    a.client.send({ op: OP.OOC_MESSAGE, text: 'planning, not roleplay' });
    await waitForCount(b.seen, OP.OOC_MESSAGE, 1);
    await new Promise(resolve => setTimeout(resolve, 200));

    // The host is what appends to the transcript, so the decisive check is that
    // it was never handed a chat payload carrying this text.
    for (const seen of [room.hostSeen, a.seen, b.seen]) {
        const chatOps = seen.filter(p => [OP.CHAT_TURN, OP.CHAT_APPEND, OP.CHAT_STATE].includes(p?.op));
        const leaked = JSON.stringify(chatOps).includes('planning, not roleplay');
        assert.equal(leaked, false, 'OOC text appeared in a chat payload');
    }

    await shutdown(room.relay, room.host, a.client, b.client);
});

await test('typing notices are relayed to others but not echoed back', async () => {
    const room = await bootRoom();
    const a = await joinClient({ ...room, name: 'PlayerA' });
    const b = await joinClient({ ...room, name: 'PlayerB' });
    await a.seen.waitForOp(OP.PARITY_RESULT);
    await b.seen.waitForOp(OP.PARITY_RESULT);

    a.client.send({ op: OP.OOC_TYPING });
    const typing = await b.seen.waitForOp(OP.OOC_TYPING);
    assert.equal(typing.name, 'PlayerA');

    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(a.seen.some(p => p?.op === OP.OOC_TYPING), false,
        'a typing notice should not be echoed to its author');

    await shutdown(room.relay, room.host, a.client, b.client);
});

await test('OOC is refused before a peer is admitted', async () => {
    const room = await bootRoom();
    // Mismatched extensions: connected, but held in the lobby.
    const held = await joinClient({ ...room, extensions: [], name: 'Held' });
    const result = await held.seen.waitForOp(OP.PARITY_RESULT);
    assert.equal(result.ok, false);

    held.client.send({ op: OP.OOC_MESSAGE, text: 'let me in' });
    await new Promise(resolve => setTimeout(resolve, 250));

    assert.equal(room.hostSeen.some(p => p?.op === OP.OOC_MESSAGE), false,
        'an unadmitted peer must not be able to talk to the room');
    assert.equal(room.relay.oocHistory.length, 0);

    await shutdown(room.relay, room.host, held.client);
});

console.log('\nConnection code against a live relay');

await test('a code built from relay output decodes back to it', async () => {
    const relay = new Relay({ log: silent });
    const info = await relay.start({ port: PORT(), bindLan: false, roomName: 'codes' });

    const code = encodeConnectionCode({
        host: info.advertiseHost,
        port: info.port,
        psk: fromBase64(info.psk),
    });
    const decoded = decodeConnectionCode(code);

    assert.equal(decoded.host, info.advertiseHost);
    assert.equal(decoded.port, info.port);
    assert.deepEqual([...decoded.psk], [...fromBase64(info.psk)]);
    assert.ok(code.startsWith('STMP1-'));

    await shutdown(relay);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
