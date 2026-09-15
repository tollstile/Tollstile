// The packages this repository publishes, read from the workspace. Shared by the release scripts.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const root = new URL('../../', import.meta.url).pathname;

/** Publishable packages (not private), with their manifests and directories. */
export function publishablePackages() {
  const dir = join(root, 'packages');
  return readdirSync(dir)
    .map((name) => ({ dir: join(dir, name), manifest: JSON.parse(readFileSync(join(dir, name, 'package.json'), 'utf8')) }))
    .filter(({ manifest }) => manifest.private !== true);
}
