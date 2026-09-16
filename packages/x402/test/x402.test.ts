import { upTo, type JsonObject } from 'tollstile';
import { mcpContext } from 'tollstile/testing';
import { describe, expect, it } from 'vitest';
import type { X402Data } from '../src/index';
import { FACILITATOR_URL, RPC_URL, USDC } from './fake-network';
import { call, challenge, decodeHeader, FACILITATOR_ADDRESS, pay, PAY_TO, PAYER, PAYER_ID, setup, sign } from './helpers';

describe('challenge', () => {
  it('answers 402 with an x402 V2 PAYMENT-REQUIRED header that carries the quote, and writes nothing', async () => {
    const { toll, ledger } = setup();
    const { result, paymentRequired } = await challenge(toll.price('$0.01'));

    expect(result.status).toBe(402);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(paymentRequired).toEqual({
      x402Version: 2,
      resource: { url: 'http://localhost/weather' },
      extensions: { 'payment-identifier': { info: { required: false }, schema: expect.objectContaining({ required: ['required'] }) as unknown } },
      accepts: [
        {
          scheme: 'exact',
          network: 'eip155:84532',
          amount: '10000',
          asset: USDC,
          payTo: PAY_TO,
          maxTimeoutSeconds: 60,
          extra: { name: 'USDC', version: '2', tollstileQuote: result.body.quote },
        },
      ],
    });
    expect(result.body.accepts).toMatchObject([{ rail: 'x402', asset: { code: 'USDC', network: 'eip155:84532', scale: 6 }, amount: '10000' }]);
    expect(ledger.charges()).toHaveLength(0);
  });

  it('offers upto with Permit2 and the facilitator address for variable prices', async () => {
    const { toll } = setup();
    const { paymentRequired } = await challenge(toll.price(upTo('$0.10')));

    expect(paymentRequired.accepts[0]).toMatchObject({
      scheme: 'upto',
      amount: '100000',
      extra: { name: 'USDC', version: '2', assetTransferMethod: 'permit2', facilitatorAddress: FACILITATOR_ADDRESS },
    });
  });
});

describe('exact', () => {
  it('pays with the echoed quote, verifies with the server requirements, and settles after the handler', async () => {
    const { toll, clock, network, ledger, charges } = setup();
    const { result, accepted } = await pay(toll.price('$0.01'), clock.now());

    expect(result.status).toBe(200);
    expect(network.calls.verify).toHaveLength(1);
    expect(network.calls.verify[0]?.paymentRequirements).toEqual(accepted);
    expect(network.calls.settle).toHaveLength(1);
    expect(decodeHeader(result.headers.get('payment-response'))).toEqual({
      success: true,
      transaction: expect.stringMatching(/^0x[0-9a-f]{64}$/) as unknown,
      network: 'eip155:84532',
      payer: PAYER_ID,
      amount: '10000',
    });
    expect(charges()).toEqual(['settled/completed']);
    expect(ledger.authorizations()[0]).toMatchObject({ rail: 'x402', payer: PAYER_ID, kind: 'single', limit: { currency: 'USD', micros: 10_000n } });
  });

  it('charges the quoted price on a dynamic route even if the price changed before the retry', async () => {
    const { toll, clock, network } = setup();
    let price = '$0.42';
    const gate = toll.price(() => price);
    const { paymentRequired } = await challenge(gate);
    price = '$0.47';

    const [accepted] = paymentRequired.accepts;
    if (accepted === undefined) throw new Error('expected an offer');
    const result = await call(gate, { payment: sign(accepted, clock.now()) });

    expect(result.status).toBe(200);
    expect(network.calls.settle[0]?.paymentRequirements).toMatchObject({ amount: '420000' });
  });

  it('pays a fixed route without a quote when the client drops it from extra', async () => {
    const { toll, clock } = setup();
    const gate = toll.price('$0.01');
    const { paymentRequired } = await challenge(gate);
    const [accepted] = paymentRequired.accepts;
    if (accepted === undefined) throw new Error('expected an offer');
    const extra = Object.fromEntries(Object.entries(accepted.extra).filter(([name]) => name !== 'tollstileQuote'));

    const result = await call(gate, { payment: sign({ ...accepted, extra }, clock.now()) });
    expect(result.status).toBe(200);
  });

  it.each([
    ['amount', { amount: '1' }],
    ['recipient', { payTo: '0x0000000000000000000000000000000000000001' }],
    ['network', { network: 'eip155:8453' }],
    ['asset', { asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }],
    ['timeout', { maxTimeoutSeconds: 3600 }],
  ])('rejects a tampered accepted %s without calling the facilitator', async (_field, tampered) => {
    const { toll, clock, network } = setup();
    const gate = toll.price('$0.01');
    const { paymentRequired } = await challenge(gate);
    const [accepted] = paymentRequired.accepts;
    if (accepted === undefined) throw new Error('expected an offer');
    const forged = { ...accepted, ...tampered };

    const result = await call(gate, { payment: sign(forged, clock.now()) });
    expect(result).toMatchObject({ status: 402, handlerRuns: 0, body: { error: { code: 'proof_invalid', detail: 'accepted_mismatch' } } });
    expect(network.calls.verify).toHaveLength(0);
  });

  it('rejects a signature to another recipient or for another amount than it accepted', async () => {
    const { toll, clock, network } = setup();
    const gate = toll.price('$0.01');

    const recipient = await pay(gate, clock.now(), { to: '0x0000000000000000000000000000000000000001' });
    const amount = await pay(gate, clock.now(), { value: '1' });

    expect(recipient.result).toMatchObject({ status: 402, handlerRuns: 0, body: { error: { code: 'proof_invalid', detail: 'recipient_mismatch' } } });
    expect(amount.result).toMatchObject({ status: 402, handlerRuns: 0, body: { error: { code: 'proof_invalid', detail: 'amount_mismatch' } } });
    expect(network.calls.verify).toHaveLength(0);
  });

  it('rejects a tampered or expired quote', async () => {
    const { toll, clock } = setup();
    const gate = toll.price('$0.01');
    const { paymentRequired } = await challenge(gate);
    const [accepted] = paymentRequired.accepts;
    if (accepted === undefined) throw new Error('expected an offer');
    const token = accepted.extra.tollstileQuote ?? '';
    // Change the character being replaced, not the one after it: when they differed, the "tampered"
    // quote was the original, and this passed a valid quote through about one run in sixty-five.
    const at = token.length - 2;
    const tampered = { ...accepted, extra: { ...accepted.extra, tollstileQuote: `${token.slice(0, at)}${token[at] === 'A' ? 'B' : 'A'}${token.slice(at + 1)}` } };

    const forged = await call(gate, { payment: sign(tampered, clock.now()) });
    clock.advance(5 * 60_000 + 1);
    const expired = await call(gate, { payment: sign(accepted, clock.now()) });

    expect(forged).toMatchObject({ status: 402, handlerRuns: 0, body: { error: { code: 'quote_invalid' } } });
    expect(expired).toMatchObject({ status: 402, handlerRuns: 0, body: { error: { code: 'quote_invalid' } } });
  });

  it('passes on the facilitator rejection reason', async () => {
    const { toll, clock } = setup();
    const { result } = await pay(toll.price('$0.01'), clock.now(), { validBefore: BigInt(Math.floor(clock.now().getTime() / 1000)) });

    expect(result).toMatchObject({ status: 402, handlerRuns: 0, body: { error: { code: 'proof_invalid', detail: 'invalid_exact_evm_payload_authorization_valid_before' } } });
  });

  it('answers 503 without running the handler when the facilitator cannot verify', async () => {
    const unreachable = setup();
    unreachable.network.simulate('unreachable');
    const down = await pay(unreachable.toll.price('$0.01'), unreachable.clock.now());

    const confused = setup();
    confused.network.simulate('unexpected-verify-error');
    const unexpected = await pay(confused.toll.price('$0.01'), confused.clock.now());

    const slow = setup();
    slow.network.simulate('hang');
    const timedOut = await pay(slow.toll.price('$0.01'), slow.clock.now());

    for (const [result, context] of [[down, unreachable], [unexpected, confused], [timedOut, slow]] as const) {
      expect(result.result).toMatchObject({ status: 503, handlerRuns: 0, body: { error: { code: 'payment_unavailable' } } });
      expect(context.ledger.charges()).toHaveLength(0);
    }
    expect(timedOut.result.status).toBe(503);
    expect(slow.errors()[0]).toMatchObject({ code: 'PROVIDER_TIMEOUT' });
  });

  it('answers a payment replayed after it settled with 409 instead of asking to pay again', async () => {
    const { toll, clock, network } = setup();
    const gate = toll.price('$0.01');
    const { payment } = await pay(gate, clock.now());

    // The facilitator rejects the used nonce; the rail still names the authorization it paid for.
    const replay = await call(gate, { payment });
    expect(replay).toMatchObject({ status: 409, handlerRuns: 0, body: { error: { code: 'proof_already_used' } } });
    expect(network.calls.verify).toHaveLength(2);
    expect(network.settlements).toBe(1);
  });

  it('answers a retry of a settled request with the same Idempotency-Key as already_paid, even after its quote expired', async () => {
    const { toll, clock, network, ledger } = setup();
    const gate = toll.price('$0.01');
    const { paymentRequired } = await challenge(gate);
    const [accepted] = paymentRequired.accepts;
    if (accepted === undefined) throw new Error('expected an offer');
    const payment = sign(accepted, clock.now());
    expect((await call(gate, { payment, idempotencyKey: 'order-42' })).status).toBe(200);

    clock.advance(10 * 60_000);
    const retry = await call(gate, { payment, idempotencyKey: 'order-42' });
    expect(retry).toMatchObject({ status: 409, handlerRuns: 0, body: { error: { code: 'already_paid' } } });
    expect(JSON.stringify(retry.body)).toContain(ledger.charges()[0]?.id ?? 'missing');
    expect(network.settlements).toBe(1);
  });

  it('asks to pay again when the facilitator rejects the signature, since a forged payload proves no identity', async () => {
    const { toll, clock, network } = setup();
    const gate = toll.price('$0.01');
    const { payment } = await pay(gate, clock.now());

    network.simulate('verify-bad-signature');
    const forged = await call(gate, { payment });
    expect(forged).toMatchObject({ status: 402, body: { error: { code: 'proof_invalid', detail: 'invalid_exact_evm_payload_signature' } } });
  });

  it('lets one of two concurrent requests with the same payment through', async () => {
    const { toll, clock, network } = setup();
    const gate = toll.price('$0.01');
    const { paymentRequired } = await challenge(gate);
    const [accepted] = paymentRequired.accepts;
    if (accepted === undefined) throw new Error('expected an offer');
    const payment = sign(accepted, clock.now());

    const results = await Promise.all([call(gate, { payment }), call(gate, { payment })]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(results.find((result) => result.status === 409)?.body.error).toMatchObject({ code: 'proof_already_used' });
    expect(network.settlements).toBe(1);
  });

  it('accepts the same payment again after the handler failed, and charges once', async () => {
    const { toll, clock, network, charges } = setup();
    const gate = toll.price('$0.01');
    const failed = await pay(gate, clock.now(), { handler: () => 'failed' });
    expect(charges()).toEqual(['released/failed']);
    expect(network.calls.settle).toHaveLength(0);

    const retry = await call(gate, { payment: failed.payment });
    expect(retry.status).toBe(200);
    expect(charges()).toEqual(['released/failed', 'settled/completed']);
    expect(network.settlements).toBe(1);
  });

  it('uses the payment-identifier extension as the idempotency key', async () => {
    const { toll, clock, network, ledger } = setup();
    const gate = toll.price('$0.01');
    const { paymentRequired } = await challenge(gate);
    const [accepted] = paymentRequired.accepts;
    if (accepted === undefined) throw new Error('expected an offer');
    const payment = sign(accepted, clock.now(), { paymentId: 'pay_7d5d747be160e280504c099d984bcfe0' });

    expect((await call(gate, { payment })).status).toBe(200);
    const retry = await call(gate, { payment });
    expect(retry).toMatchObject({ status: 409, handlerRuns: 0, body: { error: { code: 'already_paid' } } });
    expect(network.settlements).toBe(1);
    expect(ledger.charges()).toHaveLength(1);

    const malformed = await call(gate, { payment: sign(accepted, clock.now(), { nonce: 2, paymentId: 'short' }) });
    expect(malformed).toMatchObject({ status: 402, body: { error: { code: 'proof_invalid', detail: 'payment_identifier_invalid' } } });
  });

  it('answers an in-flight retry with the same payment identifier as request_in_progress', async () => {
    const { toll, clock, network } = setup();
    const gate = toll.price('$0.01');
    const { paymentRequired } = await challenge(gate);
    const [accepted] = paymentRequired.accepts;
    if (accepted === undefined) throw new Error('expected an offer');
    const payment = sign(accepted, clock.now(), { paymentId: 'pay_7d5d747be160e280504c099d984bcfe0' });
    const { httpContext } = await import('tollstile/testing');
    const request = () => new Request('http://localhost/weather', { headers: { 'payment-signature': btoa(JSON.stringify(payment)) } });

    const first = await gate.enter(httpContext(request()));
    if (first.kind !== 'admitted') throw new Error('expected admission');
    const retry = await gate.enter(httpContext(request()));
    if (retry.kind !== 'denied') throw new Error('expected a denial');
    expect(retry.denial).toMatchObject({ status: 409, error: { code: 'request_in_progress' } });

    expect((await first.pass.complete('succeeded')).settlement).toBe('settled');
    expect(network.settlements).toBe(1);
  });

  it.each(['settle-rejected', 'settle-rejected-non-2xx'] as const)('records a rejected settlement as failed (%s)', async (mode) => {
    const { toll, clock, network, charges, errors } = setup();
    const gate = toll.price('$0.01');
    const { paymentRequired } = await challenge(gate);
    const [accepted] = paymentRequired.accepts;
    if (accepted === undefined) throw new Error('expected an offer');
    const payment = sign(accepted, clock.now());
    network.simulate(mode);

    const result = await call(gate, { payment });
    expect(result).toMatchObject({ status: 402, handlerRuns: 1, settlement: 'rejected', body: { error: { code: 'settlement_rejected' } } });
    expect(result.headers.get('payment-required')).not.toBeNull();
    expect(result.headers.get('payment-response')).toBeNull();
    expect(charges()).toEqual(['failed/completed']);
    expect(errors()[0]).toMatchObject({ code: 'SETTLEMENT_REJECTED' });
  });
});

describe('reconciliation', () => {
  const settleWith = async (context: ReturnType<typeof setup>, mode: Parameters<typeof context.network.simulate>[0]) => {
    const gate = context.toll.price('$0.01');
    const { paymentRequired } = await challenge(gate);
    const [accepted] = paymentRequired.accepts;
    if (accepted === undefined) throw new Error('expected an offer');
    const payment = sign(accepted, context.clock.now());
    context.network.simulate(mode);
    const result = await call(gate, { payment });
    context.network.simulate('ok');
    return result;
  };

  it('records unknown when settlement is pending, then finds the transfer on chain without settling again', async () => {
    const context = setup();
    const result = await settleWith(context, 'settle-pending-after-effect');

    expect(result).toMatchObject({ status: 200, settlement: 'unknown' });
    expect(result.headers.get('payment-response')).toBeNull();
    expect(context.charges()).toEqual(['unknown/completed']);
    expect(context.errors()[0]).toMatchObject({ code: 'PROVIDER_TIMEOUT' });

    context.clock.advance(60_000);
    expect(await context.toll.reconcile({ olderThanMs: 1_000 })).toMatchObject({ examined: 1, resolved: 1, pending: 0 });
    expect(context.charges()).toEqual(['settled/completed']);
    expect(context.ledger.charges()[0]?.settlement).toMatchObject({ reference: expect.stringMatching(/^0x/) as unknown, details: { amount: '10000' } });
    expect(context.network.calls.settle).toHaveLength(1);
    expect(context.network.settlements).toBe(1);
  });

  it('keeps an unmined, still-valid authorization unknown, then marks it failed once it expired', async () => {
    const context = setup();
    await settleWith(context, 'settle-hang');
    expect(context.charges()).toEqual(['unknown/completed']);

    context.clock.advance(30_000);
    expect(await context.toll.reconcile({ olderThanMs: 1_000 })).toMatchObject({ examined: 1, resolved: 0, pending: 1 });
    expect(context.errors().at(-1)?.message).toMatch(/unused but valid/);

    context.clock.advance(60_000);
    await context.toll.reconcile({ olderThanMs: 1_000 });
    expect(context.charges()).toEqual(['failed/completed']);
    expect(context.network.settlements).toBe(0);
  });

  it('resolves to nothing charged when the payer cancelled the authorization before it settled', async () => {
    const context = setup();
    await settleWith(context, 'settle-hang');
    context.network.cancelAuthorization(PAYER, `0x${'1'.padStart(64, '0')}`);

    context.clock.advance(10_000);
    await context.toll.reconcile({ olderThanMs: 1_000 });
    expect(context.charges()).toEqual(['failed/completed']);
    expect(context.network.settlements).toBe(0);
  });

  it('treats a non-JSON settle answer as unknown', async () => {
    const context = setup();
    await settleWith(context, 'settle-html-502');
    expect(context.charges()).toEqual(['unknown/completed']);
  });

  it('leaves the charge unknown when the chain cannot be asked', async () => {
    const context = setup();
    await settleWith(context, 'settle-pending-after-effect');
    context.network.rpcDown(true);
    context.clock.advance(60_000);

    expect(await context.toll.reconcile({ olderThanMs: 1_000 })).toMatchObject({ resolved: 0, pending: 1 });
    expect(context.charges()).toEqual(['unknown/completed']);
  });

  it('settles a charge that was fulfilled when the process died, from the stored authorization', async () => {
    const context = setup();
    const gate = context.toll.price('$0.01');
    const { paymentRequired } = await challenge(gate);
    const [accepted] = paymentRequired.accepts;
    if (accepted === undefined) throw new Error('expected an offer');
    const headers = { 'payment-signature': btoa(JSON.stringify(sign(accepted, context.clock.now()))) };
    const { httpContext } = await import('tollstile/testing');
    const entry = await gate.enter(httpContext(new Request('http://localhost/weather', { headers })));
    if (entry.kind !== 'admitted') throw new Error('expected admission');
    await entry.pass.payment.fulfill();

    context.clock.advance(10_000);
    await context.toll.reconcile({ olderThanMs: 1_000 });
    expect(context.charges()).toEqual(['settled/completed']);
    expect(context.network.settlements).toBe(1);
  });
});

describe('redaction', () => {
  const signature = `0x${'ab'.repeat(65)}`;
  const enter = async (context: ReturnType<typeof setup>) => {
    const gate = context.toll.price('$0.01');
    const { paymentRequired } = await challenge(gate);
    const [accepted] = paymentRequired.accepts;
    if (accepted === undefined) throw new Error('expected an offer');
    const headers = { 'payment-signature': btoa(JSON.stringify(sign(accepted, context.clock.now()))) };
    const { httpContext } = await import('tollstile/testing');
    const entry = await gate.enter(httpContext(new Request('http://localhost/weather', { headers })));
    if (entry.kind !== 'admitted') throw new Error('expected admission');
    return entry.pass;
  };

  it('keeps the signed payload until the charge is final, then drops it and keeps what lookup needs', async () => {
    const context = setup();
    const pass = await enter(context);
    expect(JSON.stringify(context.ledger.authorizations()[0]?.data)).toContain(signature);

    expect((await pass.complete('succeeded')).settlement).toBe('settled');
    const [authorization] = context.ledger.authorizations();
    const [charge] = context.ledger.charges();
    if (authorization === undefined || charge === undefined) throw new Error('expected a settled charge');
    expect(JSON.stringify(authorization.data)).not.toContain(signature);
    expect(authorization.data).toMatchObject({ paymentPayload: null, paymentRequirements: null, payer: PAYER_ID, nonce: `0x${'1'.padStart(64, '0')}` });

    context.clock.advance(10_000);
    const lookup = await context.rail.lookup({ ...authorization, data: authorization.data as X402Data }, charge, { key: 'k', signal: new AbortController().signal });
    expect(lookup).toMatchObject({ status: 'settled', reference: charge.settlement?.reference });
  });

  it('keeps the signed payload while the outcome is unknown, and drops it once reconciliation resolved it', async () => {
    const context = setup();
    const pass = await enter(context);
    context.network.simulate('settle-pending-after-effect');
    expect((await pass.complete('succeeded')).settlement).toBe('unknown');
    expect(JSON.stringify(context.ledger.authorizations()[0]?.data)).toContain(signature);

    context.network.simulate('ok');
    context.clock.advance(60_000);
    await context.toll.reconcile({ olderThanMs: 1_000 });
    expect(context.charges()).toEqual(['settled/completed']);
    expect(JSON.stringify(context.ledger.authorizations()[0]?.data)).not.toContain(signature);
  });

  it('keeps the signed payload after a release so the payment can be retried, then drops it once the retry settled', async () => {
    const context = setup();
    const failed = await enter(context);
    expect((await failed.complete('failed')).settlement).toBe('none');
    expect(context.charges()).toEqual(['released/failed']);
    expect(JSON.stringify(context.ledger.authorizations()[0]?.data)).toContain(signature);

    const retry = await enter(context);
    expect((await retry.complete('succeeded')).settlement).toBe('settled');
    expect(context.charges()).toEqual(['released/failed', 'settled/completed']);
    expect(context.ledger.authorizations()).toHaveLength(1);
    expect(JSON.stringify(context.ledger.authorizations()[0]?.data)).not.toContain(signature);
    expect(context.network.settlements).toBe(1);
  });

  it('drops the signed payload when settlement was rejected', async () => {
    const context = setup();
    const pass = await enter(context);
    context.network.simulate('settle-rejected');
    expect((await pass.complete('succeeded')).denial?.body).toMatchObject({ error: { code: 'settlement_rejected' } });
    expect(JSON.stringify(context.ledger.authorizations()[0]?.data)).not.toContain(signature);
  });
});

describe('upto', () => {
  it('authorizes the maximum and settles the fulfilled amount', async () => {
    const { toll, clock, network, ledger, charges } = setup();
    const { result } = await pay(toll.price(upTo('$0.10')), clock.now(), {
      handler: async (payment) => {
        await payment.fulfill({ amount: '$0.03' });
        return 'succeeded' as const;
      },
    });

    expect(result.status).toBe(200);
    expect(network.calls.verify[0]?.paymentRequirements).toMatchObject({ scheme: 'upto', amount: '100000' });
    expect(network.calls.settle[0]?.paymentRequirements).toMatchObject({ scheme: 'upto', amount: '30000' });
    expect(decodeHeader(result.headers.get('payment-response'))).toMatchObject({ success: true, amount: '30000' });
    expect(charges()).toEqual(['settled/completed']);
    expect(ledger.authorizations()[0]?.limit).toEqual({ currency: 'USD', micros: 100_000n });
  });

  it('rejects a Permit2 signature for another spender or facilitator', async () => {
    const { toll, clock, network } = setup();
    const gate = toll.price(upTo('$0.10'));
    const spender = await pay(gate, clock.now(), { spender: '0x0000000000000000000000000000000000000002' });
    const facilitator = await pay(gate, clock.now(), { facilitator: '0x0000000000000000000000000000000000000003' });

    expect(spender.result.body.error).toMatchObject({ code: 'proof_invalid', detail: 'spender_mismatch' });
    expect(facilitator.result.body.error).toMatchObject({ code: 'proof_invalid', detail: 'facilitator_mismatch' });
    expect(network.calls.verify).toHaveLength(0);
  });

  it('reconciles a pending upto settlement from the Permit2 nonce and the proxy call', async () => {
    const context = setup();
    const gate = context.toll.price(upTo('$0.10'));
    const { paymentRequired } = await challenge(gate);
    const [accepted] = paymentRequired.accepts;
    if (accepted === undefined) throw new Error('expected an offer');
    const payment = sign(accepted, context.clock.now());
    context.network.simulate('settle-pending-after-effect');
    await call(gate, {
      payment,
      handler: async (paid) => {
        await paid.fulfill({ amount: '$0.03' });
        return 'succeeded' as const;
      },
    });
    expect(context.charges()).toEqual(['unknown/completed']);

    context.network.simulate('ok');
    context.clock.advance(60_000);
    await context.toll.reconcile({ olderThanMs: 1_000 });
    expect(context.charges()).toEqual(['settled/completed']);
    expect(context.ledger.charges()[0]?.settlement?.details).toMatchObject({ amount: '30000' });
    expect(context.network.calls.settle).toHaveLength(1);
  });

  it('does not mistake a plain transfer for the settlement of an invalidated Permit2 nonce', async () => {
    const context = setup();
    const gate = context.toll.price(upTo('$0.10'));
    const { paymentRequired } = await challenge(gate);
    const [accepted] = paymentRequired.accepts;
    if (accepted === undefined) throw new Error('expected an offer');
    context.network.simulate('settle-hang');
    await call(gate, {
      payment: sign(accepted, context.clock.now()),
      handler: async (paid) => {
        await paid.fulfill({ amount: '$0.03' });
        return 'succeeded' as const;
      },
    });
    context.network.simulate('ok');
    context.network.invalidatePermit2Nonce(PAYER, 0x1234_0001n, PAY_TO, 30_000n);

    context.clock.advance(10_000);
    await context.toll.reconcile({ olderThanMs: 1_000 });
    expect(context.charges()).toEqual(['failed/completed']);
    expect(context.network.settlements).toBe(0);
  });

  it('marks an expired, unused upto authorization failed', async () => {
    const context = setup();
    const gate = context.toll.price(upTo('$0.10'));
    const { paymentRequired } = await challenge(gate);
    const [accepted] = paymentRequired.accepts;
    if (accepted === undefined) throw new Error('expected an offer');
    context.network.simulate('settle-hang');
    await call(gate, {
      payment: sign(accepted, context.clock.now()),
      handler: async (paid) => {
        await paid.fulfill({ amount: '$0.03' });
        return 'succeeded' as const;
      },
    });

    context.network.simulate('ok');
    context.clock.advance(120_000);
    await context.toll.reconcile({ olderThanMs: 1_000 });
    expect(context.charges()).toEqual(['failed/completed']);
    expect(context.network.settlements).toBe(0);
  });
});

describe('mcp', () => {
  it('challenges in the x402 MCP style and returns the receipt in _meta', async () => {
    const { toll, clock } = setup();
    const gate = toll.price('$0.01');

    const denied = await gate.enter(mcpContext('generate_image', {}));
    if (denied.kind !== 'denied') throw new Error('expected a challenge');
    const mcp = denied.denial.offers[0]?.challenge.mcp as { style: string; paymentRequired: { resource: { url: string }; accepts: [JsonObject] } };
    expect(mcp.style).toBe('x402');
    expect(mcp.paymentRequired.resource.url).toBe('mcp://tool/generate_image');

    const accepted = mcp.paymentRequired.accepts[0] as unknown as Parameters<typeof sign>[0];
    const entry = await gate.enter(mcpContext('generate_image', { 'x402/payment': sign(accepted, clock.now()) }));
    if (entry.kind !== 'admitted') throw new Error('expected admission');
    const { settlement, receipt } = await entry.pass.complete('succeeded');
    expect(settlement).toBe('settled');

    expect(receipt.headers).toEqual([]);
    expect(receipt.meta['x402/payment-response']).toMatchObject({ success: true, network: 'eip155:84532', payer: PAYER_ID, amount: '10000' });
  });
});

describe('configuration', () => {
  const base = { network: 'eip155:84532', payTo: PAY_TO, denomination: 'USD', rpcUrl: RPC_URL } as const;

  it('declares what x402 can and cannot do', () => {
    const { rail } = setup();
    expect(rail.capabilities).toEqual({
      flows: ['authorization'],
      authorization: 'single',
      variableAmount: true,
      quotes: true,
      refund: false,
      partialRefund: false,
      lookup: true,
    });
    expect(rail.livemode).toBe(true);
    expect(setup({ upto: undefined }).rail.capabilities.variableAmount).toBe(false);
  });

  it('refuses unsafe or ambiguous configuration', async () => {
    const { x402 } = await import('../src/index');
    expect(() => x402({ ...base, network: 'eip155:8453' })).toThrow(/explicit facilitator/);
    expect(() => x402({ network: base.network, payTo: base.payTo, rpcUrl: base.rpcUrl })).toThrow(/explicit conversion basis/);
    expect(() => x402({ ...base, denomination: 'EUR' })).toThrow(/pegged to USD/);
    expect(() => x402({ ...base, network: 'eip155:1', facilitator: { url: FACILITATOR_URL } })).toThrow(/no built-in asset/);
    expect(() => x402({ ...base, payTo: 'me' })).toThrow(/payTo/);
    expect(() => x402({ ...base, maxTimeoutSeconds: 0 })).toThrow(/maxTimeoutSeconds/);
    expect(() => x402(base)).not.toThrow();
  });

  it('refuses variable prices without upto at route definition', () => {
    const { toll } = setup({ upto: undefined });
    expect(() => toll.price(upTo('$0.10'))).toThrow(expect.objectContaining({ code: 'CAPABILITY_MISSING' }) as Error);
  });

  it('does not offer a price in a currency the asset is not pegged to', async () => {
    const { rail } = setup();
    expect(await rail.offer({ resource: 'GET /weather', price: { currency: 'EUR', micros: 10_000n }, variable: false })).toBeNull();
  });

  it('converts custom assets with a merchant rate', async () => {
    const { rail } = setup({ denomination: undefined, rate: (price) => Promise.resolve(price.micros * 2n) });
    expect(await rail.offer({ resource: 'GET /weather', price: { currency: 'USD', micros: 10_000n }, variable: false })).toMatchObject({
      amount: '20000',
      basis: 'rate',
    });
  });
});
