import {
  createTollstile,
  memoryLedger,
  toResponse,
  upTo,
  type Authorization,
  type Charge,
  type Gate,
  type Payment,
  type Rail,
  type TollstileEvent,
} from 'tollstile';
import { fakeClock, httpContext, mcpContext } from 'tollstile/testing';
import { describe, expect, it } from 'vitest';
import { kyapay, type KyapayData, type KyapayOptions } from '../src/index';
import { API_KEY, base64url, createIssuer, fakeSkyfire, SANDBOX_API, SANDBOX_ISSUER, SELLER_ID, SERVICE_ID } from './fake-skyfire';

type Result = { readonly status: number; readonly body: Record<string, unknown>; readonly headers: Headers; readonly handlerRuns: number };

/**
 * Provider calls get a generous timeout so crypto and fake-network work never time out on a loaded
 * machine; tests that simulate a hanging Skyfire pass a short one so the hang resolves quickly.
 */
async function setup(options: { readonly rail?: Partial<KyapayOptions>; readonly pageSize?: number; readonly providerTimeoutMs?: number } = {}) {
  const clock = fakeClock();
  const issuer = await createIssuer(SANDBOX_ISSUER);
  const skyfire = fakeSkyfire({ clock, issuers: [issuer], ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }) });
  const rail = kyapay({ environment: 'sandbox', sellerId: SELLER_ID, serviceId: SERVICE_ID, apiKey: API_KEY, fetch: skyfire.fetch, clock, ...options.rail });
  const ledger = memoryLedger({ clock });
  const events: TollstileEvent[] = [];
  const toll = createTollstile({ rails: [rail], ledger, clock, secret: 's'.repeat(32), providerTimeoutMs: options.providerTimeoutMs ?? 5_000, onEvent: (event) => events.push(event) });

  const nowSeconds = () => Math.floor(clock.now().getTime() / 1000);
  const claims = (overrides: Record<string, unknown> = {}) => ({
    iss: SANDBOX_ISSUER,
    sub: 'buyer-1',
    aud: SELLER_ID,
    env: 'sandbox',
    tsi: SERVICE_ID,
    iat: nowSeconds() - 5,
    exp: nowSeconds() + 3600,
    jti: crypto.randomUUID(),
    amt: '0.05',
    cur: 'USD',
    val: '50000',
    stp: 'coin',
    sti: { type: 'usdc', verified: true },
    ...overrides,
  });
  const token = (overrides: Record<string, unknown> = {}, header: Record<string, unknown> = {}) => issuer.sign(claims(overrides), header);

  const call = async (gate: Gate<readonly Rail[]>, input: { readonly token?: string; readonly idempotencyKey?: string; readonly handler?: (payment: Payment<readonly Rail[]>) => Promise<'succeeded' | 'failed'> | 'succeeded' | 'failed' } = {}): Promise<Result> => {
    const headers = new Headers();
    if (input.token !== undefined) headers.set('KYAPay-Token', input.token);
    if (input.idempotencyKey !== undefined) headers.set('Idempotency-Key', input.idempotencyKey);
    const entry = await gate.enter(httpContext(new Request('https://seller.example/report', { headers })));
    if (entry.kind === 'denied') {
      const response = toResponse(entry.denial);
      return { status: response.status, body: (await response.json()) as Record<string, unknown>, headers: response.headers, handlerRuns: 0 };
    }
    const outcome = input.handler === undefined ? 'succeeded' : await input.handler(entry.pass.payment);
    const { receipt } = await entry.pass.complete(outcome);
    const responseHeaders = new Headers();
    for (const [name, value] of receipt.headers) responseHeaders.append(name, value);
    return { status: outcome === 'succeeded' ? 200 : 500, body: {}, headers: responseHeaders, handlerRuns: 1 };
  };

  const charges = () => ledger.charges().map((charge) => `${charge.payment}/${charge.fulfillment}`);
  const errors = () => events.flatMap((event) => (event.type === 'error' ? [event.error] : []));
  const posts = () => skyfire.requests.filter((request) => request.startsWith('POST'));
  return { clock, issuer, skyfire, rail, ledger, toll, token, claims, call, charges, errors, posts, nowSeconds };
}

describe('challenge', () => {
  it('names the header, token types, and where to get tokens, and includes the A2A accepts shape', async () => {
    const { toll, call, skyfire } = await setup();
    const result = await call(toll.price('$0.01'));

    expect(result.status).toBe(402);
    expect(result.body).toMatchObject({
      error: { code: 'payment_required', retryable: true, action: 'pay', detail: null },
      accepts: [
        {
          rail: 'kyapay',
          asset: { code: 'USD', network: 'skyfire:sandbox', scale: 6 },
          amount: '10000',
          flow: 'authorization',
          details: {
            header: 'KYAPay-Token',
            tokenTypes: ['pay', 'kya-pay'],
            issuer: SANDBOX_ISSUER,
            createToken: 'https://docs.skyfire.xyz/reference/create-token',
            kyapay_version: 1,
            accepts: [
              { seller_service_id: SERVICE_ID, token_amount: '0.01', token_type: 'pay', resource: 'GET /report' },
              { seller_service_id: SERVICE_ID, token_amount: '0.01', token_type: 'kya+pay', resource: 'GET /report' },
            ],
          },
        },
      ],
    });
    expect(skyfire.requests).toEqual([]);
  });

  it('offers nothing for prices outside USD', async () => {
    const { rail } = await setup();
    expect(await rail.offer({ resource: 'r', price: { currency: 'EUR', micros: 10_000n }, variable: false })).toBeNull();
  });

  it('uses the tollstile MCP style', async () => {
    const { toll } = await setup();
    const entry = await toll.price('$0.01').enter(mcpContext('report', {}));
    if (entry.kind !== 'denied') throw new Error('expected a denial');
    expect(entry.denial.offers[0]?.challenge.mcp).toMatchObject({ style: 'tollstile', meta: 'kyapay/token', header: 'KYAPay-Token' });
  });
});

describe('verification', () => {
  it('admits a valid token, charges the price after the handler, and returns a receipt', async () => {
    const { toll, call, token, skyfire, ledger, charges } = await setup();
    const jti = crypto.randomUUID();
    const result = await call(toll.price('$0.01'), { token: await token({ jti }) });

    expect(result.status).toBe(200);
    expect(JSON.parse(result.headers.get('kyapay-receipt') ?? '{}')).toEqual({ success: true, amount_charged: '0.01', token_id: jti });
    expect(charges()).toEqual(['settled/completed']);
    expect(skyfire.records).toMatchObject([{ tokenId: jti, value: '0.01' }]);
    expect(ledger.authorizations()[0]).toMatchObject({
      kind: 'reusable',
      payer: `${SANDBOX_ISSUER}#buyer-1`,
      limit: { currency: 'USD', micros: 50_000n },
      consumed: { micros: 10_000n },
      data: { tokenId: jti },
    });
    expect(ledger.charges()[0]?.settlement).toMatchObject({ details: { amountCharged: '0.01', remainingBalance: '0.04' } });
  });

  it('names the payer by issuer and subject, with the subject exactly as issued', async () => {
    const { toll, call, token, ledger } = await setup();
    expect((await call(toll.price('$0.01'), { token: await token({ sub: 'Buyer-7fA2' }) })).status).toBe(200);
    expect(ledger.charges()[0]?.payer).toBe(`${SANDBOX_ISSUER}#Buyer-7fA2`);
  });

  it('accepts the token over MCP and returns the receipt in meta', async () => {
    const { toll, token } = await setup();
    const entry = await toll.price('$0.01').enter(mcpContext('report', { 'kyapay/token': await token() }));
    if (entry.kind !== 'admitted') throw new Error('expected admission');
    const { receipt } = await entry.pass.complete('succeeded');
    expect(receipt.meta).toMatchObject({ 'kyapay/receipt': { success: true, amount_charged: '0.01' } });
  });

  it('rejects a token whose payload was changed after signing', async () => {
    const { toll, call, token, claims, posts, ledger } = await setup();
    const [header, , signature] = (await token()).split('.');
    const forged = base64url(new TextEncoder().encode(JSON.stringify(claims({ amt: '100', val: '100000000' }))));
    const result = await call(toll.price('$0.01'), { token: `${header ?? ''}.${forged}.${signature ?? ''}` });

    expect(result).toMatchObject({ status: 402, handlerRuns: 0, body: { error: { code: 'proof_invalid', detail: 'bad_signature' } } });
    expect(posts()).toEqual([]);
    expect(ledger.authorizations()).toEqual([]);
  });

  it('rejects a token signed by a key the issuer did not publish', async () => {
    const { toll, call, claims } = await setup();
    const impostor = await createIssuer(SANDBOX_ISSUER);
    const result = await call(toll.price('$0.01'), { token: await impostor.sign(claims()) });
    expect(result).toMatchObject({ status: 402, handlerRuns: 0, body: { error: { code: 'proof_invalid', detail: 'bad_signature' } } });
  });

  it('rejects a token from an untrusted issuer without fetching anything', async () => {
    const { toll, call, skyfire, claims } = await setup();
    const stranger = await createIssuer('https://issuer.example');
    const result = await call(toll.price('$0.01'), { token: await stranger.sign(claims({ iss: 'https://issuer.example' })) });

    expect(result).toMatchObject({ status: 402, handlerRuns: 0, body: { error: { code: 'proof_invalid', detail: 'untrusted_issuer' } } });
    expect(skyfire.requests).toEqual([]);
  });

  it.each([
    ['none', 'unsupported_algorithm'],
    ['HS256', 'unsupported_algorithm'],
    ['ES384', 'unsupported_algorithm'],
  ])('rejects alg %s without fetching keys', async (alg, reason) => {
    const { toll, call, token, skyfire } = await setup();
    const result = await call(toll.price('$0.01'), { token: await token({}, { alg }) });
    expect(result).toMatchObject({ status: 402, body: { error: { code: 'proof_invalid', detail: reason } } });
    expect(skyfire.requests).toEqual([]);
  });

  it.each([
    ['wrong audience', { aud: 'another-seller' }, 'wrong_audience'],
    ['audience array', { aud: [SELLER_ID] }, 'wrong_audience'],
    ['wrong environment', { env: 'production' }, 'wrong_environment'],
    ['wrong service', { tsi: 'another-service' }, 'wrong_service'],
    ['legacy service claim', { tsi: undefined, ssi: SERVICE_ID }, null],
    ['conflicting service claims', { ssi: 'another-service' }, 'wrong_service'],
    ['non-UUID jti', { jti: 'abc' }, 'invalid_claims'],
    ['missing subject', { sub: undefined }, 'invalid_claims'],
    ['card settlement', { stp: 'card' }, 'card_token_refused'],
    ['card credential', { stp: undefined, sti: { type: 'visa_vic', payment_token: '4111111111111111', verified: true } }, 'card_token_refused'],
    ['unverified instrument', { sti: { type: 'usdc', verified: false } }, 'settlement_instrument_unverified'],
    ['other currency', { cur: 'EUR' }, 'unsupported_currency'],
    ['zero amount', { amt: '0' }, 'invalid_amount'],
    ['sub-micro amount', { amt: '0.0000001' }, 'invalid_amount'],
    ['missing val', { val: undefined }, 'invalid_amount'],
    ['amount below price', { amt: '0.005', val: '5000' }, 'insufficient_token_amount'],
  ])('%s', async (_name, overrides, reason) => {
    const { toll, call, token, ledger } = await setup();
    const result = await call(toll.price('$0.01'), { token: await token(overrides) });
    if (reason === null) {
      expect(result.status).toBe(200);
      return;
    }
    expect(result).toMatchObject({ status: 402, handlerRuns: 0, body: { error: { code: 'proof_invalid', detail: reason } } });
    expect(ledger.authorizations()).toEqual([]);
  });

  it('rejects expired, not-yet-valid, and overly long-lived tokens', async () => {
    const { toll, call, token, clock, nowSeconds } = await setup();
    const gate = toll.price('$0.01');
    const shortLived = await token({ exp: nowSeconds() + 60 });
    const future = await token({ iat: nowSeconds() + 120, exp: nowSeconds() + 600 });
    const longLived = await token({ exp: nowSeconds() + 2 * 86_400 });

    expect((await call(gate, { token: future })).body).toMatchObject({ error: { code: 'proof_invalid', detail: 'not_yet_valid' } });
    expect((await call(gate, { token: longLived })).body).toMatchObject({ error: { code: 'proof_invalid', detail: 'lifetime_not_accepted' } });
    clock.advance(95_000);
    expect(await call(gate, { token: shortLived })).toMatchObject({ status: 402, handlerRuns: 0, body: { error: { code: 'proof_invalid', detail: 'expired' } } });
  });

  it('refuses sender-constrained tokens unless a request signature check is configured', async () => {
    const cnf = { jwk: { kty: 'OKP', crv: 'Ed25519', x: 'abc' } };
    const refused = await setup();
    expect((await refused.call(refused.toll.price('$0.01'), { token: await refused.token({ cnf }) })).body).toMatchObject({
      error: { code: 'proof_invalid', detail: 'sender_constrained_token_unsupported' },
    });

    const seen: unknown[] = [];
    const checked = await setup({
      rail: {
        verifyRequestSignature: ({ confirmation }) => {
          seen.push(confirmation);
          return Promise.resolve(seen.length === 1);
        },
      },
    });
    const gate = checked.toll.price('$0.01');
    expect((await checked.call(gate, { token: await checked.token({ cnf }) })).status).toBe(200);
    expect((await checked.call(gate, { token: await checked.token({ cnf }) })).body).toMatchObject({ error: { code: 'proof_invalid', detail: 'request_signature_invalid' } });
    expect(seen[0]).toEqual(cnf);
  });

  it('refuses token types the merchant did not accept', async () => {
    const { toll, call, token } = await setup({ rail: { tokenTypes: ['pay'] } });
    expect((await call(toll.price('$0.01'), { token: await token() })).body).toMatchObject({ error: { code: 'proof_invalid', detail: 'token_type_not_accepted' } });
    expect((await call(toll.price('$0.01'), { token: await token({}, { typ: 'pay+JWT' }) })).status).toBe(200);
  });

  it('ignores kya identity tokens and refuses more than one payment token', async () => {
    const { toll, call, token } = await setup();
    const identity = await token({}, { typ: 'kya+JWT' });
    expect(await call(toll.price('$0.01'), { token: identity })).toMatchObject({ status: 402, body: { error: { code: 'payment_required' } } });

    const both = `${identity}, ${await token()}`;
    expect((await call(toll.price('$0.01'), { token: both })).status).toBe(200);
    expect((await call(toll.price('$0.01'), { token: `${await token()},${await token()}` })).body).toMatchObject({ error: { code: 'proof_invalid', detail: 'multiple_payment_tokens' } });
  });

  it('answers 503 without running the handler when the issuer keys cannot be fetched', async () => {
    const { toll, call, token, skyfire, errors } = await setup();
    skyfire.simulate({ jwks: 'unavailable' });
    expect(await call(toll.price('$0.01'), { token: await token() })).toMatchObject({ status: 503, handlerRuns: 0 });
    expect(errors()[0]).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('validates configuration at construction', async () => {
    const { skyfire } = await setup();
    const base = { environment: 'sandbox', sellerId: SELLER_ID, serviceId: SERVICE_ID, apiKey: API_KEY, fetch: skyfire.fetch } as const;
    expect(() => kyapay({ ...base, clockSkewSeconds: 120 })).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    expect(() => kyapay({ ...base, issuers: ['https://app.skyfire.xyz/'] })).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    expect(() => kyapay({ ...base, issuers: ['http://app.skyfire.xyz'] })).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    expect(() => kyapay({ ...base, apiKey: '' })).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    expect(() => kyapay({ ...base, tokenTypes: [] })).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    expect(() => createTollstile({ rails: [kyapay(base)], ledger: memoryLedger(), secret: 's'.repeat(32) }).price(() => '$0.01')).toThrow(
      expect.objectContaining({ code: 'CAPABILITY_MISSING' }),
    );
  });
});

describe('reusable authorization', () => {
  it('charges one token many times up to its amount, then refuses', async () => {
    const { toll, call, token, skyfire, ledger } = await setup();
    const gate = toll.price('$0.02');
    const hold = await token({ amt: '0.05' });

    expect((await call(gate, { token: hold })).status).toBe(200);
    expect((await call(gate, { token: hold })).status).toBe(200);
    expect(await call(gate, { token: hold })).toMatchObject({ status: 402, handlerRuns: 0, body: { error: { code: 'insufficient_authorization' } } });

    expect(skyfire.records.map((entry) => entry.value)).toEqual(['0.02', '0.02']);
    expect(ledger.authorizations()).toHaveLength(1);
    expect(ledger.authorizations()[0]).toMatchObject({ consumed: { micros: 40_000n }, reserved: { micros: 0n } });
  });

  it('settles concurrent requests on one token once each', async () => {
    const { toll, call, token, skyfire, charges } = await setup();
    const gate = toll.price('$0.01');
    const hold = await token();
    const results = await Promise.all([call(gate, { token: hold }), call(gate, { token: hold }), call(gate, { token: hold })]);

    expect(results.map((result) => result.status)).toEqual([200, 200, 200]);
    expect(charges()).toEqual(['settled/completed', 'settled/completed', 'settled/completed']);
    expect(skyfire.records).toHaveLength(3);
  });

  // A token is reusable and KYAPay has no per-request payment identifier, so only the client's key tells a retry apart.
  it('charges a retry with the same Idempotency-Key once, and a retry without one again', async () => {
    const { toll, call, token, skyfire } = await setup();
    const gate = toll.price('$0.01');
    const hold = await token();

    expect((await call(gate, { token: hold, idempotencyKey: 'retry-1' })).status).toBe(200);
    expect(await call(gate, { token: hold, idempotencyKey: 'retry-1' })).toMatchObject({ status: 409, handlerRuns: 0, body: { error: { code: 'already_paid' } } });
    expect(await call(gate, { token: await token(), idempotencyKey: 'retry-1' })).toMatchObject({ status: 409, handlerRuns: 0, body: { error: { code: 'already_paid' } } });
    expect(skyfire.records).toHaveLength(1);

    expect((await call(gate, { token: hold })).status).toBe(200);
    expect(skyfire.records).toHaveLength(2);
  });

  it('charges the fulfilled amount on a variable route', async () => {
    const { toll, call, token, skyfire } = await setup();
    const result = await call(toll.price(upTo('$0.02')), {
      token: await token(),
      handler: async (payment) => {
        await payment.fulfill({ amount: '$0.015' });
        return 'succeeded' as const;
      },
    });
    expect(result.status).toBe(200);
    expect(skyfire.records.map((entry) => entry.value)).toEqual(['0.015']);
  });

  it('charges nothing when the handler fails, and the token still pays for a retry', async () => {
    const { toll, call, token, posts, charges } = await setup();
    const gate = toll.price('$0.01');
    const hold = await token();
    await call(gate, { token: hold, handler: () => 'failed' });
    expect(posts()).toEqual([]);

    expect((await call(gate, { token: hold })).status).toBe(200);
    expect(charges()).toEqual(['released/failed', 'settled/completed']);
    expect(posts()).toHaveLength(1);
  });

  it('answers a keyed retry from the ledger after the token expired, instead of asking to pay again', async () => {
    const { toll, call, token, clock, nowSeconds, skyfire, issuer, claims } = await setup();
    const gate = toll.price('$0.01');
    const hold = await token({ exp: nowSeconds() + 60 });
    expect((await call(gate, { token: hold, idempotencyKey: 'once' })).status).toBe(200);

    clock.advance(95_000);
    expect(await call(gate, { token: hold, idempotencyKey: 'once' })).toMatchObject({ status: 409, handlerRuns: 0, body: { error: { code: 'already_paid' } } });
    expect((await call(gate, { token: hold, idempotencyKey: 'another' })).body).toMatchObject({ error: { code: 'proof_invalid', detail: 'expired' } });
    const [header, payload] = hold.split('.');
    const forged = `${header ?? ''}.${payload ?? ''}.${(await issuer.sign(claims())).split('.')[2] ?? ''}`;
    expect((await call(gate, { token: forged, idempotencyKey: 'once' })).body).toMatchObject({ error: { code: 'proof_invalid', detail: 'bad_signature' } });
    expect(skyfire.records).toHaveLength(1);
  });

  it('does not answer a keyed retry of an expired sender-constrained token from the ledger', async () => {
    const { toll, call, token, clock, nowSeconds } = await setup({ rail: { verifyRequestSignature: () => Promise.resolve(true) } });
    const gate = toll.price('$0.01');
    const hold = await token({ exp: nowSeconds() + 60, cnf: { jwk: { kty: 'OKP', crv: 'Ed25519', x: 'abc' } } });
    expect((await call(gate, { token: hold, idempotencyKey: 'once' })).status).toBe(200);

    clock.advance(95_000);
    expect((await call(gate, { token: hold, idempotencyKey: 'once' })).body).toMatchObject({ error: { code: 'proof_invalid', detail: 'expired' } });
  });

  it('refuses new requests once the token expires', async () => {
    const { toll, call, token, clock, nowSeconds } = await setup();
    const hold = await token({ exp: nowSeconds() + 60 });
    clock.advance(61_000);
    expect((await call(toll.price('$0.01'), { token: hold })).body).toMatchObject({ error: { code: 'authorization_expired' } });
  });
});

describe('settlement', () => {
  it('records a documented Skyfire error as a rejected settlement', async () => {
    const { toll, call, token, skyfire, charges, errors } = await setup();
    skyfire.simulate({ charge: { status: 402, body: { code: 'PAYMENT_ERROR', message: 'Insufficient balance' } } });
    await call(toll.price('$0.01'), { token: await token() });

    expect(charges()).toEqual(['failed/completed']);
    expect(errors()[0]).toMatchObject({ code: 'SETTLEMENT_REJECTED', message: expect.stringContaining('payment_error') as unknown });
  });

  it.each([
    ['a server error', { status: 502, body: { code: 'BAD_GATEWAY' } }],
    ['an HTML error page', { status: 400, body: '<html>Bad Request</html>' }],
    ['an unexpected amount', { status: 200, body: { amountCharged: '0.02', remainingBalance: '0.03' } }],
  ])('leaves the charge unknown after %s', async (_name, response) => {
    const { toll, call, token, skyfire, charges } = await setup();
    skyfire.simulate({ charge: response });
    await call(toll.price('$0.01'), { token: await token() });
    expect(charges()).toEqual(['unknown/completed']);
  });

  it('times out after Skyfire charged, then reconciles to settled without charging again', async () => {
    const { toll, call, token, skyfire, clock, charges, errors, posts } = await setup({ providerTimeoutMs: 500 });
    skyfire.simulate({ charge: 'hang-after-effect' });
    const result = await call(toll.price('$0.01'), { token: await token() });

    expect(result.status).toBe(200);
    expect(result.headers.get('kyapay-receipt')).toBeNull();
    expect(charges()).toEqual(['unknown/completed']);
    expect(errors()[0]).toMatchObject({ code: 'PROVIDER_TIMEOUT' });
    expect(errors().map((error) => error.message).join(' ')).not.toContain(API_KEY);

    skyfire.simulate({});
    clock.advance(60_000);
    expect(await toll.reconcile({ olderThanMs: 1_000 })).toMatchObject({ examined: 1, resolved: 1, pending: 0 });
    expect(charges()).toEqual(['settled/completed']);
    expect(skyfire.records).toHaveLength(1);
    expect(posts()).toHaveLength(1);
  });

  it('times out before Skyfire charged, then reconciles by charging once', async () => {
    const { toll, call, token, skyfire, clock, charges, posts } = await setup({ providerTimeoutMs: 500 });
    skyfire.simulate({ charge: 'hang-before-effect' });
    await call(toll.price('$0.01'), { token: await token() });

    skyfire.simulate({});
    clock.advance(60_000);
    await toll.reconcile({ olderThanMs: 1_000 });
    expect(charges()).toEqual(['settled/completed']);
    expect(skyfire.records).toHaveLength(1);
    expect(posts()).toHaveLength(2);
  });

  it('leaves the charge unknown while Skyfire cannot list charges', async () => {
    const { toll, call, token, skyfire, clock, charges } = await setup({ providerTimeoutMs: 500 });
    skyfire.simulate({ charge: 'hang-after-effect' });
    await call(toll.price('$0.01'), { token: await token() });

    skyfire.simulate({ list: 'unavailable' });
    clock.advance(60_000);
    expect(await toll.reconcile({ olderThanMs: 1_000 })).toMatchObject({ examined: 1, resolved: 0, pending: 1 });
    expect(charges()).toEqual(['unknown/completed']);
  });

  it('settles a charge fulfilled before a crash exactly as recorded, once', async () => {
    const { toll, token, clock, charges, skyfire } = await setup();
    const entry = await toll
      .price('$0.01')
      .enter(httpContext(new Request('https://seller.example/report', { headers: { 'KYAPay-Token': await token() } })));
    if (entry.kind !== 'admitted') throw new Error('expected admission');
    await entry.pass.payment.fulfill();

    clock.advance(60_000);
    await toll.reconcile({ olderThanMs: 1_000 });
    await toll.reconcile({ olderThanMs: 1_000 });
    expect(charges()).toEqual(['settled/completed']);
    expect(skyfire.records).toHaveLength(1);
  });
});

describe('charge list mapping', () => {
  const USD = (micros: bigint) => ({ currency: 'USD', micros });
  const created = new Date('2026-01-01T00:00:00.000Z');

  const authorization = (token: string, tokenId: string, accounting: { consumed: bigint; reserved: bigint }): Authorization & { data: KyapayData } => ({
    id: 'auth_1',
    rail: 'kyapay',
    payer: 'buyer-1',
    kind: 'reusable',
    limit: USD(50_000n),
    consumed: USD(accounting.consumed),
    reserved: USD(accounting.reserved),
    quoteId: null,
    expiresAt: new Date(created.getTime() + 3_600_000),
    data: { token, tokenId },
    createdAt: created,
    updatedAt: created,
  });

  const charge = (amount: bigint, reservedAmount = amount): Charge => ({
    id: 'chg_1',
    authorizationId: 'auth_1',
    requestId: 'req_1',
    resource: 'GET /report',
    payer: 'buyer-1',
    flow: 'authorization',
    reservedAmount: USD(reservedAmount),
    amount: USD(amount),
    payment: 'unknown',
    fulfillment: 'completed',
    pending: 'settle',
    settlement: null,
    refundReference: null,
    requestHash: null,
    resultRef: null,
    createdAt: created,
    updatedAt: created,
  });

  const operation = { key: 'chg_1:lookup', signal: new AbortController().signal };
  const later = (seconds: number) => new Date(created.getTime() + seconds * 1000);

  const lookupSetup = async (pageSize?: number) => {
    const context = await setup(pageSize === undefined ? {} : { pageSize });
    const tokenId = crypto.randomUUID();
    const jwt = await context.token({ jti: tokenId });
    return { ...context, tokenId, jwt };
  };

  it('proves absence when Skyfire lists nothing', async () => {
    const { rail, tokenId, jwt } = await lookupSetup();
    expect(await rail.lookup(authorization(jwt, tokenId, { consumed: 0n, reserved: 10_000n }), charge(10_000n), operation)).toEqual({ status: 'none' });
  });

  it('proves absence when the list matches recorded settlements, even for charges made after this one was created', async () => {
    const { rail, skyfire, tokenId, jwt } = await lookupSetup();
    skyfire.record(tokenId, '0.01', later(5));
    expect(await rail.lookup(authorization(jwt, tokenId, { consumed: 10_000n, reserved: 10_000n }), charge(10_000n), operation)).toEqual({ status: 'none' });
  });

  it('proves absence when the only unexplained charge predates this charge', async () => {
    const { rail, skyfire, tokenId, jwt } = await lookupSetup();
    skyfire.record(tokenId, '0.01', later(-120));
    expect(await rail.lookup(authorization(jwt, tokenId, { consumed: 0n, reserved: 20_000n }), charge(10_000n), operation)).toEqual({ status: 'none' });
  });

  it('proves the charge when no other in-flight charge can explain the excess', async () => {
    const { rail, skyfire, tokenId, jwt } = await lookupSetup();
    skyfire.record(tokenId, '0.01', later(-60));
    skyfire.record(tokenId, '0.01', later(10));
    expect(await rail.lookup(authorization(jwt, tokenId, { consumed: 10_000n, reserved: 10_000n }), charge(10_000n), operation)).toMatchObject({
      status: 'settled',
      reference: `${tokenId}:chg_1`,
      details: { evidence: 'charge_list', chargedTotal: '0.02', recordedTotal: '0.01' },
    });
  });

  it('tells in-flight charges apart when their amounts differ', async () => {
    const mine = await lookupSetup();
    mine.skyfire.record(mine.tokenId, '0.02', later(10));
    expect(await mine.rail.lookup(authorization(mine.jwt, mine.tokenId, { consumed: 0n, reserved: 30_000n }), charge(20_000n), operation)).toMatchObject({
      status: 'settled',
    });

    const other = await lookupSetup();
    other.skyfire.record(other.tokenId, '0.01', later(10));
    expect(await other.rail.lookup(authorization(other.jwt, other.tokenId, { consumed: 0n, reserved: 30_000n }), charge(20_000n), operation)).toEqual({
      status: 'none',
    });
  });

  it('refuses to guess between two in-flight charges of the same amount', async () => {
    const { rail, skyfire, tokenId, jwt } = await lookupSetup();
    skyfire.record(tokenId, '0.01', later(10));
    await expect(rail.lookup(authorization(jwt, tokenId, { consumed: 0n, reserved: 20_000n }), charge(10_000n), operation)).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT',
      message: expect.stringContaining('other in-flight charges') as unknown,
    });
  });

  it('refuses to conclude when the list is behind the ledger or shows charges the ledger cannot explain', async () => {
    const behind = await lookupSetup();
    behind.skyfire.record(behind.tokenId, '0.01', later(-60));
    await expect(
      behind.rail.lookup(authorization(behind.jwt, behind.tokenId, { consumed: 20_000n, reserved: 10_000n }), charge(10_000n), operation),
    ).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });

    const excess = await lookupSetup();
    excess.skyfire.record(excess.tokenId, '0.05', later(10));
    await expect(
      excess.rail.lookup(authorization(excess.jwt, excess.tokenId, { consumed: 0n, reserved: 10_000n }), charge(10_000n), operation),
    ).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
  });

  it('does not read a 404 as proof that nothing was charged', async () => {
    const { rail, skyfire, tokenId, jwt } = await lookupSetup();
    skyfire.simulate({ list: 'not-found' });
    await expect(rail.lookup(authorization(jwt, tokenId, { consumed: 0n, reserved: 10_000n }), charge(10_000n), operation)).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT',
    });
  });

  it('follows page cursors', async () => {
    const { rail, skyfire, tokenId, jwt } = await lookupSetup(2);
    for (const seconds of [-50, -40, -30, -20]) skyfire.record(tokenId, '0.005', later(seconds));
    skyfire.record(tokenId, '0.01', later(10));
    expect(await rail.lookup(authorization(jwt, tokenId, { consumed: 20_000n, reserved: 10_000n }), charge(10_000n), operation)).toMatchObject({
      status: 'settled',
    });
    expect(skyfire.requests.filter((request) => request.startsWith('GET https://api-sandbox'))).toHaveLength(3);
  });

  it('does not charge again when the list already shows the charge', async () => {
    const { rail, skyfire, tokenId, jwt, posts } = await lookupSetup();
    skyfire.record(tokenId, '0.01', later(10));
    const result = await rail.settle(authorization(jwt, tokenId, { consumed: 0n, reserved: 10_000n }), { ...charge(10_000n), payment: 'settling' }, operation);
    expect(result).toMatchObject({ status: 'settled', details: { evidence: 'charge_list' } });
    expect(posts()).toEqual([]);
  });

  it('answers a repeated settle of a recorded charge with its settlement, without asking Skyfire', async () => {
    const { rail, skyfire, tokenId, jwt } = await lookupSetup();
    skyfire.record(tokenId, '0.01', later(10));
    const settlement = { reference: `${tokenId}:chg_1`, details: { tokenId, amountCharged: '0.01', remainingBalance: '0.04' } };
    const recorded = { ...charge(10_000n), payment: 'settled', pending: null, settlement } as const;
    const result = await rail.settle(authorization(jwt, tokenId, { consumed: 10_000n, reserved: 0n }), recorded, operation);

    expect(result).toEqual({ status: 'settled', ...settlement });
    expect(skyfire.requests.filter((request) => !request.includes('jwks'))).toEqual([]);
  });

  it('charges when another in-flight charge could explain what is listed', async () => {
    const { rail, skyfire, tokenId, jwt, posts } = await lookupSetup();
    skyfire.record(tokenId, '0.01', later(10));
    const result = await rail.settle(authorization(jwt, tokenId, { consumed: 0n, reserved: 20_000n }), { ...charge(10_000n), payment: 'settling' }, operation);
    expect(result).toMatchObject({ status: 'settled', details: { amountCharged: '0.01' } });
    expect(posts()).toHaveLength(1);
    expect(skyfire.requests.at(-1)).toBe(`POST ${SANDBOX_API}/api/v1/tokens/charge`);
  });

  it('treats an unreadable charge record as a provider failure', async () => {
    const { rail, skyfire, tokenId, jwt } = await lookupSetup();
    skyfire.record(tokenId, '0.0000001', later(10));
    await expect(rail.lookup(authorization(jwt, tokenId, { consumed: 0n, reserved: 10_000n }), charge(10_000n), operation)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
  });
});
