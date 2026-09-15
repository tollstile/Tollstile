import { describe, expect, it } from 'vitest';
import { money, parseMoney } from 'tollstile';
import { fakeClock, httpContext } from 'tollstile/testing';
import { mppStripe, type MppStripeOptions } from '../src/index';
import { issueChallenge } from '../src/challenge';
import { fakeStripe } from './fake-stripe';
import { authorization, callTool, challengeFor, decodeJson, get, parseChallenges, setup } from './mpp-client';

const SECRET = 'mpp-challenge-secret-0123456789abcdef';

function stripeSetup(overrides: Partial<MppStripeOptions> = {}) {
  const stripe = fakeStripe();
  const clock = fakeClock();
  const rail = mppStripe({
    realm: 'api.example.com',
    secret: SECRET,
    secretKey: 'sk_test_123',
    networkId: 'profile_test',
    fetch: stripe.fetch,
    clock,
    searchLagMs: 1_000,
    ...overrides,
  });
  return { stripe, rail, ...setup(rail, clock) };
}

describe('mppStripe challenge', () => {
  it('answers 402 with an HMAC-bound Payment challenge carrying the quote in opaque', async () => {
    const { toll, ledger } = stripeSetup();
    const result = await get(toll.price('$1.00'));

    expect(result.status).toBe(402);
    const [challenge] = parseChallenges(result.headers);
    expect(challenge).toMatchObject({ realm: 'api.example.com', method: 'stripe', intent: 'charge' });
    expect(challenge?.header).toBeUndefined();
    expect(challenge?.expires).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(decodeJson(challenge?.request ?? '')).toEqual({
      amount: '100',
      currency: 'usd',
      methodDetails: { networkId: 'profile_test', paymentMethodTypes: ['card'] },
    });
    expect(decodeJson(challenge?.opaque ?? '')).toEqual({ tollstile_quote: result.body.quote });
    expect(result.body.accepts).toMatchObject([{ rail: 'mpp-stripe', asset: { code: 'USD', scale: 2 }, amount: '100', flow: 'upfront' }]);
    expect(ledger.charges()).toHaveLength(0);
  });

  it('offers nothing below Stripe’s minimum or finer than a cent', async () => {
    const { rail } = stripeSetup();
    const offer = (amount: string) => rail.offer({ resource: 'GET /report', price: parseMoney(amount), variable: false });

    expect(await offer('$0.49')).toBeNull();
    expect(await offer('$0.505')).toBeNull();
    expect(await offer('0.50 XTS')).toBeNull();
    expect(await offer('$0.50')).toMatchObject({ amount: '50', asset: { scale: 2 } });
    expect(await offer('¥50')).toMatchObject({ amount: '50', asset: { code: 'JPY', scale: 0 } });
  });

  it('uses the MCP payment-required convention', async () => {
    const { toll } = stripeSetup();
    const result = await callTool(toll.price('$1.00'));

    expect(result.status).toBe(402);
    expect(result.mcp).toMatchObject([
      { style: 'mpp', challenge: { method: 'stripe', intent: 'charge', request: { amount: '100', currency: 'usd' } } },
    ]);
  });
});

describe('mppStripe payment', () => {
  it('confirms a PaymentIntent before the handler and returns a receipt', async () => {
    const { toll, stripe, charges } = stripeSetup();
    const gate = toll.price('$1.00');
    const challenge = await challengeFor(gate);
    const result = await get(gate, { authorization: authorization(challenge, { spt: 'spt_ok' }) });

    expect(result).toMatchObject({ status: 200, handlerRuns: 1 });
    expect(charges()).toEqual(['settled/completed']);
    const [create] = stripe.requests;
    expect(create?.headers.get('idempotency-key')).toBe(`tollstile_mpp_${challenge.id ?? ''}`);
    expect(create?.headers.get('stripe-version')).toBe('2026-07-29.preview');
    expect(Object.fromEntries(create?.body ?? [])).toMatchObject({
      amount: '100',
      currency: 'usd',
      confirm: 'true',
      shared_payment_granted_token: 'spt_ok',
      'metadata[challenge_id]': challenge.id,
    });

    expect(result.headers.get('cache-control')).toBe('private');
    expect(decodeJson(result.headers.get('payment-receipt') ?? '')).toMatchObject({
      status: 'success',
      method: 'stripe',
      reference: 'pi_1',
      challengeId: challenge.id,
    });
  });

  it('can send the SPT under Stripe’s payment_method_data parameter', async () => {
    const { toll, stripe } = stripeSetup({ sptParameter: 'payment_method_data[shared_payment_granted_token]', apiVersion: '2026-04-22.preview' });
    const gate = toll.price('$1.00');
    await get(gate, { authorization: authorization(await challengeFor(gate), { spt: 'spt_ok' }) });

    expect(stripe.requests[0]?.body.get('payment_method_data[shared_payment_granted_token]')).toBe('spt_ok');
    expect(stripe.requests[0]?.headers.get('stripe-version')).toBe('2026-04-22.preview');
  });

  it('pays over MCP with the credential in _meta and returns the receipt in _meta', async () => {
    const { toll } = stripeSetup();
    const gate = toll.price('$1.00');
    const denied = await callTool(gate);
    const challenge = denied.mcp[0]?.challenge;
    const result = await callTool(gate, { 'org.paymentauth/credential': { challenge: challenge ?? null, payload: { spt: 'spt_ok' } } });

    expect(result.status).toBe(200);
    expect(result.meta['org.paymentauth/receipt']).toMatchObject({ status: 'success', method: 'stripe', reference: 'pi_1' });
    expect((result.meta['org.paymentauth/receipt'] as Record<string, unknown>).challengeId).toBe((challenge as Record<string, unknown>).id);
  });

  it('refunds once when the handler fails', async () => {
    const { toll, stripe, charges } = stripeSetup();
    const gate = toll.price('$1.00');
    const result = await get(gate, { authorization: authorization(await challengeFor(gate), { spt: 'spt_ok' }), outcome: 'failed' });

    expect(result.headers.get('payment-receipt')).toBeNull();
    expect(charges()).toEqual(['refunded/failed']);
    expect(stripe.refunds).toMatchObject([{ payment_intent: 'pi_1', amount: 100, status: 'succeeded' }]);
  });

  it('rejects a declined card with a fresh challenge and without running the handler', async () => {
    const { toll, charges } = stripeSetup();
    const gate = toll.price('$1.00');
    const result = await get(gate, { authorization: authorization(await challengeFor(gate), { spt: 'spt_declined' }) });

    expect(result).toMatchObject({ status: 402, handlerRuns: 0, body: { error: { code: 'payment_rejected' } } });
    expect(parseChallenges(result.headers)).toHaveLength(1);
    expect(charges()).toEqual(['failed/pending']);
  });

  it('rejects a PaymentIntent that needs customer action', async () => {
    const { toll } = stripeSetup();
    const gate = toll.price('$1.00');
    const result = await get(gate, { authorization: authorization(await challengeFor(gate), { spt: 'spt_action' }) });

    expect(result).toMatchObject({ status: 402, handlerRuns: 0 });
  });
});

describe('mppStripe verification failures', () => {
  it('rejects a tampered request, a tampered opaque, and a forged id', async () => {
    const { toll, stripe } = stripeSetup();
    const gate = toll.price('$1.00');
    const challenge = await challengeFor(gate);
    const cheaper = Buffer.from(JSON.stringify({ ...decodeJson(challenge.request ?? ''), amount: '1' })).toString('base64url');

    for (const tampered of [
      { ...challenge, request: cheaper },
      { ...challenge, opaque: Buffer.from('{"tollstile_quote":"x"}').toString('base64url') },
      { ...challenge, id: 'x7Tg2pLqR9mKvNwY3hBcZa' },
      { ...challenge, expires: '2099-01-01T00:00:00Z' },
    ]) {
      const result = await get(gate, { authorization: authorization(tampered, { spt: 'spt_ok' }) });
      expect(result).toMatchObject({ status: 402, handlerRuns: 0, body: { error: { code: 'proof_invalid', detail: 'challenge_invalid' } } });
    }
    expect(stripe.requests).toHaveLength(0);
  });

  it('rejects an expired challenge', async () => {
    const { toll, clock } = stripeSetup();
    const gate = toll.price('$1.00');
    const challenge = await challengeFor(gate);
    clock.advance(6 * 60_000);
    const result = await get(gate, { authorization: authorization(challenge, { spt: 'spt_ok' }) });

    expect(result).toMatchObject({ status: 402, handlerRuns: 0, body: { error: { code: 'proof_invalid', detail: 'challenge_expired' } } });
  });

  it('rejects a challenge issued for another resource', async () => {
    const { toll } = stripeSetup();
    const challenge = await challengeFor(toll.price('$1.00'), '/cheap');
    const result = await get(toll.price('$5.00'), { path: '/expensive', authorization: authorization(challenge, { spt: 'spt_ok' }) });

    expect(result).toMatchObject({ status: 402, handlerRuns: 0, body: { error: { code: 'quote_invalid' } } });
  });

  it('rejects a correctly bound challenge whose terms are not this route’s price', async () => {
    const { toll } = stripeSetup();
    const issued = await issueChallenge([SECRET], {
      realm: 'api.example.com',
      method: 'stripe',
      intent: 'charge',
      request: { amount: '100', currency: 'usd', methodDetails: { networkId: 'profile_test', paymentMethodTypes: ['card'] } },
      expires: '2026-01-01T00:05:00Z',
      opaque: {},
    });
    const wire = { ...issued, request: Buffer.from(JSON.stringify(issued.request)).toString('base64url'), opaque: undefined };
    const result = await get(toll.price('$5.00'), { authorization: authorization(JSON.parse(JSON.stringify(wire)) as Record<string, string>, { spt: 'spt_ok' }) });

    expect(result).toMatchObject({ status: 402, handlerRuns: 0, body: { error: { code: 'proof_invalid', detail: 'challenge_terms_mismatch' } } });
  });

  it('answers a replayed credential with the recorded payment, without a second PaymentIntent', async () => {
    const { toll, stripe } = stripeSetup();
    const gate = toll.price('$1.00');
    const credential = authorization(await challengeFor(gate), { spt: 'spt_ok' });
    await get(gate, { authorization: credential });
    const replay = await get(gate, { authorization: credential });

    // The challenge id is the idempotency key, so the retry finds the settled charge.
    expect(replay).toMatchObject({ status: 409, handlerRuns: 0, body: { error: { code: 'already_paid' }, settlement: 'pi_1' } });
    expect(stripe.intents.size).toBe(1);
  });

  it('answers a retry of a paid request from the ledger after its challenge expired', async () => {
    const { toll, stripe, clock } = stripeSetup();
    const gate = toll.price('$1.00');
    const credential = authorization(await challengeFor(gate), { spt: 'spt_ok' });
    await get(gate, { authorization: credential });
    clock.advance(6 * 60_000);

    // Without the proof id this would be a 402 asking the client to pay a second time.
    expect(await get(gate, { authorization: credential })).toMatchObject({ status: 409, handlerRuns: 0, body: { error: { code: 'proof_already_used' } } });
    expect(stripe.intents.size).toBe(1);
  });

  it('prefers the client’s Idempotency-Key over the challenge id', async () => {
    const { toll, stripe } = stripeSetup();
    const gate = toll.price('$1.00');
    const credential = authorization(await challengeFor(gate), { spt: 'spt_ok' });
    const withKey = (key: string) =>
      gate.enter(httpContext(new Request('https://api.example.com/report', { headers: { authorization: credential, 'idempotency-key': key } })));
    const first = await withKey('client-key-1');
    if (first.kind === 'admitted') await first.pass.complete('succeeded');
    const second = await withKey('client-key-2');

    expect(first.kind).toBe('admitted');
    expect(second).toMatchObject({ kind: 'denied', denial: { status: 409, error: { code: 'proof_already_used' } } });
    expect(stripe.intents.size).toBe(1);
  });

  it('rejects a malformed payload and a malformed credential', async () => {
    const { toll } = stripeSetup();
    const gate = toll.price('$1.00');
    const challenge = await challengeFor(gate);

    expect((await get(gate, { authorization: authorization(challenge, { spt: 'pm_card' }) })).body.error).toMatchObject({ code: 'proof_invalid', detail: 'invalid_payload' });
    expect((await get(gate, { authorization: 'Payment !!!' })).body.error).toMatchObject({ code: 'proof_invalid', detail: 'malformed_credential' });
  });

  it('ignores credentials for other methods and other authorization schemes', async () => {
    const { toll } = stripeSetup();
    const gate = toll.price('$1.00');
    const challenge = await challengeFor(gate);

    expect((await get(gate, { authorization: authorization({ ...challenge, method: 'tempo' }, { spt: 'spt_ok' }) })).body).toMatchObject({ error: { code: 'payment_required' } });
    expect((await get(gate, { authorization: 'Bearer abc' })).body).toMatchObject({ error: { code: 'payment_required' } });
  });

  it('verifies challenges issued under a previous secret during rotation', async () => {
    const stripe = fakeStripe();
    const clock = fakeClock();
    const options = { realm: 'api.example.com', secretKey: 'sk_test', networkId: 'profile_test', fetch: stripe.fetch, clock };
    const before = setup(mppStripe({ ...options, secret: SECRET }), clock);
    const challenge = await challengeFor(before.toll.price('$1.00'));

    const after = setup(mppStripe({ ...options, secret: ['a-brand-new-secret-0123456789abcdef', SECRET] }), clock);
    const result = await get(after.toll.price('$1.00'), { authorization: authorization(challenge, { spt: 'spt_ok' }) });
    expect(result.status).toBe(200);

    const retired = setup(mppStripe({ ...options, secret: 'a-brand-new-secret-0123456789abcdef' }), clock);
    expect((await get(retired.toll.price('$1.00'), { authorization: authorization(challenge, { spt: 'spt_ok' }) })).body.error).toMatchObject({ code: 'proof_invalid', detail: 'challenge_invalid' });
  });

  it('refuses short secrets and non-ASCII realms at construction', () => {
    const base = { secretKey: 'sk', networkId: 'profile_test' };
    expect(() => mppStripe({ ...base, realm: 'api.example.com', secret: 'short' })).toThrow(/at least 32/);
    expect(() => mppStripe({ ...base, realm: 'api.例え.com', secret: SECRET })).toThrow(/printable ASCII/);
  });
});

describe('mppStripe ambiguous outcomes', () => {
  it('answers 503 when Stripe is unreachable, releases on reconciliation, and accepts a retry of the same credential', async () => {
    const { toll, stripe, clock, charges } = stripeSetup();
    const gate = toll.price('$1.00');
    const credential = authorization(await challengeFor(gate), { spt: 'spt_ok' });
    stripe.simulate({ payment: 'down' });

    expect(await get(gate, { authorization: credential })).toMatchObject({ status: 503, handlerRuns: 0 });
    expect(charges()).toEqual(['unknown/pending']);

    stripe.simulate({});
    clock.advance(2_000);
    await toll.reconcile({ olderThanMs: 1_000 });
    expect(charges()).toEqual(['released/failed']);

    const retry = await get(gate, { authorization: credential });
    expect(retry.status).toBe(200);
    expect(charges()).toEqual(['released/failed', 'settled/completed']);
    expect(stripe.intents.size).toBe(1);
  });

  it('keeps an ambiguous settlement unknown while search may lag, then refunds the PaymentIntent it finds', async () => {
    const { toll, stripe, clock, charges, errors } = stripeSetup();
    const gate = toll.price('$1.00');
    stripe.simulate({ payment: 'timeout-after-effect' });

    expect(await get(gate, { authorization: authorization(await challengeFor(gate), { spt: 'spt_ok' }) })).toMatchObject({ status: 503, handlerRuns: 0 });
    stripe.simulate({});
    stripe.setSearchable(false);
    clock.advance(100);
    await toll.reconcile({ olderThanMs: 50 });
    expect(charges()).toEqual(['unknown/pending']);
    expect(errors().at(-1)).toMatchObject({ code: 'PROVIDER_TIMEOUT' });

    stripe.setSearchable(true);
    clock.advance(2_000);
    await toll.reconcile({ olderThanMs: 1_000 });
    expect(charges()).toEqual(['refunded/failed']);
    expect(stripe.intents.size).toBe(1);
    expect(stripe.refunds).toHaveLength(1);
  });

  it('replays the same PaymentIntent when a settlement is retried with the same credential', async () => {
    const { toll, stripe, clock, charges } = stripeSetup();
    const gate = toll.price('$1.00');
    const credential = authorization(await challengeFor(gate), { spt: 'spt_ok' });
    stripe.simulate({ payment: 'timeout-after-effect' });
    await get(gate, { authorization: credential });

    // Search misses the PaymentIntent past the lag window, so the charge is released...
    stripe.simulate({});
    stripe.setSearchable(false);
    clock.advance(2_000);
    await toll.reconcile({ olderThanMs: 1_000 });
    expect(charges()).toEqual(['released/failed']);

    // ...and the retry replays the PaymentIntent instead of charging twice.
    const retry = await get(gate, { authorization: credential });
    expect(retry.status).toBe(200);
    expect(stripe.intents.size).toBe(1);
    expect(decodeJson(retry.headers.get('payment-receipt') ?? '')).toMatchObject({ reference: 'pi_1' });
  });

  it('answers 503 on a Stripe 5xx without running the handler', async () => {
    const { toll, stripe } = stripeSetup();
    const gate = toll.price('$1.00');
    stripe.simulate({ payment: 'server-error' });
    expect(await get(gate, { authorization: authorization(await challengeFor(gate), { spt: 'spt_ok' }) })).toMatchObject({ status: 503, handlerRuns: 0 });
  });

  it('resolves an ambiguous refund by looking it up, without refunding twice', async () => {
    const { toll, stripe, clock, charges } = stripeSetup();
    const gate = toll.price('$1.00');
    stripe.simulate({ refund: 'timeout-after-effect' });
    await get(gate, { authorization: authorization(await challengeFor(gate), { spt: 'spt_ok' }), outcome: 'failed' });
    expect(charges()).toEqual(['unknown/failed']);

    stripe.simulate({});
    clock.advance(2_000);
    await toll.reconcile({ olderThanMs: 1_000 });
    expect(charges()).toEqual(['refunded/failed']);
    expect(stripe.refunds).toHaveLength(1);
  });

  it('refunds a charge whose process crashed after settling and before the handler finished', async () => {
    const { toll, stripe, clock, charges } = stripeSetup();
    const gate = toll.price('$1.00');
    const headers = { authorization: authorization(await challengeFor(gate), { spt: 'spt_ok' }) };
    const entry = await gate.enter(httpContext(new Request('https://api.example.com/report', { headers })));
    expect(entry.kind).toBe('admitted');
    expect(charges()).toEqual(['settled/running']);

    clock.advance(2_000);
    await toll.reconcile({ olderThanMs: 1_000 });
    expect(charges()).toEqual(['refunded/failed']);
    await toll.reconcile({ olderThanMs: 1_000 });
    expect(stripe.refunds).toHaveLength(1);
  });

  it('limits the authorization to the quoted price', async () => {
    const { toll, ledger } = stripeSetup();
    const gate = toll.price('$1.00');
    await get(gate, { authorization: authorization(await challengeFor(gate), { spt: 'spt_ok' }) });
    expect(ledger.authorizations()[0]).toMatchObject({ kind: 'single', limit: money('USD', 1_000_000n), payer: expect.stringMatching(/^stripe:/) as unknown });
  });
});
