import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { json } from './helpers/storage.mjs';
import { ingestPersona, buildOutgoingMessage, resetPersonaCache } from '../mp-personas.js';

let nativeFetch, nativeST, nativeWindow, context, files, uploads, fail, settings, bytes;
beforeEach(() => {
    nativeFetch = globalThis.fetch; nativeST = globalThis.SillyTavern; nativeWindow = globalThis.window;
    files = new Set(); uploads = []; fail = null; settings = {}; bytes = 'a';
    context = { extensionSettings: { multiplayer: settings }, powerUserSettings: {},
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }), saveSettingsDebounced() {},
        chat: [], name1: 'Local' };
    globalThis.SillyTavern = { getContext: () => context };
    globalThis.window = { location: { origin: 'http://localhost' } };
    globalThis.fetch = async (url, options) => {
        if (fail === url) { fail = null; return json({}, 500); }
        if (url === '/api/avatars/get') return json([...files]);
        if (url === '/api/avatars/upload') {
            const name = options.body.get('overwrite_name');
            assert.equal(options.body.get('avatar').name, name);
            assert.equal(options.headers['Content-Type'], undefined);
            files.add(name); uploads.push(name);
            return json({ path: name });
        }
        if (url === '/portrait') return new Response(bytes);
        throw new Error(`Unexpected URL ${url}`);
    };
    resetPersonaCache();
});
afterEach(() => { globalThis.fetch = nativeFetch; globalThis.SillyTavern = nativeST; globalThis.window = nativeWindow; });
const persona = (overrides = {}) => ({ ownerId: 'owner', personaId: 'persona', avatarId: 'original.png',
    displayName: 'Guest', descriptor: { description: 'initial', position: 0 }, pngBase64: 'YQ==', ...overrides });

await test('100 simultaneous legacy-helper imports of one identity create one persona avatar', async () => {
    const result = await Promise.all(Array.from({ length: 100 }, (_, i) => ingestPersona(`peer-${i}`, persona())));
    assert.equal(new Set(result).size, 1);
    assert.equal(files.size, 1);
    assert.equal(uploads.length, 1);
    assert.equal(Object.keys(context.powerUserSettings.personas).length, 1);
    assert.equal(context.powerUserSettings.persona_descriptions[result[0]].position, 9);
});
await test('new description and equal-length image update the existing persona after reconnect', async () => {
    const first = await ingestPersona('old-peer', persona());
    const second = await ingestPersona('new-peer', persona({ descriptor: { description: 'updated' }, pngBase64: 'Yg==' }));
    assert.equal(first, second);
    assert.equal(files.size, 1);
    assert.equal(uploads.length, 2);
    assert.equal(context.powerUserSettings.persona_descriptions[first].description, 'updated');
    assert.equal(context.powerUserSettings.persona_descriptions[first].position, 9);
});
await test('same-name personas owned by different people do not merge', async () => {
    const a = await ingestPersona('a', persona());
    const b = await ingestPersona('b', persona({ ownerId: 'another-owner' }));
    assert.notEqual(a, b);
    assert.equal(files.size, 2);
});
await test('failed persona upload leaves a retryable reservation without a successful revision', async () => {
    fail = '/api/avatars/upload';
    await assert.rejects(ingestPersona('first', persona()), /500/);
    const record = Object.values(settings.sharing.remotePersonas)[0];
    assert.equal(record.revision, null);
    assert.ok(record.pendingRevision);
    const name = await ingestPersona('second', persona());
    assert.equal(name, record.avatar);
    assert.equal(files.size, 1);
});
await test('server lookup failure never creates another avatar', async () => {
    await ingestPersona('first', persona());
    fail = '/api/avatars/get';
    await assert.rejects(ingestPersona('second', persona()), /500/);
    assert.equal(uploads.length, 1);
});
await test('deleted persona image is recreated at the remembered filename', async () => {
    const first = await ingestPersona('first', persona());
    files.delete(first);
    assert.equal(await ingestPersona('second', persona()), first);
    assert.equal(files.size, 1);
});
await test('old peer/avatar mappings migrate without another timestamped copy', async () => {
    settings.personaMap = { 'old-peer:original.png': 'mp_old_123.png' };
    files.add('mp_old_123.png');
    const result = await ingestPersona('old-peer', persona());
    assert.equal(result, 'mp_old_123.png');
    assert.equal(files.size, 1);
    assert.equal(await ingestPersona('new-peer', persona()), result);
});
await test('outgoing legacy packets detect content edits, omit unchanged data, and retain stable identity', async () => {
    context.chat.push({ mes: 'hello', name: 'Local', force_avatar: '/portrait' });
    context.powerUserSettings.persona_descriptions = { portrait: { description: 'one' } };
    const a = await buildOutgoingMessage(0);
    assert.ok(a.persona.ownerId);
    assert.ok(a.persona.personaId);
    const b = await buildOutgoingMessage(0);
    assert.equal(b.persona, undefined);
    bytes = 'b';
    const c = await buildOutgoingMessage(0);
    assert.ok(c.persona);
    assert.equal(a.persona.personaId, c.persona.personaId);
    assert.notEqual(a.persona.pngBase64, c.persona.pngBase64);
    resetPersonaCache();
    assert.ok((await buildOutgoingMessage(0)).persona);
});
