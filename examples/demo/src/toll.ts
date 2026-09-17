import { sqliteLedger } from '@tollstile/sqlite';
import { createTollstile, memoryBalance, testRail, type Tollstile, type Rail } from 'tollstile';

export type Env = {
  readonly DB: D1Database;
  /** One Durable Object per MCP session: approval needs the client's answer to reach the server that asked. */
  readonly MCP_SESSIONS: DurableObjectNamespace;
  /** Paid calls and MCP, per IP. The test rail makes paying free, so without this one script could fill the ledger. */
  readonly CALLS: RateLimit;
  /** The page's own polling and the published catalogue, per IP. Counted apart so a tab left open does not spend the calls. */
  readonly READS: RateLimit;
  /** Signs quotes. Set with `wrangler secret put TOLLSTILE_SECRET`; quotes must verify across isolates. */
  readonly TOLLSTILE_SECRET: string;
};

/** Prepaid credits for the demo's "member" key. In memory, so they reset when an isolate does — a real deployment keeps balances in its own database. */
export const credits = memoryBalance({ demo_member: '$5.00' });

/**
 * A dollar the demo gives every visitor, so a tool can be tried without paying for it. Spending it
 * still asks: money that is not yours to take quietly is the point, not the price.
 */
export const guests = memoryBalance({ demo_guest: '$1.00' });

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
  // The public ledger table prints charge ids, so a result keyed by one would be anyone's to read.
  // The key is a secret the payer alone receives, in `already_paid`; the charge id is kept beside it.
  const key = Array.from(crypto.getRandomValues(new Uint8Array(18)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  await env.DB.prepare('INSERT OR REPLACE INTO demo_results (id, charge_id, content, created_at) VALUES (?, ?, ?, ?)')
    .bind(key, chargeId, content, Date.now())
    .all();
  return `results/${key}`;
}

export async function readResult(env: Env, id: string): Promise<string | undefined> {
  const { results } = await env.DB.prepare('SELECT content FROM demo_results WHERE id = ?').bind(id).all<{ content: string }>();
  return results[0]?.content;
}

/**
 * Records that a client connected, and what it declared it can do. Nothing about who is using it
 * and nothing it sent: a name, a version, and the capabilities object from `initialize`.
 */
export async function noteClient(
  env: Env,
  client: { readonly name: string; readonly version: string } | undefined,
  capabilities: unknown,
  protocol: string,
): Promise<void> {
  const name = client?.name ?? 'unknown';
  const version = client?.version ?? 'unknown';
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO demo_clients (id, name, version, protocol, capabilities, first_seen, last_seen, connections)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen, capabilities = excluded.capabilities,
       protocol = excluded.protocol, connections = demo_clients.connections + 1`,
  )
    .bind(`${name}@${version}`, name, version, protocol, JSON.stringify(capabilities ?? {}), now, now)
    .all();
}
