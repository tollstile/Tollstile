import { createTollstile, memoryLedger, testRail, toResponse, TollstileError, type Gate, type Rail } from 'tollstile';
import { fakeClock, httpContext, mcpContext } from 'tollstile/testing';
import { describe, expect, it } from 'vitest';
import { userMandate, type UserMandateOptions } from '../src/index';
import { generateKey, mandateChain, publicJwk, type ChainOptions } from './mandates';

const URL_ = 'https://api.example/purchase';

async function setup(options: Partial<UserMandateOptions> = {}, price = '$5.00') {
  const issuer = await generateKey();
  const agent = await generateKey();
  const issuerJwk = await publicJwk(issuer);
  const clock = fakeClock();
  const ledger = memoryLedger({ clock });
  const rail = testRail();
  const toll = createTollstile({ rails: [rail], ledger, clock, secret: 's'.repeat(32) });
  const requirement = userMandate({
    resolveKey: (header) => Promise.resolve(header.kid === 'issuer-1' ? issuerJwk : undefined),
    payee: { id: 'merchant_1' },
    audience: 'https://api.example',
    ...options,
  });
  const gate = toll.price(price, { require: [requirement] });
  const seconds = () => Math.floor(clock.now().getTime() / 1000);

  /** Asks for the resource, and returns the quote token and the nonce an agent reads from it. */
  const quote = async () => {
    const entry = await gate.enter(httpContext(new Request(URL_)));
    if (entry.kind !== 'denied') throw new Error('expected a challenge');
    const token = entry.denial.body.quote;
    if (typeof token !== 'string') throw new Error('no quote');
    const [payload = ''] = token.split('.');
    const { nonce } = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { nonce: string };
    return { token, nonce };
  };

  const chain = async (overrides: Partial<ChainOptions> & { readonly nonce: string }) =>
    (await mandateChain({ issuer, agent, iat: seconds(), ...overrides })).chain;

  /** Pays with the quote and presents the mandate, the way an agent retries after a 402. */
  const pay = async (token: string, mandate: string | undefined, header = 'ap2-mandate') => {
    const headers = new Headers({ payment: `test quote=${token}` });
    if (mandate !== undefined) headers.set(header, mandate);
    return enter(gate, new Request(URL_, { headers }));
  };

  /** One 402 → mandate → retry round trip. */
  const purchase = async (overrides: Partial<ChainOptions> = {}) => {
    const { token, nonce } = await quote();
    return pay(token, await chain({ nonce, ...overrides }));
  };

  return { issuer, agent, clock, ledger, rail, gate, quote, chain, pay, purchase, seconds };
}

async function enter(gate: Gate<readonly Rail[]>, request: Request) {
  const entry = await gate.enter(httpContext(request));
  if (entry.kind === 'admitted') {
    await entry.pass.complete('succeeded');
    return { status: 200, reason: null };
  }
  const body = (await toResponse(entry.denial).json()) as { reason?: string | null };
  return { status: entry.denial.status, reason: body.reason ?? null };
}

describe('userMandate', () => {
  it('admits a payment whose mandate chain binds the quote nonce, and settles it', async () => {
    const { purchase, rail, ledger } = await setup();

    expect(await purchase()).toEqual({ status: 200, reason: null });
    expect(rail.effects.settled).toEqual([5_000_000n]);
    expect(ledger.charges()).toHaveLength(1);
  });

  it('asks for a mandate with 402 when none is presented, and reserves nothing', async () => {
    const { quote, pay, ledger, rail } = await setup();
    const { token } = await quote();

    expect(await pay(token, undefined)).toEqual({ status: 402, reason: 'mandate_required' });
    expect(ledger.charges()).toHaveLength(0);
    expect(rail.effects.settlements).toBe(0);
  });

  it('requires the key-binding nonce to be the nonce of the quote the payment answers', async () => {
    const { quote, pay, chain } = await setup();
    const first = await quote();
    const second = await quote();

    expect(await pay(second.token, await chain({ nonce: first.nonce }))).toEqual({ status: 402, reason: 'mandate_invalid:nonce_mismatch' });
    expect(await pay(second.token, await chain({ nonce: second.nonce }))).toEqual({ status: 200, reason: null });
  });

  it('requires a configured audience', async () => {
    const { purchase } = await setup();
    expect(await purchase({ aud: 'https://elsewhere.example' })).toMatchObject({ reason: 'mandate_invalid:audience_mismatch' });
  });

  it('accepts a mandate once', async () => {
    const { quote, pay, chain, rail } = await setup();
    const { token, nonce } = await quote();
    const mandate = await chain({ nonce });

    expect(await pay(token, mandate)).toEqual({ status: 200, reason: null });
    expect(await pay(token, mandate)).toEqual({ status: 402, reason: 'mandate_invalid:mandate_reused' });
    expect(rail.effects.settlements).toBe(1);
  });

  it('rejects a root issuer it does not trust, or a root signed by another key', async () => {
    const { purchase } = await setup();
    expect(await purchase({ issuer: await generateKey() })).toMatchObject({ reason: 'mandate_invalid:issuer_signature_invalid' });

    const untrusting = await setup({ resolveKey: () => Promise.resolve(undefined) });
    expect(await untrusting.purchase()).toMatchObject({ reason: 'mandate_invalid:issuer_untrusted' });
  });

  it("verifies the agent's key-binding signature with the open mandate's cnf key", async () => {
    const { purchase } = await setup();
    expect(await purchase({ kbSigner: await generateKey() })).toMatchObject({ reason: 'mandate_invalid:kb_signature_invalid' });
  });

  it('checks sd_hash or issuer_jwt_hash, and requires exactly one', async () => {
    const { purchase } = await setup();

    expect(await purchase({ binding: 'issuer_jwt_hash' })).toEqual({ status: 200, reason: null });
    expect(await purchase({ binding: 'none' })).toMatchObject({ reason: 'mandate_invalid:kb_binding_missing' });
    expect(await purchase({ binding: 'both' })).toMatchObject({ reason: 'mandate_invalid:kb_binding_missing' });
  });

  it('rejects a chain whose root disclosures differ from the ones sd_hash covered', async () => {
    const { quote, pay, chain } = await setup();
    const { token, nonce } = await quote();
    const mandate = await chain({ nonce });
    // Drop the payee disclosure: the root still verifies, but sd_hash no longer matches.
    const [root = '', terminal = ''] = mandate.split('~~');
    const [jwt, , open] = root.split('~');
    expect(await pay(token, `${jwt ?? ''}~${open ?? ''}~~${terminal}`)).toMatchObject({ reason: 'mandate_invalid:kb_binding_mismatch' });
  });

  it('rejects a tampered closed mandate', async () => {
    const { quote, pay, chain } = await setup();
    const { token, nonce } = await quote();
    const mandate = await chain({ nonce });
    const tampered = mandate.replace(/~([^~]+)~$/, (_match, disclosure: string) => {
      const decoded = Buffer.from(disclosure, 'base64url').toString().replace('"amount":500', '"amount":50000');
      return `~${Buffer.from(decoded).toString('base64url')}~`;
    });
    expect(await pay(token, tampered)).toMatchObject({ reason: 'mandate_invalid:disclosure_unreferenced' });
  });

  it('matches vct exactly', async () => {
    const { purchase } = await setup();
    expect(await purchase({ closed: { vct: 'mandate.payment.2' } })).toMatchObject({ reason: 'mandate_invalid:closed_mandate:vct_mismatch' });
    expect(await purchase({ open: { vct: 'mandate.payment.open' } })).toMatchObject({ reason: 'mandate_invalid:open_mandate:vct_mismatch' });
  });

  it('requires the closed amount to cover the price in the same currency', async () => {
    const { purchase } = await setup();
    expect(await purchase({ closed: { payment_amount: { amount: 499, currency: 'USD' } } })).toMatchObject({ reason: 'mandate_invalid:amount_insufficient' });
    expect(await purchase({ closed: { payment_amount: { amount: 5.5, currency: 'USD' } } })).toMatchObject({
      reason: 'mandate_invalid:closed_mandate:payment_amount_invalid',
    });
    expect(
      await purchase({
        closed: { payment_amount: { amount: 500, currency: 'EUR' } },
        constraints: [{ type: 'payment.amount_range', currency: 'EUR', max: 1000 }],
      }),
    ).toMatchObject({ reason: 'mandate_invalid:currency_mismatch' });
  });

  it('uses ISO 4217 minor units', async () => {
    const { purchase } = await setup({}, '¥500');
    expect(
      await purchase({
        closed: { payment_amount: { amount: 500, currency: 'JPY' } },
        constraints: [{ type: 'payment.amount_range', currency: 'JPY', max: 1000 }],
      }),
    ).toEqual({ status: 200, reason: null });
  });

  it('requires the payee to be this merchant', async () => {
    const { purchase } = await setup();
    const other = { id: 'merchant_2', name: 'Other', website: 'https://other.example' };
    expect(await purchase({ closed: { payee: other }, constraints: [] })).toMatchObject({ reason: 'mandate_invalid:payee_mismatch' });
  });

  it('evaluates amount_range, allowed_payees, and execution_date constraints', async () => {
    const { purchase, clock } = await setup();
    const now = clock.now().getTime();
    const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();

    expect(await purchase({ constraints: [{ type: 'payment.amount_range', currency: 'USD', max: 499 }] })).toMatchObject({
      reason: 'mandate_invalid:constraint_failed:payment.amount_range',
    });
    expect(await purchase({ constraints: [{ type: 'payment.amount_range', currency: 'USD', min: 501, max: 1000 }] })).toMatchObject({
      reason: 'mandate_invalid:constraint_failed:payment.amount_range',
    });
    expect(await purchase({ constraints: [{ type: 'payment.allowed_payees', allowed: [{ id: 'merchant_2', name: 'Other' }] }] })).toMatchObject({
      reason: 'mandate_invalid:constraint_failed:payment.allowed_payees',
    });
    expect(await purchase({ constraints: [{ type: 'payment.execution_date', not_before: iso(60_000) }] })).toMatchObject({
      reason: 'mandate_invalid:constraint_failed:payment.execution_date',
    });
    expect(await purchase({ constraints: [{ type: 'payment.execution_date', not_before: iso(-60_000), not_after: iso(60_000) }] })).toEqual({
      status: 200,
      reason: null,
    });
  });

  it('fails constraints it does not understand, including payment.reference', async () => {
    const { purchase } = await setup();
    expect(await purchase({ constraints: [{ type: 'payment.reference', conditional_transaction_id: 'abc' }] })).toMatchObject({
      reason: 'mandate_invalid:unsupported_constraint:payment.reference',
    });
    expect(await purchase({ constraints: [{ type: 'payment.budget', max: 10, currency: 'USD' }] })).toMatchObject({
      reason: 'mandate_invalid:unsupported_constraint:payment.budget',
    });
  });

  it('requires pre-set values in the open mandate to be equal in the closed one', async () => {
    const { purchase } = await setup();
    expect(await purchase({ open: { payment_instrument: { id: 'card-1', type: 'card' } } })).toMatchObject({
      reason: 'mandate_invalid:preset_mismatch:payment_instrument',
    });
    expect(await purchase({ open: { payment_instrument: { id: 'stub', type: 'card' } } })).toEqual({ status: 200, reason: null });
  });

  it('rejects expired open mandates, stale key bindings, and future execution dates', async () => {
    const { purchase, seconds, clock } = await setup();
    expect(await purchase({ open: { exp: seconds() - 60 } })).toMatchObject({ reason: 'mandate_invalid:expired' });
    expect(await purchase({ iat: seconds() - 600 })).toMatchObject({ reason: 'mandate_invalid:stale' });
    expect(await purchase({ closed: { execution_date: new Date(clock.now().getTime() + 86_400_000).toISOString() } })).toMatchObject({
      reason: 'mandate_invalid:execution_date_future',
    });
  });

  it('refuses direct mandates and deeper delegation, which cannot be bound to this verifier', async () => {
    const { quote, pay, chain } = await setup();
    const { token, nonce } = await quote();
    const mandate = await chain({ nonce });
    const [root = '', terminal = ''] = mandate.split('~~');

    expect(await pay(token, `${root}~`)).toMatchObject({ reason: 'mandate_invalid:key_binding_required' });
    expect(await pay(token, `${root}~~${terminal}~${terminal}`)).toMatchObject({ reason: 'mandate_invalid:delegation_depth_unsupported' });
    expect(await pay(token, await chain({ nonce, kbTyp: 'kb+sd-jwt+kb' }))).toMatchObject({ reason: 'mandate_invalid:delegation_depth_unsupported' });
    expect(await pay(token, await chain({ nonce, rootTyp: 'kb+sd-jwt' }))).toMatchObject({ reason: 'mandate_invalid:root_type_invalid' });
  });

  it('rejects malformed input without throwing', async () => {
    const { quote, pay } = await setup();
    const { token } = await quote();
    for (const mandate of ['garbage', '~~', 'a.b.c~~d.e.f~', 'x'.repeat(20_000)]) {
      const result = await pay(token, mandate);
      expect(result.status, mandate.slice(0, 20)).toBe(402);
      expect(result.reason).toMatch(/^mandate_invalid:/);
    }
  });

  it('reads the mandate from a configurable header and MCP meta key', async () => {
    const custom = await setup({ header: 'X-Mandate' });
    const { token, nonce } = await custom.quote();
    expect(await custom.pay(token, await custom.chain({ nonce }), 'x-mandate')).toEqual({ status: 200, reason: null });

    const mcp = await setup({ metaKey: 'example/mandate' });
    const mandate = await mcp.chain({ nonce: 'agent-chosen' });
    const entry = await mcp.gate.enter(mcpContext('purchase', { 'tollstile/test-payment': 'test', 'example/mandate': mandate }));
    expect(entry.kind).toBe('admitted');
  });

  it('refuses invalid configuration at construction', () => {
    const base: UserMandateOptions = { resolveKey: () => Promise.resolve(undefined), payee: { id: 'm' }, audience: 'a' };
    for (const options of [{ ...base, audience: [] }, { ...base, audience: '' }, { ...base, payee: { id: '' } }, { ...base, maxAgeMs: -1 }]) {
      expect(() => userMandate(options)).toThrow(TollstileError);
    }
  });
});
