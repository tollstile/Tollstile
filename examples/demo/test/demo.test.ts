import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { sqliteSchema } from '@tollstile/sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import worker, { McpSession } from '../src/index';
import { pruneLedger, RETENTION_MS } from '../src/limits';
import type { Env } from '../src/toll';

/** D1's shape over node:sqlite, so the worker can be tested exactly as deployed. */
function d1(): D1Database {
  const db = new DatabaseSync(':memory:');
  db.exec(sqliteSchema);
  db.exec(readFileSync(new URL('../migrations/0002_results.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0003_clients.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0004_results_by_key.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/0005_usage.sql', import.meta.url), 'utf8'));
  const statement = (sql: string, params: readonly (string | number | null)[] = []): D1PreparedStatement => ({
    bind: (...values) => statement(sql, values),
    all: () => Promise.resolve({ results: db.prepare(sql).all(...params) as never, success: true }),
  });
  return {
    prepare: (sql) => statement(sql),
    batch: (statements) => Promise.all(statements.map((each) => each.all())) as never,
  };
}

/** The Durable Object namespace, in process: one McpSession object per id, as the runtime keeps them. */
function sessions(): DurableObjectNamespace {
  const objects = new Map<string, McpSession>();
  let created = 0;
  const identify = (value: string): DurableObjectId => ({ toString: () => value });
  return {
    newUniqueId: () => identify(`session-${String((created += 1))}`),
    idFromString: (value) => identify(value),
    get: (id) => {
      const key = id.toString();
      const object = objects.get(key) ?? new McpSession({ id }, env);
      objects.set(key, object);
      return { fetch: (request: Request) => object.fetch(request) };
    },
  };
}

/** A rate limiter that lets everything through unless told otherwise. */
const allow: RateLimit = { limit: () => Promise.resolve({ success: true }) };

let env: Env;
const call = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://demo.tollstile.com${path}`, init), env);
const quoteOf = async (response: Response) => ((await response.json()) as { quote: string }).quote;

type ToolResult = { isError?: boolean; content?: { text?: string }[]; _meta?: Record<string, unknown> };

const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

const rpc = (session: string | null, message: unknown) =>
  call('/mcp', { method: 'POST', headers: session === null ? MCP_HEADERS : { ...MCP_HEADERS, 'mcp-session-id': session }, body: JSON.stringify(message) });

/** Opens an MCP session the way a client does, and returns its id. */
async function open(): Promise<string> {
  const response = await rpc(null, {
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } },
  });
  await response.text();
  const session = response.headers.get('mcp-session-id');
  if (session === null) throw new Error('The MCP endpoint opened no session');
  await (await rpc(session, { jsonrpc: '2.0', method: 'notifications/initialized' })).text();
  return session;
}

/** One `tools/call`, whose answer arrives as a single SSE event on the stream this POST opened. */
async function tool(request: { session: string; name: string; arguments?: Record<string, unknown>; meta?: Record<string, string> }): Promise<ToolResult> {
  const response = await rpc(request.session, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: request.name, arguments: request.arguments ?? {}, _meta: request.meta ?? {} },
  });
  const body = await response.text();
  const data = body.split(/\r?\n/).find((line) => line.startsWith('data:'));
  if (data === undefined) throw new Error(`No JSON-RPC message in ${body}`);
  return (JSON.parse(data.slice(5)) as { result: ToolResult }).result;
}

beforeEach(() => {
  env = { DB: d1(), TOLLSTILE_SECRET: 'demo-secret-0123456789abcdefghijk', MCP_SESSIONS: sessions(), CALLS: allow, READS: allow };
});

describe('the demo, as a public target', () => {
  it('refuses a caller over the limit before anything is priced or written', async () => {
    env = { ...env, CALLS: { limit: () => Promise.resolve({ success: false }) } };

    const response = await call('/v1/forecast?city=Osaka', { headers: { payment: 'test' } });

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(await response.json()).toMatchObject({ error: { code: 'rate_limited', action: 'retry_later' }, retryAfter: 60 });
    expect(await (await call('/api/charges')).json()).toEqual({ charges: [] });
  });

  it('counts the page polling the ledger apart from paid calls', async () => {
    const counted: string[] = [];
    const counting = (name: string): RateLimit => ({ limit: () => { counted.push(name); return Promise.resolve({ success: true }); } });
    env = { ...env, CALLS: counting('calls'), READS: counting('reads') };

    await call('/api/charges');
    await call('/.well-known/tollstile');
    await call('/v1/forecast?city=Osaka');
    await call('/');

    expect(counted).toEqual(['reads', 'reads', 'calls']);
  });

  it('prunes finished charges older than a day, and keeps what is in flight and who connected', async () => {
    for (const city of ['Osaka', 'Kyoto']) {
      const quote = await quoteOf(await call(`/v1/forecast?city=${city}`));
      await call(`/v1/forecast?city=${city}`, { headers: { payment: `test quote=${quote}` } });
    }
    await open();
    // One of them never learned its outcome, and reconciliation still needs it.
    await env.DB.prepare(`UPDATE tollstile_charges SET payment = 'unknown' WHERE id = (SELECT id FROM tollstile_charges LIMIT 1)`).all();

    await pruneLedger(env, Date.now() + RETENTION_MS + 60_000);

    const { charges } = (await (await call('/api/charges')).json()) as { charges: { payment: string }[] };
    expect(charges.map((charge) => charge.payment)).toEqual(['unknown']);
    const { clients } = (await (await call('/api/clients')).json()) as { clients: unknown[] };
    expect(clients).toHaveLength(1);
  });
});

describe('the demo worker', () => {
  it('serves the page and an empty ledger', async () => {
    const page = await call('/');
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('A paid API you can pay for right now.');
    expect(await (await call('/api/charges')).json()).toEqual({ charges: [] });
  });

  it('publishes what is on sale, described by the gates that enforce it', async () => {
    const catalog = (await (await call('/.well-known/tollstile')).json()) as {
      offers: { call: string; price: string; plan: { route: string; pricing: string; access: string[]; rails: { rail: string }[] } }[];
    };

    expect(catalog.offers.map((offer) => offer.call)).toEqual([
      'GET /v1/forecast?city=',
      'POST /v1/research',
      'POST /v1/research/batch',
      'POST /v1/translate',
      'POST /v1/summarize',
      'tool:forecast',
      'tool:forecast_week',
      'tool:summarize',
    ]);
    // The plan is Tollstile's own account of the route, not a second description that could drift.
    expect(catalog.offers[0]?.plan).toMatchObject({ pricing: 'fixed', rails: [{ rail: 'test' }] });
    expect(catalog.offers[1]?.plan.pricing).toBe('up_to');
    expect(catalog.offers[2]?.plan.pricing).toBe('up_to');
    expect(catalog.offers[3]?.plan.pricing).toBe('computed');
    expect(catalog.offers[4]?.plan).toMatchObject({ pricing: 'up_to', access: ['credits', 'payPerCall'] });
  });

  it('answers 402, takes the quote, settles, and records the charge', async () => {
    const challenge = await call('/v1/forecast?city=Osaka');
    expect(challenge.status).toBe(402);

    const paid = await call('/v1/forecast?city=Osaka', { headers: { payment: `test quote=${await quoteOf(challenge)}` } });
    expect(paid.status).toBe(200);
    expect(paid.headers.get('payment-receipt')).toMatch(/^test_settlement_/);
    expect(await paid.json()).toMatchObject({ city: 'Osaka' });

    const { charges } = (await (await call('/api/charges')).json()) as { charges: { resource: string; payment: string; amount_micros: number }[] };
    expect(charges).toEqual([expect.objectContaining({ resource: 'GET /v1/forecast', payment: 'settled', amount_micros: 10_000 })]);
  });

  it('binds a computed price to the body it priced', async () => {
    const body = 'the weather in tokyo is clear';
    const quote = await quoteOf(await call('/v1/translate', { method: 'POST', body }));

    const swapped = await call('/v1/translate', { method: 'POST', body: `${body} for the whole week`, headers: { payment: `test quote=${quote}` } });
    expect(await swapped.json()).toMatchObject({ error: { code: 'quote_mismatch' } });

    const paid = await call('/v1/translate', { method: 'POST', body, headers: { payment: `test quote=${quote}` } });
    expect(await paid.json()).toMatchObject({ words: 6 });
  });

  it('charges what the handler used, not the authorized maximum', async () => {
    const body = 'One. Two. Three.';
    const quote = await quoteOf(await call('/v1/summarize', { method: 'POST', body }));
    await call('/v1/summarize', { method: 'POST', body, headers: { payment: `test quote=${quote}` } });

    const { charges } = (await (await call('/api/charges')).json()) as { charges: { amount_micros: number; result_ref?: string }[] };
    expect(charges[0]?.amount_micros).toBe(3_000);
  });

  it('lets the member key draw on credits instead of paying', async () => {
    const response = await call('/v1/summarize', { method: 'POST', body: 'One. Two.', headers: { 'x-api-key': 'demo-member' } });

    expect(response.status).toBe(200);
    expect(response.headers.get('payment-receipt')).toBeNull();
  });

  it('hands a retry the reference to what it already paid for', async () => {
    const body = 'One. Two. Three.';
    const quote = await quoteOf(await call('/v1/summarize', { method: 'POST', body }));
    const headers = { payment: `test quote=${quote}`, 'idempotency-key': 'summary-1' };
    const paid = await call('/v1/summarize', { method: 'POST', body, headers });
    expect(paid.status).toBe(200);

    const retry = await call('/v1/summarize', { method: 'POST', body, headers });
    const denial = (await retry.json()) as { error: { code: string }; result: string };
    expect(denial.error.code).toBe('already_paid');
    expect(denial.result).toMatch(/^results\/[0-9a-f]{36}$/);

    // The ledger table prints charge ids; none of them opens a result.
    const { charges } = (await (await call('/api/charges')).json()) as { charges: { id: string }[] };
    for (const { id } of charges) expect((await call(`/v1/results/${id}`)).status).toBe(404);

    const recovered = await call(`/v1/${denial.result}`);
    expect(await recovered.json()).toEqual(await paid.json());
  });

  it('answers a retry with the same idempotency key from the ledger', async () => {
    const quote = await quoteOf(await call('/v1/forecast?city=Kyoto'));
    const headers = { payment: `test quote=${quote}`, 'idempotency-key': 'demo-1' };
    expect((await call('/v1/forecast?city=Kyoto', { headers })).status).toBe(200);

    const retry = await call('/v1/forecast?city=Kyoto', { headers });
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({ error: { code: 'already_paid' } });
  });

  it('records what a client said it could do, and nothing about who is using it', async () => {
    await open();

    const { clients } = (await (await call('/api/clients')).json()) as {
      clients: { name: string; version: string; elicitation: string; capabilities: Record<string, unknown> }[];
    };

    expect(clients).toEqual([
      expect.objectContaining({ name: 'test', version: '1.0.0', elicitation: 'none', capabilities: {} }) as unknown,
    ]);
  });

  it('charges an MCP tool call and returns the receipt in _meta', async () => {
    const session = await open();

    const unpaid = await tool({ session, name: 'forecast' });
    expect(unpaid.isError).toBe(true);
    expect(unpaid._meta?.['tollstile/payment-required']).toMatchObject({ error: { code: 'payment_required' } });

    const paid = await tool({ session, name: 'forecast', meta: { 'tollstile/test-payment': 'test' } });
    expect(paid._meta?.['tollstile/test-receipt']).toMatch(/^test_settlement_/);
  });

  it('serves a one-shot tool call that opened no session', async () => {
    const response = await rpc(null, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'forecast', _meta: { 'tollstile/test-payment': 'test' } } });
    const data = (await response.text()).split(/\r?\n/).find((line) => line.startsWith('data:')) ?? '';

    expect((JSON.parse(data.slice(5)) as { result: ToolResult }).result._meta?.['tollstile/test-receipt']).toMatch(/^test_settlement_/);
  });

  it('answers a body that is not JSON with a client error rather than an exception', async () => {
    const response = await call('/mcp', { method: 'POST', headers: MCP_HEADERS, body: 'not json' });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });

  it('turns away a request for a session it no longer holds', async () => {
    const response = await rpc('session-gone', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'forecast' } });

    expect(response.status).toBe(404);
  });

  it('gives a client that cannot pay the page, naming the call that is waiting on it', async () => {
    const unpaid = await tool({ session: await open(), name: 'forecast' });

    const { url } = unpaid._meta?.['tollstile/checkout'] as { url: string };
    const page = new URL(url);
    expect(page.pathname).toBe('/pay');
    expect(page.searchParams.get('for')).toBe('tool:forecast');
    expect(page.searchParams.get('price')).toBe('$0.01');
    // Bound to this one call: the page can hand back a command that pays for it and nothing else.
    expect((page.searchParams.get('quote') ?? '').length).toBeGreaterThan(100);
  });

  it('asks before spending the demo credit, and spends nothing when nobody can be asked', async () => {
    const paid = await tool({ session: await open(), name: 'forecast_week' });

    expect(paid._meta?.['tollstile/payment-required']).toMatchObject({ error: { code: 'access_denied', detail: 'approval_unavailable' } });
    const { charges } = (await (await call('/api/charges')).json()) as { charges: { payment: string; resource: string }[] };
    expect(charges).toEqual([expect.objectContaining({ resource: 'tool:forecast_week', payment: 'released' })]);
  });

  it('refuses to charge a tool that needs approval when the client cannot ask anyone', async () => {
    const paid = await tool({
      session: await open(),
      name: 'summarize',
      arguments: { text: 'One. Two. Three.' },
      meta: { 'tollstile/test-payment': 'test' },
    });

    expect(paid._meta?.['tollstile/payment-required']).toMatchObject({ error: { code: 'access_denied', detail: 'approval_unavailable' } });
    const { charges } = (await (await call('/api/charges')).json()) as { charges: { payment: string }[] };
    expect(charges).toEqual([expect.objectContaining({ payment: 'released' })]);
  });
});

describe('research, priced at what the answer was worth', () => {
  const ask = async (question: string) => {
    const body = JSON.stringify({ question });
    const headers = { 'content-type': 'application/json' };
    const unpaid = await call('/v1/research', { method: 'POST', headers, body });
    const paid = await call('/v1/research', { method: 'POST', headers: { ...headers, payment: `test quote=${await quoteOf(unpaid)}` }, body });
    return {
      unpaid,
      paid,
      result: (await paid.json()) as {
        answered: boolean;
        pricing: { charged: string; judgedBy: string; grounded: number; depth: { level: string; price: string; probability: number }[] };
      },
    };
  };

  it('settles below the ceiling it authorized, and shows the levels it averaged over', async () => {
    const one = await ask('What do anglers say about fishing?');
    expect(one.unpaid.status).toBe(402);
    expect(one.result.pricing).toMatchObject({ charged: '$0.01', judgedBy: 'rules' });
    expect(one.result.pricing.depth.map((level) => level.probability)).toEqual([1, 0, 0]);

    const deep = await ask('Should I book the ferry in September, given the swell and a refund?');
    expect(deep.result.pricing).toMatchObject({ charged: '$0.05', judgedBy: 'rules' });
    expect(deep.paid.headers.get('payment-receipt')).toMatch(/^test_settlement_/);
  });

  it('judges ten questions in one call and settles the sum', async () => {
    const body = JSON.stringify({
      questions: [
        'What do anglers say about fishing?',
        'When is a ferry refund due?',
        'Should I book the ferry in September, given the swell and a refund?',
        'What is the capital of Mars?',
      ],
    });
    const headers = { 'content-type': 'application/json' };
    const unpaid = await call('/v1/research/batch', { method: 'POST', headers, body });
    expect(unpaid.status).toBe(402);

    const paid = await call('/v1/research/batch', { method: 'POST', headers: { ...headers, payment: `test quote=${await quoteOf(unpaid)}` }, body });
    const result = (await paid.json()) as { judged: number; charged: string; authorized: string; items: { charged: string; tookMs: number }[] };

    expect(paid.status).toBe(200);
    expect(result).toMatchObject({ judged: 4, authorized: '$0.50' });
    // $0.01 + $0.025 + $0.05 for the three the desk answered, and nothing for Mars.
    expect(result.charged).toBe('$0.085');
    expect(result.items.map((item) => item.charged)).toEqual(['$0.01', '$0.025', '$0.05', '$0.00']);
    expect(paid.headers.get('payment-receipt')).toMatch(/^test_settlement_/);
  });

  it('charges nothing when the desk found nothing, and releases the hold', async () => {
    const { paid, result } = await ask('What is the capital of Mars?');

    expect(paid.status).toBe(422);
    expect(paid.headers.get('payment-receipt')).toBeNull();
    expect(result).toMatchObject({ answered: false, pricing: { charged: '$0.00' } });
  });

  it('stops calling the paid gateway once the day\'s ceiling is reached', async () => {
    const { gatewayBudgetLeft } = await import('../src/limits');
    const today = Date.parse('2026-09-20T10:00:00Z');

    expect(await gatewayBudgetLeft(env, today, 2)).toBe(true);
    expect(await gatewayBudgetLeft(env, today, 2)).toBe(true);
    expect(await gatewayBudgetLeft(env, today, 2)).toBe(false);
    // A new day starts the count again.
    expect(await gatewayBudgetLeft(env, Date.parse('2026-09-21T00:01:00Z'), 2)).toBe(true);
  });

  it('serves the conversation at /jev without touching the front page', async () => {
    const jev = await call('/jev');
    expect(jev.status).toBe(200);
    expect(jev.headers.get('content-type')).toContain('text/html');
    expect(await jev.text()).toContain('Ask, then see what it cost');

    const front = await call('/');
    expect(await front.text()).not.toContain('Ask, then see what it cost');
  });

  it('lets a page on another origin call it', async () => {
    const preflight = await call('/v1/research', { method: 'OPTIONS' });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-headers')).toContain('payment');

    const unpaid = await call('/v1/research', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(unpaid.headers.get('access-control-allow-origin')).toBe('*');
    expect(unpaid.headers.get('access-control-expose-headers')).toContain('payment-receipt');
  });
});
