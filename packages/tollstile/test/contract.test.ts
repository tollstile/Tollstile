import { describe, expect, it } from 'vitest';
import { createTollstile, memoryLedger, TollstileError, type Ledger, type Requirement } from '../src/index';
import { httpContext } from '../src/testing/index';
import { call, setup } from './helpers';

const unavailable = () => new TollstileError('PROVIDER_UNAVAILABLE', 'directory unreachable');

describe('completion', () => {
  it('reports settled with the receipt', async () => {
    const { toll } = setup();
    const result = await call(toll.price('$0.01'), { payment: 'test' });

    expect(result).toMatchObject({ status: 200, body: { settlement: 'settled' } });
    expect(result.headers.get('payment-receipt')).toMatch(/^test_settlement_/);
  });

  it('withholds the output with a fresh 402 when settlement after the handler is rejected', async () => {
    const { toll, rail, charges } = setup();
    rail.simulate({ settle: 'reject' });
    const result = await call(toll.price('$0.01'), { payment: 'test proof=p1' });

    expect(result).toMatchObject({ status: 402, handlerRuns: 1, body: { error: { code: 'settlement_rejected' }, price: '$0.01' } });
    expect(typeof result.body.quote).toBe('string');
    expect(charges()).toEqual(['failed/completed']);
  });

  it('answers a plain 402 after a rejection when the handler already read the body', async () => {
    const { toll, rail } = setup();
    rail.simulate({ settle: 'reject' });
    const gate = toll.price(() => '$0.01');
    const quoted = await call(gate, { body: '{"a":1}' });
    const result = await call(gate, { body: '{"a":1}', payment: `test quote=${String(quoted.body.quote)}`, readBody: () => undefined });

    expect(result).toMatchObject({ status: 402, body: { error: { code: 'settlement_rejected' } } });
    expect(result.body.quote).toBeUndefined();
  });

  it('serves the output when the settlement outcome is unknown', async () => {
    const { toll, rail } = setup();
    rail.simulate({ settle: 'timeout-after-effect' });
    const result = await call(toll.price('$0.01'), { payment: 'test' });

    expect(result).toMatchObject({ status: 200, body: { settlement: 'unknown' } });
  });

  it('reports none when the handler failed', async () => {
    const { toll } = setup();
    const result = await call(toll.price('$0.01'), { payment: 'test', handler: () => 'failed' });

    expect(result.body.settlement).toBe('none');
  });

  it('emits an error before rethrowing when the outcome cannot be recorded', async () => {
    const ledger = memoryLedger();
    let broken = false;
    const failing: Ledger = {
      ...ledger,
      transitionCharge: (...args) => (broken ? Promise.reject(new Error('ledger down')) : ledger.transitionCharge(...args)),
    };
    const { toll, errors } = setup({ config: { ledger: failing } });
    const entry = await toll.price('$0.01').enter((await import('../src/testing/index')).httpContext(
      new Request('http://localhost/weather', { headers: { payment: 'test' } }),
    ));
    if (entry.kind !== 'admitted') throw new Error('expected admission');
    broken = true;

    await expect(entry.pass.complete('succeeded')).rejects.toThrow('ledger down');
    expect(errors().map((error) => error.message)).toEqual(['ledger down']);
  });
});

describe('challenges', () => {
  it('includes the quote nonce', async () => {
    const { toll } = setup();
    const result = await call(toll.price('$0.01'));

    expect(result.body.nonce).toMatch(/^[\w-]{16,}$/);
  });

  it('omits a rail whose challenge cannot reach its provider, and answers 503 when none are left', async () => {
    const { toll, rail, errors } = setup();
    rail.simulate({ challenge: 'unavailable' });
    const result = await call(toll.price('$0.01'));

    expect(result).toMatchObject({ status: 503, body: { error: { code: 'payment_unavailable' } } });
    expect(errors()[0]).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('spreads the wait it asks for, so clients denied together do not return together', async () => {
    const { toll, rail } = setup();
    rail.simulate({ challenge: 'unavailable' });
    const gate = toll.price('$0.01');

    const waits = new Set<string>();
    for (let i = 0; i < 40; i += 1) {
      const result = await call(gate);
      const wait = result.headers.get('retry-after') ?? '';
      expect(Number(wait)).toBeGreaterThanOrEqual(3);
      expect(Number(wait)).toBeLessThanOrEqual(7);
      expect(result.body.retryAfter).toBe(Number(wait));
      waits.add(wait);
    }

    expect(waits.size).toBeGreaterThan(1);
  });
});

describe('work an unauthenticated caller can ask for', () => {
  it('refuses a body larger than it will price, before pricing it or contacting a rail', async () => {
    const { toll, rail } = setup({ config: { maxRequestBytes: 64 } });
    let priced = 0;
    const gate = toll.price(() => {
      priced += 1;
      return '$0.01';
    });

    // A server delivers the length the client declared; this is that request, as one arrives.
    const request = new Request('http://localhost/weather', { method: 'POST', body: 'x'.repeat(100), headers: { 'content-length': '100' } });
    const entry = await gate.enter(httpContext(request));

    expect(entry.kind === 'denied' && entry.denial.status).toBe(400);
    expect(entry.kind === 'denied' && entry.denial.error.detail).toBe('request_too_large');
    expect(priced).toBe(0);
    expect(rail.effects).toMatchObject({ settlements: 0 });
  });

  it('prices a body within the limit', async () => {
    const { toll } = setup({ config: { maxRequestBytes: 64 } });

    const result = await call(toll.price('$0.01'), { method: 'POST', body: 'x'.repeat(10) });

    expect(result.status).toBe(402);
  });

  it('refuses a quote token whose signature cannot be base64url, instead of throwing', async () => {
    const { toll } = setup();

    for (const token of ['A.A', 'AAAA.AAAAA', '.', 'AAAA.']) {
      const result = await call(toll.price('$0.01'), { payment: `test quote=${token}` });
      expect(result).toMatchObject({ status: 402, body: { error: { code: 'quote_invalid' } } });
    }
  });

  it('will not hash an oversized quote token', async () => {
    const { toll } = setup();
    const gate = toll.price('$0.01');

    const result = await call(gate, { payment: `test quote=${'a'.repeat(9000)}` });

    expect(result).toMatchObject({ status: 402, body: { error: { code: 'quote_invalid' } } });
  });
});

describe('requirements', () => {
  const requirement = (check: Requirement['check']): Requirement => ({ name: 'agent', check });

  it('answers 503 when a requirement cannot reach its provider', async () => {
    const { toll, errors } = setup();
    const gate = toll.price('$0.01', { require: [requirement(() => Promise.reject(unavailable()))] });

    const result = await call(gate, { payment: 'test' });
    expect(result).toMatchObject({ status: 503, handlerRuns: 0, body: { error: { code: 'requirement_unavailable' }, requirement: 'agent' } });
    expect(errors()).toHaveLength(1);
  });

  it('lets a requirement answer 503 itself, and passes an abort signal', async () => {
    const { toll } = setup();
    let signal: AbortSignal | undefined;
    const gate = toll.price('$0.01', {
      require: [
        requirement((input) => {
          signal = input.signal;
          return Promise.resolve({ ok: false, status: 503, reason: 'directory_unavailable' });
        }),
      ],
    });

    expect(await call(gate, { payment: 'test' })).toMatchObject({ status: 503, body: { error: { code: 'requirement_unavailable', detail: 'directory_unavailable' } } });
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('still lets non-provider errors from a requirement propagate', async () => {
    const { toll } = setup();
    const gate = toll.price('$0.01', { require: [requirement(() => Promise.reject(new Error('bug')))] });

    await expect(call(gate, { payment: 'test' })).rejects.toThrow('bug');
  });
});

describe('payments that move during verification', () => {
  it('records the charge as settled before the handler and attaches a receipt', async () => {
    const { toll, rail, charges } = setup();
    rail.simulate({ verify: 'paid' });
    const result = await call(toll.price('$0.01'), { payment: 'test proof=push1' });

    expect(result).toMatchObject({ status: 200, body: { settlement: 'settled' } });
    expect(charges()).toEqual(['settled/completed']);
    expect(rail.effects.settled).toEqual([10_000n]);
  });

  it('refunds when the handler fails on a rail that can refund', async () => {
    const { toll, rail, charges } = setup();
    rail.simulate({ verify: 'paid' });
    await call(toll.price('$0.01'), { payment: 'test proof=push1', handler: () => 'failed' });

    expect(charges()).toEqual(['refunded/failed']);
    expect(rail.effects.refunds).toBe(1);
  });

  it('keeps the charge settled and reports it when the rail cannot refund, and reconcile does not guess', async () => {
    const { toll, rail, charges, errors, clock } = setup({ rail: { refund: false } });
    rail.simulate({ verify: 'paid' });
    const result = await call(toll.price('$0.01'), { payment: 'test proof=push1', handler: () => 'failed' });

    expect(result.body.settlement).toBe('none');
    expect(charges()).toEqual(['settled/failed']);
    expect(errors()[0]).toMatchObject({ code: 'REFUND_REJECTED' });

    clock.advance(60 * 60_000);
    expect(await toll.reconcile()).toMatchObject({ examined: 1, resolved: 0 });
    expect(charges()).toEqual(['settled/failed']);
    expect(errors()[1]).toMatchObject({ code: 'RECONCILIATION_SKIPPED' });
    expect(rail.effects.refunds).toBe(0);
  });
});

describe('redaction', () => {
  it('drops payer evidence from a single-use authorization once its charge is final', async () => {
    const { toll, ledger } = setup();
    const gate = toll.price('$0.01');
    const entry = await gate.enter((await import('../src/testing/index')).httpContext(
      new Request('http://localhost/weather', { headers: { payment: 'test proof=p1 signature=0xsigned' } }),
    ));
    if (entry.kind !== 'admitted') throw new Error('expected admission');
    expect(ledger.authorizations()[0]?.data).toMatchObject({ signature: '0xsigned' });

    await entry.pass.complete('succeeded');
    expect(ledger.authorizations()[0]?.data).toEqual({ proofId: 'p1', payer: 'test-payer' });
  });

  it('keeps evidence while the outcome is unknown, so reconciliation can still use it', async () => {
    const { toll, rail, ledger } = setup();
    rail.simulate({ settle: 'timeout-before-effect' });
    await call(toll.price('$0.01'), { payment: 'test proof=p1 signature=0xsigned' });

    expect(ledger.authorizations()[0]?.data).toMatchObject({ signature: '0xsigned' });
  });

  it('keeps evidence when the charge is released, so the same proof can be retried and settled', async () => {
    const { toll, ledger, rail } = setup();
    const gate = toll.price('$0.01');
    await call(gate, { payment: 'test proof=p1 signature=0xsigned', handler: () => 'failed' });
    expect(ledger.authorizations()[0]?.data).toMatchObject({ signature: '0xsigned' });

    expect((await call(gate, { payment: 'test proof=p1 signature=0xsigned' })).status).toBe(200);
    expect(ledger.authorizations()[0]?.data).toEqual({ proofId: 'p1', payer: 'test-payer' });
    expect(rail.effects.settlements).toBe(1);
  });

  it('keeps evidence on reusable authorizations', async () => {
    const { toll, ledger } = setup({ rail: { authorization: 'reusable' } });
    await call(toll.price('$0.01'), { payment: 'test proof=p1 limit=$1 signature=0xsigned' });

    expect(ledger.authorizations()[0]?.data).toMatchObject({ signature: '0xsigned' });
  });
});

describe('memory ledger', () => {
  const open = async (ledger: ReturnType<typeof memoryLedger>, limit: { currency: string; micros: bigint } | null) =>
    ledger.openAuthorization({ id: 'a1', rail: 'test', payer: 'p', kind: 'reusable', limit, quoteId: null, expiresAt: null, data: null, at: new Date(0) });
  const charge = (id: string, currency: string, micros: bigint) => ({
    id,
    authorizationId: 'a1',
    requestId: id,
    resource: 'r',
    payer: 'p',
    flow: 'authorization' as const,
    amount: { currency, micros },
    fulfillment: 'running' as const,
    requestHash: null,
    at: new Date(1),
  });

  it('refuses a charge in another currency than the authorization', async () => {
    const ledger = memoryLedger();
    await open(ledger, { currency: 'USD', micros: 1_000_000n });

    await expect(ledger.createCharge(charge('c1', 'EUR', 1n))).rejects.toMatchObject({ code: 'CURRENCY_MISMATCH' });
  });

  it('refuses mixing currencies on an authorization without a limit', async () => {
    const ledger = memoryLedger();
    await open(ledger, null);
    await ledger.createCharge(charge('c1', 'EUR', 5n));

    await expect(ledger.createCharge(charge('c2', 'USD', 5n))).rejects.toMatchObject({ code: 'CURRENCY_MISMATCH' });
  });

  it('refuses amounts outside the 64-bit range and a patched amount in another currency', async () => {
    const ledger = memoryLedger();
    await open(ledger, null);
    await expect(ledger.createCharge(charge('c1', 'USD', 2n ** 63n))).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    await ledger.createCharge(charge('c2', 'USD', 5n));

    await expect(
      ledger.transitionCharge('c2', { payment: 'reserved', fulfillment: 'running' }, { payment: 'reserved', fulfillment: 'completed' }, new Date(2), {
        amount: { currency: 'EUR', micros: 5n },
      }),
    ).rejects.toMatchObject({ code: 'CURRENCY_MISMATCH' });
  });

  it('sorts spend totals by currency code', async () => {
    const ledger = memoryLedger();
    for (const [id, currency] of [['a', 'USD'], ['b', 'EUR']] as const) {
      await ledger.openAuthorization({ id, rail: 'test', payer: 'p', kind: 'single', limit: null, quoteId: null, expiresAt: null, data: null, at: new Date(0) });
      await ledger.createCharge({ ...charge(id, currency, 1n), authorizationId: id });
    }

    expect((await ledger.spendSince('p', new Date(0))).total.map((money) => money.currency)).toEqual(['EUR', 'USD']);
  });
});

describe('concurrent reconciliation', () => {
  it('leaves a charge another worker moved first, and finishes the rest of its run', async () => {
    const { toll, rail, ledger, clock, charges } = setup();
    rail.simulate({ settle: 'timeout-after-effect' });
    for (const proof of ['a', 'b', 'c']) await call(toll.price('$0.01'), { payment: `test proof=${proof}` });
    rail.simulate({});
    clock.advance(60 * 60_000);

    // Another worker settles the first charge between this worker's read and its write.
    const [first] = ledger.charges();
    const racing: typeof ledger = {
      ...ledger,
      pendingCharges: async (before) => {
        const pending = await ledger.pendingCharges(before);
        if (first !== undefined) {
          await ledger.transitionCharge(first.id, { payment: 'unknown', fulfillment: 'completed' }, { payment: 'settled', fulfillment: 'completed' }, clock.now(), { pending: null, settlement: { reference: 'other-worker', details: null } });
        }
        return pending;
      },
    };
    const worker = createTollstile({ rails: [rail], ledger: racing, clock });

    await expect(worker.reconcile()).resolves.toMatchObject({ examined: 3 });
    expect(charges()).toEqual(['settled/completed', 'settled/completed', 'settled/completed']);
    expect(rail.effects.settlements).toBe(3);
  });
});
