import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeStorage, json } from './helpers/storage.mjs';
import { MultiplayerSession } from '../lib/session.js';
import { SecureSocket, STATE } from '../lib/transport.js';
import { ChatBridge } from '../lib/chat.js';
import { Relay } from '../server/lib/relay.js';
import { OP, PROTOCOL_REVISION, encodeConnectionCode } from '../lib/protocol.js';
import { contentHash, objectHash } from '../lib/identity.js';
import { readMarker } from '../lib/cards.js';

const psk = new Uint8Array(16).fill(7);
const code = encodeConnectionCode({ host: '127.0.0.1', port: 24910, psk });
const tick = () => new Promise(r => setTimeout(r, 0));
async function until(fn, label = 'condition', ms = 6000) {
    const end = Date.now() + ms;
    while (!fn()) { if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`); await new Promise(r => setTimeout(r, 10)); }
}
class FakeSocket extends EventTarget {
    constructor(options) { super(); Object.assign(this, options); this.sent = []; this.opened = false; }
    emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
    async connect() { this.opened = true; this.emit('open', {}); }
    async send(payload) { if (!this.opened) return false; this.sent.push(payload); return true; }
    close() { this.opened = false; }
    disconnect() { this.opened = false; this.emit('close', { wasOpen: true, willReconnect: true, reason: 'test disconnect' }); }
    message(payload) { this.emit('message', { payload }); }
}
let nativeFetch, nativeLocation, sessions;
beforeEach(() => {
    nativeFetch = globalThis.fetch; nativeLocation = globalThis.location;
    globalThis.location = { protocol: 'http:', hostname: 'localhost' };
    sessions = [];
});
afterEach(async () => {
    for (const session of sessions) await session.leave();
    globalThis.fetch = nativeFetch;
    if (nativeLocation === undefined) delete globalThis.location; else globalThis.location = nativeLocation;
});
async function makeSession({ role = 'client', options = {} } = {}) {
    const env = makeStorage({ settings: { autoReconnect: true, ...options } });
    const sockets = [];
    env.deps.createSocket = opts => { const socket = new FakeSocket(opts); sockets.push(socket); return socket; };
    const session = new MultiplayerSession(env.deps); sessions.push(session);
    globalThis.fetch = env.fetch;
    await session.join(code);
    session.role = role;
    return { env, session, sockets, get socket() { return session.socket; } };
}
async function drain(session) { await session._routes; await session._personaJob?.promise; await tick(); await session._routes; }
async function admit(h, id = 'me') {
    h.socket.message({ op: OP.WELCOME, peerId: id, role: h.session.role, roomId: 'room-one', peers: [] });
    h.socket.message({ op: OP.PARITY_RESULT, ok: true });
    await drain(h.session);
}
const entry = overrides => ({ cardId: 'card-a', ownerId: 'owner-a', sourceId: 'source-a', name: 'Ada',
    avatar: 'original.png', defHash: 'definition-1', ...overrides });

await test('welcome metadata and 100 duplicate welcomes produce exactly one name announcement', async () => {
    const h = await makeSession();
    await admit(h);
    for (let i = 0; i < 100; i++) {
        h.socket.message({ op: OP.WELCOME, hostName: `Host-${i}` });
        h.socket.message({ op: OP.WELCOME_UPDATE, hostName: `Host-${i}` });
        h.socket.message({ op: OP.WELCOME, peerId: 'wrong-new-id' });
    }
    await drain(h.session);
    assert.equal(h.session.peerId, 'me');
    assert.equal(h.socket.sent.filter(p => p.op === OP.ROSTER).length, 1);
});

await test('duplicate parity acceptance attaches one chat listener set and publishes once', async () => {
    const h = await makeSession(); await admit(h);
    const before = h.env.context.eventSource.listenerCount('MESSAGE_SENT');
    for (let i = 0; i < 100; i++) h.socket.message({ op: OP.PARITY_RESULT, ok: true });
    await drain(h.session);
    assert.equal(h.env.context.eventSource.listenerCount('MESSAGE_SENT'), before);
    assert.equal(h.socket.sent.filter(p => p.op === OP.PERSONA_STATE).length, 1);
});

await test('100 queued card catalogues through the actual session route create only one stub', async () => {
    const h = await makeSession(); await admit(h);
    for (let i = 0; i < 100; i++) h.socket.message({ op: OP.CARDS_INDEX, cards: [entry()] });
    await drain(h.session);
    assert.equal(h.env.disk.size, 1);
    assert.equal(h.env.count('/api/characters/import'), 1);
    assert.equal(h.socket.sent.filter(p => p.op === OP.CARDS_WANT && p.want === 'definition').length, 1);
    assert.equal(h.socket.sent.filter(p => p.op === OP.CARDS_WANT && p.want === 'avatar').length, 1);
});

await test('latest definition hydrates in memory, removed fields disappear, and disconnect restores the stub', async () => {
    const h = await makeSession(); await admit(h);
    const old = { description: 'old private text', scenario: 'removed' };
    const oldEntry = entry({ defHash: await objectHash(old) });
    h.socket.message({ op: OP.CARDS_INDEX, cards: [oldEntry] });
    h.socket.message({ op: OP.CARDS_DEFINITION, cardId: oldEntry.cardId, defHash: oldEntry.defHash, definition: old });
    await drain(h.session);
    assert.equal(h.env.context.characters[0].data.description, old.description);
    const updated = { description: 'updated private text' };
    const newEntry = entry({ defHash: await objectHash(updated) });
    h.socket.message({ op: OP.CARDS_INDEX, cards: [newEntry] });
    h.socket.message({ op: OP.CARDS_DEFINITION, cardId: newEntry.cardId, defHash: oldEntry.defHash, definition: old });
    h.socket.message({ op: OP.CARDS_DEFINITION, cardId: newEntry.cardId, defHash: newEntry.defHash, definition: updated });
    await drain(h.session);
    assert.equal(h.env.context.characters[0].data.description, updated.description);
    assert.equal(h.env.context.characters[0].data.scenario, '');
    assert.equal(h.env.disk.size, 1);
    assert.equal([...h.env.disk.values()][0].data.description, '');
    h.socket.disconnect();
    assert.equal(h.env.context.characters[0].data.description, '');
    assert.equal(h.session.hydration.size, 0);
    assert.equal(h.session.definitions.size, 0);
});

await test('definition for an unshared or revoked card cannot hydrate another local character', async () => {
    const h = await makeSession(); await admit(h);
    const definition = { description: 'private text' };
    const e = entry({ defHash: await objectHash(definition) });
    h.socket.message({ op: OP.CARDS_INDEX, cards: [e] });
    h.socket.message({ op: OP.CARDS_DEFINITION, cardId: e.cardId, defHash: e.defHash, definition });
    h.socket.message({ op: OP.CARDS_INDEX, cards: [] });
    h.socket.message({ op: OP.CARDS_DEFINITION, cardId: e.cardId, defHash: e.defHash, definition });
    await drain(h.session);
    assert.equal(h.session.hydration.size, 0);
    assert.equal(h.env.context.characters[0].data.description, '');
    assert.equal(h.env.disk.size, 1, 'revocation does not delete chats or stubs');
});

await test('failed import has no recursive refresh loop and explicit resync retries it', async () => {
    const h = await makeSession(); await admit(h);
    h.env.failNext('/api/characters/import');
    h.socket.message({ op: OP.CARDS_INDEX, cards: [entry()] });
    await drain(h.session);
    assert.equal(h.env.disk.size, 0);
    assert.equal(h.env.refreshes, 0);
    await h.session.resyncSharedData();
    assert.ok(h.socket.sent.some(p => p.op === OP.CARDS_WANT && p.want === 'republish'));
    h.socket.message({ op: OP.CARDS_INDEX, cards: [entry()] });
    await drain(h.session);
    assert.equal(h.env.disk.size, 1);
});

await test('definition waiting for a missing UI card attempts at most one refresh', async () => {
    const h = await makeSession(); await admit(h);
    h.session.cardIndex = [entry()];
    h.session.pendingDefinitions.set('card-a', { description: 'pending' });
    await h.session.applyPendingDefinitions();
    assert.equal(h.env.refreshes, 1);
    assert.equal(h.session.pendingDefinitions.size, 1);
});

await test('disconnect during a delayed import prevents stale hydration but retains the successful receipt', async () => {
    const h = await makeSession(); await admit(h);
    const baseFetch = h.env.fetch;
    let release, imported;
    const blocked = new Promise(resolve => { imported = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    globalThis.fetch = async (url, opts) => {
        const response = await baseFetch(url, opts);
        if (url === '/api/characters/import') { imported(); await gate; }
        return response;
    };
    h.socket.message({ op: OP.CARDS_INDEX, cards: [entry()] });
    const routes = h.session._routes;
    await blocked;
    h.socket.disconnect();
    release();
    await routes;
    assert.equal(h.env.disk.size, 1);
    assert.equal(h.session.hydration.size, 0);
    assert.equal(h.session.stubs.size, 0);
    assert.equal(Object.keys(h.env.settings.sharing.remoteCards).length, 1);
});

await test('heartbeat reply is not blocked behind an import waiting on disk', async () => {
    const h = await makeSession(); await admit(h);
    const baseFetch = h.env.fetch;
    let release, blocked;
    const entered = new Promise(r => { blocked = r; });
    const gate = new Promise(r => { release = r; });
    globalThis.fetch = async (url, opts) => {
        if (url === '/api/characters/import') { blocked(); await gate; }
        return baseFetch(url, opts);
    };
    h.socket.message({ op: OP.CARDS_INDEX, cards: [entry()] });
    await entered;
    h.socket.message({ op: OP.PING, t: 42 });
    assert.ok(h.socket.sent.some(p => p.op === OP.PONG && p.t === 42));
    release(); await drain(h.session);
});

await test('old sockets cannot close a newly joined room or insert old personas', async () => {
    const h = await makeSession(); await admit(h);
    const old = h.socket;
    await h.session.leave();
    await h.session.join(code); await admit(h, 'new-me');
    old.message({ op: OP.PERSONA_STATE, from: 'ghost', persona: { name: 'Ghost' } });
    old.disconnect();
    await drain(h.session);
    assert.equal(h.session.connected, true);
    assert.equal(h.session.peerId, 'new-me');
    assert.equal(h.session.chat.personas.has('ghost'), false);
});

await test('100 transient peer IDs for the same stable persona occupy a single remote roster entry', async () => {
    const h = await makeSession(); await admit(h);
    for (let i = 0; i < 100; i++) h.socket.message({ op: OP.PERSONA_STATE, from: `p-${i}`,
        persona: { name: 'Guest', ownerId: 'guest-owner', personaId: 'guest-persona', full: true, description: `revision ${i}` } });
    await drain(h.session);
    const remote = [...h.session.chat.personas.values()].filter(p => p.ownerId === 'guest-owner');
    assert.equal(remote.length, 1);
    assert.equal(remote[0].description, 'revision 99');
    h.socket.message({ op: OP.PEER_LEAVE, peer: { id: 'p-99' } });
    await drain(h.session);
    assert.equal([...h.session.chat.personas.values()].some(p => p.ownerId === 'guest-owner'), false);
});

await test('roster replacement, persona switches, and disconnect remove ghost personas', async () => {
    const h = await makeSession(); await admit(h);
    h.socket.message({ op: OP.PERSONA_STATE, from: 'guest', persona: { name: 'A', ownerId: 'owner', personaId: 'a', full: true, lorebook: { entries: ['old'] } } });
    h.socket.message({ op: OP.PERSONA_STATE, from: 'guest', persona: { name: 'B', ownerId: 'owner', personaId: 'b', full: true, lorebook: null } });
    await drain(h.session);
    assert.equal(h.session.chat.personas.get('guest').name, 'B');
    assert.equal(h.session.chat.personas.get('guest').lorebook, null);
    h.socket.message({ op: OP.ROSTER, peers: [{ id: 'me', name: 'Player' }] });
    await drain(h.session);
    assert.equal(h.session.chat.personas.has('guest'), false);
    h.socket.disconnect();
    assert.equal(h.session.chat.personas.size, 0);
    assert.equal(h.session.peers.length, 0);
});

await test('full persona revisions detect equal-length portrait changes and cleared lore, without duplicate sends', async () => {
    const h = await makeSession(); await admit(h);
    let persona = { name: 'Me', ownerId: 'owner', personaId: 'persona', avatarData: 'data:image/png;base64,YQ==', lorebook: { entries: ['a'] } };
    h.session.chat.describeLocalPersona = async () => structuredClone(persona);
    await h.session.publishPersona();
    const count = () => h.socket.sent.filter(p => p.op === OP.PERSONA_STATE).length;
    const before = count();
    await Promise.all(Array.from({ length: 100 }, () => h.session.publishPersona()));
    assert.equal(count(), before);
    persona = { ...persona, avatarData: 'data:image/png;base64,Yg==', lorebook: null };
    await h.session.publishPersona();
    assert.equal(count(), before + 1);
    assert.equal(h.socket.sent.filter(p => p.op === OP.PERSONA_STATE).at(-1).persona.lorebook, null);
});

await test('autoReconnect=false is passed to the transport and terminal close exits connecting state', async () => {
    const h = await makeSession({ options: { autoReconnect: false } });
    assert.equal(h.socket.autoReconnect, false);
    h.socket.emit('close', { wasOpen: false, willReconnect: false, reason: 'bad revision' });
    assert.equal(h.session.status, 'error');
    assert.match(h.session.lastError, /bad revision/);
});

await test('host startup with failed router mapping no longer references an undefined kind', async () => {
    const h = await makeSession(); await h.session.leave();
    const logs = []; h.session.addEventListener('log', e => logs.push(e.detail.message));
    globalThis.fetch = async url => String(url).endsWith('/probe') ? json({ revision: PROTOCOL_REVISION }) :
        json({ psk: btoa(String.fromCharCode(...psk)), roomId: 'room', hostToken: 'token', port: 24910,
            advertiseHost: '192.168.1.123', portMapping: { ok: false, reason: 'router did not respond' } });
    await h.session.startHosting({ bindLan: true });
    assert.ok(logs.some(line => line.includes('router did not respond')));
    assert.equal(h.session.role, 'host');
});

await test('native stale WebSocket events are ignored after transport replacement', async () => {
    const Native = globalThis.WebSocket;
    class NativeFake extends EventTarget {
        static OPEN = 1;
        constructor() { super(); this.readyState = 0; }
        close() { this.readyState = 3; }
        send() {}
    }
    globalThis.WebSocket = NativeFake;
    const socket = new SecureSocket({ url: 'ws://test', psk, autoReconnect: false });
    try {
        await socket.connect(); const old = socket.socket;
        socket.close(); await socket.connect(); const current = socket.socket;
        old.dispatchEvent(new Event('open'));
        old.dispatchEvent(new MessageEvent('message', { data: '{bad json' }));
        old.dispatchEvent(new Event('close'));
        await tick();
        assert.equal(socket.socket, current);
        assert.equal(socket.state, STATE.CONNECTING);
    } finally { socket.close(); globalThis.WebSocket = Native; }
});

await test('native WebSocket constructor errors emit a terminal close, not a permanent connecting state', async () => {
    const Native = globalThis.WebSocket;
    globalThis.WebSocket = class { constructor() { throw new Error('blocked'); } };
    const socket = new SecureSocket({ url: 'ws://test', psk });
    const closes = []; socket.addEventListener('close', e => closes.push(e.detail));
    try {
        await socket.connect();
        assert.equal(socket.state, STATE.CLOSED);
        assert.equal(closes.length, 1);
        assert.equal(closes[0].willReconnect, false);
    } finally { socket.close(); globalThis.WebSocket = Native; }
});

await test('real relay + both real sessions: 10 rejoins plus automatic recovery reuse one card/persona', { timeout: 25000 }, async () => {
    const relay = new Relay({ log() {} });
    const hostEnv = makeStorage({ settings: { sharedCards: ['original.png'], autoReconnect: false, bindLan: false, port: 24931 }, name: 'Host' });
    const guestEnv = makeStorage({ settings: { autoReconnect: false }, name: 'Guest' });
    hostEnv.add({ name: 'Ada', avatar: 'original.png', data: { description: 'first revision', extensions: {} } });
    hostEnv.images.set('original.png', new Uint8Array([137, 80, 78, 71, 1]));
    const hostSent = [], guestSent = [];
    for (const [env, id, sent] of [[hostEnv, 'host', hostSent], [guestEnv, 'guest', guestSent]]) {
        env.deps.getRequestHeaders = ({ omitContentType } = {}) => ({ 'X-Test-Client': id,
            ...(omitContentType ? {} : { 'Content-Type': 'application/json' }) });
        env.deps.createSocket = options => {
            const socket = new SecureSocket(options), send = socket.send.bind(socket);
            socket.send = payload => { sent.push(payload); return send(payload); };
            return socket;
        };
    }
    globalThis.fetch = async (url, opts = {}) => {
        if (url.endsWith('/probe')) return json({ revision: PROTOCOL_REVISION });
        if (url.endsWith('/start')) return json(await relay.start({ ...JSON.parse(opts.body), port: 24931, bindLan: false, requireParity: false }));
        if (url.endsWith('/stop')) { await relay.stop(); return json({}); }
        return (String(url).startsWith('/characters/') || opts.headers?.['X-Test-Client'] === 'host' ? hostEnv : guestEnv).fetch(url, opts);
    };
    const host = new MultiplayerSession(hostEnv.deps), guest = new MultiplayerSession(guestEnv.deps);
    sessions.push(host, guest);
    const logs = [];
    for (const s of [host, guest]) s.addEventListener('log', e => logs.push(e.detail.message));
    try {
        await host.startHosting({ bindLan: false, requireParity: false, port: 24931 });
        await until(() => host.connected && host.cardIndex.length === 1, 'host admission + catalogue');
        for (let i = 0; i < 10; i++) {
            await guest.join(host.code);
            await until(() => guest.connected && guest.hydration.size === 1 && guest._avatarRequests.size === 0,
                `guest join ${i}; ${logs.slice(-3).join(' | ')}`);
            assert.equal(host.connected, true);
            assert.ok(host.chat.personas.size <= 2);
            assert.ok(guest.chat.personas.size <= 2);
            if (i < 9) {
                await guest.leave();
                await until(() => host.peers.length === 1, 'guest departure');
            }
        }
        assert.equal(hostSent.filter(p => p.op === OP.ROSTER).length, 1, 'metadata must not echo welcomes');
        assert.equal(guestSent.filter(p => p.op === OP.ROSTER).length, 10);
        assert.equal(guestEnv.count('/api/characters/import'), 1);
        assert.equal(guestEnv.disk.size, 1);
        const filename = [...guestEnv.disk.keys()][0];
        // Close the native WS (not SecureSocket.close(), which is an intentional
        // departure) to exercise the real backoff and reconnect handshake too.
        const beforeRetry = guest.peerId;
        const transport = guest.socket;
        transport.autoReconnect = true;
        transport.socket.close(4001, 'simulated connection loss');
        await until(() => guest.connected && guest.peerId && guest.peerId !== beforeRetry
            && guest.hydration.size === 1 && guest._avatarRequests.size === 0, 'automatic recovery', 10000);
        assert.equal(guest.socket, transport, 'the existing transport manages its retry');
        assert.equal(guestSent.filter(p => p.op === OP.ROSTER).length, 11);
        assert.equal(guestEnv.count('/api/characters/import'), 1);
        assert.equal(guestEnv.disk.size, 1);
        assert.ok(host.chat.personas.size <= 2);
        assert.ok(guest.chat.personas.size <= 2);
        const oldWrites = guestEnv.count('/api/characters/edit');
        hostEnv.disk.get('original.png').data.description = 'second revision';
        await host.publishCards();
        await until(() => guestEnv.context.characters[0]?.data.description === 'second revision', 'updated definition');
        assert.equal([...guestEnv.disk.keys()][0], filename);
        assert.equal(guestEnv.disk.size, 1);
        assert.equal(guestEnv.count('/api/characters/edit'), oldWrites + 1);
        assert.equal(guestEnv.disk.get(filename).data.description, '', 'full definition is never saved by sync');
        await guest.leave();
        assert.equal(guestEnv.context.characters[0].data.description, '');
        assert.equal(host.connected, true);
    } finally {
        await guest.leave(); await host.leave(); await relay.stop();
    }
});
