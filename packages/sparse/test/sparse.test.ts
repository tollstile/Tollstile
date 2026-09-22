import { describe, expect, it } from 'vitest';
import { upTo } from 'tollstile';
import { httpContext } from 'tollstile/testing';
import { oddsOf, outcomeOf, thresholdFor, TWO_128 } from '../src/index';
import { encodeTicket, TICKET_HEADER } from '../src/ticket';
import { call, challenge, pay, seeded, setup, URL_UNDER_TEST } from './helpers';

describe('ticket arithmetic', () => {
  it('threshold is floor(p / T · 2^256), deterministic at p ≥ T, and odds read back correctly', () => {
    expect(thresholdFor(10_000n, 1_000_000n)).toBe(TWO_128 / 100n);
    expect(oddsOf(thresholdFor(10_000n, 1_000_000n))).toBeCloseTo(0.01, 9);
    expect(thresholdFor(1_000_000n, 1_000_000n)).toBe(TWO_128);
    expect(thresholdFor(2_000_000n, 1_000_000n)).toBe(TWO_128);
    expect(oddsOf(TWO_128)).toBe(1);
    expect(thresholdFor(0n, 1_000_000n)).toBe(0n);
  });

  it('the same digest and secret always roll the same way', async () => {
    const threshold = thresholdFor(500_000n, 1_000_000n);
    const first = await outcomeOf('d', 's', threshold);
    for (let i = 0; i < 5; i += 1) expect(await outcomeOf('d', 's', threshold)).toBe(first);
    expect(await outcomeOf('d', 's', TWO_128)).toBe('win');
    expect(await outcomeOf('d', 's', 0n)).toBe('lose');
  });
});

describe('a paid call', () => {
  it('answers 402 with the witness fields, and a $1 ticket cannot cover a $2 route', async () => {
    const { toll } = setup();
    const accepts = await challenge(toll.price('$0.01'));
    expect(accepts).toMatchObject({ ticket: '1000000', price: '10000', threshold: (TWO_128 / 100n).toString(), to: '0xmerchant', facilitator: '0xfacilitator' });
    expect(accepts.commitment).toMatch(/^[0-9a-f]{64}$/);
    expect(accepts.challengeId.length).toBeGreaterThan(0);

    const tooDear = await call(toll.price('$2'));
    expect(tooDear.status).toBe(402);
    expect((tooDear.body.accepts as unknown[]).length).toBe(0);
  });

  it('settles a winner with one transfer of T and a loser with none; expected and realized are on the record', async () => {
    const { toll, facilitator, ledger } = setup({ random: seeded(3) });
    const wallet = facilitator.wallet('buyer', 10_000_000n);
    const gate = toll.price('$0.50');
    const outcomes: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const { result } = await pay(gate, wallet);
      expect(result.status).toBe(200);
      const charge = ledger.charges().at(-1);
      const details = charge?.settlement?.details as { outcome: string; expected: string; realized: string; ticket: string; odds: number };
      outcomes.push(details.outcome);
      expect(details).toMatchObject({ expected: '$0.50', ticket: '$1.00', odds: 0.5 });
      expect(details.realized).toBe(details.outcome === 'win' ? '$1.00' : '$0.00');
      expect(charge?.amount.micros).toBe(500_000n);
    }
    expect(outcomes).toContain('win');
    expect(outcomes).toContain('lose');
    expect(facilitator.transfers()).toBe(outcomes.filter((o) => o === 'win').length);
    expect(wallet.balance()).toBe(10_000_000n - BigInt(facilitator.transfers()) * 1_000_000n);
  });

  it('realized revenue converges on expected over many tickets', async () => {
    const { toll, facilitator } = setup({ random: seeded(11) });
    const wallet = facilitator.wallet('whale', 10_000_000_000n);
    const gate = toll.price('$0.05');
    const N = 400;
    for (let i = 0; i < N; i += 1) await pay(gate, wallet);
    const wins = facilitator.transfers();
    const expected = N * 0.05;
    const realized = wins * 1;
    // q = 0.05, n = 400 → 20 expected wins, σ ≈ 4.4; four sigma is a comfortable bound for a seeded run.
    expect(Math.abs(wins - 20)).toBeLessThan(18);
    expect(realized / expected).toBeGreaterThan(0.2);
    expect(realized / expected).toBeLessThan(1.9);
  });

  it('a failed handler settles nothing, even on a winning ticket', async () => {
    const { toll, facilitator, ledger } = setup({ random: seeded(5) });
    const wallet = facilitator.wallet('buyer', 10_000_000n);
    const { result } = await pay(toll.price('$1'), wallet, { outcome: 'failed' });
    expect(result.status).toBe(500);
    expect(facilitator.transfers()).toBe(0);
    expect(ledger.charges()[0]).toMatchObject({ payment: 'released', fulfillment: 'failed' });
    expect(wallet.balance()).toBe(10_000_000n);
  });
});

describe('invariants', () => {
  it('advertised odds are settled odds: a ticket whose threshold disagrees with its price and T is refused', async () => {
    const { toll, facilitator } = setup();
    const wallet = facilitator.wallet('buyer', 10_000_000n);
    const gate = toll.price('$0.01');
    const accepts = await challenge(gate);
    const inflated = await wallet.sign({ ...accepts, threshold: TWO_128.toString() });
    const result = await call(gate, { ticket: inflated });
    expect(result).toMatchObject({ status: 402, body: { error: { code: 'proof_invalid', detail: 'threshold_mismatch' } } });
    expect(facilitator.transfers()).toBe(0);
  });

  it('a ticket bound to another payee or facilitator is refused before the facilitator is asked', async () => {
    const { toll, facilitator } = setup();
    const wallet = facilitator.wallet('buyer', 10_000_000n);
    const gate = toll.price('$0.01');
    const accepts = await challenge(gate);
    const elsewhere = await wallet.sign({ ...accepts, to: '0xattacker' });
    expect((await call(gate, { ticket: elsewhere })).body).toMatchObject({ error: { detail: 'witness_mismatch' } });
  });

  it('a tampered digest is refused', async () => {
    const { toll, facilitator } = setup();
    const wallet = facilitator.wallet('buyer', 10_000_000n);
    const gate = toll.price('$0.01');
    const ticket = await wallet.sign(await challenge(gate));
    expect((await call(gate, { ticket: { ...ticket, price: '1' } })).body).toMatchObject({ error: { detail: 'digest_mismatch' } });
  });

  it('a losing ticket is single-use in the ledger even though its nonce never reached the chain', async () => {
    const { toll, facilitator } = setup({ random: seeded(2) });
    const wallet = facilitator.wallet('buyer', 10_000_000n);
    const gate = toll.price('$0.01');
    let loser;
    for (let i = 0; i < 50 && loser === undefined; i += 1) {
      const { ticket, result } = await pay(gate, wallet);
      if (result.headers.get('sparse-receipt')?.startsWith('sparse:lose:') === true) loser = ticket;
    }
    expect(loser).toBeDefined();
    if (loser === undefined) return;
    const replay = await call(gate, { ticket: loser });
    expect(replay).toMatchObject({ status: 409, body: { error: { code: 'proof_already_used' } } });
  });

  it('a buyer without T in the wallet is refused at verify; two tickets against one T settle at most once', async () => {
    const { toll, facilitator } = setup();
    const poor = facilitator.wallet('poor', 500_000n);
    const gate = toll.price('$1');
    const { result } = await pay(gate, poor);
    expect(result.body).toMatchObject({ error: { detail: 'insufficient_balance' } });

    const exactlyOne = facilitator.wallet('one', 1_000_000n);
    const [a, b] = await Promise.all([challenge(gate), challenge(gate)]);
    const [ta, tb] = await Promise.all([exactlyOne.sign(a), exactlyOne.sign(b)]);
    const results = await Promise.all([call(gate, { ticket: ta }), call(gate, { ticket: tb })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 402]);
    expect(facilitator.transfers()).toBe(1);
    expect(exactlyOne.balance()).toBe(0n);
  });
});

describe('selective abort and the retry rule', () => {
  it('a facilitator that hides a losing reveal charges nothing; resubmitting the same ticket cannot re-roll', async () => {
    const { toll, facilitator } = setup({ random: seeded(2) });
    const wallet = facilitator.wallet('buyer', 10_000_000n);
    const gate = toll.price('$0.01');
    // Find a losing ticket first, so the abort fault is exercised on a real loss.
    let losing;
    for (let i = 0; i < 50 && losing === undefined; i += 1) {
      const accepts = await challenge(gate);
      const ticket = await wallet.sign(accepts);
      facilitator.abortNextLosingVerify();
      const result = await call(gate, { ticket });
      if (result.body.error !== undefined && (result.body.error as { detail: string }).detail === 'verification_failed') losing = { accepts, ticket };
    }
    expect(losing).toBeDefined();
    if (losing === undefined) return;
    expect(facilitator.transfers()).toBe(0);

    // The honest client resubmits the *same* ticket: same commitment, same digest, same outcome — a loss, recorded as settled with nothing moved.
    const again = await call(gate, { ticket: losing.ticket });
    expect(again.status).toBe(200);
    expect(again.headers.get('sparse-receipt')).toMatch(/^sparse:lose:/);
    expect(facilitator.transfers()).toBe(0);

    // A *new* signature for the same challenge is what the re-roll attack needs, and the facilitator refuses it.
    const reRolled = await wallet.sign(losing.accepts, { nonce: 'fresh' });
    const refused = await call(gate, { ticket: reRolled });
    expect(refused.body).toMatchObject({ error: { detail: 'challenge_consumed' } });
  });
});

describe('variable amounts', () => {
  it('settles an upTo() route at the charged price: odds fall from the signed ceiling, never rise', async () => {
    const { toll, facilitator, ledger } = setup({ random: seeded(9) });
    const wallet = facilitator.wallet('buyer', 100_000_000n);
    const gate = toll.price(upTo('$1'));
    const accepts = await challenge(gate);
    expect(accepts.threshold).toBe(TWO_128.toString());
    const ticket = await wallet.sign(accepts);
    const entry = await gate.enter(httpContext(new Request(URL_UNDER_TEST, { headers: { [TICKET_HEADER]: encodeTicket(ticket) } }), { resource: URL_UNDER_TEST }));
    if (entry.kind !== 'admitted') throw new Error('expected admission');
    await entry.pass.payment.fulfill({ amount: '$0.10' });
    const completion = await entry.pass.complete('succeeded');
    expect(completion.denial).toBeNull();
    const charge = ledger.charges()[0];
    expect(charge?.amount.micros).toBe(100_000n);
    expect((charge?.settlement?.details as { odds: number }).odds).toBeCloseTo(0.1, 6);
  });
});

describe('lost responses', () => {
  it('a settle whose response was lost is resolved by lookup, once', async () => {
    const { toll, facilitator, ledger, clock } = setup();
    const wallet = facilitator.wallet('buyer', 10_000_000n);
    facilitator.loseNextSettleResponse();
    const { result } = await pay(toll.price('$1'), wallet);
    expect(result.status).toBe(200);
    expect(ledger.charges()[0]?.payment).toBe('unknown');
    clock.advance(60 * 60_000);
    await toll.reconcile({ olderThanMs: 0 });
    expect(ledger.charges()[0]?.payment).toBe('settled');
    expect(facilitator.transfers()).toBe(1);
  });
});
