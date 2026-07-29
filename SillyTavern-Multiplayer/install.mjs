#!/usr/bin/env node
/**
 * Installer for the server half of SillyTavern-Multiplayer.
 *
 * The UI extension is installed the normal way (Extensions -> Install from URL),
 * which drops this folder into SillyTavern's extensions directory. The relay,
 * though, has to live in SillyTavern's `plugins/` directory to be loaded by its
 * plugin loader. Rather than asking people to copy files around, this script
 * links `./server` into `<SillyTavern>/plugins/st-multiplayer`.
 *
 * Usage, from inside this extension's folder:
 *
 *   node install.mjs                 # find SillyTavern, link, report on config
 *   node install.mjs --root /path    # point at SillyTavern explicitly
 *   node install.mjs --copy          # copy instead of symlink (Windows, Docker)
 *   node install.mjs --enable        # also set enableServerPlugins in config.yaml
 *   node install.mjs --uninstall     # remove the link again
 *
 * Nothing here touches SillyTavern's own files unless --enable is passed, and
 * even then it makes a timestamped backup of config.yaml first.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR_NAME = 'st-multiplayer';

const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const option = name => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : null;
};

const colour = {
    ok: text => `\x1b[32m${text}\x1b[0m`,
    warn: text => `\x1b[33m${text}\x1b[0m`,
    bad: text => `\x1b[31m${text}\x1b[0m`,
    dim: text => `\x1b[2m${text}\x1b[0m`,
};

const say = (...parts) => console.log(...parts);
const fail = message => {
    console.error(`\n${colour.bad('✗')} ${message}\n`);
    process.exit(1);
};

/** A directory looks like SillyTavern if it has server.js and a package.json saying so. */
function looksLikeSillyTavern(directory) {
    try {
        if (!fs.existsSync(path.join(directory, 'server.js'))) return false;
        const manifestPath = path.join(directory, 'package.json');
        if (!fs.existsSync(manifestPath)) return false;
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        return String(manifest.name ?? '').toLowerCase() === 'sillytavern';
    } catch {
        return false;
    }
}

/**
 * Walks up from this extension's folder. This works for both install layouts:
 *   data/<user>/extensions/SillyTavern-Multiplayer      (per-user)
 *   public/scripts/extensions/third-party/SillyTavern-… (global)
 */
function findSillyTavernRoot() {
    const explicit = option('root');
    if (explicit) {
        const resolved = path.resolve(explicit);
        if (!looksLikeSillyTavern(resolved)) fail(`${resolved} does not look like a SillyTavern installation.`);
        return resolved;
    }

    let current = HERE;
    for (let depth = 0; depth < 10; depth++) {
        if (looksLikeSillyTavern(current)) return current;
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }

    fail('Could not find your SillyTavern folder by walking up from this directory.\n'
        + '  Pass it explicitly:  node install.mjs --root /path/to/SillyTavern');
}

function copyDirectory(from, to) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const source = path.join(from, entry.name);
        const target = path.join(to, entry.name);
        if (entry.isDirectory()) copyDirectory(source, target);
        else if (entry.isFile()) fs.copyFileSync(source, target);
    }
}

function link(serverSource, target) {
    if (flag('copy')) {
        copyDirectory(serverSource, target);
        return 'copied';
    }
    try {
        // "junction" is the only symlink type Windows allows without elevation.
        fs.symlinkSync(serverSource, target, process.platform === 'win32' ? 'junction' : 'dir');
        return 'linked';
    } catch (error) {
        say(colour.warn(`  Could not create a link (${error.code}); copying instead.`));
        copyDirectory(serverSource, target);
        return 'copied';
    }
}

function removeExisting(target) {
    let stats;
    try {
        stats = fs.lstatSync(target);
    } catch {
        return false;
    }
    if (stats.isSymbolicLink()) fs.unlinkSync(target);
    else fs.rmSync(target, { recursive: true, force: true });
    return true;
}

/** Reports on (and optionally sets) enableServerPlugins in config.yaml. */
function handleConfig(root) {
    const configPath = path.join(root, 'config.yaml');

    if (!fs.existsSync(configPath)) {
        say(colour.warn('  config.yaml not found — SillyTavern writes it on first run.'));
        say(colour.dim('    After starting it once, set: enableServerPlugins: true'));
        return;
    }

    const original = fs.readFileSync(configPath, 'utf8');
    const match = /^enableServerPlugins:\s*(\S+)\s*$/m.exec(original);

    if (match && /^true$/i.test(match[1])) {
        say(`${colour.ok('✓')} enableServerPlugins is already true`);
        return;
    }

    if (!flag('enable')) {
        say(colour.warn('! Server plugins are disabled, so the relay will not load.'));
        say(colour.dim(`    Edit ${configPath} and set:  enableServerPlugins: true`));
        say(colour.dim('    Or re-run:  node install.mjs --enable'));
        return;
    }

    const backup = `${configPath}.multiplayer-backup-${Date.now()}`;
    fs.copyFileSync(configPath, backup);

    const updated = match
        ? original.replace(/^enableServerPlugins:\s*\S+\s*$/m, 'enableServerPlugins: true')
        : `${original.replace(/\s*$/, '')}\n\n# Added by SillyTavern-Multiplayer\nenableServerPlugins: true\n`;

    fs.writeFileSync(configPath, updated, 'utf8');
    say(`${colour.ok('✓')} Set enableServerPlugins: true  ${colour.dim(`(backup: ${path.basename(backup)})`)}`);
}

/** The relay needs `ws`, which SillyTavern 1.13+ already depends on. */
function checkWs(root) {
    try {
        createRequire(path.join(root, 'package.json')).resolve('ws');
        say(`${colour.ok('✓')} The "ws" package resolves from your SillyTavern install`);
    } catch {
        say(colour.warn('! The "ws" package could not be resolved.'));
        say(colour.dim(`    Run:  cd "${root}" && npm install ws`));
    }
}

// ---------------------------------------------------------------------------

say('\nSillyTavern-Multiplayer — server plugin installer\n');

const root = findSillyTavernRoot();
const pluginsDir = path.join(root, 'plugins');
const target = path.join(pluginsDir, PLUGIN_DIR_NAME);
const serverSource = path.join(HERE, 'server');

say(`${colour.dim('SillyTavern:')} ${root}`);
say(`${colour.dim('Extension:  ')} ${HERE}\n`);

if (flag('uninstall')) {
    if (removeExisting(target)) say(`${colour.ok('✓')} Removed ${target}`);
    else say(colour.dim(`  Nothing to remove at ${target}`));
    say('\nRestart SillyTavern to release the port.\n');
    process.exit(0);
}

if (!fs.existsSync(serverSource)) {
    fail(`Expected the relay source at ${serverSource}, but it is missing.\n`
        + '  Re-install the extension so the whole repository is present.');
}

fs.mkdirSync(pluginsDir, { recursive: true });

if (removeExisting(target)) say(colour.dim(`  Replaced the previous install at ${target}`));

const mode = link(serverSource, target);
say(`${colour.ok('✓')} Relay ${mode} to ${target}`);
if (mode === 'copied') {
    say(colour.dim('    Copies do not track updates. Re-run this script after updating the extension.'));
}

checkWs(root);
handleConfig(root);

say(`\n${colour.ok('Done.')} Restart SillyTavern, then open Extensions → Multiplayer.\n`);
say(colour.dim('If the panel says the server plugin is unavailable, check the SillyTavern'));
say(colour.dim('console for a line reading "Initializing plugin from …/plugins/st-multiplayer".\n'));
