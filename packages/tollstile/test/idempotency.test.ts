import { describe, expect, it } from 'vitest';
import { credits, memoryBalance, payPerCall, testRail, type Outcome, type Payment, type Rail } from '../src/index';
import { httpContext, mcpContext } from '../src/testing/index';
import { call, setup } from './helpers';

const reusable = 'test proof=credential limit=$1';

describe('idempotency keys', () => {
  it('answers a retried reusable-credential request as already paid, without charging or running it again', async () => {
    const { toll, rail } = setup({ rail: { authorization: 'reusable' } });
    const gate = toll.price('$0.10');

    const first = await call(gate, { payment: reusable, idempotencyKey: 'order-1' });
    const retry = await call(gate, { payment: reusable, idempotencyKey: 'order-1' });

    expect(first.status).toBe(200);
    expect(retry).toMatchObject({
      status: 409,
      handlerRuns: 0,
      body: { error: { code: 'already_paid', retryable: false, action: 'stop' }, chargeId: expect.stringMatching(/^chg_/) as unknown },
    });
    expect(rail.effects.settled).toEqual([100_000n]);
  });

  it('does not charge a retry that signed a new payment under the same key', async () => {
    const { toll, rail, ledger } = setup();
    const gate = toll.price('$0.01');
    expect((await call(gate, { payment: 'test proof=first', idempotencyKey: 'order-9' })).status).toBe(200);

    const resigned = await call(gate, { payment: 'test proof=second', idempotencyKey: 'order-9' });
    expect(resigned).toMatchObject({ status: 409, handlerRuns: 0, body: { error: { code: 'already_paid' } } });
    expect(rail.effects.settlements).toBe(1);
    expect(ledger.charges()).toHaveLength(1);
  });

  it('does not let one payer occupy another payer\'s key', async () => {
    const { toll, rail } = setup();
    const gate = toll.price('$0.01');
    await call(gate, { payment: 'test proof=a payer=alice', idempotencyKey: 'shared' });

    expect((await call(gate, { payment: 'test proof=b payer=bob', idempotencyKey: 'shared' })).status).toBe(200);
    expect(rail.effects.settlements).toBe(2);
  });

  it('returns the result reference the handler recorded to a retry of a paid request', async () => {
    const { toll } = setup({ rail: { authorization: 'reusable' } });
    const gate = toll.price('$0.10');
    const handler = async (payment: Payment<readonly Rail[]>) => {
      await payment.fulfill({ resultRef: 'jobs/42' });
      return 'succeeded' as const;
    };
    await call(gate, { payment: reusable, idempotencyKey: 'k1', handler });

    const retry = await call(gate, { payment: reusable, idempotencyKey: 'k1', handler });
    expect(retry).toMatchObject({ status: 409, handlerRuns: 0, body: { error: { code: 'already_paid' }, result: 'jobs/42' } });
  });

  it('records the result reference on upfront charges too, and refuses an oversized one', async () => {
    const { toll, ledger } = setup();
    const gate = toll.price('$0.01', { flow: 'upfront' });
    await call(gate, {
      payment: 'test proof=u1',
      handler: async (payment): Promise<Outcome> => {
        await payment.fulfill({ resultRef: 'files/out.png' });
        return 'succeeded';
      },
    });
    expect(ledger.charges()[0]?.resultRef).toBe('files/out.png');

    await expect(
      call(gate, { payment: 'test proof=u2', handler: async (payment): Promise<Outcome> => {
          await payment.fulfill({ resultRef: 'x'.repeat(1025) });
          return 'succeeded';
        },
      }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('charges a reusable credential again without a key, as documented', async () => {
    const { toll, rail } = setup({ rail: { authorization: 'reusable' } });
    const gate = toll.price('$0.10');
    await call(gate, { payment: reusable });
    await call(gate, { payment: reusable });

    expect(rail.effects.settled).toEqual([100_000n, 100_000n]);
  });

  it('answers a single-use proof retried with its key as already paid, and without a key as a used proof', async () => {
    const { toll } = setup();
    const gate = toll.price('$0.01');
    await call(gate, { payment: 'test proof=p1', idempotencyKey: 'k1' });

    expect((await call(gate, { payment: 'test proof=p1', idempotencyKey: 'k1' })).body.error).toMatchObject({ code: 'already_paid' });
    expect((await call(gate, { payment: 'test proof=p1' })).body.error).toMatchObject({ code: 'proof_already_used' });
  });

  it('refuses the same key for a different request', async () => {
    const { toll, rail } = setup({ rail: { authorization: 'reusable' } });
    const gate = toll.price('$0.10', { resource: 'translate' });
    await call(gate, { method: 'POST', body: '{"text":"hello"}', payment: reusable, idempotencyKey: 'k1' });

    const reused = await call(gate, { method: 'POST', body: '{"text":"other"}', payment: reusable, idempotencyKey: 'k1' });
    expect(reused).toMatchObject({ status: 422, body: { error: { code: 'idempotency_key_reused', action: 'fix_request' } } });
    expect(rail.effects.settlements).toBe(1);
  });

  it('asks a retry to wait while the first attempt is still running', async () => {
    const { toll } = setup({ rail: { authorization: 'reusable' } });
    const gate = toll.price('$0.10');
    const request = () => new Request('http://localhost/weather', { headers: { payment: reusable, 'idempotency-key': 'k1' } });

    const first = await gate.enter(httpContext(request()));
    if (first.kind !== 'admitted') throw new Error('expected admission');
    const retry = await gate.enter(httpContext(request()));

    expect(retry).toMatchObject({ kind: 'denied', denial: { status: 409, error: { code: 'request_in_progress', action: 'retry_later' } } });
    if (retry.kind === 'denied') expect(retry.denial.headers).toContainEqual(['retry-after', '5']);
    expect((await first.pass.complete('succeeded')).settlement).toBe('settled');
  });

  it('runs the request again when the first attempt was released', async () => {
    const { toll, rail } = setup({ rail: { authorization: 'reusable' } });
    const gate = toll.price('$0.10');
    let outcome: Outcome = 'failed';
    const handler = () => outcome;

    expect((await call(gate, { payment: reusable, idempotencyKey: 'k1', handler })).status).toBe(500);
    outcome = 'succeeded';
    expect((await call(gate, { payment: reusable, idempotencyKey: 'k1', handler })).status).toBe(200);
    expect((await call(gate, { payment: reusable, idempotencyKey: 'k1', handler })).body.error).toMatchObject({ code: 'already_paid' });
    expect(rail.effects.settled).toEqual([100_000n]);
  });

  it('asks a retry to wait while the settlement outcome is unknown', async () => {
    const { toll, rail } = setup({ rail: { authorization: 'reusable' } });
    const gate = toll.price('$0.10');
    rail.simulate({ settle: 'timeout-after-effect' });
    await call(gate, { payment: reusable, idempotencyKey: 'k1' });
    rail.simulate({});

    const retry = await call(gate, { payment: reusable, idempotencyKey: 'k1' });
    expect(retry).toMatchObject({ status: 503, handlerRuns: 0, body: { error: { code: 'payment_outcome_unknown' } } });
    expect(rail.effects.settlements).toBe(1);
  });

  it('asks for a new payment when the first attempt\'s settlement was rejected', async () => {
    const { toll, rail } = setup({ rail: { authorization: 'reusable' } });
    const gate = toll.price('$0.10');
    rail.simulate({ settle: 'reject' });
    await call(gate, { payment: reusable, idempotencyKey: 'k1' });

    const retry = await call(gate, { payment: reusable, idempotencyKey: 'k1' });
    expect(retry).toMatchObject({ status: 402, handlerRuns: 0, body: { error: { code: 'settlement_rejected', action: 'pay' } } });
    expect(typeof retry.body.quote).toBe('string');
  });

  it('does not reserve credits twice for a retried request', async () => {
    const { toll } = setup();
    const balance = memoryBalance({ alice: '$1' });
    const gate = toll.price('$0.25', { access: [credits({ balance }), payPerCall()] });
    const alice = { id: 'alice' };

    expect((await call(gate, { principal: alice, idempotencyKey: 'k1' })).status).toBe(200);
    expect((await call(gate, { principal: alice, idempotencyKey: 'k1' })).body.error).toMatchObject({ code: 'already_paid' });
    expect(balance.available('alice')).toEqual({ currency: 'USD', micros: 750_000n });
  });

  it('uses a payment identifier from the rail when the client sends no key', async () => {
    const { toll, rail } = setup({ rail: { authorization: 'reusable' } });
    const gate = toll.price('$0.10');
    await call(gate, { payment: `${reusable} paymentId=pay_1` });

    expect((await call(gate, { payment: `${reusable} paymentId=pay_1` })).body.error).toMatchObject({ code: 'already_paid' });
    expect(rail.effects.settlements).toBe(1);
  });

  it('reads the key from MCP _meta', async () => {
    const { toll, rail } = setup({ rail: { authorization: 'reusable' } });
    const gate = toll.price('$0.10', { resource: 'tool:forecast' });
    const meta = { 'tollstile/test-payment': reusable, 'tollstile/idempotency-key': 'k1' };

    const first = await gate.enter(mcpContext('forecast', meta));
    if (first.kind !== 'admitted') throw new Error('expected admission');
    await first.pass.complete('succeeded');

    expect(await gate.enter(mcpContext('forecast', meta))).toMatchObject({ kind: 'denied', denial: { error: { code: 'already_paid' } } });
    expect(rail.effects.settlements).toBe(1);
  });

  describe('when the provider rejects a proof it already settled', () => {
    /** A provider that refuses a used nonce before core sees the ledger, like an x402 facilitator. */
    function rejectsUsedProofs(rail: Rail): Rail {
      const used = new Set<string>();
      return {
        ...rail,
        async verify(context, terms, operation) {
          const result = await rail.verify(context, terms, operation);
          if (result.status !== 'valid') return result;
          if (used.has(result.proofId)) {
            return { status: 'invalid', reason: 'nonce_already_used', proofId: result.proofId, ...(result.idempotencyKey === undefined ? {} : { idempotencyKey: result.idempotencyKey }) };
          }
          return result;
        },
        async settle(authorization, charge, operation) {
          used.add((authorization.data as { proofId: string }).proofId);
          return rail.settle(authorization, charge, operation);
        },
      };
    }

    it('answers a keyed retry as already paid, not with a request to pay again', async () => {
      const { toll, rail } = setup({ config: { rails: [rejectsUsedProofs(testRail())] } });
      const gate = toll.price('$0.01');
      await call(gate, { payment: 'test proof=p1', idempotencyKey: 'k1' });

      const retry = await call(gate, { payment: 'test proof=p1', idempotencyKey: 'k1' });
      expect(retry).toMatchObject({ status: 409, body: { error: { code: 'already_paid', action: 'stop' } } });
      expect(rail.effects.settlements).toBe(0);
    });

    it('answers a retry identified only by the rail\'s payment identifier as already paid', async () => {
      const { toll } = setup({ config: { rails: [rejectsUsedProofs(testRail())] } });
      const gate = toll.price('$0.01');
      await call(gate, { payment: 'test proof=p1 paymentId=pay_1' });

      expect(await call(gate, { payment: 'test proof=p1 paymentId=pay_1' })).toMatchObject({ status: 409, body: { error: { code: 'already_paid' } } });
    });

    it('answers an unkeyed replay as a used proof', async () => {
      const { toll } = setup({ config: { rails: [rejectsUsedProofs(testRail())] } });
      const gate = toll.price('$0.01');
      await call(gate, { payment: 'test proof=p1' });

      expect(await call(gate, { payment: 'test proof=p1' })).toMatchObject({ status: 409, body: { error: { code: 'proof_already_used' } } });
    });

    it('still asks for payment when the rejected proof was never charged here', async () => {
      const { toll } = setup({ config: { rails: [rejectsUsedProofs(testRail())] } });
      const gate = toll.price('$0.01');

      expect(await call(gate, { payment: 'test proof=p1 amount=$5' })).toMatchObject({ status: 402, body: { error: { code: 'proof_invalid' } } });
    });
  });

  it('refuses a malformed key before anything else', async () => {
    const { toll } = setup();
    const result = await call(toll.price('$0.01'), { payment: 'test', idempotencyKey: 'has space' });

    expect(result).toMatchObject({ status: 400, handlerRuns: 0, body: { error: { code: 'invalid_request' } } });
  });
});
