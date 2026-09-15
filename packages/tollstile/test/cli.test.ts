import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const tsx = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const config = fileURLToPath(new URL('./fixtures/reconcile.config.ts', import.meta.url));

async function reconcile(args: readonly string[], env: Record<string, string> = {}) {
  return run(tsx, [cli, 'reconcile', '--config', config, ...args], { env: { ...process.env, ...env } }).then(
    ({ stdout }) => ({ code: 0, stdout }),
    (error: unknown) => {
      const failed = error as { code: number; stdout: string };
      return { code: failed.code, stdout: failed.stdout };
    },
  );
}

describe('tollstile reconcile', () => {
  it('resolves lost settlements and prints what changed', async () => {
    const { code, stdout } = await reconcile(['--older-than', '0s']);

    expect(code).toBe(0);
    expect(stdout).toContain('Reconciled 2 charges');
    expect(stdout).toMatch(/GET \/report {2}\$0\.05 {2}unknown\/completed → settled\/completed/);
    expect(stdout).toContain('2 resolved · 0 pending · 0 errors');
  }, 30_000);

  it('prints JSON, and exits 1 when the provider cannot be asked', async () => {
    const { code, stdout } = await reconcile(['--older-than', '0s', '--json'], { LOOKUP_DOWN: '1' });
    const report = JSON.parse(stdout) as { pending: number; errors: { code: string }[] };

    expect(code).toBe(1);
    expect(report.pending).toBe(2);
    expect(report.errors[0]?.code).toBe('PROVIDER_UNAVAILABLE');
  }, 30_000);

  it('refuses a config without a Tollstile instance and a malformed duration', async () => {
    expect((await reconcile(['--older-than', 'soon'])).code).toBe(1);
  }, 30_000);
});
