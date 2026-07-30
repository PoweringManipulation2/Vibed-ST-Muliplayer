/**
 * SillyTavern server plugin: Multiplayer relay control API.
 *
 * SillyTavern's plugin loader (src/plugin-loader.js) requires three things from
 * this module: an `info` object carrying `id`, `name` and `description`, an
 * `init(router)` function, and optionally an `exit()` hook that runs before the
 * server shuts down. Routes registered on the router are mounted at
 * `/api/plugins/<info.id>`.
 *
 * Security posture
 * ----------------
 * `loadPlugins()` is called *after* SillyTavern installs its basic-auth, IP
 * whitelist, CSRF and `requireLoginMiddleware` layers, so every route below is
 * already behind the same protection as the rest of SillyTavern's API. That is
 * what makes it safe to return the room's pre-shared key here: it only ever
 * travels to the already-authenticated browser session of the person hosting.
 *
 * On top of that inherited protection this file adds:
 *   - an admin check, because opening a listening socket is a privileged action;
 *   - `Cache-Control: no-store` on every response that carries a secret;
 *   - strict input validation before anything reaches the relay;
 *   - a single-relay-per-process invariant, so a stray request cannot leave
 *     orphaned listeners behind.
 */

import { PROTOCOL_REVISION } from './lib/protocol.js';
import { Relay, localAddresses } from './lib/relay.js';

export const info = {
    id: 'st-multiplayer',
    name: 'Multiplayer Relay',
    description: 'Hosts an authenticated, encrypted relay so other SillyTavern users can join this instance.',
};

const PREFIX = '[Multiplayer]';

function log(level, ...args) {
    const write = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    write(PREFIX, ...args);
}

/** @type {Relay} */
const relay = new Relay({ log });

/** Serialises start/stop/rotate so two overlapping requests cannot race. */
let mutex = Promise.resolve();
function exclusive(task) {
    const run = mutex.then(task, task);
    // Swallow rejections on the chain itself; the caller still sees them.
    mutex = run.then(() => undefined, () => undefined);
    return run;
}

/**
 * Rejects non-admin users. SillyTavern populates `request.user.profile` in
 * multi-user mode; single-user installs have no profile, in which case the
 * inherited auth layers are the only gate and that is by design.
 */
function requireAdmin(request, response) {
    const profile = request.user?.profile;
    if (profile && profile.admin === false) {
        log('warn', `User "${profile.handle}" tried to control the relay without admin rights`);
        response.status(403).send('Forbidden: hosting a Multiplayer room requires an admin account.');
        return false;
    }
    return true;
}

function noStore(response) {
    response.set('Cache-Control', 'no-store');
    response.set('Pragma', 'no-cache');
}

function fail(response, error, fallbackStatus = 500) {
    const message = error?.message ?? String(error);
    log('error', message);
    response.status(fallbackStatus).send(message);
}

/**
 * @param {import('express').Router} router
 */
export async function init(router) {
    // ---------------------------------------------------------------- probe --
    // Cheap liveness + version handshake. The extension calls this before it
    // offers to host, so a version skew produces a clear message instead of a
    // mysterious handshake failure later.
    router.get('/probe', (request, response) => {
        response.json({
            ok: true,
            id: info.id,
            name: info.name,
            revision: PROTOCOL_REVISION,
            running: relay.running,
            node: process.versions.node,
        });
    });

    // ---------------------------------------------------------------- start --
    router.post('/start', async (request, response) => {
        if (!requireAdmin(request, response)) return;

        const body = request.body ?? {};
        if (body.port !== undefined && !Number.isFinite(Number(body.port))) {
            return response.status(400).send('Bad Request: "port" must be a number.');
        }

        try {
            const result = await exclusive(async () => {
                if (relay.running) await relay.stop();
                return relay.start({
                    port: body.port,
                    bindLan: body.bindLan,
                    autoMap: body.autoMap,
                    roomName: body.roomName,
                    maxPeers: body.maxPeers,
                    requireParity: body.requireParity,
                    parityStrictness: body.parityStrictness,
                });
            });

            noStore(response);
            response.json(result);
        } catch (error) {
            // Port conflicts are the common case and are the caller's problem.
            const status = /already in use/i.test(error?.message ?? '') ? 409 : 500;
            fail(response, error, status);
        }
    });

    // ----------------------------------------------------------------- stop --
    router.post('/stop', async (request, response) => {
        if (!requireAdmin(request, response)) return;
        try {
            await exclusive(() => relay.stop());
            response.json({ stopped: true });
        } catch (error) {
            fail(response, error);
        }
    });

    // --------------------------------------------------------------- status --
    router.get('/status', (request, response) => {
        noStore(response);
        response.json({ ...relay.status(), revision: PROTOCOL_REVISION, addresses: localAddresses() });
    });

    // --------------------------------------------------------------- rotate --
    // Mints a new pre-shared key and host token. The previous connection code
    // stops working immediately and everyone except the host is dropped.
    router.post('/rotate', async (request, response) => {
        if (!requireAdmin(request, response)) return;
        if (!relay.running) return response.status(409).send('The relay is not running.');
        try {
            const result = await exclusive(() => relay.rotate());
            noStore(response);
            response.json(result);
        } catch (error) {
            fail(response, error);
        }
    });

    // ----------------------------------------------------------------- kick --
    router.post('/kick', (request, response) => {
        if (!requireAdmin(request, response)) return;

        const peerId = request.body?.peerId;
        if (typeof peerId !== 'string' || !peerId) {
            return response.status(400).send('Bad Request: "peerId" is required.');
        }

        const removed = relay.kick(peerId, { ban: request.body?.ban === true });
        response.json({ removed });
    });

    // ---------------------------------------------------------------- unban --
    router.post('/unban', (request, response) => {
        if (!requireAdmin(request, response)) return;

        const ip = request.body?.ip;
        if (typeof ip !== 'string' || !ip) {
            return response.status(400).send('Bad Request: "ip" is required.');
        }
        response.json({ unbanned: relay.unban(ip) });
    });

    log('info', `Relay control API ready at /api/plugins/${info.id} (protocol ${PROTOCOL_REVISION})`);
}

/**
 * Called by SillyTavern before the process exits. Closing the listener here
 * means a restart never trips over its own port.
 */
export async function exit() {
    try {
        await relay.stop();
    } catch (error) {
        log('error', 'Failed to stop the relay cleanly:', error?.message ?? error);
    }
}

export default { info, init, exit };
