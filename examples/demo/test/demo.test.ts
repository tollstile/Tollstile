import { DatabaseSync } from 'node:sqlite';
import { sqliteSchema } from '@tollstile/sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';

/** D1's shape over node:sqlite, so the worker can be tested exactly as deployed. */
function d1(): D1Database {
  const db = new DatabaseSync(':memory:');
  db.exec(sqliteSchema);
  const statement = (sql: string, params: readonly (string | number | null)[] = []): D1PreparedStatement => ({
    bind: (...values) => statement(sql, values),
    all: () => Promise.resolve({ results: db.prepare(sql).all(...params) as never, success: true }),
  });
  return {
    prepare: (sql) => statement(sql),
    batch: (statements) => Promise.all(statements.map((each) => each.all())) as never,
  };
}

let env: { DB: D1Database; TOLLSTILE_SECRET: string };
const call = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://demo.tollstile.com${path}`, init), env);
const quoteOf = async (response: Response) => ((await response.json()) as { quote: string }).quote;

beforeEach(() => {
  env = { DB: d1(), TOLLSTILE_SECRET: 'demo-secret-0123456789abcdefghijk' };
});

describe('the demo worker', () => {
  it('serves the page and an empty ledger', async () => {
    const page = await call('/');
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('A paid API you can pay for right now.');
    expect(await (await call('/api/charges')).json()).toEqual({ charges: [] });
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

  it('answers a retry with the same idempotency key from the ledger', async () => {
    const quote = await quoteOf(await call('/v1/forecast?city=Kyoto'));
    const headers = { payment: `test quote=${quote}`, 'idempotency-key': 'demo-1' };
    expect((await call('/v1/forecast?city=Kyoto', { headers })).status).toBe(200);

    const retry = await call('/v1/forecast?city=Kyoto', { headers });
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({ error: { code: 'already_paid' } });
  });

  it('charges an MCP tool call and returns the receipt in _meta', async () => {
    const post = (body: unknown) =>
      call('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) });
    const toolCall = (meta: Record<string, string>) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'forecast', arguments: {}, _meta: meta } });

    const unpaid = (await (await post(toolCall({}))).json()) as { result: { isError?: boolean; _meta?: Record<string, unknown> } };
    expect(unpaid.result.isError).toBe(true);
    expect(unpaid.result._meta?.['tollstile/payment-required']).toMatchObject({ error: { code: 'payment_required' } });

    const paid = (await (await post(toolCall({ 'tollstile/test-payment': 'test' }))).json()) as { result: { _meta?: Record<string, unknown> } };
    expect(paid.result._meta?.['tollstile/test-receipt']).toMatch(/^test_settlement_/);
  });
});
