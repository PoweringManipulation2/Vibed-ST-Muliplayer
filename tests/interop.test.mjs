/**
 * Interop test.
 *
 * The browser and the relay implement the same key schedule and frame format
 * twice, in two different crypto APIs. This file proves the two halves actually
 * agree: same ECDH secret, same HKDF output, same confirmation MACs, and frames
 * sealed by either side open correctly on the other.
 *
 * Run with:  node tests/interop.test.mjs
 * Requires Node 18+ (for globalThis.crypto.subtle and CompressionStream).
 */

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const browser = await import(path.join(root, 'lib/crypto.js'));
const node = await import(path.join(root, 'server/lib/crypto.js'));
const browserProto = await import(path.join(root, 'lib/protocol.js'));
const nodeProto = await import(path.join(root, 'server/lib/protocol.js'));

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

console.log('\nProtocol constants');

await test('the two protocol mirrors agree on the revision', () => {
    assert.equal(browserProto.PROTOCOL_REVISION, nodeProto.PROTOCOL_REVISION);
});

await test('frame layout and KDF labels match', () => {
    for (const key of ['FRAME_VERSION', 'HEADER_SIZE', 'FLAG_COMPRESSED', 'FLAG_BINARY',
        'LABEL_TRANSCRIPT', 'LABEL_KEYS', 'LABEL_ROOM_ID', 'CONFIRM_CLIENT', 'CONFIRM_SERVER',
        'KDF_LENGTH', 'NONCE_LENGTH', 'PSK_LENGTH', 'ROOM_ID_LENGTH', 'HANDSHAKE_NONCE_LENGTH']) {
        assert.equal(browserProto[key], nodeProto[key], `${key} differs`);
    }
    assert.deepEqual(browserProto.KDF_SLICES, nodeProto.KDF_SLICES);
});

await test('opcode tables and limits match', () => {
    assert.deepEqual(browserProto.OP, nodeProto.OP);
    assert.deepEqual(browserProto.HS, nodeProto.HS);
    assert.deepEqual(browserProto.REJECT_REASON, nodeProto.REJECT_REASON);
    assert.deepEqual(browserProto.ROLE, nodeProto.ROLE);
    assert.deepEqual({ ...browserProto.LIMITS }, { ...nodeProto.LIMITS });
});

console.log('\nAddress classification');

await test('recognises local-network addresses', () => {
    // These are the codes that produce "stuck on connecting" for a remote friend.
    for (const host of [
        '192.168.1.50', '192.168.0.1', '10.0.0.7', '10.255.255.254',
        '172.16.0.1', '172.31.255.255', '127.0.0.1', 'localhost',
        '169.254.10.1', '100.64.0.1', 'tavern.local', '::1',
    ]) {
        assert.equal(browserProto.isPrivateAddress(host), true, `${host} should be private`);
    }
});

await test('recognises routable addresses', () => {
    for (const host of [
        '8.8.8.8', '1.1.1.1', '203.0.113.5', '172.32.0.1', '172.15.0.1',
        '192.169.0.1', '11.0.0.1', 'tavern.example.net', 'my-host.duckdns.org',
    ]) {
        assert.equal(browserProto.isPrivateAddress(host), false, `${host} should be routable`);
    }
});

await test('does not misjudge the 172.16/12 boundaries', () => {
    assert.equal(browserProto.isPrivateAddress('172.15.255.255'), false);
    assert.equal(browserProto.isPrivateAddress('172.16.0.0'), true);
    assert.equal(browserProto.isPrivateAddress('172.31.255.255'), true);
    assert.equal(browserProto.isPrivateAddress('172.32.0.0'), false);
});

await test('handles empty and junk input', () => {
    for (const host of ['', null, undefined, '   ', 'not an address', '999.999.999.999']) {
        assert.equal(typeof browserProto.isPrivateAddress(host), 'boolean');
    }
    assert.equal(browserProto.isPrivateAddress(''), false);
});

await test('a code carrying a public address survives the round trip', () => {
    const psk = browser.randomBytes(browserProto.PSK_LENGTH);
    const code = browserProto.encodeConnectionCode({ host: 'tavern.example.net', port: 8899, psk });
    const decoded = browserProto.decodeConnectionCode(code);
    assert.equal(decoded.host, 'tavern.example.net');
    assert.equal(browserProto.isPrivateAddress(decoded.host), false);
});

console.log('\nExtension folder derivation');

await test('recovers a renamed folder from the module URL', () => {
    // Regression: this used to be hardcoded, so any fork or rename made
    // settings.html 404 and the panel silently never rendered.
    assert.equal(
        browserProto.parseExtensionFolder('http://127.0.0.1:8000/scripts/extensions/third-party/Vibed-ST-Muliplayer/index.js'),
        'third-party/Vibed-ST-Muliplayer');
});

await test('handles both install layouts and an https origin', () => {
    for (const url of [
        'http://localhost:8000/scripts/extensions/third-party/SillyTavern-Multiplayer/index.js',
        'https://tavern.example.net/scripts/extensions/third-party/SillyTavern-Multiplayer/index.js',
        'https://tavern.example.net:8443/scripts/extensions/third-party/SillyTavern-Multiplayer/index.js',
    ]) {
        assert.equal(browserProto.parseExtensionFolder(url), 'third-party/SillyTavern-Multiplayer', url);
    }
});

await test('ignores a cache-busting query or hash', () => {
    assert.equal(
        browserProto.parseExtensionFolder('http://x/scripts/extensions/third-party/My-Fork/index.js?v=2#frag'),
        'third-party/My-Fork');
});

await test('decodes percent-escaped folder names', () => {
    assert.equal(
        browserProto.parseExtensionFolder('http://x/scripts/extensions/third-party/My%20Fork%20v2/index.js'),
        'third-party/My Fork v2');
});

await test('falls back rather than throwing on an unexpected URL', () => {
    assert.equal(browserProto.parseExtensionFolder(''), browserProto.EXTENSION_NAME);
    assert.equal(browserProto.parseExtensionFolder(undefined), browserProto.EXTENSION_NAME);
    assert.equal(browserProto.parseExtensionFolder('file:///somewhere/else/index.js'), browserProto.EXTENSION_NAME);
    assert.equal(browserProto.parseExtensionFolder('http://x/scripts/extensions/builtin/index.js', 'fb'), 'fb');
});

console.log('\nConnection codes');

await test('round-trips an IPv4 host', () => {
    const psk = browser.randomBytes(browserProto.PSK_LENGTH);
    const code = browserProto.encodeConnectionCode({ host: '192.168.1.42', port: 8899, psk });
    const decoded = browserProto.decodeConnectionCode(code);
    assert.equal(decoded.host, '192.168.1.42');
    assert.equal(decoded.port, 8899);
    assert.deepEqual([...decoded.psk], [...psk]);
});

await test('round-trips a hostname and a non-default port', () => {
    const psk = browser.randomBytes(browserProto.PSK_LENGTH);
    const code = browserProto.encodeConnectionCode({ host: 'tunnel.example.net', port: 51820, psk });
    const decoded = browserProto.decodeConnectionCode(code);
    assert.equal(decoded.host, 'tunnel.example.net');
    assert.equal(decoded.port, 51820);
});

await test('tolerates lowercase, missing dashes and O/I/L typos', () => {
    const psk = browser.randomBytes(browserProto.PSK_LENGTH);
    const code = browserProto.encodeConnectionCode({ host: '10.0.0.7', port: 9000, psk });
    const mangled = code.toLowerCase().replace(/-/g, ' ');
    const decoded = browserProto.decodeConnectionCode(mangled);
    assert.equal(decoded.host, '10.0.0.7');
    assert.deepEqual([...decoded.psk], [...psk]);
});

await test('rejects a single-character corruption via the checksum', () => {
    const psk = browser.randomBytes(browserProto.PSK_LENGTH);
    const code = browserProto.encodeConnectionCode({ host: '10.0.0.7', port: 9000, psk });
    // Flip one payload character to something else in the alphabet.
    const chars = [...code];
    const index = code.length - 4;
    chars[index] = chars[index] === 'Z' ? 'Y' : 'Z';
    assert.throws(() => browserProto.decodeConnectionCode(chars.join('')), /checksum|Invalid|truncated/i);
});

console.log('\nHandshake interop (WebCrypto client <-> Node relay)');

/** Runs one full handshake and returns both sides' derived material. */
async function handshake(psk = null) {
    const sharedPsk = psk ?? node.randomBytes(browserProto.PSK_LENGTH);

    // Client half, exactly as lib/transport.js does it.
    const clientPair = await browser.generateEphemeralKeyPair();
    const clientNonce = browser.randomBytes(browserProto.HANDSHAKE_NONCE_LENGTH);

    // Relay half, exactly as server/lib/relay.js does it.
    const serverPair = node.createEphemeralKeyPair();
    const serverNonce = node.randomBytes(nodeProto.HANDSHAKE_NONCE_LENGTH);

    const clientSide = await browser.deriveSessionKeys({
        privateKey: clientPair.privateKey,
        ownPublicRaw: clientPair.publicKeyRaw,
        peerPublicRaw: new Uint8Array(serverPair.publicKeyRaw),
        ownNonce: clientNonce,
        peerNonce: new Uint8Array(serverNonce),
        psk: new Uint8Array(sharedPsk),
        isClient: true,
    });

    const serverSide = node.deriveSessionKeys({
        ecdh: serverPair.ecdh,
        ownPublicRaw: serverPair.publicKeyRaw,
        peerPublicRaw: Buffer.from(clientPair.publicKeyRaw),
        ownNonce: serverNonce,
        peerNonce: Buffer.from(clientNonce),
        psk: Buffer.from(sharedPsk),
    });

    return { sharedPsk, clientSide, serverSide };
}

await test('both sides derive the same transcript hash', async () => {
    const { clientSide, serverSide } = await handshake();
    assert.deepEqual([...clientSide.transcriptHash], [...serverSide.transcriptHash]);
});

await test('room id derivation matches', async () => {
    const psk = node.randomBytes(browserProto.PSK_LENGTH);
    const fromBrowser = await browser.deriveRoomId(new Uint8Array(psk));
    const fromNode = node.deriveRoomId(Buffer.from(psk));
    assert.deepEqual([...fromBrowser], [...fromNode]);
    assert.equal(fromBrowser.length, browserProto.ROOM_ID_LENGTH);
});

await test('confirmation MACs verify in both directions', async () => {
    const { clientSide, serverSide } = await handshake();

    const clientMac = await browser.computeConfirmation(
        clientSide.keys.confirmKey, clientSide.transcriptHash, browserProto.CONFIRM_CLIENT);
    const serverExpectsClient = node.computeConfirmation(
        serverSide.keys.confirmKey, serverSide.transcriptHash, nodeProto.CONFIRM_CLIENT);
    assert.ok(node.timingSafeEqual(Buffer.from(clientMac), serverExpectsClient),
        'relay could not verify the client confirmation');

    const serverMac = node.computeConfirmation(
        serverSide.keys.confirmKey, serverSide.transcriptHash, nodeProto.CONFIRM_SERVER);
    const clientExpectsServer = await browser.computeConfirmation(
        clientSide.keys.confirmKey, clientSide.transcriptHash, browserProto.CONFIRM_SERVER);
    assert.ok(browser.timingSafeEqual(new Uint8Array(serverMac), clientExpectsServer),
        'client could not verify the relay confirmation');
});

await test('a wrong pre-shared key produces unusable keys', async () => {
    // Same ECDH exchange, different PSK on each side: this is what an
    // attacker who relays public keys but lacks the code ends up with.
    const clientPair = await browser.generateEphemeralKeyPair();
    const clientNonce = browser.randomBytes(16);
    const serverPair = node.createEphemeralKeyPair();
    const serverNonce = node.randomBytes(16);

    const clientSide = await browser.deriveSessionKeys({
        privateKey: clientPair.privateKey,
        ownPublicRaw: clientPair.publicKeyRaw,
        peerPublicRaw: new Uint8Array(serverPair.publicKeyRaw),
        ownNonce: clientNonce,
        peerNonce: new Uint8Array(serverNonce),
        psk: new Uint8Array(16).fill(1),
        isClient: true,
    });

    const serverSide = node.deriveSessionKeys({
        ecdh: serverPair.ecdh,
        ownPublicRaw: serverPair.publicKeyRaw,
        peerPublicRaw: Buffer.from(clientPair.publicKeyRaw),
        ownNonce: serverNonce,
        peerNonce: Buffer.from(clientNonce),
        psk: Buffer.alloc(16, 2),
    });

    const clientMac = await browser.computeConfirmation(
        clientSide.keys.confirmKey, clientSide.transcriptHash, browserProto.CONFIRM_CLIENT);
    const serverExpects = node.computeConfirmation(
        serverSide.keys.confirmKey, serverSide.transcriptHash, nodeProto.CONFIRM_CLIENT);

    assert.ok(!node.timingSafeEqual(Buffer.from(clientMac), serverExpects),
        'a PSK mismatch must not produce a verifying MAC');
});

await test('rejects an off-curve peer public key', async () => {
    const serverPair = node.createEphemeralKeyPair();
    const bogus = Buffer.alloc(65, 0);
    bogus[0] = 0x04; // right prefix, point not on the curve
    assert.throws(() => node.deriveSessionKeys({
        ecdh: serverPair.ecdh,
        ownPublicRaw: serverPair.publicKeyRaw,
        peerPublicRaw: bogus,
        ownNonce: node.randomBytes(16),
        peerNonce: node.randomBytes(16),
        psk: node.randomBytes(16),
    }));
});

console.log('\nFrame interop');

await test('client -> relay: small JSON payload', async () => {
    const { clientSide, serverSide } = await handshake();
    const payload = { op: 'chat.turn', id: 'abc', text: 'hello room' };
    const frame = await browser.sealFrame(clientSide.keys, 1n, payload);
    const opened = await node.openFrame(serverSide.keys, Buffer.from(frame));
    assert.equal(opened.counter, 1n);
    assert.deepEqual(opened.payload, payload);
});

await test('relay -> client: small JSON payload', async () => {
    const { clientSide, serverSide } = await handshake();
    const payload = { op: 'welcome', peerId: 'p1', peers: [] };
    const frame = await node.sealFrame(serverSide.keys, 1n, payload);
    const opened = await browser.openFrame(clientSide.keys, new Uint8Array(frame));
    assert.equal(opened.counter, 1n);
    assert.deepEqual(opened.payload, payload);
});

await test('compression path survives the round trip both ways', async () => {
    const { clientSide, serverSide } = await handshake();
    // Highly compressible and well over COMPRESS_THRESHOLD.
    const payload = { op: 'chat.state', messages: Array.from({ length: 400 }, (_, i) => ({ mes: 'the quick brown fox '.repeat(4), i })) };

    const up = await browser.sealFrame(clientSide.keys, 7n, payload);
    assert.ok((up[1] & browserProto.FLAG_COMPRESSED) !== 0, 'client did not compress a large payload');
    assert.deepEqual((await node.openFrame(serverSide.keys, Buffer.from(up))).payload, payload);

    const down = await node.sealFrame(serverSide.keys, 7n, payload);
    assert.ok((down[1] & nodeProto.FLAG_COMPRESSED) !== 0, 'relay did not compress a large payload');
    assert.deepEqual((await browser.openFrame(clientSide.keys, new Uint8Array(down))).payload, payload);
});

await test('binary payloads keep their bytes exactly', async () => {
    const { clientSide, serverSide } = await handshake();
    const bytes = node.randomBytes(50_000); // random data will not compress
    const frame = await node.sealFrame(serverSide.keys, 3n, Buffer.from(bytes));
    const opened = await browser.openFrame(clientSide.keys, new Uint8Array(frame));
    assert.ok(opened.payload instanceof Uint8Array);
    assert.deepEqual([...opened.payload], [...bytes]);
});

await test('high counters work (nonce is 64-bit big-endian)', async () => {
    const { clientSide, serverSide } = await handshake();
    const counter = 2n ** 40n + 12345n;
    const frame = await browser.sealFrame(clientSide.keys, counter, { op: 'ping' });
    const opened = await node.openFrame(serverSide.keys, Buffer.from(frame));
    assert.equal(opened.counter, counter);
});

console.log('\nTamper resistance');

await test('flipping a ciphertext bit fails authentication', async () => {
    const { clientSide, serverSide } = await handshake();
    const frame = Buffer.from(await browser.sealFrame(clientSide.keys, 1n, { op: 'ping' }));
    frame[frame.length - 20] ^= 0x01;
    await assert.rejects(() => node.openFrame(serverSide.keys, frame));
});

await test('rewriting the counter in the header fails (header is AAD)', async () => {
    const { clientSide, serverSide } = await handshake();
    const frame = Buffer.from(await browser.sealFrame(clientSide.keys, 1n, { op: 'ping' }));
    frame.writeBigUInt64BE(99n, 2);
    await assert.rejects(() => node.openFrame(serverSide.keys, frame));
});

await test('flipping the compression flag fails (flags are AAD)', async () => {
    const { clientSide, serverSide } = await handshake();
    const frame = Buffer.from(await browser.sealFrame(clientSide.keys, 1n, { op: 'ping' }));
    frame[1] ^= nodeProto.FLAG_COMPRESSED;
    await assert.rejects(() => node.openFrame(serverSide.keys, frame));
});

await test('a frame from one session cannot be opened by another', async () => {
    const a = await handshake();
    const b = await handshake();
    const frame = Buffer.from(await browser.sealFrame(a.clientSide.keys, 1n, { op: 'ping' }));
    await assert.rejects(() => node.openFrame(b.serverSide.keys, frame));
});

await test('unknown frame flags are refused', async () => {
    const { clientSide, serverSide } = await handshake();
    const frame = Buffer.from(await browser.sealFrame(clientSide.keys, 1n, { op: 'ping' }));
    frame[1] |= 0x80;
    await assert.rejects(() => node.openFrame(serverSide.keys, frame), /Unknown frame flags/);
});

await test('truncated frames are refused before any crypto work', async () => {
    const { serverSide } = await handshake();
    await assert.rejects(() => node.openFrame(serverSide.keys, Buffer.alloc(12)), /too short/i);
});

console.log('\nReplay windows');

for (const [label, Window] of [['browser', browser.ReplayWindow], ['relay', node.ReplayWindow]]) {
    await test(`${label}: accepts in order, refuses repeats and stale counters`, () => {
        const window = new Window();
        assert.ok(window.accept(1n));
        assert.ok(window.accept(2n));
        assert.ok(!window.accept(2n), 'accepted an exact replay');
        assert.ok(window.accept(3n));
        assert.ok(!window.accept(0n), 'accepted a zero counter');

        // Jump far ahead, then try something now outside the window.
        assert.ok(window.accept(1000n));
        assert.ok(!window.accept(3n), 'accepted a counter outside the window');
        assert.ok(window.accept(999n), 'refused legitimate reordering inside the window');
        assert.ok(!window.accept(999n), 'accepted a replay inside the window');
    });
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
