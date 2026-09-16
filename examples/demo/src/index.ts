import { paid } from '@tollstile/fetch';
import { credits, payPerCall, upTo, type Payment, type Principal, type Rail } from 'tollstile';
import { forecast, pricePerWord, summarize, translate, words } from './handlers';
import { mcp } from './mcp';
import { page } from './page';
import { createToll, credits as balance, type Env } from './toll';

/** The demo's "member": callers who send this key draw from prepaid credits instead of paying. */
const MEMBER_KEY = 'demo-member';

const principal = (request: Request): Principal | null =>
  request.headers.get('x-api-key') === MEMBER_KEY ? { id: 'demo_member' } : null;

export { McpSession } from './mcp';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const toll = createToll(env);

    if (url.pathname === '/' && request.method === 'GET') return page(url.host);
    if (url.pathname === '/api/charges' && request.method === 'GET') return recentCharges(env);
    if (url.pathname === '/mcp') return mcp(request, env);

    if (url.pathname === '/v1/forecast' && request.method === 'GET') {
      return paid(toll.price('$0.01'), (paidRequest) => Response.json(forecast(new URL(paidRequest.url).searchParams.get('city') ?? 'Tokyo')))(request);
    }

    // A price computed from the body: the quote commits to it, so a paid retry must send the same text.
    if (url.pathname === '/v1/translate' && request.method === 'POST') {
      return paid(toll.price(pricePerWord), async (paidRequest) => Response.json(translate(await paidRequest.text())))(request);
    }

    // A maximum the payer authorizes; the handler charges what it used.
    if (url.pathname === '/v1/summarize' && request.method === 'POST') {
      return paid(
        toll.price(upTo('$0.50'), { access: [credits({ balance }), payPerCall()] }),
        async (paidRequest, { payment }) => {
          const text = await paidRequest.text();
          const result = summarize(text, 2);
          await charge(payment, words(text));
          return Response.json(result);
        },
        { principal },
      )(request);
    }

    return Response.json({ error: { code: 'not_found', message: `No route for ${request.method} ${url.pathname}. See /` } }, { status: 404 });
  },

  /** Resolves anything a crashed isolate left behind. */
  scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(createToll(env).reconcile({ olderThanMs: 60_000 }));
  },
};

/** $0.001 per word, never more than the authorized maximum. */
async function charge(payment: Payment<readonly Rail[]>, count: number): Promise<void> {
  const micros = BigInt(Math.min(Math.max(count, 1), 500)) * 1_000n;
  await payment.fulfill({ amount: `${(Number(micros) / 1_000_000).toFixed(3)} USD`, resultRef: `summaries/${String(count)}` });
}

/** The ledger, read straight from D1 for the live table on the page. */
async function recentCharges(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT id, resource, payment, fulfillment, amount_micros, currency, updated_at, settlement_reference
       FROM tollstile_charges ORDER BY updated_at DESC LIMIT 25`,
  ).all<Record<string, string | number | null>>();
  return Response.json(
    { charges: results },
    { headers: { 'cache-control': 'no-store', 'access-control-allow-origin': '*' } },
  );
}
