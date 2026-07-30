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
    // 100.64.0.0/10 is deliberately absent: it is carrier-grade NAT space and
    // also Tailscale's range, which does reach across the internet. See the
    // tailnet test below.
    for (const host of [
        '192.168.1.50', '192.168.0.1', '10.0.0.7', '10.255.255.254',
        '172.16.0.1', '172.31.255.255', '127.0.0.1', 'localhost',
        '169.254.10.1', 'tavern.local', '::1',
    ]) {
        assert.equal(browserProto.isPrivateAddress(host), true, `${host} should be private`);
    }
});

await test('recognises routable addresses', () => {
    for (const host of [
        '8.8.8.8', '1.1.1.1', '203.0.113.5', '172.32.0.1', '172.15.0.1',
        '192.169.0.1', '11.0.0.1', 'tavern.example.net', 'my-host.duckdns.org',
        '100.101.102.103', // Tailscale: routable between tailnet members
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

console.log('\nTLS endpoints and default ports');

await test('a wss code round-trips with no port (scheme default)', () => {
    // This is the Cloudflare Tunnel / reverse-proxy shape: hostname on 443.
    const psk = browser.randomBytes(browserProto.PSK_LENGTH);
    const code = browserProto.encodeConnectionCode({ host: 'shy-fog-1234.trycloudflare.com', port: 0, psk, secure: true });
    const d = browserProto.decodeConnectionCode(code);
    assert.equal(d.host, 'shy-fog-1234.trycloudflare.com');
    assert.equal(d.port, 0);
    assert.equal(d.secure, true);
    assert.equal(browserProto.connectionUrl(d), 'wss://shy-fog-1234.trycloudflare.com/');
});

await test('a wss code with an explicit port keeps it', () => {
    const psk = browser.randomBytes(browserProto.PSK_LENGTH);
    const d = browserProto.decodeConnectionCode(
        browserProto.encodeConnectionCode({ host: 'tavern.example.net', port: 8443, psk, secure: true }));
    assert.equal(browserProto.connectionUrl(d), 'wss://tavern.example.net:8443/');
});

await test('plain codes still decode as plain, and IPv4 TLS works too', () => {
    const psk = browser.randomBytes(browserProto.PSK_LENGTH);
    const plain = browserProto.decodeConnectionCode(
        browserProto.encodeConnectionCode({ host: '100.101.102.103', port: 8899, psk }));
    assert.equal(plain.secure, false);
    assert.equal(browserProto.connectionUrl(plain), 'ws://100.101.102.103:8899/');

    const tls = browserProto.decodeConnectionCode(
        browserProto.encodeConnectionCode({ host: '203.0.113.9', port: 443, psk, secure: true }));
    assert.equal(tls.secure, true);
    assert.equal(browserProto.connectionUrl(tls), 'wss://203.0.113.9:443/');
});

await test('the psk survives every address kind intact', () => {
    const psk = browser.randomBytes(browserProto.PSK_LENGTH);
    for (const params of [
        { host: '10.0.0.1', port: 8899, psk },
        { host: '10.0.0.1', port: 0, psk, secure: true },
        { host: 'a.example.com', port: 1234, psk },
        { host: 'a.example.com', port: 0, psk, secure: true },
    ]) {
        const d = browserProto.decodeConnectionCode(browserProto.encodeConnectionCode(params));
        assert.deepEqual([...d.psk], [...psk], JSON.stringify({ ...params, psk: undefined }));
    }
});

await test('a rejected port is caught rather than silently wrapped', () => {
    const psk = browser.randomBytes(browserProto.PSK_LENGTH);
    assert.throws(() => browserProto.encodeConnectionCode({ host: '10.0.0.1', port: 70000, psk }), /out of range/);
});

console.log('\nAdvertisement resolution');

const resolve = input => browserProto.resolveAdvertisement(input);

await test('blank address plus a router mapping is the zero-setup path', () => {
    // This is what "leave everything blank and press Start hosting" produces.
    const r = resolve({ publicHost: '203.0.113.9', detectedHost: '192.168.1.42', listenPort: 8899 });
    assert.equal(r.error, null);
    assert.equal(r.host, '203.0.113.9');
    assert.equal(r.port, 8899);
    assert.equal(r.secure, false);
    assert.equal(r.source, 'router');
    assert.equal(browserProto.connectionUrl(r), 'ws://203.0.113.9:8899/');
    assert.deepEqual(r.warnings, [], 'a working public address should not warn');
});

await test('blank address with no mapping falls back and warns', () => {
    const r = resolve({ detectedHost: '192.168.1.42', listenPort: 8899 });
    assert.equal(r.error, null);
    assert.equal(r.source, 'detected');
    assert.equal(r.host, '192.168.1.42');
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /local-network/);
});

await test('ticking HTTPS with no address is refused, not silently broken', () => {
    // Previously this produced wss://<router-ip>/ on port 443 against a relay
    // serving plain ws on 8899 — a code that could never connect.
    const r = resolve({ advertiseSecure: true, publicHost: '203.0.113.9', listenPort: 8899 });
    assert.ok(r.error, 'the impossible combination was accepted');
    assert.match(r.error, /needs one|hostname/i);
});

await test('HTTPS with a tunnel hostname omits the port', () => {
    const r = resolve({ advertiseHost: 'shy-fog.trycloudflare.com', advertiseSecure: true, listenPort: 8899 });
    assert.equal(r.error, null);
    assert.equal(r.port, 0);
    assert.equal(browserProto.connectionUrl(r), 'wss://shy-fog.trycloudflare.com/');
});

await test('an explicit public port overrides the derived one', () => {
    const r = resolve({ advertiseHost: 'tavern.example.net', advertiseSecure: true, advertisePort: 8443, listenPort: 8899 });
    assert.equal(browserProto.connectionUrl(r), 'wss://tavern.example.net:8443/');

    const plain = resolve({ advertiseHost: '203.0.113.9', advertisePort: 9000, listenPort: 8899 });
    assert.equal(browserProto.connectionUrl(plain), 'ws://203.0.113.9:9000/');
});

await test('a typed address with LAN sharing off is refused', () => {
    const r = resolve({ advertiseHost: '203.0.113.9', bindLan: false, listenPort: 8899 });
    assert.ok(r.error);
    assert.match(r.error, /only listens on 127\.0\.0\.1/);
});

await test('a loopback address with LAN sharing off is allowed (ssh -L case)', () => {
    const r = resolve({ advertiseHost: '127.0.0.1', bindLan: false, listenPort: 8899 });
    assert.equal(r.error, null);
    assert.match(r.warnings[0], /loopback/);
});

await test('a typed address always beats the router and the detected one', () => {
    const r = resolve({
        advertiseHost: 'my.duckdns.org',
        publicHost: '203.0.113.9',
        detectedHost: '192.168.1.42',
        listenPort: 8899,
    });
    assert.equal(r.host, 'my.duckdns.org');
    assert.equal(r.source, 'typed');
});

await test('a typed Tailscale address is reported accurately, not warned about', () => {
    const r = resolve({ advertiseHost: '100.101.102.103', listenPort: 8899 });
    assert.equal(r.error, null);
    assert.match(r.warnings[0], /Tailscale/);
    assert.ok(!r.warnings[0].includes('cannot reach'));
});

await test('handles being called with nothing at all', () => {
    const r = resolve({});
    assert.equal(r.error, null);
    assert.equal(typeof r.host, 'string');
    assert.ok(Number.isFinite(r.port));
});

console.log('\nAddress classification for advice');

await test('Tailscale space is a tailnet, not a LAN', () => {
    // Warning "same local network only" here would be wrong: a tailnet spans
    // the internet, and it is the recommended way to play across houses.
    for (const host of ['100.64.0.1', '100.101.102.103', '100.127.255.255']) {
        assert.equal(browserProto.classifyAddress(host), 'tailnet');
        assert.equal(browserProto.isPrivateAddress(host), false, `${host} must not be flagged same-network-only`);
    }
});

await test('classifies the other kinds correctly', () => {
    const cases = {
        '127.0.0.1': 'loopback', 'localhost': 'loopback', '::1': 'loopback',
        '192.168.1.5': 'lan', '10.0.0.7': 'lan', '172.20.1.1': 'lan', '169.254.1.1': 'lan',
        'tavern.local': 'lan',
        '8.8.8.8': 'public', '203.0.113.5': 'public', '172.32.0.1': 'public',
        'x.trycloudflare.com': 'hostname',
        '': 'unknown', '999.1.1.1': 'unknown',
    };
    for (const [host, expected] of Object.entries(cases)) {
        assert.equal(browserProto.classifyAddress(host), expected, `${host} should be ${expected}`);
    }
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
