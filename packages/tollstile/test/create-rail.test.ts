import { describe, expect, it } from 'vitest';
import { createRail, createTollstile, memoryLedger, type RailDefinition, type Verification } from '../src/index';
import { httpContext } from '../src/testing/index';

type Data = { readonly paymentId: string };

/** The smallest definition a rail author can write: a proof in a header, settled by an imaginary provider. */
function definition(overrides: Partial<RailDefinition<'acme-pay', Data>> = {}): RailDefinition<'acme-pay', Data> {
  return {
    name: 'acme-pay',
    livemode: false,
    capabilities: { flows: ['authorization'], authorization: 'single' },
    offer: ({ price }) => Promise.resolve({ rail: 'acme-pay', asset: { code: price.currency, network: null, scale: 6 }, amount: price.micros.toString(), basis: 'par', details: {} }),
    challenge: () => Promise.resolve({ headers: [['acme-payment', 'required']], accepts: {}, mcp: { style: 'acme' } }),
    verify: (context, terms) => {
      const id = context.request?.headers.get('acme-payment-id');
      if (id === undefined || id === null) return Promise.resolve({ status: 'absent' });
      return Promise.resolve({ status: 'valid', proofId: id, payer: 'acct_1', quote: null, limit: terms.price, expiresAt: null, data: { paymentId: id } });
    },
    settle: (authorization) => Promise.resolve({ status: 'settled', reference: `cap_${authorization.data.paymentId}`, details: {} }),
    lookup: () => Promise.resolve({ status: 'none' }),
    ...overrides,
  };
}

const enter = async (rail: ReturnType<typeof createRail>, headers: Record<string, string> = {}) => {
  const toll = createTollstile({ rails: [rail], ledger: memoryLedger() });
  return toll.price('$0.01').enter(httpContext(new Request('http://localhost/report', { headers })));
};

describe('createRail', () => {
  it('fills safe defaults for what a rail need not decide', async () => {
    const rail = createRail(definition());

    expect(rail.capabilities).toEqual({
      flows: ['authorization'],
      authorization: 'single',
      variableAmount: false,
      quotes: false,
      refund: false,
      partialRefund: false,
      lookup: true,
    });
    expect(await rail.refund({} as never, {} as never, { key: 'k', signal: new AbortController().signal })).toEqual({ status: 'rejected', reason: 'refund_unsupported' });
    expect("redact" in rail).toBe(false);

    const entry = await enter(rail, { 'acme-payment-id': 'pay_1' });
    if (entry.kind !== 'admitted') throw new Error('expected admission');
    expect(await entry.pass.complete('succeeded')).toMatchObject({ settlement: 'settled', receipt: { headers: [], meta: {} } });
  });

  it('declares refunds when refund() is given', () => {
    const rail = createRail(definition({ refund: () => Promise.resolve({ status: 'refunded', reference: 'ref_1' }), capabilities: { flows: ['upfront'], authorization: 'single' } }));
    expect(rail.capabilities).toMatchObject({ refund: true, flows: ['upfront'] });
  });

  it('refuses declarations no route could use', () => {
    expect(() => createRail(definition({ name: 'Acme Pay' as 'acme-pay' }))).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    expect(() => createRail(definition({ capabilities: { flows: [], authorization: 'single' } }))).toThrow(/at least one flow/);
    expect(() => createRail(definition({ capabilities: { flows: ['upfront'], authorization: 'single' } }))).toThrow(/must refund/);
    expect(() => createRail(definition({ capabilities: { flows: ['authorization'], authorization: 'single', partialRefund: true } }))).toThrow(/requires refund/);
  });

  it.each<[string, Verification<Data>]>([
    ['an empty proofId', { status: 'valid', proofId: '', payer: 'acct_1', quote: null, limit: null, expiresAt: null, data: { paymentId: 'x' } }],
    ['an untrimmed payer', { status: 'valid', proofId: 'p', payer: ' acct_1', quote: null, limit: null, expiresAt: null, data: { paymentId: 'x' } }],
    ['a sentence as the reason', { status: 'invalid', reason: 'The signature did not match.' }],
  ])('fails loudly instead of admitting a verify result with %s', async (_label, result) => {
    const rail = createRail(definition({ verify: () => Promise.resolve(result) }));
    await expect(enter(rail, { 'acme-payment-id': 'pay_1' })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('refuses a quote from a rail that does not declare quotes', async () => {
    const rail = createRail(
      definition({
        verify: async (_context, terms) => {
          const quote = (await terms.openQuote('forged')) ?? null;
          return { status: 'valid', proofId: 'p', payer: 'acct_1', quote: quote ?? ({ id: 'q' } as never), limit: null, expiresAt: null, data: { paymentId: 'p' } };
        },
      }),
    );
    await expect(enter(rail)).rejects.toThrow(/does not declare capabilities.quotes/);
  });
});
