import { PGlite } from '@electric-sql/pglite';
import {
  createTollstile,
  credits,
  memoryBalance,
  memoryLedger,
  money,
  testRail,
  toResponse,
  type Clock,
  type Gate,
  type Outcome,
  type Rail,
  type TestRailOptions,
} from 'tollstile';
import { fakeClock, httpContext } from 'tollstile/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { postgresLedger, postgresSchema, type PostgresQuery, type PostgresRow } from '../src/index';
import { describeLedgerConformance } from './ledger-conformance';

let db: PGlite;
let tables = 0;

beforeAll(async () => {
  db = new PGlite();
  await db.waitReady;
}, 120_000);

afterAll(async () => {
  await db.close();
});

/** Each ledger gets its own tables, created from the published schema with its own prefix. */
async function pgliteLedger(clock: Clock) {
  tables += 1;
  const prefix = `t${String(tables)}_`;
  await db.exec(postgresSchema.replaceAll('tollstile_', prefix));
  const query: PostgresQuery = (sql, params) => db.query<PostgresRow>(sql, params);
  const ledger = postgresLedger({
    query,
    transaction: (work) => db.transaction((tx) => work((sql, params) => tx.query<PostgresRow>(sql, params))),
    tablePrefix: prefix,
    clock,
  });
  const history = async (chargeId: string) =>
    (
      await db.query<PostgresRow>(
        `SELECT version, payment, fulfillment, pending, amount_micros::text AS amount FROM ${prefix}charge_transitions WHERE charge_id = $1 ORDER BY version`,
        [chargeId],
      )
    ).rows;
  return { ledger, prefix, history };
}

describeLedgerConformance('memory', (clock) => Promise.resolve(memoryLedger({ clock })));
describeLedgerConformance('postgres', async (clock) => (await pgliteLedger(clock)).ledger);

describe('postgresLedger', () => {
  const authorization = (at: Date) => ({
    id: 'auth_1',
    rail: 'test',
    payer: 'payer_1',
    kind: 'reusable' as const,
    limit: money('USD', 100_000n),
    quoteId: null,
    expiresAt: null,
    data: {},
    at,
  });
  const newCharge = (at: Date, id = 'chg_1') => ({
    id,
    authorizationId: 'auth_1',
    requestId: id,
    resource: 'GET /weather',
    payer: 'payer_1',
    flow: 'authorization' as const,
    amount: money('USD', 10_000n),
    fulfillment: 'running' as const,
    requestHash: null,
    at,
  });

  it('appends a history row for the creation and for every transition, and none for a conflict', async () => {
    const clock = fakeClock();
    const { ledger, history } = await pgliteLedger(clock);
    await ledger.openAuthorization(authorization(clock.now()));
    await ledger.createCharge(newCharge(clock.now()));
    await ledger.transitionCharge('chg_1', { payment: 'reserved', fulfillment: 'running' }, { payment: 'settling', fulfillment: 'completed' }, clock.now(), {
      pending: 'settle',
      amount: money('USD', 7_000n),
    });
    await ledger.transitionCharge('chg_1', { payment: 'reserved', fulfillment: 'running' }, { payment: 'released', fulfillment: 'failed' }, clock.now());
    await ledger.transitionCharge('chg_1', { payment: 'settling', fulfillment: 'completed' }, { payment: 'settled', fulfillment: 'completed' }, clock.now(), {
      pending: null,
    });

    expect(await history('chg_1')).toEqual([
      { version: 1, payment: 'reserved', fulfillment: 'running', pending: null, amount: '10000' },
      { version: 2, payment: 'settling', fulfillment: 'completed', pending: 'settle', amount: '7000' },
      { version: 3, payment: 'settled', fulfillment: 'completed', pending: null, amount: '7000' },
    ]);
  });

  it('rolls back the reservation when the transaction fails part-way', async () => {
    const clock = fakeClock();
    const { prefix } = await pgliteLedger(clock);
    let statements = 0;
    const failing = postgresLedger({
      query: (sql, params) => db.query<PostgresRow>(sql, params),
      transaction: (work) =>
        db.transaction((tx) =>
          work((sql, params) => {
            statements += 1;
            // The fourth statement of createCharge updates the authorization's totals.
            return statements === 4 ? Promise.reject(new Error('connection lost')) : tx.query<PostgresRow>(sql, params);
          }),
        ),
      tablePrefix: prefix,
      clock,
    });
    await failing.openAuthorization(authorization(clock.now()));

    await expect(failing.createCharge(newCharge(clock.now()))).rejects.toThrow('connection lost');
    expect(await failing.getCharge('chg_1')).toBeUndefined();
    expect(await failing.getAuthorization('auth_1')).toMatchObject({ reserved: money('USD', 0n) });
  });

  it('refuses an invalid table prefix', () => {
    const options = { query: () => Promise.resolve({ rows: [] }), transaction: () => Promise.reject(new Error('unused')) };
    expect(() => postgresLedger({ ...options, tablePrefix: 'billing; DROP TABLE x' })).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    expect(() => postgresLedger({ ...options, tablePrefix: '1_' })).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
  });

  it('applies the schema twice without error', async () => {
    const { prefix } = await pgliteLedger(fakeClock());
    await expect(db.exec(postgresSchema.replaceAll('tollstile_', prefix))).resolves.toBeDefined();
  });

  it('works with the default table names', async () => {
    await db.exec(postgresSchema);
    const ledger = postgresLedger({
      query: (sql, params) => db.query<PostgresRow>(sql, params),
      transaction: (work) => db.transaction((tx) => work((sql, params) => tx.query<PostgresRow>(sql, params))),
    });
    expect(await ledger.claim('scope', 'key', new Date(Date.now() + 60_000))).toBe('claimed');
    expect((await db.query<PostgresRow>('SELECT count(*)::int AS n FROM tollstile_claims')).rows).toEqual([{ n: 1 }]);
  });
});

describe('with createTollstile', () => {
  async function setup(railOptions: TestRailOptions = {}) {
    const clock = fakeClock();
    const { ledger } = await pgliteLedger(clock);
    const rail = testRail(railOptions);
    const errors: Error[] = [];
    const toll = createTollstile({
      rails: [rail],
      ledger,
      clock,
      onEvent: (event) => {
        if (event.type === 'error') errors.push(event.error);
      },
    });
    return { clock, ledger, rail, toll, errors };
  }

  async function call<Rails extends readonly Rail[]>(gate: Gate<Rails>, payment?: string, outcome: Outcome = 'succeeded', principal?: { id: string }, idempotencyKey?: string) {
    const headers = new Headers(payment === undefined ? {} : { payment });
    if (idempotencyKey !== undefined) headers.set('idempotency-key', idempotencyKey);
    const context = httpContext(new Request('http://localhost/weather', { headers }), principal === undefined ? {} : { principal });
    const entry = await gate.enter(context);
    if (entry.kind === 'denied') {
      const response = toResponse(entry.denial);
      return { status: response.status, body: (await response.json()) as Record<string, unknown>, chargeId: undefined, completion: undefined };
    }
    const completion = await entry.pass.complete(outcome);
    const status = completion.denial?.status ?? (outcome === 'succeeded' ? 200 : 500);
    return { status, body: {} as Record<string, unknown>, chargeId: entry.pass.payment.chargeId ?? undefined, completion };
  }

  it('pays with the quote it was offered, then refuses a replay', async () => {
    const { toll, rail, ledger } = await setup();
    const gate = toll.price('$0.01');
    const challenge = await call(gate);
    expect(challenge.status).toBe(402);

    const paid = await call(gate, `test quote=${String(challenge.body.quote)} proof=p1`);
    expect(paid.status).toBe(200);
    expect(await ledger.getCharge(paid.chargeId ?? '')).toMatchObject({ payment: 'settled', fulfillment: 'completed', amount: money('USD', 10_000n) });

    expect(await call(gate, 'test proof=p1')).toMatchObject({ status: 409, body: { error: { code: 'proof_already_used' } } });
    expect(rail.effects.settlements).toBe(1);
  });

  it('drops the payer signature from a single-use authorization once its charge settled', async () => {
    const { toll, ledger } = await setup();
    const result = await call(toll.price('$0.01'), 'test proof=p1 signature=0xsig');

    expect(result.completion).toMatchObject({ settlement: 'settled', denial: null });
    const charge = await ledger.getCharge(result.chargeId ?? '');
    expect(charge).toMatchObject({ payment: 'settled', fulfillment: 'completed' });
    expect((await ledger.getAuthorization(charge?.authorizationId ?? ''))?.data).toEqual({ proofId: 'p1', payer: 'test-payer' });
  });

  it('keeps the signature while settlement is unknown, and drops it once reconciliation settles', async () => {
    const { toll, rail, ledger, clock } = await setup();
    rail.simulate({ settle: 'timeout-after-effect' });
    const result = await call(toll.price('$0.01'), 'test proof=p1 signature=0xsig');
    const authorizationId = (await ledger.getCharge(result.chargeId ?? ''))?.authorizationId ?? '';

    expect(result.completion).toMatchObject({ settlement: 'unknown' });
    expect((await ledger.getAuthorization(authorizationId))?.data).toMatchObject({ signature: '0xsig' });
    rail.simulate({});
    clock.advance(60_000);
    await toll.reconcile({ olderThanMs: 1_000 });
    expect((await ledger.getAuthorization(authorizationId))?.data).toEqual({ proofId: 'p1', payer: 'test-payer' });
  });

  it('answers a reusable credential retried with the same idempotency key as already paid, and settles once', async () => {
    const { toll, rail, ledger } = await setup({ authorization: 'reusable' });
    const gate = toll.price('$0.10');

    const first = await call(gate, 'test proof=c limit=$1', 'succeeded', undefined, 'order-1');
    const retry = await call(gate, 'test proof=c limit=$1', 'succeeded', undefined, 'order-1');

    expect(first.status).toBe(200);
    expect(retry).toMatchObject({ status: 409, body: { error: { code: 'already_paid' }, chargeId: first.chargeId } });
    expect(rail.effects.settled).toEqual([100_000n]);
    expect((await ledger.getCharge(first.chargeId ?? ''))?.requestHash).toEqual(expect.any(String));
  });

  it('returns the result reference the handler stored to a keyed retry that is already paid', async () => {
    const { toll, rail, ledger } = await setup({ authorization: 'reusable' });
    const gate = toll.price('$0.10');
    const enter = () =>
      gate.enter(httpContext(new Request('http://localhost/weather', { headers: { payment: 'test proof=c limit=$1', 'idempotency-key': 'job-1' } })));

    const first = await enter();
    if (first.kind !== 'admitted') throw new Error('expected admission');
    await first.pass.payment.fulfill({ resultRef: 'jobs/42' });
    expect(await first.pass.complete('succeeded')).toMatchObject({ settlement: 'settled' });
    expect((await ledger.getCharge(first.pass.payment.chargeId ?? ''))?.resultRef).toBe('jobs/42');

    const retry = await enter();
    if (retry.kind !== 'denied') throw new Error('expected a denial');
    const response = toResponse(retry.denial);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'already_paid' }, result: 'jobs/42' });
    expect(rail.effects.settlements).toBe(1);
  });

  it('accepts the same proof again after the handler failed, and settles once', async () => {
    const { toll, rail, ledger } = await setup();
    const gate = toll.price('$0.01');

    const failed = await call(gate, 'test proof=p1', 'failed');
    expect(await ledger.getCharge(failed.chargeId ?? '')).toMatchObject({ payment: 'released', fulfillment: 'failed' });
    expect((await call(gate, 'test proof=p1')).status).toBe(200);
    expect((await call(gate, 'test proof=p1')).status).toBe(409);
    expect(rail.effects).toMatchObject({ settlements: 1, releases: 1 });
  });

  it('records unknown when settlement times out, then reconciles through lookup without settling again', async () => {
    const { toll, rail, ledger, clock, errors } = await setup();
    rail.simulate({ settle: 'timeout-after-effect' });
    const result = await call(toll.price('$0.01'), 'test proof=p1');

    expect(result.status).toBe(200);
    expect(errors[0]).toMatchObject({ code: 'PROVIDER_TIMEOUT' });
    const charge = await ledger.getCharge(result.chargeId ?? '');
    expect(charge).toMatchObject({ payment: 'unknown', pending: 'settle', fulfillment: 'completed' });
    expect(await ledger.getAuthorization(charge?.authorizationId ?? '')).toMatchObject({ reserved: money('USD', 10_000n) });

    rail.simulate({});
    clock.advance(60_000);
    expect(await toll.reconcile({ olderThanMs: 1_000 })).toMatchObject({ examined: 1, resolved: 1, pending: 0 });
    expect(await ledger.getCharge(result.chargeId ?? '')).toMatchObject({ payment: 'settled', pending: null });
    expect(await ledger.getAuthorization(charge?.authorizationId ?? '')).toMatchObject({ reserved: money('USD', 0n), consumed: money('USD', 10_000n) });
    expect(rail.effects.settlements).toBe(1);
  });

  it('retries settlement on reconciliation when the timeout happened before the effect', async () => {
    const { toll, rail, ledger, clock } = await setup();
    rail.simulate({ settle: 'timeout-before-effect' });
    const result = await call(toll.price('$0.01'), 'test proof=p1');

    rail.simulate({});
    clock.advance(60_000);
    await toll.reconcile({ olderThanMs: 1_000 });
    expect(await ledger.getCharge(result.chargeId ?? '')).toMatchObject({ payment: 'settled', fulfillment: 'completed' });
    expect(rail.effects.settlements).toBe(1);
  });

  it('releases a charge whose handler was running when the process died', async () => {
    const { toll, rail, ledger, clock } = await setup();
    const entry = await toll.price('$0.01').enter(httpContext(new Request('http://localhost/weather', { headers: { payment: 'test proof=p1' } })));
    if (entry.kind !== 'admitted') throw new Error('expected admission');

    clock.advance(60_000);
    await toll.reconcile({ olderThanMs: 1_000 });
    expect(await ledger.getCharge(entry.pass.payment.chargeId ?? '')).toMatchObject({ payment: 'released', fulfillment: 'failed' });
    expect(rail.effects.settlements).toBe(0);
  });

  it('records credit reservations against an unlimited authorization', async () => {
    const { toll, ledger } = await setup();
    const balance = memoryBalance({ acct_alice: '$0.05' });
    const gate = toll.price('$0.02', { access: [credits({ balance })] });

    const result = await call(gate, undefined, 'succeeded', { id: 'acct_alice' });
    expect(result.status).toBe(200);
    const charge = await ledger.getCharge(result.chargeId ?? '');
    expect(charge).toMatchObject({ payment: 'settled', fulfillment: 'completed', amount: money('USD', 20_000n) });
    expect(await ledger.getAuthorization(charge?.authorizationId ?? '')).toMatchObject({ kind: 'reusable', limit: null, consumed: money('USD', 20_000n) });
    expect(await balance.status(result.chargeId ?? '')).toBe('committed');
  });
});
