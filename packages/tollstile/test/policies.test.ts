import { describe, expect, it } from 'vitest';
import {
  amountOver,
  credits,
  limit,
  memoryBalance,
  payers,
  payPerCall,
  subscriber,
  when,
  type Requirement,
} from '../src/index';
import { httpContext } from '../src/testing/index';
import { call, setup } from './helpers';

const alice = { id: 'acct_alice' };

describe('subscriber', () => {
  it('lets an active subscriber through with no charge', async () => {
    const { toll, ledger } = setup();
    const gate = toll.price('$0.01', { access: [subscriber({ active: (principal) => principal.id === alice.id }), payPerCall()] });
    const result = await call(gate, { principal: alice });

    expect(result).toMatchObject({ status: 200, body: { via: 'policy' } });
    expect(ledger.charges()).toHaveLength(0);
  });

  it('falls through to payment for anonymous callers, and denies when nothing asks for payment', async () => {
    const { toll } = setup();
    const policy = subscriber({ active: () => true });

    expect((await call(toll.price('$0.01', { access: [policy, payPerCall()] }))).status).toBe(402);
    expect((await call(toll.price('$0.01', { access: [policy] }))).status).toBe(403);
  });
});

describe('credits', () => {
  it('reserves before the handler, commits on success, and releases on failure', async () => {
    const { toll, charges } = setup();
    const balance = memoryBalance({ [alice.id]: '$0.05' });
    const gate = toll.price('$0.02', { access: [credits({ balance }), payPerCall()] });

    await call(gate, {
      principal: alice,
      handler: () => {
        expect(balance.available(alice.id)?.micros).toBe(30_000n);
        return 'succeeded';
      },
    });
    await call(gate, { principal: alice, handler: () => 'failed' });

    expect(balance.available(alice.id)?.micros).toBe(30_000n);
    expect(charges()).toEqual(['settled/completed', 'released/failed']);
  });

  it('asks for payment when credits are insufficient', async () => {
    const { toll } = setup();
    const balance = memoryBalance({ [alice.id]: '$0.01' });
    const result = await call(toll.price('$0.02', { access: [credits({ balance }), payPerCall()] }), { principal: alice });

    expect(result.status).toBe(402);
    expect(balance.available(alice.id)?.micros).toBe(10_000n);
  });

  it('releases a reservation left by a crash, restoring the balance', async () => {
    const { toll, clock, charges } = setup();
    const balance = memoryBalance({ [alice.id]: '$0.05' });
    const gate = toll.price('$0.02', { access: [credits({ balance })] });
    await gate.enter(httpContext(new Request('http://localhost/weather'), { principal: alice }));
    expect(balance.available(alice.id)?.micros).toBe(30_000n);

    clock.advance(60_000);
    await toll.reconcile({ olderThanMs: 1_000 });

    expect(charges()).toEqual(['released/failed']);
    expect(balance.available(alice.id)?.micros).toBe(50_000n);
  });

  it('commits a reservation whose handler fulfilled before a crash', async () => {
    const { toll, clock, charges } = setup();
    const balance = memoryBalance({ [alice.id]: '$0.05' });
    const entry = await toll
      .price('$0.02', { access: [credits({ balance })] })
      .enter(httpContext(new Request('http://localhost/weather'), { principal: alice }));
    if (entry.kind !== 'admitted') throw new Error('expected admission');
    await entry.pass.payment.fulfill();

    clock.advance(60_000);
    await toll.reconcile({ olderThanMs: 1_000 });

    expect(charges()).toEqual(['settled/completed']);
    expect(balance.available(alice.id)?.micros).toBe(30_000n);
  });
});

describe('requirements', () => {
  it('limits payments per payer', async () => {
    const { toll } = setup();
    const gate = toll.price('$0.01', { require: [limit({ perPayer: '2/hour' })] });

    const statuses = [];
    for (const proof of ['p1', 'p2', 'p3']) statuses.push((await call(gate, { payment: `test proof=${proof} payer=agent_1` })).status);

    expect(statuses).toEqual([200, 200, 429]);
    expect((await call(gate, { payment: 'test proof=p4 payer=agent_2' })).status).toBe(200);
  });

  it('caps daily spend and ignores released charges', async () => {
    const { toll } = setup();
    const gate = toll.price('$0.40', { require: [limit({ spendPerDay: '$1' })] });

    await call(gate, { payment: 'test proof=p0 payer=agent_1', handler: () => 'failed' });
    const statuses = [];
    for (const proof of ['p1', 'p2', 'p3']) statuses.push((await call(gate, { payment: `test proof=${proof} payer=agent_1` })).status);

    expect(statuses).toEqual([200, 200, 429]);
  });

  it('denies payers on the deny list, case-insensitively', async () => {
    const { toll, rail } = setup();
    const result = await call(toll.price('$0.01', { require: [payers({ deny: ['0xABC'] })] }), { payment: 'test payer=0xabc' });

    expect(result.status).toBe(403);
    expect(rail.effects.settlements).toBe(0);
  });

  it('applies a conditional requirement only above a threshold', async () => {
    const { toll } = setup();
    const mandate: Requirement = { name: 'mandate', check: () => Promise.resolve({ ok: false, status: 402, reason: 'mandate required' }) };
    const require = [when(amountOver('$5'), mandate)];

    expect((await call(toll.price('$1', { require }), { payment: 'test' })).status).toBe(200);
    expect(await call(toll.price('$10', { require }), { payment: 'test' })).toMatchObject({
      status: 402,
      body: { error: { code: 'requirement_failed' }, requirement: 'mandate' },
    });
  });

  it('gives requirements a single-use claims store for nonces', async () => {
    const { toll } = setup();
    const nonce: Requirement = {
      name: 'nonce',
      async check({ context, claims, now }) {
        const value = context.request?.headers.get('payment') ?? '';
        const claimed = await claims.claim('nonce', value, new Date(now.getTime() + 60_000));
        return claimed === 'claimed' ? { ok: true } : { ok: false, status: 403, reason: 'nonce reused' };
      },
    };
    const gate = toll.price('$0.01', { require: [nonce] });

    expect((await call(gate, { payment: 'test proof=p1' })).status).toBe(200);
    expect((await call(gate, { payment: 'test proof=p1' })).status).toBe(403);
  });
});
