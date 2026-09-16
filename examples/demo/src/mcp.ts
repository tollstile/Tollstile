import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { paidTool } from '@tollstile/mcp';
import { formatMoney, money } from 'tollstile';
import { z } from 'zod';
import { offers } from './catalog';
import type { Denial } from 'tollstile';
import { forecast, summarize, words } from './handlers';
import { keepResult, noteClient, type Env } from './toll';

/** The header the worker uses to tell a session which id it was routed under. */
const SESSION_ID = 'x-demo-session-id';

/**
 * Where a person is sent when the call cannot be paid for from where they are sitting. No chat
 * client lets a model attach a payment, so for a human at one of them this is the only way forward:
 * the client shows the link and stops, instead of handing the model an error to read out.
 */
function checkout(denial: Denial): { readonly url: string; readonly message: string } | null {
  const { code } = denial.error;
  if (code === 'payment_required' || code === 'quote_required') {
    // The page is told which call sent the person: the quote is bound to that one request, so what
    // it shows, and the command it hands back, are for the call that is actually waiting.
    const { quote, resource, price } = denial.body;
    const url = new URL('https://demo.tollstile.com/pay');
    if (typeof quote === 'string') url.searchParams.set('quote', quote);
    if (typeof resource === 'string') url.searchParams.set('for', resource);
    if (typeof price === 'string') url.searchParams.set('price', price);
    return { url: url.toString(), message: `This call costs ${typeof price === 'string' ? price : 'money'}. Open the page to see what is waiting and how to pay for it.` };
  }
  if (code === 'access_denied') {
    return { url: 'https://demo.tollstile.com/pay#approval', message: 'This tool is charged only with your approval, and this client cannot ask for one. The demo explains what happens instead.' };
  }
  return null;
}

/**
 * Routes an MCP request to its session. Asking a person to approve a charge means the server sends
 * the client a request and reads the answer off a later POST, so the session cannot be rebuilt per
 * request the way the paid HTTP routes are: every request for one session goes to one Durable Object.
 */
export async function mcp(request: Request, env: Env): Promise<Response> {
  const existing = request.headers.get('mcp-session-id');
  if (existing === null) {
    // A one-shot call — `curl` straight at a tool, with no `initialize` — is served on its own.
    if (!(await startsSession(request))) return withoutSession(request, env);
    return route(request, env.MCP_SESSIONS.newUniqueId(), env);
  }
  const id = identify(existing, env);
  if (id === null) return sessionNotFound();
  return route(request, id, env);
}

function route(request: Request, id: DurableObjectId, env: Env): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.set(SESSION_ID, id.toString());
  return env.MCP_SESSIONS.get(id).fetch(new Request(request, { headers }));
}

function identify(session: string, env: Env): DurableObjectId | null {
  // catch-reason: the session id comes from the wire; anything that is not one names no session.
  try {
    return env.MCP_SESSIONS.idFromString(session);
  } catch {
    return null;
  }
}

/**
 * One request, one server, nothing kept. A caller like this cannot be asked anything — the answer
 * would arrive at a server that is gone — so tools that need approval refuse instead of charging.
 */
async function withoutSession(request: Request, env: Env): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({});
  await tools(env).connect(transport);
  return closeWhenSent(await transport.handleRequest(request), transport);
}

function sessionNotFound(): Response {
  return Response.json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null }, { status: 404 });
}

/** The answer is still being written when handleRequest returns, so the transport outlives it. */
function closeWhenSent(response: Response, transport: WebStandardStreamableHTTPServerTransport): Response {
  if (response.body === null) return response;
  return new Response(response.body.pipeThrough(new TransformStream({ flush: () => transport.close() })), response);
}

/** One MCP session: a server and its transport, alive across the requests that make up a conversation. */
export class McpSession {
  readonly #env: Env;
  #transport: WebStandardStreamableHTTPServerTransport | undefined;

  constructor(_state: DurableObjectState, env: Env) {
    this.#env = env;
  }

  async fetch(request: Request): Promise<Response> {
    if (this.#transport === undefined) {
      // A session this object no longer holds (it was evicted, or never existed): 404 tells the
      // client to start a new one rather than to retry a session that cannot answer.
      if (!(await startsSession(request))) return sessionNotFound();
      const sessionId = request.headers.get(SESSION_ID) ?? crypto.randomUUID();
      this.#transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => sessionId });
      const server = tools(this.#env);
      // Who connects here and what they say they can do. The answer is otherwise guesswork.
      const env = this.#env;
      server.server.oninitialized = () => {
        void noteClient(env, server.server.getClientVersion(), server.server.getClientCapabilities(), request.headers.get('mcp-protocol-version') ?? 'unknown');
      };
      await server.connect(this.#transport);
    }
    return this.#transport.handleRequest(request);
  }
}

/** The demo's paid tools, and the free one that explains them. */
function tools(env: Env): McpServer {
  const priced = offers(env);
  const server = new McpServer({ name: 'tollstile-demo', version: '1.0.0' });

  paidTool(
    server,
    'forecast',
    { description: `${priced.toolForecast.description} Costs ${priced.toolForecast.price} per call.` },
    priced.toolForecast.gate,
    (_args, { payment }) => {
      const result = forecast('Tokyo');
      return { content: [{ type: 'text' as const, text: `${result.city}: ${result.forecast} (paid via ${payment.via})` }] };
    },
    { checkout },
  );

  // Nothing here is charged until a person answers: the client is asked over MCP elicitation, and a
  // call they decline releases its reservation instead of settling.
  paidTool(
    server,
    'summarize',
    { description: `Two sentences from any text. ${priced.toolSummarize.price}, and a person approves the maximum first.`, inputSchema: { text: z.string() } },
    priced.toolSummarize.gate,
    async ({ text }, { payment }) => {
      const result = summarize(text, 2);
      // The summary is kept under this charge's id, so a retry that lost its answer is told where it is.
      const amount = perWord(words(text));
      const chargeId = payment.chargeId;
      await payment.fulfill(chargeId === null ? { amount } : { amount, resultRef: await keepResult(env, chargeId, result.summary) });
      return { content: [{ type: 'text' as const, text: result.summary }] };
    },
    { approval: { message: (payment) => `Summarize this text for up to ${formatMoney(payment.amount)}?` }, checkout },
  );

  // Nothing to pay here, and still nobody's to spend quietly: the client asks a person first.
  paidTool(
    server,
    'forecast_week',
    { description: `Seven days for a city. ${priced.toolWeek.price} — no payment, but your approval.` },
    priced.toolWeek.gate,
    () => {
      const result = forecast('Tokyo');
      return { content: [{ type: 'text' as const, text: `${result.city}, the week ahead: ${result.week.join(', ')}` }] };
    },
    {
      approval: { message: (payment) => `Spend ${formatMoney(payment.amount)} of the demo's credit on a seven-day forecast?` },
      checkout,
    },
  );

  server.registerTool(
    'pricing',
    { description: 'What this demo charges, how to pay for a tool call, and which calls a person has to approve. Free.' },
    () => ({
      content: [
        {
          type: 'text' as const,
          text: [
            ...Object.values(priced).map(({ call, price, description }) => `${call} — ${price}\n  ${description}`),
            '',
            'To pay, call the tool with _meta: { "tollstile/test-payment": "test" }.',
            'An unpaid call answers with the payment requirement in _meta["tollstile/payment-required"].',
            'Retry safely with _meta["tollstile/idempotency-key"]: the same key is never charged twice, and the answer',
            'to the first call is named in `result`.',
            '',
            'The full catalogue, with what happens to the money on each route:',
            '  GET https://demo.tollstile.com/.well-known/tollstile',
          ].join('\n'),
        },
      ],
    }),
  );

  return server;
}

/** Only `initialize` may open a session; the body is read from a copy, so the transport still has it. */
async function startsSession(request: Request): Promise<boolean> {
  if (request.method !== 'POST') return false;
  const body: unknown = await request.clone().json();
  return Array.isArray(body) ? body.some((message) => isInitializeRequest(message)) : isInitializeRequest(body);
}

/** $0.001 per word, never more than the authorized maximum. */
function perWord(count: number): string {
  return formatMoney(money('USD', BigInt(Math.min(Math.max(count, 1), 500)) * 1_000n));
}
