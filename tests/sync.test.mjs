/**
 * Extension sync tests.
 *
 * The sync path had a hole that produced no error and no result: the parity
 * report stripped `homePage`, and `remoteUrl` was only ever populated in the
 * non-default strictness mode. So `buildSyncPlan` had no URL for anything, every
 * entry became an "install this yourself" step, and pressing Sync appeared to
 * work while installing nothing.
 *
 * These tests pin down the whole chain: what the report carries, what URLs are
 * accepted, what plan comes out, and what `applyPlan` actually calls.
 *
 * Run with:  node tests/sync.test.mjs
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const parity = await import(path.join(root, 'lib/parity.js'));
const { buildSyncPlan, diffReports, applyPlan, normaliseInstallUrl, summarisePlan } = parity;

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

/** An entry as it arrives over the wire in the default (manifest) mode. */
const entry = (id, over = {}) => ({
    id,
    displayName: id,
    version: '1.0.0',
    commit: '',
    branch: '',
    remoteUrl: '',
    homePage: `https://github.com/someone/${id}`,
    ...over,
});

const report = (extensions, strictness = 'manifest') => ({
    strictness,
    hash: 'x',
    extensions,
});

console.log('\nURL selection');

await test('a manifest homePage is enough to install from', () => {
    // The regression: with no remoteUrl, homePage has to carry the sync.
    const url = normaliseInstallUrl('', 'https://github.com/someone/Cool-Extension');
    assert.equal(url, 'https://github.com/someone/Cool-Extension');
});

await test('a real git remote wins over the manifest homePage', () => {
    const url = normaliseInstallUrl('https://github.com/fork/Cool-Extension.git', 'https://github.com/someone/Cool-Extension');
    assert.equal(url, 'https://github.com/fork/Cool-Extension');
});

await test('a /tree/branch link is trimmed to something cloneable', () => {
    assert.equal(
        normaliseInstallUrl('https://github.com/someone/Repo/tree/main'),
        'https://github.com/someone/Repo');
    assert.equal(
        normaliseInstallUrl('https://github.com/someone/Repo/blob/dev/README.md'),
        'https://github.com/someone/Repo');
});

await test('.git suffixes, trailing slashes, queries and fragments are dropped', () => {
    for (const input of [
        'https://github.com/someone/Repo.git',
        'https://github.com/someone/Repo/',
        'https://github.com/someone/Repo?tab=readme',
        'https://github.com/someone/Repo#install',
        'https://github.com/someone/Repo.git/',
    ]) {
        assert.equal(normaliseInstallUrl(input), 'https://github.com/someone/Repo', input);
    }
});

await test('URLs installExtension would reject count as no URL', () => {
    // ST refuses anything that is not http/https, so handing it these would
    // fail at install time rather than being reported as unresolvable.
    for (const input of [
        'discord.gg/abcdef', 'https://discord.gg', 'git@github.com:someone/Repo.git',
        'ftp://example.com/repo', 'javascript:alert(1)', 'not a url', '', null, undefined,
        'https://github.com', 'https://github.com/',
    ]) {
        assert.equal(normaliseInstallUrl(input), '', `${input} should not be treated as installable`);
    }
});

await test('falls through candidates until one is usable', () => {
    assert.equal(
        normaliseInstallUrl('', 'not a url', 'https://github.com/x/y'),
        'https://github.com/x/y');
});

console.log('\nPlan construction');

await test('a missing extension with only a homePage becomes a real install step', () => {
    // This is the exact case that used to produce nothing at all.
    const diff = diffReports(report([entry('Ext-A'), entry('Ext-B')]), report([entry('Ext-A')]));
    assert.equal(diff.ok, false);
    assert.equal(diff.missing.length, 1);

    const plan = buildSyncPlan(diff);
    assert.equal(plan.length, 1);
    assert.equal(plan[0].action, 'install', 'the step should install, not defer to the user');
    assert.equal(plan[0].url, 'https://github.com/someone/Ext-B');
});

await test('an entry with no usable URL is reported as manual, with a reason', () => {
    const hostReport = report([entry('Ext-A'), entry('Mystery', { homePage: '', remoteUrl: '' })]);
    const diff = diffReports(hostReport, report([entry('Ext-A')]));
    const plan = buildSyncPlan(diff);

    assert.equal(plan[0].action, 'manual');
    assert.ok(plan[0].note.length > 20, 'the manual step should explain itself');
});

await test('a version difference becomes a reinstall pinned to the branch', () => {
    const hostReport = report([entry('Ext-A', { version: '2.0.0', branch: 'main' })]);
    const clientReport = report([entry('Ext-A', { version: '1.0.0' })]);
    const plan = buildSyncPlan(diffReports(hostReport, clientReport));

    assert.equal(plan.length, 1);
    assert.equal(plan[0].action, 'reinstall');
    assert.equal(plan[0].from, '1.0.0');
    assert.equal(plan[0].to, '2.0.0');
    assert.equal(plan[0].branch, 'main');
});

await test('extras are disabled by default and only deleted on request', () => {
    const diff = diffReports(report([entry('Ext-A')]), report([entry('Ext-A'), entry('Extra')]));
    assert.equal(buildSyncPlan(diff)[0].action, 'disable');
    assert.equal(buildSyncPlan(diff, { removeExtras: true })[0].action, 'delete');
});

await test('summarisePlan describes a mixed plan', () => {
    const hostReport = report([entry('A'), entry('B'), entry('C', { version: '2.0.0' })]);
    const clientReport = report([entry('A'), entry('C', { version: '1.0.0' }), entry('D')]);
    const summary = summarisePlan(buildSyncPlan(diffReports(hostReport, clientReport)));
    assert.match(summary, /1 to install/);
    assert.match(summary, /1 to update/);
    assert.match(summary, /1 to disable/);
});

console.log('\nWhat applyPlan actually calls');

/** Records every call the plan makes into SillyTavern's extension API. */
function recordingApi({ failOn = null } = {}) {
    const calls = [];
    return {
        calls,
        installExtension: async (url, global, branch) => {
            calls.push({ fn: 'install', url, global, branch });
            if (failOn === 'install') throw new Error('clone failed');
        },
        deleteExtension: async (name, clean) => {
            calls.push({ fn: 'delete', name, clean });
            if (failOn === 'delete') throw new Error('delete failed');
        },
        disableExtension: async (name, reload) => {
            calls.push({ fn: 'disable', name, reload });
        },
        enableExtension: async () => {},
    };
}

await test('install passes the URL, non-global, and the branch', async () => {
    const api = recordingApi();
    const diff = diffReports(report([entry('Ext-B', { branch: 'dev' })]), report([]));
    const results = await applyPlan(buildSyncPlan(diff), api);

    assert.deepEqual(api.calls, [{
        fn: 'install', url: 'https://github.com/someone/Ext-B', global: false, branch: 'dev',
    }]);
    assert.equal(results[0].status, 'done');
});

await test('delete is called with a leading slash so hooks resolve', async () => {
    // deleteExtension builds its hook name as 'third-party' + name with no
    // separator, so a bare folder name silently skips the extension's own
    // delete hook. SillyTavern's own UI passes "/Name".
    const api = recordingApi();
    const diff = diffReports(report([entry('A')]), report([entry('A'), entry('Extra')]));
    await applyPlan(buildSyncPlan(diff, { removeExtras: true }), api);

    const call = api.calls.find(c => c.fn === 'delete');
    assert.equal(call.name, '/Extra');
    assert.equal(call.clean, true, 'an explicit delete should also clean up data');
});

await test('reinstall deletes then installs, in that order', async () => {
    const api = recordingApi();
    const hostReport = report([entry('A', { version: '2.0.0', branch: 'main' })]);
    const clientReport = report([entry('A', { version: '1.0.0' })]);
    await applyPlan(buildSyncPlan(diffReports(hostReport, clientReport)), api);

    assert.deepEqual(api.calls.map(c => c.fn), ['delete', 'install']);
    assert.equal(api.calls[0].name, '/A');
    assert.equal(api.calls[0].clean, false, 'an update must not wipe the extension\'s data');
});

await test('disable uses the full third-party name', async () => {
    // disabledExtensions is keyed by the full name, so a bare one would not
    // actually disable anything.
    const api = recordingApi();
    const diff = diffReports(report([entry('A')]), report([entry('A'), entry('Extra')]));
    await applyPlan(buildSyncPlan(diff), api);

    const call = api.calls.find(c => c.fn === 'disable');
    assert.equal(call.name, 'third-party/Extra');
});

await test('a failing step is reported and the rest still run', async () => {
    const api = recordingApi({ failOn: 'install' });
    const hostReport = report([entry('A'), entry('B'), entry('C')]);
    const results = await applyPlan(buildSyncPlan(diffReports(hostReport, report([]))), api);

    assert.equal(results.length, 3);
    assert.ok(results.every(r => r.status === 'failed'));
    assert.equal(results[0].error, 'clone failed');
    assert.equal(api.calls.length, 3, 'one failure must not abandon the remaining steps');
});

await test('manual steps are skipped without calling anything', async () => {
    const api = recordingApi();
    const hostReport = report([entry('Mystery', { homePage: '', remoteUrl: '' })]);
    const results = await applyPlan(buildSyncPlan(diffReports(hostReport, report([]))), api);

    assert.equal(results[0].status, 'skipped');
    assert.deepEqual(api.calls, []);
});

await test('progress is reported for every step', async () => {
    const api = recordingApi();
    const hostReport = report([entry('A'), entry('B')]);
    const seen = [];
    await applyPlan(buildSyncPlan(diffReports(hostReport, report([]))), api,
        progress => seen.push(`${progress.index}:${progress.status}`));

    assert.ok(seen.includes('0:running'));
    assert.ok(seen.includes('0:done'));
    assert.ok(seen.includes('1:done'));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
