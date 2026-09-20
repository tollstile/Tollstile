import { paid } from '@tollstile/fetch';
import type { Payment, Principal, Rail } from 'tollstile';
import { catalog, offers } from './catalog';
import { chat } from './chat';
import { forecast, research, summarize, translate, words } from './handlers';
import { answerAnything, judge, MAX_QUESTION, RESEARCH_CAP, type Verdict } from './judge';
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
    // The research desk as a conversation: same ceiling every question, a different settlement each time.
    if (url.pathname === '/jev' && request.method === 'GET') return chat();
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

    // A ceiling the payer authorizes, settled at what a judge says the answer was worth. Browsers
    // call this one from other origins (the chat demo), so it carries CORS; the rest do not.
    if (url.pathname === '/v1/research' && request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: preflightHeaders() });
    }
    if (url.pathname === '/v1/research' && request.method === 'POST') {
      const answered = await paid(priced.research.gate, async (paidRequest, { payment }) => {
        const question = (await questionOf(paidRequest)).slice(0, MAX_QUESTION);
        const found = await desk(question, env);
        const verdict = await judge({ question, answer: found.answer, sources: found.sources.length, characters: found.answer.length }, env.JEV_API_KEY);

        // Nothing was answered, so nothing is charged: a 4xx releases the hold.
        if (!verdict.answered) return Response.json({ answered: false, sources: [], pricing: pricing(verdict, '$0.00') }, { status: 422 });

        await payment.fulfill({ amount: verdict.amount });
        return Response.json({ answered: true, answer: found.answer, sources: found.sources, pricing: pricing(verdict, verdict.amount) });
      })(request);
      return shared(answered);
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
    // The routes register their credit balances on the instance; a charge paid from one can only be
    // reconciled by an instance that knows it, so the routes are defined before reconciling.
    const toll = createToll(env);
    offers(env, toll);
    ctx.waitUntil(toll.reconcile({ olderThanMs: 60_000 }).then(() => pruneLedger(env, event.scheduledTime)));
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

/** The buyer's own charge, explained: a price nobody can question is a price nobody trusts. */
function pricing(verdict: Verdict, charged: string) {
  return {
    charged,
    authorized: RESEARCH_CAP,
    tier: verdict.answered ? verdict.tier : 'none',
    judgedBy: verdict.judgedBy,
    confidence: Number(verdict.confidence.toFixed(2)),
    reason: verdict.reason,
  };
}

/**
 * The corpus first, because it is free and deterministic. Anything it does not hold is written by
 * a model, when this deployment has a key for one — and judged the same way either.
 */
async function desk(question: string, env: Env): Promise<{ answer: string; sources: readonly string[] }> {
  const found = research(question);
  if (found.sources.length > 0) return found;
  const written = await answerAnything(question, env.JEV_API_KEY);
  return written === undefined ? found : { answer: written.answer, sources: [written.source] };
}

async function questionOf(request: Request): Promise<string> {
  const body: unknown = await request.json().catch(() => ({}));
  return typeof body === 'object' && body !== null && 'question' in body && typeof body.question === 'string' ? body.question : '';
}

function preflightHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type, payment, idempotency-key',
    'access-control-max-age': '86400',
  };
}

/** Lets a page on another origin read the 402 and the receipt. Nothing here is private to an origin. */
function shared(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', '*');
  headers.set('access-control-expose-headers', 'payment-receipt, retry-after');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
