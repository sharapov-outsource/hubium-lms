// Fails when an installed package carries a license policy.json does not accept. Run from
// anywhere: `pnpm licenses:check` at the repository root.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { satisfies } from './spdx.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const policy = JSON.parse(readFileSync(resolve(here, 'policy.json'), 'utf8'));
const production = new Set(policy.production.accepted);
const tooling = new Set([...production, ...policy.tooling.accepted]);

/** Every package pnpm reports, once per license (versions of a package may differ). */
function installed(prodOnly) {
  const args = ['licenses', 'list', '--json', '--recursive', ...(prodOnly ? ['--prod'] : [])];
  const out = execFileSync('pnpm', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  return Object.entries(JSON.parse(out)).flatMap(([license, list]) =>
    list.map((p) => ({ name: p.name, versions: p.versions, license })),
  );
}

function accepted(license, set) {
  try {
    return satisfies(license, set);
  } catch {
    return false; // not an SPDX expression ("SEE LICENSE IN …", "Unknown")
  }
}

const prod = new Set(installed(true).map((p) => p.name));
const all = installed(false);
const problems = [];
const used = new Set();

for (const p of all) {
  const scope = prod.has(p.name) ? 'production' : 'tooling';
  if (accepted(p.license, scope === 'production' ? production : tooling)) continue;
  const exception = policy.exceptions[p.name];
  if (exception && exception.license === p.license) {
    used.add(p.name);
    continue;
  }
  problems.push({ ...p, scope });
}

for (const name of Object.keys(policy.exceptions)) {
  if (!used.has(name)) console.warn(`warning: exception for ${name} no longer applies; remove it`);
}

if (problems.length) {
  console.error('Licenses not accepted by tools/licenses/policy.json:\n');
  for (const p of problems.sort((a, b) => a.name.localeCompare(b.name))) {
    console.error(`  ${p.name}@${p.versions.join(', ')}  ${p.license}  (${p.scope})`);
  }
  console.error(
    '\nFind who pulls a package in with `pnpm why <name> -r`. Replace it, or, once the license' +
      ' is checked, add it to policy.json (accepted licenses or a package exception with a reason).',
  );
  process.exit(1);
}

const licenses = new Set(all.filter((p) => prod.has(p.name)).map((p) => p.license));
console.log(
  `Licenses OK: ${prod.size} production packages under ${licenses.size} licenses, ` +
    `${new Set(all.map((p) => p.name)).size - prod.size} tooling packages.`,
);
