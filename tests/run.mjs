/** Run each suite in a fresh process: old suites mutate globals and bind test ports. */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const suites = readdirSync(path.join(root, 'tests')).filter(name => name.endsWith('.test.mjs') && name !== 'hunt.test.mjs').sort();
let failed = 0;
for (const name of suites) {
    console.log(`\n========== ${name} ==========\n`);
    const result = spawnSync(process.execPath, [path.join('tests', name)], { cwd: root, stdio: 'inherit', timeout: 120000 });
    if (result.error || result.status !== 0) {
        failed++;
        console.error(`${name} FAILED: ${result.error?.message ?? `exit ${result.status}`}`);
    }
}
console.log(`\n${suites.length - failed}/${suites.length} regression suites passed.`);
process.exitCode = failed ? 1 : 0;
