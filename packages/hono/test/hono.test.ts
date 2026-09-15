import { Hono } from 'hono';
import { createTollstile, credits, memoryBalance, memoryLedger, payPerCall, testRail } from 'tollstile';
import { describe, expect, it } from 'vitest';
import { tollstile } from '../src/index';

function setup() {
  const rail = testRail();
  const ledger = memoryLedger();
  const toll = createTollstile({ rails: [rail], ledger });
  const app = new Hono();
  let runs = 0;

  app.get('/weather', tollstile(toll.price('$0.01')), (c) => {
    runs += 1;
    return c.json({ forecast: 'clear', paidWith: c.get('payment').via });
  });
  app.get('/broken', tollstile(toll.price('$0.01')), () => {
    runs += 1;
    throw new Error('handler failed');
  });
  app.get('/missing', tollstile(toll.price('$0.01')), (c) => {
    runs += 1;
    return c.json({ error: 'missing' }, 404);
  });

  return { app, toll, rail, ledger, runs: () => runs };
}

describe('@tollstile/hono', () => {
  it('turns 402 into 200 with the test rail and the quote it was offered', async () => {
    const { app, runs } = setup();

    const unpaid = await app.request('/weather');
    expect(unpaid.status).toBe(402);
    const { quote } = (await unpaid.json()) as { quote: string };
    expect(runs()).toBe(0);

    const paid = await app.request('/weather', { headers: { payment: `test quote=${quote}` } });
    expect(paid.status).toBe(200);
    expect(await paid.json()).toEqual({ forecast: 'clear', paidWith: 'rail' });
    expect(paid.headers.get('payment-receipt')).toMatch(/^test_settlement_/);
    expect(runs()).toBe(1);
  });

  it('names the resource after the matched route', async () => {
    const { app, ledger } = setup();
    await app.request('/weather', { headers: { payment: 'test' } });
    expect(ledger.charges()[0]?.resource).toBe('GET /weather');
  });

  it('releases the reservation when the handler throws or answers 400 or above', async () => {
    const { app, rail, ledger } = setup();
    expect((await app.request('/broken', { headers: { payment: 'test proof=a' } })).status).toBe(500);
    expect((await app.request('/missing', { headers: { payment: 'test proof=b' } })).status).toBe(404);

    expect(rail.effects.settlements).toBe(0);
    expect(ledger.charges().map((charge) => charge.payment)).toEqual(['released', 'released']);
  });

  it('replaces the output with a fresh 402 when settlement is rejected', async () => {
    const { app, rail, runs } = setup();
    rail.simulate({ settle: 'reject' });
    const response = await app.request('/weather', { headers: { payment: 'test proof=r1' } });

    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ reason: 'settlement_rejected' });
    expect(response.headers.get('payment-receipt')).toBeNull();
    expect(runs()).toBe(1);
  });

  it('passes the resolved principal to access policies', async () => {
    const { toll } = setup();
    const balance = memoryBalance({ acct_1: '$1' });
    const app = new Hono();
    app.get(
      '/credits',
      tollstile(toll.price('$0.25', { access: [credits({ balance }), payPerCall()] }), {
        principal: (c) => (c.req.header('x-account') === undefined ? null : { id: c.req.header('x-account') ?? '' }),
      }),
      (c) => c.text('ok'),
    );

    expect((await app.request('/credits', { headers: { 'x-account': 'acct_1' } })).status).toBe(200);
    expect(balance.available('acct_1')?.micros).toBe(750_000n);
    expect((await app.request('/credits')).status).toBe(402);
  });
});
