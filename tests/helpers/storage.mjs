/** A small HTTP-contract mock, not a replacement for a live SillyTavern smoke test. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

export const clone = value => structuredClone(value);
export const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
});

export function makeStorage({ settings = {}, name = 'Player' } = {}) {
    const disk = new Map(), images = new Map(), calls = [];
    const failures = [], lostReplies = [], silentFailures = [];
    let saves = 0, refreshes = 0;
    const context = {
        characters: [], chat: [], characterId: undefined, chatMetadata: {},
        powerUserSettings: {}, extensionSettings: { multiplayer: settings },
        eventSource: new EventEmitter(),
        eventTypes: Object.fromEntries(['MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_EDITED', 'MESSAGE_DELETED',
            'STREAM_TOKEN_RECEIVED', 'GENERATION_STARTED', 'GENERATION_ENDED', 'CHARACTER_EDITED',
            'CHARACTER_RENAMED', 'PERSONA_UPDATED', 'SETTINGS_UPDATED', 'CHAT_CHANGED', 'CHARACTER_PAGE_LOADED']
            .map(x => [x, x])),
        substituteParams: () => name,
        setExtensionPrompt() {}, saveChat: async () => {}, saveMetadata: async () => {},
        getCharacters: async () => { refreshes++; context.characters = clone([...disk.values()]); },
        getRequestHeaders: ({ omitContentType } = {}) => omitContentType ? {} : { 'Content-Type': 'application/json' },
        saveSettingsDebounced: () => { saves++; },
    };
    const deps = {
        getContext: () => context, settings: () => settings,
        save: () => { saves++; }, getRequestHeaders: context.getRequestHeaders,
        activePersonaAvatar: () => null,
        extensionApi: { extensionNames: [], extensionTypes: {}, getExtensionManifest: () => ({}) },
        toastr: { error() {}, warning() {}, success() {}, info() {} },
    };
    function add(card) {
        const item = clone({ chat: 'chat-preserved', create_date: 'date-preserved', fav: false, ...card });
        disk.set(item.avatar, item);
        context.characters = clone([...disk.values()]);
        return item;
    }
    async function fetch(url, options = {}) {
        const path = String(url);
        const form = options.body instanceof FormData;
        let body = options.body ? form ? Object.fromEntries(options.body.entries()) : JSON.parse(options.body) : {};
        if (form) {
            for (const key of Object.keys(body)) {
                const match = /^(.+)\[(\d+)\]$/.exec(key);
                if (match) { (body[match[1]] ??= [])[Number(match[2])] = body[key]; delete body[key]; }
            }
        }
        calls.push({ path, body, form });
        const failure = failures.findIndex(x => x.path === path);
        if (failure !== -1) return json({ error: true }, failures.splice(failure, 1)[0].status);
        const silent = silentFailures.indexOf(path);
        if (silent !== -1) { silentFailures.splice(silent, 1); return json({}); }
        let result;
        if (path === '/api/characters/get') {
            result = disk.has(body.avatar_url) ? json(disk.get(body.avatar_url)) : json({}, 404);
        } else if (path === '/api/characters/import') {
            assert.ok(form);
            const file = body.preserved_name;
            const card = JSON.parse(await body.avatar.text());
            disk.set(`${file}.png`, { ...card, avatar: `${file}.png`, chat: 'initial-chat', create_date: 'initial-date', fav: false });
            result = json({ file_name: file });
        } else if (path === '/api/characters/edit') {
            assert.ok(disk.has(body.avatar_url), 'edit must never create an unknown card');
            const card = JSON.parse(body.json_data);
            const old = disk.get(body.avatar_url);
            const fav = body.fav === 'true';
            const extensions = JSON.parse(body.extensions);
            // ST's formatter copies fields from the form over json_data.
            card.data.name = body.ch_name;
            for (const key of ['description', 'personality', 'scenario', 'first_mes', 'mes_example',
                'creator_notes', 'system_prompt', 'post_history_instructions', 'creator', 'character_version']) {
                card.data[key] = body[key] ?? '';
            }
            for (const key of ['alternate_greetings', 'tags', 'group_only_greetings']) card.data[key] = body[key] ?? [];
            card.data.extensions = { ...card.data.extensions, ...extensions, fav };
            Object.assign(card, { name: body.ch_name, description: card.data.description, avatar: body.avatar_url,
                chat: body.chat, create_date: body.create_date, fav, chat_size: old.chat_size });
            disk.set(card.avatar, card);
            if (body.avatar) images.set(card.avatar, new Uint8Array(await body.avatar.arrayBuffer()));
            result = json({});
        } else if (path === '/api/characters/edit-avatar') {
            assert.ok(disk.has(body.avatar_url));
            images.set(body.avatar_url, new Uint8Array(await body.avatar.arrayBuffer()));
            result = json({});
        } else if (path.startsWith('/characters/')) {
            const name = decodeURIComponent(path.slice('/characters/'.length));
            result = images.has(name) ? new Response(images.get(name)) : json({}, 404);
        } else throw new Error(`Unmocked HTTP endpoint: ${path}`);
        const lost = lostReplies.indexOf(path);
        if (lost !== -1) { lostReplies.splice(lost, 1); throw new TypeError('Simulated network loss after disk write'); }
        return result;
    }
    return { deps, context, settings, disk, images, calls, fetch, add,
        count: path => calls.filter(c => c.path === path).length,
        failNext: (path, status = 500) => failures.push({ path, status }),
        loseNextReply: path => lostReplies.push(path),
        silentlyFailNext: path => silentFailures.push(path),
        get saves() { return saves; }, get refreshes() { return refreshes; },
    };
}
