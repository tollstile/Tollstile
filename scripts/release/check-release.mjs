// Refuses a release that would publish packages users cannot install.
//
//   node scripts/release/check-release.mjs [--tag v0.1.1] [--registry]
//
// Without --registry: every package has the same version (matching --tag when given), and every
// dependency or peer on a workspace package points at a package in the same release.
// With --registry: every package@version in the release is installable from npm right now.
import { execFileSync } from 'node:child_process';
import { publishablePackages } from './packages.mjs';

const args = process.argv.slice(2);
const tag = args.includes('--tag') ? args[args.indexOf('--tag') + 1] : undefined;
const registry = args.includes('--registry');
const packages = publishablePackages();
const names = new Set(packages.map(({ manifest }) => manifest.name));
const problems = [];

const versions = new Set(packages.map(({ manifest }) => manifest.version));
if (versions.size !== 1) {
  problems.push(`Packages release together but have different versions: ${packages.map(({ manifest }) => `${manifest.name}@${manifest.version}`).join(', ')}`);
}
const [version] = versions;
if (tag !== undefined && tag !== `v${version}`) problems.push(`Tag ${tag} does not match the package version ${version}.`);

for (const { manifest } of packages) {
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [dependency, range] of Object.entries(manifest[field] ?? {})) {
      if (!String(range).startsWith('workspace:')) continue;
      if (!names.has(dependency)) {
        problems.push(`${manifest.name} ${field} "${dependency}" is a workspace package that is not published. Users could never install it.`);
      }
    }
  }
}

if (registry) {
  for (const { manifest } of packages) {
    const spec = `${manifest.name}@${manifest.version}`;
    const found = npmView(spec);
    if (found !== manifest.version) problems.push(`${spec} is not installable from npm (npm view returned ${found === '' ? 'nothing' : found}).`);
  }
}

if (problems.length > 0) {
  console.error(`Release check failed:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
  process.exit(1);
}
console.log(`Release check passed: ${String(packages.length)} packages at ${String(version)}${registry ? ', all installable from npm' : ''}.`);

function npmView(spec) {
  try {
    return execFileSync('npm', ['view', spec, 'version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}
