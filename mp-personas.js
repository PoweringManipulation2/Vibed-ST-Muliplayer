/**
 * mp-personas.js — persona + avatar sync for the multiplayer extension.
 *
 * Transport-agnostic. You supply the socket; this handles everything between
 * "a player sent a message" and "it renders with the right icon on the host".
 *
 * Split:
 *   CLIENT  buildOutgoingMessage() / resetPersonaCache()
 *   HOST    ingestPersona() / stampPlayer() / restampChat() / injectRoster()
 */

import { sharingState, sourceIdentity, objectHash, contentHash, sharedWrite, validIdentity } from './lib/identity.js';

const MODULE_NAME = 'multiplayer';

const ctx = () => SillyTavern.getContext();

// Compatibility helper for integrations that explicitly import personas.
// The main extension uses lib/chat.js and does NOT auto-import remote personas.
// These are the native SillyTavern multipart avatar-upload field names.
const AVATAR_UPLOAD_URL = '/api/avatars/upload';
const AVATAR_UPLOAD_FIELD = 'avatar';

/* ------------------------------------------------------------------ *
 * Shared
 * ------------------------------------------------------------------ */

function settings() {
    const s = ctx().extensionSettings;
    s[MODULE_NAME] ??= {};
    // `${playerId}:${remoteAvatarId}` -> local filename in User Avatars/
    s[MODULE_NAME].personaMap ??= {};
    return s[MODULE_NAME];
}

/**
 * Pull the avatar filename back out of a force_avatar value.
 * Your chat file shows the thumbnailed form:
 *   /thumbnail?type=persona&file=1774920536592-Legoshi.png
 * With persona thumbnailing off it's a direct path, so handle both.
 */
export function avatarIdFromForceAvatar(forceAvatar) {
    if (typeof forceAvatar !== 'string' || !forceAvatar) return null;
    try {
        const url = new URL(forceAvatar, window.location.origin);
        return url.searchParams.get('file')
            ?? decodeURIComponent(url.pathname.split('/').pop());
    } catch {
        return null;
    }
}

async function blobToBase64(blob) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    }
    return btoa(bin);
}

/* ------------------------------------------------------------------ *
 * CLIENT
 * ------------------------------------------------------------------ */

/** Avatars this client has already shipped to the host, this connection. */
const sentAvatars = new Map();

/**
 * Call on every (re)connect. The host may have restarted or had its
 * settings cleared, so never assume a previous sync still holds.
 */
export function resetPersonaCache() {
    sentAvatars.clear();
}

/**
 * Build the outbound packet for a message ST just recorded.
 * Call from your MESSAGE_SENT handler with the message index.
 *
 * A persona payload travels once per content revision. Same-filename edits
 * are detected too; unchanged revisions are omitted from subsequent packets.
 */
export async function buildOutgoingMessage(messageIndex) {
    const c = ctx();
    const mes = c.chat[messageIndex];
    if (!mes) return null;

    const avatarId = avatarIdFromForceAvatar(mes.force_avatar);

    const packet = {
        kind: 'player_message',
        text: mes.mes,
        name: mes.name,
        avatarId,
        // Intent is NOT decided here. Your generate_interceptor sends a
        // separate request_generation packet; this one never asks for a reply.
    };

    if (avatarId) {
        try {
            const persona = await collectPersona(avatarId, mes.force_avatar);
            const revision = await objectHash(persona);
            if (sentAvatars.get(avatarId) !== revision) {
                packet.persona = persona;
                sentAvatars.set(avatarId, revision);
            }
        } catch (err) {
            console.error(`[${MODULE_NAME}] persona capture failed`, err);
            // Ship the message anyway — a missing icon beats a dropped line.
        }
    }

    return packet;
}

async function collectPersona(avatarId, imageUrl) {
    const pu = ctx().powerUserSettings;

    // Fetch the same URL the DOM is already rendering. Guaranteed to resolve,
    // unlike guessing at the User Avatars path. Downside: if thumbnailing is
    // on you get the thumbnail, not the original. Fine for a chat icon.
    const res = await fetch(imageUrl, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`avatar fetch ${res.status}`);

    const state = sharingState(settings(), () => ctx().saveSettingsDebounced());
    return {
        ownerId: state.ownerId,
        personaId: sourceIdentity(state, 'persona', avatarId, () => ctx().saveSettingsDebounced()),
        avatarId,
        displayName: pu.personas?.[avatarId] ?? ctx().name1,
        descriptor: structuredClone(pu.persona_descriptions?.[avatarId] ?? {}),
        pngBase64: await blobToBase64(await res.blob()),
    };
}

/* ------------------------------------------------------------------ *
 * HOST
 * ------------------------------------------------------------------ */

/**
 * Write a remote player's avatar into this machine's User Avatars/ and
 * register it as a persona. Idempotent — safe to call on every packet.
 * Returns the local filename.
 */
export async function ingestPersona(playerId, persona) {
    if (!persona || typeof persona.avatarId !== 'string' || typeof persona.pngBase64 !== 'string'
        || persona.pngBase64.length > 4 * 1024 * 1024) throw new Error('Invalid or oversized persona');
    const stable = persona.ownerId !== undefined || persona.personaId !== undefined;
    if (stable && (!validIdentity(persona.ownerId) || !validIdentity(persona.personaId))) throw new Error('Invalid persona identity');
    const key = JSON.stringify(stable ? [persona.ownerId, persona.personaId] : ['legacy', String(playerId), persona.avatarId]);
    return sharedWrite(`persona:${key}`, async () => {
        const state = sharingState(settings(), () => ctx().saveSettingsDebounced());
        const map = settings().personaMap;
        const alias = `${playerId}:${persona.avatarId}`;
        let record = state.remotePersonas[key];
        const pu = ctx().powerUserSettings;
        pu.personas ??= {};
        pu.persona_descriptions ??= {};
        const revision = await objectHash({ displayName: persona.displayName, descriptor: persona.descriptor, pngBase64: persona.pngBase64 });
        const response = await fetch('/api/avatars/get', { method: 'POST', headers: ctx().getRequestHeaders(), body: '{}' });
        if (!response.ok) throw new Error(`Could not check existing persona avatars (${response.status})`);
        const files = await response.json();
        if (!Array.isArray(files)) throw new Error('Invalid persona avatar listing');
        let localFile = record?.avatar ?? map[alias];
        if (!localFile) {
            localFile = `stmp_persona_${(await contentHash(key)).slice(0, 32)}.png`;
            if (files.includes(localFile)) throw new Error('Persona filename conflict; nothing was overwritten.');
        }
        if (typeof localFile !== 'string' || /[\\/\x00-\x1f]/.test(localFile) || !localFile.endsWith('.png')) throw new Error('Invalid local persona filename');
        const currentMarker = pu.persona_descriptions[localFile]?.st_multiplayer;
        if (currentMarker?.key && currentMarker.key !== key) throw new Error('This local persona belongs to another sharing identity');
        if (record?.revision !== revision || !files.includes(localFile) || !currentMarker) {
            // Persist a reservation before uploading. After an interrupted upload,
            // a retry overwrites this same reserved file, never a timestamped copy.
            record = { avatar: localFile, revision: record?.revision ?? null, pendingRevision: revision };
            state.remotePersonas[key] = record;
            ctx().saveSettingsDebounced();
            await uploadAvatar(localFile, persona.pngBase64);
            pu.personas[localFile] = String(persona.displayName ?? 'Player').slice(0, 128);
            pu.persona_descriptions[localFile] = {
                description: '', depth: 4, role: 0, lorebook: '',
                ...(persona.descriptor ?? {}),
                // NONE: remote descriptions must never become the host's own persona.
                position: 9,
                st_multiplayer: { key, ownerId: persona.ownerId, personaId: persona.personaId },
            };
            state.remotePersonas[key] = { avatar: localFile, revision };
        }
        map[alias] = localFile; // compatibility with stamped historical chat messages
        ctx().saveSettingsDebounced();
        return localFile;
    });
}

async function uploadAvatar(fileName, pngBase64) {
    const bytes = Uint8Array.from(atob(pngBase64), ch => ch.charCodeAt(0));

    const form = new FormData();
    form.append(AVATAR_UPLOAD_FIELD, new File([bytes], fileName, { type: 'image/png' }));
    form.append('overwrite_name', fileName);

    const headers = { ...ctx().getRequestHeaders() };
    // Must go — the browser sets its own multipart boundary.
    delete headers['Content-Type'];
    delete headers['content-type'];

    const res = await fetch(AVATAR_UPLOAD_URL, { method: 'POST', headers, body: form });
    if (!res.ok) {
        throw new Error(
            `avatar upload failed (${res.status}) at ${AVATAR_UPLOAD_URL} — ` +
            `check AVATAR_UPLOAD_URL / AVATAR_UPLOAD_FIELD against your install`
        );
    }
    const result = await res.json();
    if (result?.path !== fileName) throw new Error('Persona upload did not confirm the requested filename');
}

/**
 * Stamp a message object so it renders as the remote player.
 * Call this before pushing to chat[] and addOneMessage().
 *
 * Never relay force_avatar from the client — that URL points at a file on
 * the client's disk. Recompute it here against our own copy.
 */
export function stampPlayer(message, playerId, packet) {
    const localFile = settings().personaMap[`${playerId}:${packet.avatarId}`];

    message.name = packet.name;
    message.is_user = true;
    message.is_system = false;
    message.extra = {
        ...(message.extra ?? {}),
        mp_player: playerId,
        mp_avatar: packet.avatarId,
    };

    if (localFile) {
        message.force_avatar = ctx().getThumbnailUrl('persona', localFile);
    }
    return message;
}

/**
 * One-time repair for messages already sitting in your chats with the
 * host's icon on them. Keys off extra.mp_player, which stampPlayer()
 * writes and which round-trips through the chat file.
 */
export async function restampChat() {
    const c = ctx();
    const map = settings().personaMap;
    let changed = 0;

    for (const mes of c.chat) {
        const playerId = mes.extra?.mp_player;
        const avatarId = mes.extra?.mp_avatar;
        if (!playerId || !avatarId) continue;

        const localFile = map[`${playerId}:${avatarId}`];
        if (!localFile) continue;

        const url = c.getThumbnailUrl('persona', localFile);
        if (mes.force_avatar !== url) {
            mes.force_avatar = url;
            changed++;
        }
    }

    if (changed) {
        await c.saveChat();
        await c.reloadCurrentChat();
    }
    return changed;
}

/**
 * ST only injects the ACTIVE persona's description, so registering remote
 * personas gets you the icon but not the context. This closes that gap.
 *
 * players: [{ id, avatarId }]
 *
 * NOTE: 1 is IN_CHAT in extension_prompt_types — worth a one-line check
 * against your version, since it's the only magic number here I haven't
 * confirmed from your install.
 */
export function injectRoster(players) {
    const c = ctx();
    const pu = c.powerUserSettings;
    const map = settings().personaMap;

    const lines = players.map(p => {
        const file = map[`${p.id}:${p.avatarId}`];
        if (!file) return null;
        const name = pu.personas?.[file];
        const desc = pu.persona_descriptions?.[file]?.description?.trim();
        return desc ? `${name}: ${desc}` : null;
    }).filter(Boolean);

    c.setExtensionPrompt('MP_ROSTER', lines.join('\n'), 1, 4);
}
