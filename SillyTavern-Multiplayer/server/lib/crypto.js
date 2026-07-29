/**
 * Node half of the Multiplayer session crypto.
 *
 * Byte-for-byte compatible with ../../lib/crypto.js: same curve, same KDF
 * labels, same slice layout, same frame header and the same GCM nonce
 * construction. If you change one, change both.
 */

import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

import {
    CONFIRM_CLIENT, CONFIRM_SERVER, FLAG_BINARY, FLAG_COMPRESSED, FRAME_VERSION,
    HEADER_SIZE, KDF_LENGTH, KDF_SLICES, LABEL_KEYS, LABEL_ROOM_ID, LABEL_TRANSCRIPT,
    LIMITS, NONCE_LENGTH, ROOM_ID_LENGTH,
} from './protocol.js';

const deflateRaw = promisify(zlib.deflateRaw);
const inflateRaw = promisify(zlib.inflateRaw);

export const CURVE = 'prime256v1'; // NIST P-256, matching WebCrypto's "P-256"

export function randomBytes(length) {
    return crypto.randomBytes(length);
}

/** Constant-time comparison that also tolerates length mismatches safely. */
export function timingSafeEqual(a, b) {
    if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b) || a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

export function sha256(...parts) {
    const hash = crypto.createHash('sha256');
    for (const part of parts) hash.update(part);
    return hash.digest();
}

/** Public room identifier derived from the PSK, so the PSK never travels. */
export function deriveRoomId(psk) {
    return sha256(Buffer.from(LABEL_ROOM_ID, 'utf8'), psk).subarray(0, ROOM_ID_LENGTH);
}

export function createEphemeralKeyPair() {
    const ecdh = crypto.createECDH(CURVE);
    ecdh.generateKeys();
    return { ecdh, publicKeyRaw: ecdh.getPublicKey() }; // uncompressed, 65 bytes
}

/**
 * Runs the key schedule for the server side of one connection.
 *
 * `computeSecret` validates that the peer's point is on the curve and rejects
 * the identity, so a malformed or malicious public key throws here rather than
 * producing a predictable shared secret.
 */
export function deriveSessionKeys({ ecdh, ownPublicRaw, peerPublicRaw, ownNonce, peerNonce, psk }) {
    if (!Buffer.isBuffer(peerPublicRaw) || peerPublicRaw.length !== 65 || peerPublicRaw[0] !== 0x04) {
        throw new Error('Peer public key is not an uncompressed P-256 point');
    }

    const sharedSecret = ecdh.computeSecret(peerPublicRaw);

    // The relay is always the "server" half, so the peer is always the client.
    const transcriptHash = sha256(
        Buffer.from(LABEL_TRANSCRIPT, 'utf8'),
        peerPublicRaw, ownPublicRaw,
        peerNonce, ownNonce,
    );

    const okm = Buffer.from(crypto.hkdfSync(
        'sha256',
        Buffer.concat([sharedSecret, psk]),
        transcriptHash,
        Buffer.from(LABEL_KEYS, 'utf8'),
        KDF_LENGTH,
    ));

    const slice = ([from, to]) => Buffer.from(okm.subarray(from, to));

    const keys = {
        // Relay receives client->server traffic and sends server->client.
        receive: slice(KDF_SLICES.keyC2S),
        send: slice(KDF_SLICES.keyS2C),
        receiveSalt: slice(KDF_SLICES.saltC2S),
        sendSalt: slice(KDF_SLICES.saltS2C),
        confirmKey: slice(KDF_SLICES.confirm),
    };

    sharedSecret.fill(0);
    okm.fill(0);

    return { keys, transcriptHash };
}

export function computeConfirmation(confirmKey, transcriptHash, who) {
    return crypto.createHmac('sha256', confirmKey)
        .update(Buffer.from(who, 'utf8'))
        .update(transcriptHash)
        .digest();
}

export const confirmationLabels = { client: CONFIRM_CLIENT, server: CONFIRM_SERVER };

function buildNonce(salt, counter) {
    const nonce = Buffer.allocUnsafe(NONCE_LENGTH);
    salt.copy(nonce, 0, 0, 4);
    nonce.writeBigUInt64BE(counter, 4);
    return nonce;
}

/**
 * Encrypts one payload into a wire frame.
 * @param {object} keys
 * @param {bigint} counter
 * @param {object|Buffer} payload
 */
export async function sealFrame(keys, counter, payload) {
    let flags = 0;
    let plaintext = Buffer.isBuffer(payload)
        ? (flags |= FLAG_BINARY, payload)
        : Buffer.from(JSON.stringify(payload), 'utf8');

    if (plaintext.length >= LIMITS.COMPRESS_THRESHOLD) {
        const compressed = await deflateRaw(plaintext);
        if (compressed.length < plaintext.length) {
            plaintext = compressed;
            flags |= FLAG_COMPRESSED;
        }
    }

    if (plaintext.length > LIMITS.MAX_FRAME_BYTES) {
        throw new Error(`Payload of ${plaintext.length} bytes exceeds the frame limit`);
    }

    const header = Buffer.allocUnsafe(HEADER_SIZE);
    header[0] = FRAME_VERSION;
    header[1] = flags;
    header.writeBigUInt64BE(counter, 2);

    const cipher = crypto.createCipheriv('aes-256-gcm', keys.send, buildNonce(keys.sendSalt, counter));
    cipher.setAAD(header);
    const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

    return Buffer.concat([header, body]);
}

/**
 * Decrypts one wire frame. Throws on tampering, unknown flags, oversize
 * payloads or malformed JSON; callers treat a throw as fatal for the socket.
 * @returns {Promise<{counter: bigint, payload: object|Buffer}>}
 */
export async function openFrame(keys, frame) {
    const bytes = Buffer.isBuffer(frame) ? frame : Buffer.from(frame);
    if (bytes.length <= HEADER_SIZE + 16) throw new Error('Frame is too short');
    if (bytes[0] !== FRAME_VERSION) throw new Error('Unsupported frame version');

    const flags = bytes[1];
    if (flags & ~(FLAG_COMPRESSED | FLAG_BINARY)) throw new Error('Unknown frame flags');

    const header = bytes.subarray(0, HEADER_SIZE);
    const counter = header.readBigUInt64BE(2);

    const tag = bytes.subarray(bytes.length - 16);
    const ciphertext = bytes.subarray(HEADER_SIZE, bytes.length - 16);

    const decipher = crypto.createDecipheriv('aes-256-gcm', keys.receive, buildNonce(keys.receiveSalt, counter));
    decipher.setAAD(header);
    decipher.setAuthTag(tag);

    let plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    if (flags & FLAG_COMPRESSED) {
        // maxOutputLength stops a compression bomb from allocating unbounded memory.
        plaintext = await inflateRaw(plaintext, { maxOutputLength: LIMITS.MAX_FRAME_BYTES });
    }

    const payload = (flags & FLAG_BINARY) ? plaintext : JSON.parse(plaintext.toString('utf8'));
    return { counter, payload };
}

/** Sliding-window replay guard, identical in behaviour to the browser copy. */
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

/** Token bucket used for per-peer message and byte rate limits. */
export class TokenBucket {
    constructor(capacity, refillPerMs) {
        this.capacity = capacity;
        this.tokens = capacity;
        this.refillPerMs = refillPerMs;
        this.updatedAt = Date.now();
    }

    take(amount = 1) {
        const now = Date.now();
        this.tokens = Math.min(this.capacity, this.tokens + (now - this.updatedAt) * this.refillPerMs);
        this.updatedAt = now;
        if (this.tokens < amount) return false;
        this.tokens -= amount;
        return true;
    }
}
