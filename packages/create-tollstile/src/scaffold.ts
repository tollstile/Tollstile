import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { honoTemplate } from './templates';

export type ScaffoldResult =
  | { readonly status: 'created'; readonly files: readonly string[] }
  | { readonly status: 'not_empty' }
  | { readonly status: 'invalid_name'; readonly reason: string };

const PACKAGE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

export async function scaffold(directory: string, name: string): Promise<ScaffoldResult> {
  if (!PACKAGE_NAME.test(name)) {
    return { status: 'invalid_name', reason: `"${name}" is not a valid npm package name. Use lowercase letters, digits, and dashes.` };
  }
  if ((await listDirectory(directory)).length > 0) return { status: 'not_empty' };

  const files = honoTemplate(name);
  for (const file of files) {
    const target = join(directory, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.contents, { flag: 'wx' });
  }
  return { status: 'created', files: files.map((file) => file.path) };
}

async function listDirectory(directory: string): Promise<readonly string[]> {
  await mkdir(directory, { recursive: true });
  return readdir(directory);
}
