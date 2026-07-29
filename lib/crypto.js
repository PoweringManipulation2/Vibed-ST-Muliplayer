/**
 * Browser half of the Multiplayer session crypto.
 *
 * Design notes
 * ------------
 * The relay always runs on the host's own machine, so the interesting attacker
 * is on the network path (shared Wi-Fi, a router, a tunnel provider), not the
 * relay itself. Every frame is therefore encrypted end-to-end *above* the
 * WebSocket layer, which means the security properties hold identically over
 * `ws://` on a LAN and over `wss://` behind a reverse proxy.
 *
 * The handshake is an ephemeral ECDH (P-256) whose shared secret is folded
 * together with the pre-shared key carried by the connection code before the
 * KDF runs. An active man-in-the-middle can substitute public keys, but without
 * the PSK it cannot derive the traffic keys and cannot forge either
 * confirmation MAC, so the connection dies before a single byte of application
 * data moves. Forward secrecy comes from the ephemeral keypairs: recording the
 * traffic and later learning the code does not decrypt anything.
 *
 * Frames use AES-256-GCM with a per-direction key and a nonce built from a
 * per-direction salt plus a monotonic counter, so a (key, nonce) pair is never
 * reused and replays are rejected by counter check before any crypto work.
 */

import {
    CONFIRM_CLIENT, CONFIRM_SERVER, FLAG_BINARY, FLAG_COMPRESSED, FRAME_VERSION,
    HEADER_SIZE, KDF_LENGTH, KDF_SLICES, LABEL_KEYS, LABEL_ROOM_ID, LABEL_TRANSCRIPT,
    LIMITS, NONCE_LENGTH, ROOM_ID_LENGTH,
} from './protocol.js';

const subtle = globalThis.crypto?.subtle;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

if (!subtle) {
    console.error('[Multiplayer] WebCrypto is unavailable. SillyTavern must be served over https:// or from localhost.');
}

/** @returns {Uint8Array} cryptographically random bytes */
export function randomBytes(length) {
    return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

export function concatBytes(...parts) {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

/**
 * Timing-safe byte comparison. Always walks the full length so the running
 * time does not leak the position of the first differing byte.
 */
export function timingSafeEqual(a, b) {
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
}

export function toBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

export function fromBase64(text) {
    const binary = atob(String(text ?? ''));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
}

export async function sha256(bytes) {
    return new Uint8Array(await subtle.digest('SHA-256', bytes));
}

/**
 * Public room identifier derived from the PSK. Lets the relay look up a room
 * without ever seeing the PSK itself, and without the PSK travelling in
 * plaintext during the handshake.
 */
export async function deriveRoomId(psk) {
    const digest = await sha256(concatBytes(encoder.encode(LABEL_ROOM_ID), psk));
    return digest.subarray(0, ROOM_ID_LENGTH);
}

/** Generates the ephemeral P-256 keypair used for one connection attempt. */
export async function generateEphemeralKeyPair() {
    const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const publicKeyRaw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
    return { privateKey: pair.privateKey, publicKeyRaw };
}

/**
 * Runs the full key schedule.
 *
 * `HKDF(ikm = ECDH_secret || psk, salt = transcriptHash, info = LABEL_KEYS)`
 *
 * Binding the PSK into the input keying material (rather than only MAC-ing with
 * it afterwards) means an attacker who cannot supply the PSK derives entirely
 * different keys, so the ECDH is authenticated rather than anonymous.
 *
 * @returns {Promise<{keys: object, transcriptHash: Uint8Array}>}
 */
export async function deriveSessionKeys({ privateKey, ownPublicRaw, peerPublicRaw, ownNonce, peerNonce, psk, isClient }) {
    const peerKey = await subtle.importKey(
        'raw', peerPublicRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
    );
    const sharedSecret = new Uint8Array(
        await subtle.deriveBits({ name: 'ECDH', public: peerKey }, privateKey, 256),
    );

    // Transcript order is fixed as (client, server) on both sides so the two
    // peers hash exactly the same bytes regardless of who is speaking.
    const clientPub = isClient ? ownPublicRaw : peerPublicRaw;
    const serverPub = isClient ? peerPublicRaw : ownPublicRaw;
    const clientNonce = isClient ? ownNonce : peerNonce;
    const serverNonce = isClient ? peerNonce : ownNonce;

    const transcriptHash = await sha256(concatBytes(
        encoder.encode(LABEL_TRANSCRIPT), clientPub, serverPub, clientNonce, serverNonce,
    ));

    const ikm = await subtle.importKey('raw', concatBytes(sharedSecret, psk), 'HKDF', false, ['deriveBits']);
    const okm = new Uint8Array(await subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: transcriptHash, info: encoder.encode(LABEL_KEYS) },
        ikm,
        KDF_LENGTH * 8,
    ));

    const slice = ([from, to]) => okm.slice(from, to);
    const rawC2S = slice(KDF_SLICES.keyC2S);
    const rawS2C = slice(KDF_SLICES.keyS2C);

    const [keyC2S, keyS2C, confirmKey] = await Promise.all([
        subtle.importKey('raw', rawC2S, 'AES-GCM', false, ['encrypt', 'decrypt']),
        subtle.importKey('raw', rawS2C, 'AES-GCM', false, ['encrypt', 'decrypt']),
        subtle.importKey('raw', slice(KDF_SLICES.confirm), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']),
    ]);

    const keys = {
        send: isClient ? keyC2S : keyS2C,
        receive: isClient ? keyS2C : keyC2S,
        sendSalt: slice(isClient ? KDF_SLICES.saltC2S : KDF_SLICES.saltS2C),
        receiveSalt: slice(isClient ? KDF_SLICES.saltS2C : KDF_SLICES.saltC2S),
        confirmKey,
    };

    // Scrub the raw key bytes; the imported CryptoKeys are non-extractable.
    rawC2S.fill(0); rawS2C.fill(0); okm.fill(0); sharedSecret.fill(0);

    return { keys, transcriptHash };
}

/** HMAC proving PSK knowledge, bound to the full handshake transcript. */
export async function computeConfirmation(confirmKey, transcriptHash, who) {
    const message = concatBytes(encoder.encode(who), transcriptHash);
    return new Uint8Array(await subtle.sign('HMAC', confirmKey, message));
}

export const confirmationLabels = { client: CONFIRM_CLIENT, server: CONFIRM_SERVER };

// ---------------------------------------------------------------------------
// Optional payload compression. Ciphertext is incompressible, so this has to
// happen before encryption; only whole self-contained payloads are compressed
// and only above a threshold, so there is no mixing of attacker-chosen and
// secret data inside one compression context.
// ---------------------------------------------------------------------------

const compressionAvailable = typeof globalThis.CompressionStream === 'function'
    && typeof globalThis.DecompressionStream === 'function';

async function streamThrough(bytes, stream) {
    const response = new Response(new Blob([bytes]).stream().pipeThrough(stream));
    return new Uint8Array(await response.arrayBuffer());
}

async function deflate(bytes) {
    if (!compressionAvailable) return null;
    try {
        const out = await streamThrough(bytes, new CompressionStream('deflate-raw'));
        return out.length < bytes.length ? out : null;
    } catch {
        return null;
    }
}

async function inflate(bytes) {
    if (!compressionAvailable) throw new Error('Peer sent a compressed frame but this browser cannot decompress it');
    return streamThrough(bytes, new DecompressionStream('deflate-raw'));
}

// ---------------------------------------------------------------------------
// Frame sealing / opening
// ---------------------------------------------------------------------------

function buildNonce(salt, counter) {
    const nonce = new Uint8Array(NONCE_LENGTH);
    nonce.set(salt, 0);
    new DataView(nonce.buffer).setBigUint64(4, counter, false);
    return nonce;
}

/**
 * Encrypts one payload into a wire frame.
 * @param {object} keys session keys from {@link deriveSessionKeys}
 * @param {bigint} counter strictly increasing send counter
 * @param {object|Uint8Array} payload JSON-serialisable object, or raw bytes
 */
export async function sealFrame(keys, counter, payload) {
    let flags = 0;
    let plaintext;

    if (payload instanceof Uint8Array) {
        flags |= FLAG_BINARY;
        plaintext = payload;
    } else {
        plaintext = encoder.encode(JSON.stringify(payload));
    }

    if (plaintext.length >= LIMITS.COMPRESS_THRESHOLD) {
        const compressed = await deflate(plaintext);
        if (compressed) {
            plaintext = compressed;
            flags |= FLAG_COMPRESSED;
        }
    }

    if (plaintext.length > LIMITS.MAX_FRAME_BYTES) {
        throw new Error(`Payload of ${plaintext.length} bytes exceeds the frame limit`);
    }

    const header = new Uint8Array(HEADER_SIZE);
    header[0] = FRAME_VERSION;
    header[1] = flags;
    new DataView(header.buffer).setBigUint64(2, counter, false);

    const ciphertext = new Uint8Array(await subtle.encrypt(
        { name: 'AES-GCM', iv: buildNonce(keys.sendSalt, counter), additionalData: header, tagLength: 128 },
        keys.send,
        plaintext,
    ));

    return concatBytes(header, ciphertext);
}

/**
 * Decrypts one wire frame. Throws on any tampering, replay or malformed input;
 * callers treat a throw as fatal for the connection.
 * @returns {Promise<{counter: bigint, payload: object|Uint8Array}>}
 */
export async function openFrame(keys, frame) {
    const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
    if (bytes.length <= HEADER_SIZE + 16) throw new Error('Frame is too short');
    if (bytes[0] !== FRAME_VERSION) throw new Error('Unsupported frame version');

    const header = bytes.subarray(0, HEADER_SIZE);
    const flags = header[1];
    if (flags & ~(FLAG_COMPRESSED | FLAG_BINARY)) throw new Error('Unknown frame flags');

    const counter = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(2, false);

    let plaintext = new Uint8Array(await subtle.decrypt(
        { name: 'AES-GCM', iv: buildNonce(keys.receiveSalt, counter), additionalData: header, tagLength: 128 },
        keys.receive,
        bytes.subarray(HEADER_SIZE),
    ));

    if (flags & FLAG_COMPRESSED) {
        plaintext = await inflate(plaintext);
        if (plaintext.length > LIMITS.MAX_FRAME_BYTES) throw new Error('Decompressed payload exceeds the frame limit');
    }

    const payload = (flags & FLAG_BINARY) ? plaintext : JSON.parse(decoder.decode(plaintext));
    return { counter, payload };
}

/**
 * Sliding-window replay guard. Accepts counters ahead of the high-water mark
 * and a bounded amount of reordering behind it, and rejects anything already
 * seen. Reordering never actually happens over a single WebSocket, but the
 * window costs nothing and keeps the check independent of transport ordering.
 */
export class ReplayWindow {
    #highest = 0n;
    #seen = new Set();

    accept(counter) {
        if (counter <= 0n) return false;
        if (counter > this.#highest) {
            this.#highest = counter;
            this.#seen.add(counter);
            const floor = this.#highest - BigInt(LIMITS.COUNTER_WINDOW);
            for (const value of this.#seen) if (value < floor) this.#seen.delete(value);
            return true;
        }
        if (this.#highest - counter >= BigInt(LIMITS.COUNTER_WINDOW)) return false;
        if (this.#seen.has(counter)) return false;
        this.#seen.add(counter);
        return true;
    }
}
