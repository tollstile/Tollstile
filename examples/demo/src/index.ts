import { paid } from '@tollstile/fetch';
import type { Payment, Principal, Rail } from 'tollstile';
import { catalog, offers } from './catalog';
import { forecast, summarize, translate, words } from './handlers';
import { mcp } from './mcp';
import { page } from './page';
import { overLimit, pruneLedger } from './limits';
import { createToll, keepResult, readResult, type Env } from './toll';

/** The demo's "member": callers who send this key draw from prepaid credits instead of paying. */
const MEMBER_KEY = 'demo-member';

const principal = (request: Request): Principal | null =>
  request.headers.get('x-api-key') === MEMBER_KEY ? { id: 'demo_member' } : null;

export { McpSession } from './mcp';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const limited = await overLimit(request, env);
    if (limited !== null) return limited;

    const url = new URL(request.url);
    const priced = offers(env);

    if ((url.pathname === '/' || url.pathname === '/pay') && request.method === 'GET') return page(url.host);
    // What is on sale, what it costs, and what happens to the money — before anything is called.
    if (url.pathname === '/.well-known/tollstile' && request.method === 'GET') {
      return Response.json(catalog(env), { headers: { 'cache-control': 'public, max-age=60', 'access-control-allow-origin': '*' } });
    }
    if (url.pathname === '/api/charges' && request.method === 'GET') return recentCharges(env);
    // What each MCP client that has connected here says it can do.
    if (url.pathname === '/api/clients' && request.method === 'GET') return connectedClients(env);
    if (url.pathname === '/mcp') return mcp(request, env);

    if (url.pathname === '/v1/forecast' && request.method === 'GET') {
      return paid(priced.forecast.gate, (paidRequest) => Response.json(forecast(new URL(paidRequest.url).searchParams.get('city') ?? 'Tokyo')))(request);
    }

    // A price computed from the body: the quote commits to it, so a paid retry must send the same text.
    if (url.pathname === '/v1/translate' && request.method === 'POST') {
      return paid(priced.translate.gate, async (paidRequest) => Response.json(translate(await paidRequest.text())))(request);
    }

    // A maximum the payer authorizes; the handler charges what it used.
    if (url.pathname === '/v1/summarize' && request.method === 'POST') {
      return paid(
        priced.summarize.gate,
        async (paidRequest, { payment }) => {
          const text = await paidRequest.text();
          const result = summarize(text, 2);
          await charge(env, payment, text, JSON.stringify(result));
          return Response.json(result);
        },
        { principal },
      )(request);
    }

    // What a paid call produced, by the reference a retry was handed in `already_paid`.
    if (url.pathname.startsWith('/v1/results/') && request.method === 'GET') {
      const content = await readResult(env, url.pathname.slice('/v1/results/'.length));
      return content === undefined
        ? Response.json({ error: { code: 'not_found', message: 'No result under that reference.' } }, { status: 404 })
        : new Response(content, { headers: { 'content-type': 'application/json' } });
    }

    return Response.json({ error: { code: 'not_found', message: `No route for ${request.method} ${url.pathname}. See /` } }, { status: 404 });
  },

  /** Resolves anything a crashed isolate left behind, then clears what finished more than a day ago. */
  scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(createToll(env).reconcile({ olderThanMs: 60_000 }).then(() => pruneLedger(env, event.scheduledTime)));
  },
};

/**
 * $0.001 per word, never more than the authorized maximum, and the result is kept under the charge's
 * own id: a retry that lost its response is answered `already_paid` with a reference to it.
 */
async function charge(env: Env, payment: Payment<readonly Rail[]>, text: string, result: string): Promise<void> {
  const micros = BigInt(Math.min(Math.max(words(text), 1), 500)) * 1_000n;
  const amount = `${(Number(micros) / 1_000_000).toFixed(3)} USD`;
  const chargeId = payment.chargeId;
  if (chargeId === null) return payment.fulfill({ amount });
  await payment.fulfill({ amount, resultRef: await keepResult(env, chargeId, result) });
}

/** Which MCP clients have connected, and what each declared. Names and capabilities only. */
async function connectedClients(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT name, version, protocol, capabilities, connections, last_seen FROM demo_clients ORDER BY last_seen DESC LIMIT 50`,
  ).all<Record<string, string | number>>();
  return Response.json(
    {
      clients: results.map((row) => ({
        ...row,
        capabilities: JSON.parse(String(row.capabilities)) as unknown,
        elicitation: capabilityOf(String(row.capabilities)),
      })),
    },
    { headers: { 'cache-control': 'no-store', 'access-control-allow-origin': '*' } },
  );
}

/** The one question every server asks about a client: can it put something in front of a person? */
function capabilityOf(capabilities: string): string {
  const declared = JSON.parse(capabilities) as { elicitation?: { form?: unknown; url?: unknown } };
  if (declared.elicitation === undefined) return 'none';
  const modes = [declared.elicitation.form === undefined ? [] : ['form'], declared.elicitation.url === undefined ? [] : ['url']].flat();
  return modes.length === 0 ? 'declared, no mode' : modes.join(' + ');
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
