import {
  createTollstile,
  memoryLedger,
  toResponse,
  type Context,
  type DynamicPrice,
  type Gate,
  type Money,
  type Outcome,
  type Rail,
  type TollstileEvent,
} from 'tollstile';
import { fakeClock, httpContext, mcpContext } from 'tollstile/testing';
import { describe, expect, it } from 'vitest';
import { l402, L402_CREDENTIAL_META, L402_RECEIPT_META, lndRest, type L402Options } from '../src/index';
import { appendCaveat, fakeLnd, LND_MACAROON_HEX, readChallenge } from './fake-lnd';

/** A merchant's rate: 2 msat per micro-dollar, i.e. $0.01 buys 20 sat. */
const rate = (amount: Money) => amount.micros * 2n;
const SECRET = 'l402-root-key-secret-0123456789abcdef';

function setup(options: Partial<L402Options> = {}) {
  const clock = fakeClock();
  const lnd = fakeLnd();
  const rail = l402({
    network: 'regtest',
    invoices: lndRest({ url: 'https://lnd.test:8080', macaroon: LND_MACAROON_HEX, fetch: lnd.fetch }),
    rate,
    secret: SECRET,
    clock,
    ...options,
  });
  const ledger = memoryLedger({ clock });
  const events: TollstileEvent[] = [];
  const toll = createTollstile({ rails: [rail], ledger, clock, secret: 's'.repeat(32), onEvent: (event) => events.push(event) });
  const charges = () => ledger.charges().map((charge) => `${charge.payment}/${charge.fulfillment}`);
  return { clock, lnd, rail, ledger, toll, events, charges };
}

type Result = { readonly status: number; readonly body: Record<string, unknown>; readonly headers: Headers; readonly handlerRuns: number };

async function call(
  gate: Gate<readonly Rail[]>,
  options: { readonly authorization?: string; readonly idempotencyKey?: string; readonly path?: string; readonly handler?: () => Outcome } = {},
): Promise<Result> {
  const headers = new Headers(options.authorization === undefined ? {} : { authorization: options.authorization });
  if (options.idempotencyKey !== undefined) headers.set('idempotency-key', options.idempotencyKey);
  const entry = await gate.enter(httpContext(new Request(`http://localhost${options.path ?? '/weather'}`, { headers })));
  if (entry.kind === 'denied') {
    const response = toResponse(entry.denial);
    return { status: response.status, body: (await response.json()) as Record<string, unknown>, headers: response.headers, handlerRuns: 0 };
  }
  const outcome = options.handler?.() ?? 'succeeded';
  const { receipt } = await entry.pass.complete(outcome);
  const responseHeaders = new Headers();
  for (const [name, value] of receipt.headers) responseHeaders.append(name, value);
  return { status: outcome === 'succeeded' ? 200 : 500, body: {}, headers: responseHeaders, handlerRuns: 1 };
}

/** Requests, pays the invoice from the challenge, and returns the credential and challenge. */
async function buy(context: ReturnType<typeof setup>, gate: Gate<readonly Rail[]>, path?: string) {
  const challenged = await call(gate, path === undefined ? {} : { path });
  expect(challenged.status).toBe(402);
  const challenge = readChallenge(challenged.headers);
  const preimage = context.lnd.pay(challenge.invoice);
  return { challenged, challenge, preimage, authorization: `L402 ${challenge.macaroon}:${preimage}` };
}

describe('challenge', () => {
  it('answers 402 with LSAT then L402 challenges for an invoice worth the credential, and writes nothing', async () => {
    const context = setup({ calls: 3 });
    const result = await call(context.toll.price('$0.01'));

    expect(result.status).toBe(402);
    expect(result.headers.get('www-authenticate')).toMatch(/^LSAT macaroon="[^"]+", invoice="lnbcrt[^"]+", L402 macaroon="[^"]+", invoice="lnbcrt/);
    expect(result.body).toMatchObject({
      error: { code: 'payment_required', retryable: true, action: 'pay', detail: null },
      accepts: [
        {
          rail: 'l402',
          asset: { code: 'BTC', network: 'lightning:regtest', scale: 11 },
          amount: '60000',
          flow: 'authorization',
          details: { scheme: 'L402', value: '$0.03', calls: 3 },
        },
      ],
    });
    expect(context.lnd.requests[0]?.body).toMatchObject({ value_msat: '60000', memo: 'L402', expiry: '300' });
    expect(context.ledger.authorizations()).toHaveLength(0);
  });

  it('offers MCP clients the same macaroon and invoice under a documented meta key', async () => {
    const { toll } = setup();
    const entry = await toll.price('$0.01').enter(mcpContext('forecast', {}));
    if (entry.kind !== 'denied') throw new Error('expected a challenge');

    expect(entry.denial.offers[0]?.challenge.mcp).toMatchObject({ style: 'tollstile', rail: 'l402', meta: L402_CREDENTIAL_META, format: 'L402 <macaroon>:<preimage>' });
  });

  it('omits the offer instead of an unpayable invoice when the node is down, and answers 503 without another rail', async () => {
    const { toll, lnd, events } = setup();
    lnd.setMode('down');

    expect(await call(toll.price('$0.01'))).toMatchObject({ status: 503, body: { error: { code: 'payment_unavailable' } } });
    expect(events.find((event) => event.type === 'error')).toMatchObject({ error: { code: 'PROVIDER_UNAVAILABLE' } });
  });

  it('refuses an invoice from another network', async () => {
    const { toll } = setup({ network: 'mainnet' });

    await expect(call(toll.price('$0.01'))).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('makes no offer when the rate yields nothing to pay', async () => {
    const { toll, lnd } = setup({ rate: () => 0n });
    const result = await call(toll.price('$0.01'));

    expect(result.body).toMatchObject({ accepts: [] });
    expect(lnd.requests).toHaveLength(0);
  });
});

describe('paying and consuming a credential', () => {
  it('admits a paid credential against the quote it was minted for and consumes the price', async () => {
    const context = setup();
    const gate = context.toll.price('$0.01');
    const { authorization, challenge } = await buy(context, gate);
    const result = await call(gate, { authorization });

    expect(result).toMatchObject({ status: 200, handlerRuns: 1 });
    expect(result.headers.get('l402-remaining')).toBe('$0.00');
    expect(result.headers.get('l402-receipt')).toMatch(/^[0-9a-f]{64}:chg_/);
    expect(context.charges()).toEqual(['settled/completed']);
    expect(context.ledger.charges()[0]?.payer).toBe(`l402:${String(context.lnd.invoices.keys().next().value)}`);
    expect(context.ledger.charges()[0]?.payer).toMatch(/^l402:[0-9a-f]{64}$/);
    const [opened] = context.ledger.authorizations();
    expect(opened).toMatchObject({ kind: 'reusable', limit: { currency: 'USD', micros: 10_000n }, consumed: { micros: 10_000n } });
    expect(opened?.expiresAt).toEqual(new Date(context.clock.now().getTime() + 24 * 60 * 60_000));
    expect(opened?.data).toEqual({ paymentHash: context.lnd.invoices.keys().next().value });
    expect(JSON.stringify(opened, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value))).not.toContain(challenge.macaroon);
  });

  it('draws down a multi-call credential until its value is used, then challenges again', async () => {
    const context = setup({ calls: 3 });
    const gate = context.toll.price('$0.01');
    const { authorization } = await buy(context, gate);

    const results = [];
    for (let index = 0; index < 4; index += 1) results.push(await call(gate, { authorization }));

    expect(results.map((result) => result.status)).toEqual([200, 200, 200, 402]);
    expect(results.map((result) => result.headers.get('l402-remaining'))).toEqual(['$0.02', '$0.01', '$0.00', null]);
    expect(results[3]?.body).toMatchObject({ error: { code: 'insufficient_authorization' } });
    expect(context.ledger.authorizations()).toHaveLength(1);
    expect(context.ledger.authorizations()[0]).toMatchObject({ consumed: { micros: 30_000n }, reserved: { micros: 0n } });
  });

  // A credential is reusable and L402 has no per-request payment identifier, so only the client's key tells a retry apart.
  it('charges a retry with the same Idempotency-Key once, and a retry without one again', async () => {
    const context = setup({ calls: 3 });
    const gate = context.toll.price('$0.01');
    const { authorization } = await buy(context, gate);

    expect((await call(gate, { authorization, idempotencyKey: 'retry-1' })).status).toBe(200);
    expect(await call(gate, { authorization, idempotencyKey: 'retry-1' })).toMatchObject({ status: 409, handlerRuns: 0, body: { error: { code: 'already_paid' } } });
    expect(context.ledger.authorizations()[0]).toMatchObject({ consumed: { micros: 10_000n } });

    expect((await call(gate, { authorization })).status).toBe(200);
    expect(context.ledger.authorizations()[0]).toMatchObject({ consumed: { micros: 20_000n } });
  });

  it('answers a keyed retry from the ledger once its quote no longer opens or the credential expired, instead of asking to pay again', async () => {
    const context = setup({ calls: 5, credentialTtlMs: 60 * 60_000 });
    const dynamic = context.toll.price(() => '$0.01');
    const { authorization, challenge } = await buy(context, dynamic);
    expect((await call(dynamic, { authorization, idempotencyKey: 'once' })).status).toBe(200);
    const forged = `L402 ${challenge.macaroon}:${'00'.repeat(32)}`;

    context.clock.advance(10 * 60_000);
    expect(await call(dynamic, { authorization, idempotencyKey: 'once' })).toMatchObject({ status: 409, handlerRuns: 0, body: { error: { code: 'already_paid' } } });
    expect((await call(dynamic, { authorization, idempotencyKey: 'another' })).body).toMatchObject({ error: { code: 'quote_invalid' } });

    context.clock.advance(60 * 60_000);
    expect(await call(dynamic, { authorization, idempotencyKey: 'once' })).toMatchObject({ status: 409, handlerRuns: 0, body: { error: { code: 'already_paid' } } });
    expect((await call(dynamic, { authorization })).body).toMatchObject({ error: { code: 'proof_invalid', detail: 'credential_expired' } });
    expect((await call(dynamic, { authorization: forged, idempotencyKey: 'once' })).body).toMatchObject({ error: { code: 'proof_invalid', detail: 'preimage_mismatch' } });
    expect(context.ledger.charges()).toHaveLength(1);
  });

  it('spends one credential across routes at each route’s price', async () => {
    const context = setup({ calls: 2 });
    const cheap = context.toll.price('$0.01');
    const { authorization } = await buy(context, cheap);

    expect((await call(context.toll.price('$0.015'), { authorization, path: '/radar' })).status).toBe(200);
    expect(context.ledger.authorizations()[0]).toMatchObject({ consumed: { micros: 15_000n } });
    expect((await call(context.toll.price('$0.01'), { authorization, path: '/radar' })).body).toMatchObject({ error: { code: 'insufficient_authorization' } });
  });

  it('gives a failed call its value back, so the same credential pays for the retry', async () => {
    const context = setup();
    const gate = context.toll.price('$0.01');
    const { authorization } = await buy(context, gate);

    const failed = await call(gate, { authorization, handler: () => 'failed' });
    const retry = await call(gate, { authorization });

    expect([failed.status, retry.status]).toEqual([500, 200]);
    expect(context.charges()).toEqual(['released/failed', 'settled/completed']);
    expect(context.ledger.authorizations()[0]).toMatchObject({ consumed: { micros: 10_000n }, reserved: { micros: 0n } });
  });

  it('lets only one of two concurrent calls through when the credential covers one', async () => {
    const context = setup();
    const gate = context.toll.price('$0.01');
    const { authorization } = await buy(context, gate);
    const results = await Promise.all([call(gate, { authorization }), call(gate, { authorization })]);

    expect(results.map((result) => result.status).sort()).toEqual([200, 402]);
    expect(context.ledger.authorizations()[0]).toMatchObject({ consumed: { micros: 10_000n } });
  });

  it('accepts the macaroon lnget sends, with preimage= appended, as the same credential', async () => {
    const context = setup({ calls: 2 });
    const gate = context.toll.price('$0.01');
    const { challenge, preimage, authorization } = await buy(context, gate);
    const paid = `LSAT ${appendCaveat(challenge.macaroon, `preimage=${preimage}`)}:${preimage}`;

    expect((await call(gate, { authorization })).status).toBe(200);
    expect((await call(gate, { authorization: `${paid}, ${paid.replace('LSAT', 'L402')}` })).status).toBe(200);
    expect((await call(gate, { authorization: paid })).body).toMatchObject({ error: { code: 'insufficient_authorization' } });
    expect(context.ledger.authorizations()).toHaveLength(1);
  });

  it('accepts the credential over MCP and returns the receipt in meta', async () => {
    const context = setup();
    const challenged = await context.toll.price('$0.01').enter(mcpContext('forecast', {}));
    if (challenged.kind !== 'denied') throw new Error('expected a challenge');
    const mcp = challenged.denial.offers[0]?.challenge.mcp;
    if (typeof mcp?.invoice !== 'string' || typeof mcp.macaroon !== 'string') throw new Error('expected a macaroon and invoice');
    const preimage = context.lnd.pay(mcp.invoice);

    const entry = await context.toll.price('$0.01').enter(mcpContext('forecast', { [L402_CREDENTIAL_META]: `L402 ${mcp.macaroon}:${preimage}` }));
    if (entry.kind !== 'admitted') throw new Error('expected admission');
    const { receipt } = await entry.pass.complete('succeeded');

    expect(receipt.meta[L402_RECEIPT_META]).toMatchObject({ remaining: '$0.00' });
  });
});

describe('rejected credentials', () => {
  it('rejects a wrong preimage without running the handler or touching the ledger', async () => {
    const context = setup();
    const gate = context.toll.price('$0.01');
    const { challenge } = await buy(context, gate);
    const result = await call(gate, { authorization: `L402 ${challenge.macaroon}:${'00'.repeat(32)}` });

    expect(result).toMatchObject({ status: 402, handlerRuns: 0, body: { error: { code: 'proof_invalid', detail: 'preimage_mismatch' } } });
    expect(readChallenge(result.headers).invoice).not.toBe(challenge.invoice);
    expect(context.ledger.authorizations()).toHaveLength(0);
  });

  it('rejects an appended preimage caveat that disagrees with the presented preimage', async () => {
    const context = setup();
    const gate = context.toll.price('$0.01');
    const { challenge, preimage } = await buy(context, gate);
    const result = await call(gate, { authorization: `L402 ${appendCaveat(challenge.macaroon, `preimage=${'11'.repeat(32)}`)}:${preimage}` });

    expect(result.body).toMatchObject({ error: { code: 'proof_invalid', detail: 'preimage_mismatch' } });
  });

  it('rejects macaroons minted with another secret or altered in transit', async () => {
    const context = setup();
    const gate = context.toll.price('$0.01');
    const { challenge, preimage } = await buy(context, gate);
    const other = setup({ secret: 'another-secret-another-secret-0123' });
    const foreign = readChallenge((await call(other.toll.price('$0.01'))).headers);
    const foreignPreimage = other.lnd.pay(foreign.invoice);

    const bytes = Buffer.from(challenge.macaroon, 'base64');
    bytes[bytes.length - 40] = (bytes[bytes.length - 40] ?? 0) ^ 1;

    expect((await call(gate, { authorization: `L402 ${foreign.macaroon}:${foreignPreimage}` })).body).toMatchObject({ error: { code: 'proof_invalid', detail: 'macaroon_invalid' } });
    expect((await call(gate, { authorization: `L402 ${bytes.toString('base64')}:${preimage}` })).body).toMatchObject({ error: { code: 'proof_invalid', detail: 'macaroon_invalid' } });
    expect((await call(gate, { authorization: `L402 AgEEbHNhdAJCAAA=:${preimage}` })).body).toMatchObject({ error: { code: 'proof_invalid', detail: 'macaroon_invalid' } });
  });

  it('keeps accepting credentials minted with a rotated-out secret while it is still listed', async () => {
    const context = setup();
    const gate = context.toll.price('$0.01');
    const { authorization } = await buy(context, gate);
    const rotated = l402({
      network: 'regtest',
      invoices: lndRest({ url: 'https://lnd.test:8080', macaroon: LND_MACAROON_HEX, fetch: context.lnd.fetch }),
      rate,
      secret: ['a-brand-new-secret-0123456789abcdef', SECRET],
      clock: context.clock,
    });
    const toll = createTollstile({ rails: [rotated], ledger: memoryLedger({ clock: context.clock }), clock: context.clock, secret: 's'.repeat(32) });

    expect((await call(toll.price('$0.01'), { authorization })).status).toBe(200);
  });

  it('rejects an expired credential, including an expiry the holder shortened', async () => {
    const context = setup({ calls: 5, credentialTtlMs: 60 * 60_000 });
    const gate = context.toll.price('$0.01');
    const { challenge, preimage, authorization } = await buy(context, gate);
    const soon = Math.floor(context.clock.now().getTime() / 1000) + 60;
    const shortened = `L402 ${appendCaveat(challenge.macaroon, `tollstile_valid_until=${String(soon)}`)}:${preimage}`;

    expect((await call(gate, { authorization: shortened })).status).toBe(200);
    context.clock.advance(61_000);
    expect((await call(gate, { authorization: shortened })).body).toMatchObject({ error: { code: 'proof_invalid', detail: 'credential_expired' } });
    expect((await call(gate, { authorization })).status).toBe(200);
    context.clock.advance(60 * 60_000);
    expect((await call(gate, { authorization })).body).toMatchObject({ error: { code: 'proof_invalid', detail: 'credential_expired' } });
  });

  it('refuses caveats that restate the quote or value, and caveats it does not understand', async () => {
    const context = setup({ calls: 5 });
    const gate = context.toll.price('$0.01');
    const { challenge, preimage } = await buy(context, gate);
    const second = await call(gate);
    const otherQuote = String(second.body.quote);
    const attenuated = (caveat: string) => `L402 ${appendCaveat(challenge.macaroon, caveat)}:${preimage}`;

    expect((await call(gate, { authorization: attenuated(`tollstile_quote=${otherQuote}`) })).body).toMatchObject({ error: { code: 'proof_invalid', detail: 'caveat_conflict' } });
    expect((await call(gate, { authorization: attenuated('tollstile_limit=USD:999999999') })).body).toMatchObject({ error: { code: 'proof_invalid', detail: 'caveat_conflict' } });
    expect((await call(gate, { authorization: attenuated('services=weather:0') })).body).toMatchObject({ error: { code: 'proof_invalid', detail: 'caveat_unsupported' } });
    expect((await call(gate, { authorization: attenuated('no separator') })).body).toMatchObject({ error: { code: 'proof_invalid', detail: 'caveat_malformed' } });
    expect(context.ledger.authorizations()).toHaveLength(0);
  });

  it('rejects a credential priced in another currency', async () => {
    const context = setup();
    const { authorization } = await buy(context, context.toll.price('$0.01'));
    const result = await call(context.toll.price('0.01 EUR'), { authorization, path: '/euro' });

    expect(result.body).toMatchObject({ error: { code: 'proof_invalid', detail: 'currency_mismatch' } });
  });
});

describe('quotes', () => {
  // A credential outlives the request it was quoted for, so locking every call to that quote's price
  // would let a cheap request buy credit for expensive ones. Each call pays its own price against the limit.
  it('charges each call its current dynamic price against the credential limit', async () => {
    const context = setup({ calls: 10 });
    let current = '$0.02';
    const price: DynamicPrice = () => current;
    const gate = context.toll.price(price);
    const { authorization } = await buy(context, gate);
    current = '$0.05';

    expect((await call(gate, { authorization })).status).toBe(200);
    expect(context.ledger.charges()[0]?.amount).toEqual({ currency: 'USD', micros: 50_000n });
    expect(context.ledger.authorizations()[0]?.limit).toEqual({ currency: 'USD', micros: 200_000n });
  });

  it('keeps honoring a credential after its quote expires at the fixed route price, but asks dynamic routes for a new quote', async () => {
    const context = setup({ calls: 10 });
    const fixed = context.toll.price('$0.01');
    const dynamic = context.toll.price(() => '$0.01');
    const { authorization } = await buy(context, fixed);
    context.clock.advance(10 * 60_000);

    expect((await call(fixed, { authorization })).status).toBe(200);
    expect(await call(dynamic, { authorization })).toMatchObject({ status: 402, handlerRuns: 0, body: { error: { code: 'quote_invalid', detail: null } } });
  });
});

describe('invoice confirmation', () => {
  it('can require the node to report the invoice settled, and answers 503 when it cannot be asked', async () => {
    const context = setup({ confirmSettled: true });
    const gate = context.toll.price('$0.01');
    const challenged = readChallenge((await call(gate)).headers);
    const leaked = `L402 ${challenged.macaroon}:${context.lnd.preimageOf(challenged.invoice)}`;

    expect((await call(gate, { authorization: leaked })).body).toMatchObject({ error: { code: 'proof_invalid', detail: 'invoice_not_settled' } });

    context.lnd.pay(challenged.invoice);
    context.lnd.setMode('down');
    const unavailable = await call(gate, { authorization: leaked });
    expect(unavailable).toMatchObject({ status: 503, handlerRuns: 0 });
    expect(context.events.some((event) => event.type === 'error' && 'code' in event.error && event.error.code === 'PROVIDER_UNAVAILABLE')).toBe(true);

    context.lnd.setMode('up');
    expect((await call(gate, { authorization: leaked })).status).toBe(200);
  });

  it('does not contact the node to verify by default', async () => {
    const context = setup();
    const gate = context.toll.price('$0.01');
    const { authorization } = await buy(context, gate);
    context.lnd.setMode('down');

    expect((await call(gate, { authorization })).status).toBe(200);
  });
});

describe('reconciliation', () => {
  async function admit(context: ReturnType<typeof setup>) {
    const gate = context.toll.price('$0.01');
    const { authorization } = await buy(context, gate);
    const request = new Request('http://localhost/weather', { headers: { authorization } });
    const entry = await gate.enter(httpContext(request) satisfies Context);
    if (entry.kind !== 'admitted') throw new Error('expected admission');
    return { pass: entry.pass, authorization };
  }

  it('returns the value of a call whose handler was running when the process died', async () => {
    const context = setup();
    const { authorization } = await admit(context);

    context.clock.advance(60_000);
    await context.toll.reconcile({ olderThanMs: 1_000 });

    expect(context.charges()).toEqual(['released/failed']);
    expect((await call(context.toll.price('$0.01'), { authorization })).status).toBe(200);
  });

  it('consumes a call that was fulfilled before the process died', async () => {
    const context = setup();
    const { pass } = await admit(context);
    await pass.payment.fulfill();

    context.clock.advance(60_000);
    expect(await context.toll.reconcile({ olderThanMs: 1_000 })).toMatchObject({ examined: 1, resolved: 1, pending: 0 });
    expect(context.charges()).toEqual(['settled/completed']);
  });

  it('finishes a charge left in settling by re-running the deterministic settle, never by trusting the invoice', async () => {
    const context = setup();
    const { pass } = await admit(context);
    await pass.payment.fulfill();
    const [charge] = context.ledger.charges();
    if (charge === undefined) throw new Error('expected a charge');
    await context.ledger.transitionCharge(charge.id, { payment: 'reserved', fulfillment: 'completed' }, { payment: 'settling', fulfillment: 'completed' }, context.clock.now(), { pending: 'settle' });

    context.clock.advance(60_000);
    await context.toll.reconcile({ olderThanMs: 1_000 });

    expect(context.charges()).toEqual(['settled/completed']);
    expect(context.ledger.charges()[0]?.settlement?.reference).toBe(`${String(context.lnd.invoices.keys().next().value)}:${charge.id}`);
    expect(context.ledger.authorizations()[0]).toMatchObject({ consumed: { micros: 10_000n }, reserved: { micros: 0n } });
  });

  it('reports no out-of-ledger settlement for any charge, and cannot refund', async () => {
    const context = setup();
    const { pass } = await admit(context);
    await pass.complete('succeeded');
    const [authorization] = context.ledger.authorizations();
    const [charge] = context.ledger.charges();
    if (authorization === undefined || charge === undefined) throw new Error('expected records');
    const operation = { key: 'k', signal: new AbortController().signal };
    const data = { paymentHash: 'ab'.repeat(32) };

    expect(await context.rail.lookup({ ...authorization, data }, charge, operation)).toEqual({ status: 'none' });
    expect(await context.rail.refund({ ...authorization, data }, charge, operation)).toMatchObject({ status: 'rejected' });
    expect(await context.rail.settle({ ...authorization, data }, charge, operation)).toEqual(await context.rail.settle({ ...authorization, data }, charge, operation));
  });
});

describe('configuration', () => {
  it('refuses the upfront flow, which would need refunds', () => {
    const { toll } = setup();

    expect(() => toll.price('$0.01', { flow: 'upfront' })).toThrow(expect.objectContaining({ code: 'CAPABILITY_MISSING' }) as Error);
  });

  it('refuses a short secret, a bad network, and non-integer counts', () => {
    const invoices = lndRest({ url: 'https://lnd.test:8080', macaroon: LND_MACAROON_HEX });
    const base = { network: 'regtest', invoices, rate, secret: SECRET } as const;

    expect(() => l402({ ...base, secret: 'short' })).toThrow(/secret/);
    expect(() => l402({ ...base, secret: [] })).toThrow(/secret/);
    expect(() => l402({ ...base, network: 'bitcoin' as 'mainnet' })).toThrow(/network/);
    expect(() => l402({ ...base, calls: 0 })).toThrow(/calls/);
    expect(() => l402({ ...base, credentialTtlMs: 1.5 })).toThrow(/credentialTtlMs/);
  });
});
