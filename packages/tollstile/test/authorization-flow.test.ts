import { describe, expect, it } from 'vitest';
import { httpContext } from '../src/testing/index';
import { call, setup } from './helpers';

describe('challenge', () => {
  it('answers 402 with a signed quote and an offer per rail, and writes nothing', async () => {
    const { toll, ledger } = setup();
    const result = await call(toll.price('$0.01'));

    expect(result.status).toBe(402);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(result.body).toMatchObject({
      error: { code: 'payment_required', retryable: true, action: 'pay' },
      price: '$0.01',
      variable: false,
      accepts: [{ rail: 'test', asset: { code: 'USD', scale: 6 }, amount: '10000', flow: 'authorization' }],
    });
    expect(typeof result.body.quote).toBe('string');
    expect(ledger.authorizations()).toHaveLength(0);
    expect(ledger.charges()).toHaveLength(0);
  });

  it('rejects a proof for the wrong amount without running the handler', async () => {
    const { toll, rail } = setup();
    const result = await call(toll.price('$0.01'), { payment: 'test amount=$0.02' });

    expect(result).toMatchObject({ status: 402, handlerRuns: 0, body: { error: { code: 'proof_invalid', detail: 'amount_mismatch' } } });
    expect(rail.effects.settlements).toBe(0);
  });

  it('returns 503 without running the handler when verification cannot reach the provider', async () => {
    const { toll, rail, errors } = setup();
    rail.simulate({ verify: 'unavailable' });
    const result = await call(toll.price('$0.01'), { payment: 'test' });

    expect(result).toMatchObject({ status: 503, handlerRuns: 0 });
    expect(errors()).toHaveLength(1);
  });
});

describe('authorization flow', () => {
  it('runs the handler on a reservation and settles after it completes', async () => {
    const { toll, rail, ledger, charges } = setup();
    const result = await call(toll.price('$0.01'), { payment: 'test proof=p1' });

    expect(result.status).toBe(200);
    expect(result.headers.get('payment-receipt')).toMatch(/^test_settlement_chg_/);
    expect(charges()).toEqual(['settled/completed']);
    expect(rail.effects.settled).toEqual([10_000n]);
    expect(ledger.authorizations()[0]).toMatchObject({ consumed: { micros: 10_000n }, reserved: { micros: 0n } });
  });

  it('releases the reservation and charges nothing when the handler fails', async () => {
    const { toll, rail, ledger, charges } = setup();
    await call(toll.price('$0.01'), { payment: 'test proof=p1', handler: () => 'failed' });

    expect(charges()).toEqual(['released/failed']);
    expect(rail.effects).toMatchObject({ settlements: 0, releases: 1 });
    expect(ledger.authorizations()[0]).toMatchObject({ consumed: { micros: 0n }, reserved: { micros: 0n } });
  });

  it('accepts the same proof again after a failed attempt, and still settles only once', async () => {
    const { toll, rail } = setup();
    const gate = toll.price('$0.01');
    await call(gate, { payment: 'test proof=p1', handler: () => 'failed' });
    const retry = await call(gate, { payment: 'test proof=p1' });
    const replay = await call(gate, { payment: 'test proof=p1' });

    expect(retry.status).toBe(200);
    expect(replay).toMatchObject({ status: 409, handlerRuns: 0, body: { error: { code: 'proof_already_used', action: 'stop' } } });
    expect(rail.effects.settlements).toBe(1);
  });

  it('lets one of two concurrent requests with the same proof through', async () => {
    const { toll, rail } = setup();
    const gate = toll.price('$0.01');
    const results = await Promise.all([call(gate, { payment: 'test proof=p1' }), call(gate, { payment: 'test proof=p1' })]);

    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(rail.effects.settlements).toBe(1);
  });

  it('records unknown when settlement times out after the effect, then reconciles without settling again', async () => {
    const { toll, rail, clock, charges, errors } = setup();
    rail.simulate({ settle: 'timeout-after-effect' });
    const result = await call(toll.price('$0.01'), { payment: 'test proof=p1' });

    expect(result.status).toBe(200);
    expect(result.headers.get('payment-receipt')).toBeNull();
    expect(charges()).toEqual(['unknown/completed']);
    expect(errors()[0]).toMatchObject({ code: 'PROVIDER_TIMEOUT' });

    rail.simulate({});
    clock.advance(60_000);
    expect(await toll.reconcile({ olderThanMs: 1_000 })).toEqual({ examined: 1, resolved: 1, pending: 0 });
    expect(charges()).toEqual(['settled/completed']);
    expect(rail.effects.settlements).toBe(1);
  });

  it('retries settlement on reconciliation when the timeout happened before the effect', async () => {
    const { toll, rail, clock, charges } = setup();
    rail.simulate({ settle: 'timeout-before-effect' });
    await call(toll.price('$0.01'), { payment: 'test proof=p1' });

    rail.simulate({});
    clock.advance(60_000);
    await toll.reconcile({ olderThanMs: 1_000 });

    expect(charges()).toEqual(['settled/completed']);
    expect(rail.effects.settlements).toBe(1);
  });

  it('marks a rejected settlement as failed and reports it', async () => {
    const { toll, rail, charges, errors } = setup();
    rail.simulate({ settle: 'reject' });
    await call(toll.price('$0.01'), { payment: 'test proof=p1' });

    expect(charges()).toEqual(['failed/completed']);
    expect(errors()[0]).toMatchObject({ code: 'SETTLEMENT_REJECTED' });
  });

  it('refuses a second complete()', async () => {
    const { toll } = setup();
    const entry = await toll.price('$0.01').enter(httpContext(new Request('http://localhost/weather', { headers: { payment: 'test' } })));
    if (entry.kind !== 'admitted') throw new Error('expected admission');

    await entry.pass.complete('succeeded');
    await expect(entry.pass.complete('succeeded')).rejects.toMatchObject({ code: 'ALREADY_COMPLETED' });
  });
});

describe('crash recovery', () => {
  const enter = async (setupResult: ReturnType<typeof setup>) => {
    const entry = await setupResult.toll
      .price('$0.01')
      .enter(httpContext(new Request('http://localhost/weather', { headers: { payment: 'test proof=p1' } })));
    if (entry.kind !== 'admitted') throw new Error('expected admission');
    return entry.pass;
  };

  it('releases a charge whose handler was running when the process died', async () => {
    const context = setup();
    await enter(context);

    context.clock.advance(60_000);
    await context.toll.reconcile({ olderThanMs: 1_000 });

    expect(context.charges()).toEqual(['released/failed']);
    expect(context.rail.effects.settlements).toBe(0);
  });

  it('settles a charge that was fulfilled before the process died', async () => {
    const context = setup();
    const pass = await enter(context);
    await pass.payment.fulfill();

    context.clock.advance(60_000);
    await context.toll.reconcile({ olderThanMs: 1_000 });

    expect(context.charges()).toEqual(['settled/completed']);
    expect(context.rail.effects.settlements).toBe(1);
  });

  it('leaves charges younger than the window alone', async () => {
    const context = setup();
    await enter(context);

    context.clock.advance(500);
    expect(await context.toll.reconcile({ olderThanMs: 1_000 })).toMatchObject({ examined: 0 });
    expect(context.charges()).toEqual(['reserved/running']);
  });

  it('leaves an unknown charge pending when the provider cannot be asked', async () => {
    const { toll, rail, clock, charges } = setup();
    rail.simulate({ settle: 'timeout-after-effect' });
    await call(toll.price('$0.01'), { payment: 'test proof=p1' });

    rail.simulate({ lookup: 'unavailable' });
    clock.advance(60_000);

    expect(await toll.reconcile({ olderThanMs: 1_000 })).toEqual({ examined: 1, resolved: 0, pending: 1 });
    expect(charges()).toEqual(['unknown/completed']);
  });
});
