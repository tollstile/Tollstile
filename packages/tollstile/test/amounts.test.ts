import { describe, expect, it } from 'vitest';
import { upTo } from '../src/index';
import { call, payWithQuote, setup } from './helpers';

describe('variable prices', () => {
  it('settles the fulfilled amount, not the maximum', async () => {
    const { toll, rail, ledger } = setup();
    const result = await payWithQuote(toll.price(upTo('$0.50')), '', {
      handler: async (payment) => {
        await payment.fulfill({ amount: '$0.12' });
        return 'succeeded' as const;
      },
    });

    expect(result.status).toBe(200);
    expect(rail.effects.settled).toEqual([120_000n]);
    expect(ledger.authorizations()[0]).toMatchObject({ consumed: { micros: 120_000n }, reserved: { micros: 0n } });
  });

  it('charges nothing and reports it when the handler never calls fulfill()', async () => {
    const { toll, rail, charges, errors } = setup();
    await payWithQuote(toll.price(upTo('$0.50')));

    expect(rail.effects.settlements).toBe(0);
    expect(charges()).toEqual(['released/failed']);
    expect(errors()[0]).toMatchObject({ code: 'FULFILLMENT_MISSING' });
  });

  it('releases a zero-amount fulfillment instead of settling', async () => {
    const { toll, rail, charges } = setup();
    await payWithQuote(toll.price(upTo('$0.50')), '', {
      handler: async (payment) => {
        await payment.fulfill({ amount: '$0' });
        return 'succeeded' as const;
      },
    });

    expect(rail.effects.settlements).toBe(0);
    expect(charges()).toEqual(['released/completed']);
  });

  it('refuses a fulfilled amount above the maximum, and a different amount on a fixed price', async () => {
    const { toll } = setup();
    const variable = payWithQuote(toll.price(upTo('$0.50')), '', {
      handler: async (payment) => {
        await payment.fulfill({ amount: '$0.51' });
        return 'succeeded' as const;
      },
    });
    await expect(variable).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });

    const fixed = call(toll.price('$0.50'), {
      payment: 'test',
      handler: async (payment) => {
        await payment.fulfill({ amount: '$0.10' });
        return 'succeeded' as const;
      },
    });
    await expect(fixed).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
  });

  it('requires the authorization flow for variable prices', () => {
    const { toll } = setup();
    expect(() => toll.price(upTo('$1'), { flow: 'upfront' })).toThrow(expect.objectContaining({ code: 'CAPABILITY_MISSING' }));
  });
});

describe('reusable authorizations', () => {
  it('draws many charges from one authorization until its limit', async () => {
    const { toll, rail, ledger } = setup({ rail: { authorization: 'reusable' } });
    const gate = toll.price('$0.40');
    const credential = 'test proof=token1 limit=$1.00';

    const statuses = [];
    for (let index = 0; index < 3; index += 1) statuses.push((await call(gate, { payment: credential })).status);

    expect(statuses).toEqual([200, 200, 402]);
    expect(rail.effects.settled).toEqual([400_000n, 400_000n]);
    expect(ledger.authorizations()).toHaveLength(1);
    expect(ledger.authorizations()[0]).toMatchObject({ consumed: { micros: 800_000n } });
  });

  it('returns capacity when a charge is released', async () => {
    const { toll, rail } = setup({ rail: { authorization: 'reusable' } });
    const gate = toll.price('$0.60');
    const credential = 'test proof=token1 limit=$1.00';

    await call(gate, { payment: credential, handler: () => 'failed' });
    const next = await call(gate, { payment: credential });

    expect(next.status).toBe(200);
    expect(rail.effects.settled).toEqual([600_000n]);
  });

  it('reports insufficient capacity clearly', async () => {
    const { toll } = setup({ rail: { authorization: 'reusable' } });
    const result = await call(toll.price('$2'), { payment: 'test proof=token1 limit=$1.00' });

    expect(result).toMatchObject({ status: 402, body: { reason: 'insufficient_authorization' } });
  });
});

describe('money', () => {
  it('parses symbols and codes exactly and refuses more than 6 decimals', async () => {
    const { parseMoney, formatMoney, toAssetUnits } = await import('../src/index');
    expect(parseMoney('$0.04')).toEqual({ currency: 'USD', micros: 40_000n });
    expect(parseMoney('12.5 EUR')).toEqual({ currency: 'EUR', micros: 12_500_000n });
    expect(formatMoney(parseMoney('$0.000001'))).toBe('$0.000001');
    expect(() => parseMoney('$0.0000001')).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    expect(toAssetUnits(parseMoney('$0.04'), 2)).toBe(4n);
    expect(toAssetUnits(parseMoney('$0.04'), 18)).toBe(40_000_000_000_000_000n);
    expect(() => toAssetUnits(parseMoney('$0.001'), 2)).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
  });
});
