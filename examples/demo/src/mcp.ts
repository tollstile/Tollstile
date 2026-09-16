import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { paidTool } from '@tollstile/mcp';
import { formatMoney, money, upTo } from 'tollstile';
import { z } from 'zod';
import { forecast, summarize, words } from './handlers';
import { createToll, type Env } from './toll';

/** The header the worker uses to tell a session which id it was routed under. */
const SESSION_ID = 'x-demo-session-id';

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
      await tools(this.#env).connect(this.#transport);
    }
    return this.#transport.handleRequest(request);
  }
}

/** The demo's paid tools, and the free one that explains them. */
function tools(env: Env): McpServer {
  const toll = createToll(env);
  const server = new McpServer({ name: 'tollstile-demo', version: '1.0.0' });

  paidTool(
    server,
    'forecast',
    { description: 'Tomorrow in one word, for a city. Costs $0.01 per call.' },
    toll.price('$0.01', { resource: 'tool:forecast' }),
    (_args, { payment }) => {
      const result = forecast('Tokyo');
      return { content: [{ type: 'text' as const, text: `${result.city}: ${result.forecast} (paid via ${payment.via})` }] };
    },
  );

  // Nothing here is charged until a person answers: the client is asked over MCP elicitation, and a
  // call they decline releases its reservation instead of settling.
  paidTool(
    server,
    'summarize',
    {
      description: 'Two sentences from any text. $0.001 per word, up to $0.50, and a person approves the maximum first.',
      inputSchema: { text: z.string() },
    },
    toll.price(upTo('$0.50'), { resource: 'tool:summarize' }),
    async ({ text }, { payment }) => {
      const result = summarize(text, 2);
      await payment.fulfill({ amount: perWord(words(text)) });
      return { content: [{ type: 'text' as const, text: result.summary }] };
    },
    { approval: { message: (payment) => `Summarize this text for up to ${formatMoney(payment.amount)}?` } },
  );

  server.registerTool(
    'pricing',
    { description: 'What this demo charges, how to pay for a tool call, and which calls a person has to approve. Free.' },
    () => ({
      content: [
        {
          type: 'text' as const,
          text: [
            'tools:',
            '  forecast  — $0.01 per call',
            "  summarize — $0.001 per word, up to $0.50, and only with a person's approval",
            '',
            'To pay, call the tool with _meta:',
            '  { "tollstile/test-payment": "test" }',
            'An unpaid call answers with the payment requirement in _meta["tollstile/payment-required"].',
            'Retry safely with _meta["tollstile/idempotency-key"]: the same key is never charged twice.',
            '',
            'summarize is charged only after the client asks a person (MCP elicitation) and they accept.',
            'A client that cannot ask is refused with access_denied, and nothing is charged.',
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
