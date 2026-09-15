import { describe, expect, it } from 'vitest';
import { httpContext } from '../src/testing/index';
import { call, setup } from './helpers';

const upfront = { flow: 'upfront' } as const;

describe('upfront flow', () => {
  it('settles before the handler and completes after it', async () => {
    const { toll, rail, charges } = setup();
    const result = await call(toll.price('$0.01', upfront), {
      payment: 'test proof=p1',
      handler: () => {
        expect(rail.effects.settlements).toBe(1);
        return 'succeeded';
      },
    });

    expect(result.status).toBe(200);
    expect(charges()).toEqual(['settled/completed']);
  });

  it('refunds once when the handler fails', async () => {
    const { toll, rail, charges } = setup();
    await call(toll.price('$0.01', upfront), { payment: 'test proof=p1', handler: () => 'failed' });

    expect(charges()).toEqual(['refunded/failed']);
    expect(rail.effects.refunds).toBe(1);
  });

  it('keeps the charge when the handler fails after fulfilling', async () => {
    const { toll, rail, charges } = setup();
    await call(toll.price('$0.01', upfront), {
      payment: 'test proof=p1',
      handler: async (payment) => {
        await payment.fulfill();
        return 'failed' as const;
      },
    });

    expect(charges()).toEqual(['settled/completed']);
    expect(rail.effects.refunds).toBe(0);
  });

  it('answers 503 without running the handler when settlement is ambiguous, then refunds on reconciliation', async () => {
    const { toll, rail, clock, charges } = setup();
    rail.simulate({ settle: 'timeout-after-effect' });
    const result = await call(toll.price('$0.01', upfront), { payment: 'test proof=p1' });
    expect(result).toMatchObject({ status: 503, handlerRuns: 0 });

    rail.simulate({});
    clock.advance(60_000);
    await toll.reconcile({ olderThanMs: 1_000 });

    expect(charges()).toEqual(['refunded/failed']);
    expect(rail.effects).toMatchObject({ settlements: 1, refunds: 1 });
  });

  it('releases on reconciliation when an ambiguous settlement never happened', async () => {
    const { toll, rail, clock, charges } = setup();
    rail.simulate({ settle: 'timeout-before-effect' });
    await call(toll.price('$0.01', upfront), { payment: 'test proof=p1' });

    rail.simulate({});
    clock.advance(60_000);
    await toll.reconcile({ olderThanMs: 1_000 });

    expect(charges()).toEqual(['released/failed']);
    expect(rail.effects.settlements).toBe(0);
  });

  it('completes an ambiguous refund on reconciliation without refunding twice', async () => {
    const { toll, rail, clock, charges } = setup();
    rail.simulate({ refund: 'timeout-after-effect' });
    await call(toll.price('$0.01', upfront), { payment: 'test proof=p1', handler: () => 'failed' });
    expect(charges()).toEqual(['unknown/failed']);

    rail.simulate({});
    clock.advance(60_000);
    await toll.reconcile({ olderThanMs: 1_000 });

    expect(charges()).toEqual(['refunded/failed']);
    expect(rail.effects.refunds).toBe(1);
  });

  it('refunds a charge that settled but whose handler never finished before a crash', async () => {
    const { toll, rail, clock, charges } = setup();
    const entry = await toll
      .price('$0.01', upfront)
      .enter(httpContext(new Request('http://localhost/weather', { headers: { payment: 'test proof=p1' } })));
    expect(entry.kind).toBe('admitted');

    clock.advance(60_000);
    await toll.reconcile({ olderThanMs: 1_000 });

    expect(charges()).toEqual(['refunded/failed']);
    expect(rail.effects.refunds).toBe(1);
  });
});
