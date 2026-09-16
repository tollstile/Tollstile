import { sqliteLedger } from '@tollstile/sqlite';
import { createTollstile, memoryBalance, testRail, type Tollstile, type Rail } from 'tollstile';

export type Env = {
  readonly DB: D1Database;
  /** One Durable Object per MCP session: approval needs the client's answer to reach the server that asked. */
  readonly MCP_SESSIONS: DurableObjectNamespace;
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

/** Keeps what a paid call produced. `already_paid` hands a retry this reference; `GET /v1/results/:id` serves it. */
export async function keepResult(env: Env, chargeId: string, content: string): Promise<string> {
  await env.DB.prepare('INSERT OR REPLACE INTO demo_results (id, content, created_at) VALUES (?, ?, ?)')
    .bind(chargeId, content, Date.now())
    .all();
  return `results/${chargeId}`;
}

export async function readResult(env: Env, id: string): Promise<string | undefined> {
  const { results } = await env.DB.prepare('SELECT content FROM demo_results WHERE id = ?').bind(id).all<{ content: string }>();
  return results[0]?.content;
}
