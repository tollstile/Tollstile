import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scaffold } from '../src/scaffold';

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'create-tollstile-'));
}

describe('create-tollstile', () => {
  it('creates a runnable Hono project with a paid route and a test agent', async () => {
    const directory = join(await temporaryDirectory(), 'weather-api');
    const result = await scaffold(directory, 'weather-api');

    expect(result).toEqual({
      status: 'created',
      files: ['package.json', 'tsconfig.json', 'src/toll.ts', 'src/server.ts', 'src/agent.ts', 'README.md', '.gitignore'],
    });

    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { name: string };
    expect(manifest.name).toBe('weather-api');
    expect(await readFile(join(directory, 'src/server.ts'), 'utf8')).toContain('tollstile(toll.price("$0.01"))');
    expect(await readFile(join(directory, 'src/agent.ts'), 'utf8')).toContain('payment: "test"');
  });

  it('refuses to write into a non-empty directory', async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, 'existing.txt'), 'keep me');

    expect(await scaffold(directory, 'existing')).toEqual({ status: 'not_empty' });
  });

  it('refuses invalid package names', async () => {
    const directory = join(await temporaryDirectory(), 'Bad Name');
    const result = await scaffold(directory, 'Bad Name');

    expect(result.status).toBe('invalid_name');
  });
});
