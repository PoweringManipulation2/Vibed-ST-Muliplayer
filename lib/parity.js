/**
 * Extension parity.
 *
 * Two people running different extension sets produce different prompts,
 * different macros and different regex post-processing, so the same chat
 * renders differently on each screen. The relay therefore fingerprints every
 * peer's enabled third-party extensions and refuses to seat a peer whose
 * fingerprint does not match the host's.
 *
 * Two strictness levels:
 *   - "manifest" (default): name + version from each manifest.json. Instant,
 *     no network, and catches every practical mismatch.
 *   - "commit": additionally pins the git commit of each extension, using
 *     SillyTavern's /api/extensions/version endpoint. Exact, but each entry
 *     costs a `git fetch`, so results are cached.
 */

import { sha256 } from './crypto.js';

const encoder = new TextEncoder();

/** Cache for the expensive commit-level lookups: name -> {value, expiresAt}. */
const versionCache = new Map();
const VERSION_TTL_MS = 5 * 60 * 1000;

/**
 * Runs async jobs with bounded concurrency so a 30-extension install does not
 * fire 30 simultaneous `git fetch` calls at SillyTavern's backend.
 */
async function mapLimit(items, limit, worker) {
    const results = new Array(items.length);
    let cursor = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) {
            const index = cursor++;
            results[index] = await worker(items[index], index);
        }
    });
    await Promise.all(runners);
    return results;
}

/**
 * Collects the local extension set.
 * @param {object} deps injected SillyTavern module bindings
 * @param {'manifest'|'commit'} strictness
 */
export async function collectLocalExtensions(deps, strictness = 'manifest') {
    const { extensionNames, extensionTypes, getExtensionManifest, extension_settings, getRequestHeaders } = deps;

    const disabled = new Set(extension_settings?.disabledExtensions ?? []);
    const thirdParty = (extensionNames ?? []).filter(name => name.startsWith('third-party'));

    const entries = thirdParty.map(name => {
        const manifest = getExtensionManifest(name) ?? {};
        return {
            /** Folder name without the `third-party/` prefix — the join key. */
            id: name.replace(/^third-party[/\\]?/, ''),
            name,
            displayName: manifest.display_name ?? name,
            version: String(manifest.version ?? '0.0.0'),
            enabled: !disabled.has(name),
            global: extensionTypes?.[name] === 'global',
            homePage: manifest.homePage ?? '',
            commit: '',
            branch: '',
            remoteUrl: '',
        };
    });

    const enabled = entries.filter(entry => entry.enabled);

    if (strictness === 'commit') {
        await mapLimit(enabled, 4, async entry => {
            const cached = versionCache.get(entry.name);
            if (cached && cached.expiresAt > Date.now()) {
                Object.assign(entry, cached.value);
                return;
            }
            try {
                const response = await fetch('/api/extensions/version', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({ extensionName: entry.id, global: entry.global }),
                });
                if (!response.ok) return;
                const data = await response.json();
                const value = {
                    commit: String(data.currentCommitHash ?? '').slice(0, 12),
                    branch: String(data.currentBranchName ?? ''),
                    remoteUrl: String(data.remoteUrl ?? '').trim(),
                };
                Object.assign(entry, value);
                versionCache.set(entry.name, { value, expiresAt: Date.now() + VERSION_TTL_MS });
            } catch (error) {
                console.warn('[Multiplayer] Could not read version info for', entry.id, error);
            }
        });
    }

    return enabled.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Canonical fingerprint over the enabled set. Sorting plus a fixed field order
 * means two installs that agree produce byte-identical input to the hash.
 */
export async function fingerprint(entries, strictness = 'manifest') {
    const canonical = entries
        .map(entry => (strictness === 'commit'
            ? `${entry.id}@${entry.version}#${entry.commit}`
            : `${entry.id}@${entry.version}`))
        .sort()
        .join('\n');

    const digest = await sha256(encoder.encode(`${strictness}\u0000${canonical}`));
    return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Builds the payload a peer sends to the relay for comparison. */
export async function buildReport(deps, strictness) {
    const entries = await collectLocalExtensions(deps, strictness);
    return {
        strictness,
        hash: await fingerprint(entries, strictness),
        // homePage comes straight from each manifest.json and costs nothing to
        // read. It was previously dropped here, which left buildSyncPlan with no
        // URL at all in the default strictness mode — so every extension became
        // a "install this by hand" step and sync silently did nothing.
        extensions: entries.map(({ id, displayName, version, commit, branch, remoteUrl, homePage }) => ({
            id, displayName, version, commit, branch, remoteUrl, homePage,
        })),
    };
}

/**
 * Compares a client report against the host's.
 * @returns {{ok: boolean, missing: object[], extra: object[], mismatched: object[]}}
 */
export function diffReports(hostReport, clientReport) {
    const hostMap = new Map(hostReport.extensions.map(entry => [entry.id, entry]));
    const clientMap = new Map(clientReport.extensions.map(entry => [entry.id, entry]));
    const strict = hostReport.strictness === 'commit';

    const missing = [];
    const mismatched = [];
    for (const [id, hostEntry] of hostMap) {
        const clientEntry = clientMap.get(id);
        if (!clientEntry) {
            missing.push(hostEntry);
        } else if (clientEntry.version !== hostEntry.version || (strict && clientEntry.commit !== hostEntry.commit)) {
            mismatched.push({ ...hostEntry, clientVersion: clientEntry.version, clientCommit: clientEntry.commit });
        }
    }

    const extra = [...clientMap.values()].filter(entry => !hostMap.has(entry.id));

    return {
        ok: missing.length === 0 && extra.length === 0 && mismatched.length === 0,
        missing, extra, mismatched,
    };
}

/**
 * Turns a diff into an ordered, human-readable action plan.
 * Nothing is executed here — {@link applyPlan} does that after the user agrees.
 */
/**
 * Picks a URL that `installExtension` will actually accept.
 *
 * ST rejects anything that is not http/https, so a manifest `homePage` pointing
 * at a Discord invite has to count as "no URL" rather than be handed over to
 * fail. `/tree/branch` suffixes and trailing slashes are trimmed because a git
 * clone of those fails.
 */
export function normaliseInstallUrl(...candidates) {
    for (const candidate of candidates) {
        const raw = String(candidate ?? '').trim();
        if (!raw) continue;
        let parsed;
        try {
            parsed = new URL(raw);
        } catch {
            continue;
        }
        if (!['http:', 'https:'].includes(parsed.protocol)) continue;

        parsed.pathname = parsed.pathname
            .replace(/\/(tree|blob)\/[^/]+\/?.*$/, '')
            .replace(/\.git\/?$/, '')
            .replace(/\/+$/, '');
        parsed.hash = '';
        parsed.search = '';
        if (!parsed.pathname || parsed.pathname === '/') continue;
        return parsed.toString();
    }
    return '';
}

export function buildSyncPlan(diff, { removeExtras = false } = {}) {
    const steps = [];

    for (const entry of diff.missing) {
        const url = normaliseInstallUrl(entry.remoteUrl, entry.homePage);
        steps.push(url
            ? { action: 'install', id: entry.id, label: entry.displayName || entry.id, url, branch: entry.branch || '' }
            : { action: 'manual', id: entry.id, label: entry.displayName || entry.id, note: 'No installable URL is published — the manifest has no homePage and the host could not read its git remote. Install it by hand.' });
    }

    for (const entry of diff.mismatched) {
        const url = normaliseInstallUrl(entry.remoteUrl, entry.homePage);
        steps.push(url
            ? { action: 'reinstall', id: entry.id, label: entry.displayName || entry.id, url, branch: entry.branch || '', from: entry.clientVersion, to: entry.version }
            : { action: 'manual', id: entry.id, label: entry.displayName || entry.id, note: `Update from ${entry.clientVersion} to ${entry.version} manually.` });
    }

    for (const entry of diff.extra) {
        steps.push({
            action: removeExtras ? 'delete' : 'disable',
            id: entry.id,
            label: entry.displayName || entry.id,
        });
    }

    return steps;
}

/**
 * Executes a sync plan against SillyTavern's own extension APIs.
 *
 * "disable" is the default for extras because deleting someone's extension
 * folder to join a chat is not a reasonable default. Deletion only happens when
 * the user explicitly ticks the destructive option.
 *
 * @param {object[]} steps from {@link buildSyncPlan}
 * @param {object} deps injected SillyTavern bindings
 * @param {(progress: {index: number, total: number, step: object, status: string, error?: string}) => void} onProgress
 */
export async function applyPlan(steps, deps, onProgress = () => {}) {
    const { installExtension, deleteExtension, disableExtension } = deps;
    const results = [];

    for (const [index, step] of steps.entries()) {
        const report = status => onProgress({ index, total: steps.length, step, status });
        report('running');

        try {
            switch (step.action) {
                case 'install':
                    await installExtension(step.url, false, step.branch || '');
                    break;

                case 'reinstall':
                    // Delete then re-clone: the version endpoint pins a branch,
                    // and a plain `git pull` cannot move between branches.
                    // The leading slash matters: deleteExtension builds its hook
                    // name as `'third-party' + name` with no separator, so a bare
                    // folder name resolves to "third-partyFoo" and the extension's
                    // own delete hook never runs. SillyTavern's own UI passes
                    // "/Foo" for exactly this reason.
                    await deleteExtension(`/${step.id}`, false);
                    await installExtension(step.url, false, step.branch || '');
                    break;

                case 'disable':
                    await disableExtension(`third-party/${step.id}`, false);
                    break;

                case 'delete':
                    await deleteExtension(`/${step.id}`, true);
                    break;

                case 'manual':
                    results.push({ step, status: 'skipped' });
                    onProgress({ index, total: steps.length, step, status: 'skipped' });
                    continue;

                default:
                    throw new Error(`Unknown sync action "${step.action}"`);
            }
            results.push({ step, status: 'done' });
            report('done');
        } catch (error) {
            const message = error?.message ?? String(error);
            results.push({ step, status: 'failed', error: message });
            onProgress({ index, total: steps.length, step, status: 'failed', error: message });
        }
    }

    return results;
}

export function summarisePlan(steps) {
    const counts = steps.reduce((acc, step) => {
        acc[step.action] = (acc[step.action] ?? 0) + 1;
        return acc;
    }, {});
    const parts = [];
    if (counts.install) parts.push(`${counts.install} to install`);
    if (counts.reinstall) parts.push(`${counts.reinstall} to update`);
    if (counts.disable) parts.push(`${counts.disable} to disable`);
    if (counts.delete) parts.push(`${counts.delete} to delete`);
    if (counts.manual) parts.push(`${counts.manual} needing manual work`);
    return parts.join(', ') || 'nothing to change';
}

/**
 * Looks up the real git remote for specific extensions, on demand.
 *
 * `/api/extensions/version` runs a `git fetch` per extension, so calling it for
 * everything while a peer waits on the parity handshake would add seconds to
 * every join. Instead the host answers with manifest data immediately, and this
 * runs only when somebody actually presses Sync — at which point a few seconds
 * is fine and an accurate URL matters.
 *
 * @param {object} deps
 * @param {string[]} ids folder names to look up
 * @returns {Promise<Record<string, {remoteUrl: string, branch: string, commit: string}>>}
 */
export async function enrichRemotes(deps, ids) {
    const { extensionNames, extensionTypes, getRequestHeaders } = deps;
    const wanted = new Set(ids ?? []);
    const out = {};

    const targets = (extensionNames ?? [])
        .filter(name => name.startsWith('third-party'))
        .map(name => ({ name, id: name.replace(/^third-party[/\\]?/, '') }))
        .filter(entry => wanted.has(entry.id));

    await mapLimit(targets, 4, async entry => {
        const cached = versionCache.get(entry.name);
        if (cached && cached.expiresAt > Date.now()) {
            out[entry.id] = cached.value;
            return;
        }
        try {
            const response = await fetch('/api/extensions/version', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ extensionName: entry.id, global: extensionTypes?.[entry.name] === 'global' }),
            });
            if (!response.ok) return;
            const data = await response.json();
            const value = {
                remoteUrl: String(data.remoteUrl ?? '').trim(),
                branch: String(data.currentBranchName ?? ''),
                commit: String(data.currentCommitHash ?? '').slice(0, 12),
            };
            out[entry.id] = value;
            versionCache.set(entry.name, { value, expiresAt: Date.now() + VERSION_TTL_MS });
        } catch (error) {
            console.warn('[Multiplayer] Could not read the git remote for', entry.id, error);
        }
    });

    return out;
}

export function clearVersionCache() {
    versionCache.clear();
}
