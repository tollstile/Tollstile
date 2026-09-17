import type { Env } from './toll';

/**
 * Anyone can pay on this demo — the test rail makes it free — so every paid call is a ledger write
 * someone else chose to cause. A real deployment prices calls so that abuse costs the abuser; this one
 * cannot, so it counts them instead.
 */
export async function overLimit(request: Request, env: Env): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const limiter = pathname.startsWith('/v1/') || pathname === '/mcp' ? env.CALLS : pathname.startsWith('/api/') || pathname.startsWith('/.well-known/') ? env.READS : null;
  if (limiter === null) return null;

  const { success } = await limiter.limit({ key: request.headers.get('cf-connecting-ip') ?? 'unknown' });
  if (success) return null;
  // Shaped like a Tollstile denial, so a client that already backs off on one backs off on this.
  return Response.json(
    {
      error: {
        code: 'rate_limited',
        retryable: true,
        action: 'retry_later',
        message: 'Too many requests from this address. This is a public demo; try again in a minute.',
        detail: null,
      },
      retryAfter: 60,
    },
    { status: 429, headers: { 'retry-after': '60', 'cache-control': 'no-store' } },
  );
}

/** How long a finished charge stays visible on the page. */
export const RETENTION_MS = 24 * 60 * 60 * 1000;

const FINISHED = `(payment IN ('failed', 'released', 'refunded') OR (payment = 'settled' AND fulfillment = 'completed'))`;

/**
 * Deletes finished demo charges older than a day, with what hangs off them.
 *
 * Only safe here. A ledger is the record of what was charged and is not something to prune; this one
 * can be, because nothing on it is real money, and every proof that could pay for anything expires in
 * minutes, so a deleted row cannot be replayed. Charges still in flight are never touched:
 * reconciliation needs them. The client register is kept — that is the data this demo exists to gather.
 */
export async function pruneLedger(env: Env, now: number): Promise<void> {
  const before = now - RETENTION_MS;
  const finished = `SELECT id FROM tollstile_charges WHERE updated_at < ?1 AND ${FINISHED}`;
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM tollstile_charge_transitions WHERE charge_id IN (${finished})`).bind(before),
    env.DB.prepare(`DELETE FROM demo_results WHERE charge_id IN (${finished})`).bind(before),
    env.DB.prepare(`DELETE FROM tollstile_charges WHERE updated_at < ?1 AND ${FINISHED}`).bind(before),
    env.DB.prepare(`DELETE FROM tollstile_authorizations WHERE updated_at < ?1 AND id NOT IN (SELECT authorization_id FROM tollstile_charges)`).bind(before),
    env.DB.prepare(`DELETE FROM tollstile_claims WHERE expires_at < ?1`).bind(now),
  ]);
}
