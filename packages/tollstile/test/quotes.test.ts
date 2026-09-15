import { describe, expect, it } from 'vitest';
import { createTollstile, memoryLedger, testRail, type Rail } from '../src/index';
import { call, payWithQuote, setup } from './helpers';

describe('quotes', () => {
  it('charges the quoted price even if the price changed before the payer retried', async () => {
    const { toll, rail } = setup();
    let price = '$0.42';
    const gate = toll.price(() => price);

    const challenge = await call(gate);
    expect(challenge.body.price).toBe('$0.42');
    price = '$0.47';

    const paid = await call(gate, { payment: `test quote=${String(challenge.body.quote)}` });
    expect(paid.status).toBe(200);
    expect(rail.effects.settled).toEqual([420_000n]);
  });

  it('requires a quote on dynamic routes', async () => {
    const { toll } = setup();
    const result = await call(toll.price(() => '$0.42'), { payment: 'test' });

    expect(result).toMatchObject({ status: 402, body: { reason: 'quote_required' } });
  });

  it('rejects a tampered quote', async () => {
    const { toll } = setup();
    const gate = toll.price('$0.01');
    const challenge = await call(gate);
    const token = String(challenge.body.quote);
    const tampered = `${token.slice(0, -2)}${token.endsWith('A') ? 'B' : 'A'}${token.slice(-1)}`;

    const result = await call(gate, { payment: `test quote=${tampered}` });
    expect(result).toMatchObject({ status: 402, body: { reason: 'quote_invalid' } });
  });

  it('rejects an expired quote', async () => {
    const { toll, clock } = setup({ config: { quoteTtlMs: 1_000 } });
    const gate = toll.price('$0.01');
    const challenge = await call(gate);

    clock.advance(1_001);
    const result = await call(gate, { payment: `test quote=${String(challenge.body.quote)}` });
    expect(result).toMatchObject({ status: 402, body: { reason: 'quote_invalid' } });
  });

  it('rejects a quote issued for a different resource', async () => {
    const { toll } = setup();
    const gate = toll.price('$0.01');
    const challenge = await call(gate, { path: '/weather' });

    const result = await call(gate, { path: '/forecast', payment: `test quote=${String(challenge.body.quote)}` });
    expect(result).toMatchObject({ status: 402, body: { reason: 'quote_invalid' } });
  });

  it('honors quotes signed with a previous secret during rotation', async () => {
    const ledger = memoryLedger();
    const old = 'o'.repeat(32);
    const next = 'n'.repeat(32);
    const before = createTollstile({ rails: [testRail()], ledger, secret: old });
    const challenge = await call(before.price('$0.01'));

    const after = createTollstile({ rails: [testRail()], ledger, secret: [next, old] });
    const result = await call(after.price('$0.01'), { payment: `test quote=${String(challenge.body.quote)}` });
    expect(result.status).toBe(200);
  });

  it('pays against the quote with the helper flow', async () => {
    const { toll } = setup();
    expect((await payWithQuote(toll.price('$0.05'))).status).toBe(200);
  });

  it('requires a strong secret with live rails', () => {
    const live: Rail = { ...testRail(), name: 'live', livemode: true };
    expect(() => createTollstile({ rails: [live], ledger: memoryLedger() })).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    expect(() => createTollstile({ rails: [live], ledger: memoryLedger(), secret: 'short' })).toThrow(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    );
  });
});
