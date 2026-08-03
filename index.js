/**
 * SillyTavern-Multiplayer — UI extension entry point.
 *
 * Everything below runs in the browser. The listening socket lives in the
 * companion server plugin (see ./server), because a page cannot bind a port.
 * The host's browser talks to its own relay over loopback using the exact same
 * authenticated transport a remote client uses.
 *
 * SillyTavern loads this module and calls the `activate` hook declared in
 * manifest.json, so no work happens at import time.
 */

import {
    deleteExtension, disableExtension, enableExtension, extension_settings,
    extensionNames, extensionTypes, getExtensionManifest, installExtension,
    renderExtensionTemplateAsync,
} from '../../../extensions.js';
// `user_avatar` is a live module binding holding the *active* persona's avatar
// filename. It is not on getContext(), and it is not the same thing as
// `power_user.default_persona`, which is only the favourite.
import { getRequestHeaders, saveSettingsDebounced, user_avatar } from '../../../../script.js';

import { DEFAULT_PORT, LIMITS, SETTINGS_KEY, parseExtensionFolder } from './lib/protocol.js';
import { MultiplayerSession } from './lib/session.js';
import { MultiplayerUI } from './lib/ui.js';

/**
 * Folder name as SillyTavern addresses it when resolving templates.
 *
 * Derived from this module's own URL rather than hardcoded, because the folder
 * is named after whatever repository the extension was installed from. Anyone
 * who forks or renames the repo gets a different folder, and a hardcoded name
 * would make `settings.html` 404 with no visible error.
 */
const EXTENSION_FOLDER = parseExtensionFolder(import.meta.url);

const DEFAULT_SETTINGS = Object.freeze({
    /** Port the relay listens on. */
    port: DEFAULT_PORT,
    /**
     * false -> bind 127.0.0.1 only (nobody else can reach it)
     * true  -> bind 0.0.0.0 so other machines on the LAN can join
     */
    bindLan: true,
    roomName: 'SillyTavern room',
    /**
     * What address goes into the connection code. Blank means "use the LAN
     * address the relay detected", which is correct for same-network play and
     * useless for anything else. Set this to a public hostname, a public IP, or
     * a tunnel address when players are not on your network.
     */
    advertiseHost: '',
    /**
     * Ask the router to open the port on our behalf, via NAT-PMP or UPnP. On by
     * default because it is what turns cross-network play into no setup at all;
     * turn it off if you would rather manage router rules yourself.
     */
    autoPortForward: true,
    /** Public port players reach, if it differs from the listen port. 0 = same. */
    advertisePort: 0,
    /** True when the address above is fronted by an HTTPS tunnel or proxy (wss). */
    advertiseSecure: false,
    maxPeers: 4,
    /** Refuse peers whose extension set differs from the host's. */
    requireParity: true,
    /** 'manifest' (name + version) or 'commit' (also pins the git commit). */
    parityStrictness: 'manifest',
    autoReconnect: true,
    /** Avatar filenames the host has chosen to share. */
    sharedCards: [],
    /**
     * Whether a client's turn should make the host's model reply automatically.
     * On by default — otherwise a client sends a message and nothing happens.
     * Turn it off if you would rather several players act before the model does.
     */
    autoReply: true,
    /** Remembered player-chat panel geometry: {left, top, width, height, collapsed}. */
    oocPanel: {},
});

/** @type {MultiplayerSession|null} */
let session = null;
/** @type {MultiplayerUI|null} */
let ui = null;
let started = false;

function settings() {
    extension_settings[SETTINGS_KEY] ??= {};
    const current = extension_settings[SETTINGS_KEY];
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (current[key] === undefined) current[key] = Array.isArray(value) ? [...value] : value;
    }
    current.maxPeers = Math.min(LIMITS.MAX_PEERS, Math.max(2, Number(current.maxPeers) || 4));
    return current;
}

function save() {
    saveSettingsDebounced();
}

/** Everything the library modules are allowed to reach into. */
function buildDeps() {
    return {
        getContext: () => globalThis.SillyTavern.getContext(),
        getRequestHeaders,
        /** Read through a getter so it always reflects the current persona. */
        activePersonaAvatar: () => user_avatar,
        settings,
        save,
        extensionFolder: EXTENSION_FOLDER,
        toastr: globalThis.toastr,
        renderExtensionTemplateAsync,
        extensionApi: {
            extensionNames,
            extensionTypes,
            getExtensionManifest,
            extension_settings,
            getRequestHeaders,
            installExtension,
            deleteExtension,
            enableExtension,
            disableExtension,
        },
    };
}

/**
 * `generate_interceptor` hook, registered globally because SillyTavern looks
 * the function up on `globalThis` by the name given in manifest.json.
 *
 * A connected client never runs its own inference: the turn is handed to the
 * host, which owns the API connection and the canonical transcript, and local
 * generation is aborted before a prompt is assembled.
 */
globalThis.stmpGenerateInterceptor = async function stmpGenerateInterceptor(chat, _contextSize, abort, type) {
    if (!session?.connected) return;

    // Host: this is the last moment before the prompt is assembled, which makes
    // it the right place to put the other players' personas in front of the
    // model. Without this the descriptions travelled and were stored but never
    // reached a prompt, so the model saw several names and knew none of them.
    if (session.role === 'host') {
        if (session.inSessionChat()) {
            try {
                session.chat.injectPersonas(6, session.peerId);
            } catch (error) {
                console.error('[Multiplayer] Could not inject player personas', error);
            }
        } else {
            session.chat.clearPersonaInjection();
        }
        return;
    }

    if (session.role !== 'client') return;
    if (type === 'quiet' || type === 'impersonate') return; // local-only helpers stay local

    const last = chat?.[chat.length - 1];
    if (last?.is_user) {
        // ChatBridge already forwarded this on MESSAGE_SENT; abort so the
        // client does not also hit its own API with a half-synced context.
        abort(true);
        globalThis.toastr?.info('Sent to the host — their model will answer for the room.', 'Multiplayer');
        return;
    }
    abort(true);
};

/**
 * `activate` hook from manifest.json. Idempotent: SillyTavern can call it again
 * after the extension is re-enabled.
 */
export async function init() {
    if (started) return;
    started = true;

    const deps = buildDeps();
    settings();

    session = new MultiplayerSession(deps);
    ui = new MultiplayerUI({ session, deps });

    try {
        await ui.mount();
    } catch (error) {
        console.error('[Multiplayer] Failed to mount the settings panel', error);
    }

    // The OOC panel lives outside the settings drawer so players can use it
    // while the roleplay is on screen.
    try {
        session.ooc.mount();
    } catch (error) {
        console.error('[Multiplayer] Failed to mount the player chat panel', error);
    }

    try {
        session.typing.mount();
    } catch (error) {
        console.error('[Multiplayer] Failed to mount the typing indicator', error);
    }

    registerSlashCommands(deps);

    // Leaving a session cleanly on unload stops the relay from holding a dead
    // peer slot until its heartbeat expires.
    globalThis.addEventListener('beforeunload', () => {
        try { session?.socket?.close('page closed'); } catch { /* nothing useful to do here */ }
    });

    console.log(`[Multiplayer] ready (folder: ${EXTENSION_FOLDER})`);
}

/** `disable` hook: drop the session but leave stub cards in place. */
export async function onDisable() {
    await teardown();
}

/** `delete` hook: also stop the relay so no port is left listening. */
export async function onDelete() {
    try {
        await session?.stopHosting();
    } catch { /* the relay may already be gone */ }
    await teardown();
}

async function teardown() {
    try { await session?.leave(); } catch { /* ignore */ }
    try { session?.ooc.destroy(); } catch { /* ignore */ }
    try { session?.typing.destroy(); } catch { /* ignore */ }
    ui?.destroy();
    session = null;
    ui = null;
    started = false;
    delete globalThis.stmpGenerateInterceptor;
}

function registerSlashCommands(deps) {
    const context = deps.getContext();
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = context;
    if (!SlashCommandParser?.addCommandObject) return;

    const register = (name, callback, helpString, unnamed = []) => {
        try {
            SlashCommandParser.addCommandObject(SlashCommand.fromProps({
                name, callback, helpString, unnamedArgumentList: unnamed,
            }));
        } catch (error) {
            console.warn(`[Multiplayer] Could not register /${name}`, error);
        }
    };

    register('mp-host', async () => {
        await session.startHosting();
        return session.code;
    }, 'Starts hosting a multiplayer room and returns the connection code.');

    register('mp-join', async (_named, code) => {
        await session.join(String(code ?? '').trim());
        return 'joining';
    }, 'Joins a multiplayer room using a connection code.', [
        SlashCommandArgument.fromProps({ description: 'connection code', typeList: [ARGUMENT_TYPE.STRING], isRequired: true }),
    ]);

    register('mp-leave', async () => {
        await session.leave();
        return 'left';
    }, 'Leaves the current multiplayer session.');

    register('mp-sync', async () => {
        await ui.openSyncDialog();
        return '';
    }, 'Opens the extension sync dialog.');

    register('mp-ooc', async (_named, text) => {
        const message = String(text ?? '').trim();
        if (!message) {
            session.ooc.toggle();
            return '';
        }
        if (!session.connected) return 'not connected';
        session.socket?.send({ op: 'ooc.message', text: message });
        return '';
    }, 'Sends a message to the player-only chat, or opens the panel when given no text.', [
        SlashCommandArgument.fromProps({ description: 'message', typeList: [ARGUMENT_TYPE.STRING], isRequired: false }),
    ]);

    register('mp-status', () => JSON.stringify({
        status: session.status, role: session.role, peers: session.peers.length,
    }), 'Reports the current multiplayer status.');
}
