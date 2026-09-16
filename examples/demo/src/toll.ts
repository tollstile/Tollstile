import { sqliteLedger } from '@tollstile/sqlite';
import { createTollstile, memoryBalance, testRail, type Tollstile, type Rail } from 'tollstile';

export type Env = {
  readonly DB: D1Database;
  /** Signs quotes. Set with `wrangler secret put TOLLSTILE_SECRET`; quotes must verify across isolates. */
  readonly TOLLSTILE_SECRET: string;
};

/** Prepaid credits for the demo's "member" key. In memory, so they reset when an isolate does — a real deployment keeps balances in its own database. */
export const credits = memoryBalance({ demo_member: '$5.00' });

/**
 * One Tollstile instance per request. The rail is the test rail, so anyone can pay here with a
 * header instead of a wallet; the ledger is the real SQLite ledger on D1.
 */
export function createToll(env: Env): Tollstile<readonly Rail[]> {
  return createTollstile({
    rails: [testRail()],
    ledger: sqliteLedger({
      execute: async (sql, params) => (await env.DB.prepare(sql).bind(...params).all()).results,
      transaction: async (statements) =>
        (await env.DB.batch(statements.map(({ sql, params }) => env.DB.prepare(sql).bind(...params)))).map((result) => result.results),
    }),
    secret: env.TOLLSTILE_SECRET,
  });
}
