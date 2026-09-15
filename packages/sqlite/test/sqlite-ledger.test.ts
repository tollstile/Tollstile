import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
import { describe, expect, it } from 'vitest';
import { sqliteLedger, sqliteSchema, type SqliteLedgerOptions, type SqliteRow, type SqliteValue } from '../src/index';
import { describeLedgerConformance } from './ledger-conformance';

type Driver = Pick<SqliteLedgerOptions, 'execute' | 'transaction'>;

/** node:sqlite, synchronous, as the README shows it. `bigints` makes INTEGER columns come back as bigint. */
function nodeSqlite(db: DatabaseSync, bigints = false): Driver {
  const all = (sql: string, params: readonly SqliteValue[]) => {
    const statement = db.prepare(sql);
    statement.setReadBigInts(bigints);
    return statement.all(...params);
  };
  return {
    execute: all,
    transaction: (statements) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map((statement) => all(statement.sql, statement.params));
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

/**
 * Behaves like D1: every call resolves on a later turn, so other ledger calls interleave between
 * statements and batches, and a batch is the only way to group statements atomically.
 */
function batchOnly(driver: Driver): Driver {
  const later = <T>(run: () => T | Promise<T>) => new Promise<void>((resolve) => setTimeout(resolve, 0)).then(run);
  return {
    execute: (sql, params) => later(() => driver.execute(sql, params)),
    transaction: (statements) => later(() => driver.transaction(statements)),
  };
}

function database(prefix = 'tollstile_') {
  const db = new DatabaseSync(':memory:');
  db.exec(sqliteSchema.replaceAll('tollstile_', prefix));
  return db;
}

function ledgerFor(clock: Clock, driver = nodeSqlite(database())) {
  return sqliteLedger({ ...driver, clock });
}

describeLedgerConformance('memory', (clock) => Promise.resolve(memoryLedger({ clock })));
describeLedgerConformance('sqlite', (clock) => Promise.resolve(ledgerFor(clock)));
describeLedgerConformance('sqlite (batch-only driver returning bigint)', (clock) =>
  Promise.resolve(ledgerFor(clock, batchOnly(nodeSqlite(database(), true)))),
);

describe('sqliteLedger', () => {
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
  const history = (db: DatabaseSync, chargeId: string) =>
    db
      .prepare('SELECT version, payment, fulfillment, pending, CAST(amount_micros AS TEXT) AS amount FROM tollstile_charge_transitions WHERE charge_id = ? ORDER BY version')
      .all(chargeId);

  it('appends a history row for the creation and for every transition, and none for a conflict or a duplicate', async () => {
    const clock = fakeClock();
    const db = database();
    const ledger = ledgerFor(clock, nodeSqlite(db));
    await ledger.openAuthorization(authorization(clock.now()));
    await ledger.createCharge(newCharge(clock.now()));
    await ledger.createCharge(newCharge(clock.now()));
    await ledger.transitionCharge('chg_1', { payment: 'reserved', fulfillment: 'running' }, { payment: 'settling', fulfillment: 'completed' }, clock.now(), {
      pending: 'settle',
      amount: money('USD', 7_000n),
    });
    await ledger.transitionCharge('chg_1', { payment: 'reserved', fulfillment: 'running' }, { payment: 'released', fulfillment: 'failed' }, clock.now());
    await ledger.transitionCharge('chg_1', { payment: 'settling', fulfillment: 'completed' }, { payment: 'settled', fulfillment: 'completed' }, clock.now(), {
      pending: null,
    });

    expect(history(db, 'chg_1')).toEqual([
      { version: 1, payment: 'reserved', fulfillment: 'running', pending: null, amount: '10000' },
      { version: 2, payment: 'settling', fulfillment: 'completed', pending: 'settle', amount: '7000' },
      { version: 3, payment: 'settled', fulfillment: 'completed', pending: null, amount: '7000' },
    ]);
    expect(await ledger.getAuthorization('auth_1')).toMatchObject({ reserved: money('USD', 0n), consumed: money('USD', 7_000n) });
  });

  it('fails instead of storing a total that overflows into REAL', async () => {
    const clock = fakeClock();
    const ledger = ledgerFor(clock);
    const max = 9_223_372_036_854_775_807n;
    await ledger.openAuthorization({ ...authorization(clock.now()), limit: null });
    await ledger.createCharge({ ...newCharge(clock.now(), 'chg_1'), amount: money('USD', max) });

    await expect(ledger.createCharge({ ...newCharge(clock.now(), 'chg_2'), amount: money('USD', 1n) })).rejects.toThrow('cannot store REAL value in INTEGER column');
    expect(await ledger.getCharge('chg_2')).toBeUndefined();
    expect((await ledger.getAuthorization('auth_1'))?.reserved).toEqual(money('USD', max));
  });

  it('rolls back every statement of a transaction when one fails', async () => {
    const clock = fakeClock();
    const db = database();
    const driver = nodeSqlite(db);
    const ledger = ledgerFor(clock, driver);
    await ledger.openAuthorization(authorization(clock.now()));
    const failing = sqliteLedger({
      ...driver,
      // Fails after the charge, the reservation, and the history row were written.
      transaction: (statements) => driver.transaction([...statements, { sql: 'SELECT no_such_column FROM tollstile_charges', params: [] }]),
      clock,
    });

    await expect(failing.createCharge(newCharge(clock.now()))).rejects.toThrow('no such column');
    expect(await ledger.getCharge('chg_1')).toBeUndefined();
    expect(await ledger.getAuthorization('auth_1')).toMatchObject({ reserved: money('USD', 0n) });
    expect(history(db, 'chg_1')).toEqual([]);
  });

  it('refuses a transaction() that does not return one result per statement', async () => {
    const clock = fakeClock();
    const ledger = sqliteLedger({ ...nodeSqlite(database()), transaction: () => [], clock });
    await expect(ledger.openAuthorization(authorization(clock.now()))).rejects.toMatchObject({ code: 'LEDGER_INCONSISTENT' });
  });

  it('refuses integers a driver returned as numbers beyond 2^53', async () => {
    const clock = fakeClock();
    const driver = nodeSqlite(database());
    await ledgerFor(clock, driver).openAuthorization(authorization(clock.now()));
    const rounded = sqliteLedger({
      ...driver,
      execute: async (sql, params) => (await driver.execute(sql, params)).map((row: SqliteRow) => ({ ...row, created_at: 2 ** 53 })),
      clock,
    });

    await expect(rounded.getAuthorization('auth_1')).rejects.toMatchObject({ code: 'LEDGER_INCONSISTENT' });
  });

  it('uses the partial index for pendingCharges and the payer index for spendSince', async () => {
    const db = database();
    const driver = nodeSqlite(db);
    const statements: { sql: string; params: readonly SqliteValue[] }[] = [];
    const ledger = sqliteLedger({
      ...driver,
      execute: (sql, params) => {
        statements.push({ sql, params });
        return driver.execute(sql, params);
      },
    });
    await ledger.pendingCharges(new Date());
    await ledger.spendSince('payer_1', new Date(0));

    const plan = (index: number) => {
      const statement = statements[index];
      if (statement === undefined) throw new Error('statement not captured');
      return JSON.stringify(db.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`).all(...statement.params));
    };
    expect(plan(0)).toContain('tollstile_charges_pending_idx');
    expect(plan(1)).toContain('tollstile_charges_payer_created_idx');
  });

  it('refuses an invalid table prefix', () => {
    expect(() => sqliteLedger({ execute: () => [], transaction: () => [], tablePrefix: 'x; DROP TABLE y' })).toThrow(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    );
  });

  it('works with a custom table prefix, and applies the schema twice without error', async () => {
    const clock = fakeClock();
    const db = database('billing_');
    db.exec(sqliteSchema.replaceAll('tollstile_', 'billing_'));
    const ledger = sqliteLedger({ ...nodeSqlite(db), tablePrefix: 'billing_', clock });

    await ledger.openAuthorization(authorization(clock.now()));
    expect((await ledger.createCharge(newCharge(clock.now()))).status).toBe('created');
    expect(db.prepare('SELECT count(*) AS n FROM billing_charge_transitions').all()).toEqual([{ n: 1 }]);
  });

  it('shares one database file between two connections', async () => {
    const clock = fakeClock();
    const directory = mkdtempSync(join(tmpdir(), 'tollstile-sqlite-'));
    const path = join(directory, 'ledger.db');
    const first = new DatabaseSync(path);
    first.exec('PRAGMA journal_mode = WAL;');
    first.exec(sqliteSchema);
    const second = new DatabaseSync(path);
    second.exec('PRAGMA busy_timeout = 1000;');
    const a = ledgerFor(clock, batchOnly(nodeSqlite(first)));
    const b = ledgerFor(clock, batchOnly(nodeSqlite(second)));

    await a.openAuthorization({ ...authorization(clock.now()), kind: 'single' });
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) => (index % 2 === 0 ? a : b).createCharge(newCharge(clock.now(), `chg_${String(index)}`))),
    );
    expect(results.filter((result) => result.status === 'created')).toHaveLength(1);
    expect(await b.getAuthorization('auth_1')).toMatchObject({ reserved: money('USD', 10_000n) });
    first.close();
    second.close();
    rmSync(directory, { recursive: true });
  });
});

describe('with createTollstile', () => {
  function setup(railOptions: TestRailOptions = {}) {
    const clock = fakeClock();
    const ledger = ledgerFor(clock);
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
    const { toll, rail, ledger } = setup();
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
    const { toll, ledger } = setup();
    const result = await call(toll.price('$0.01'), 'test proof=p1 signature=0xsig');

    expect(result.completion).toMatchObject({ settlement: 'settled', denial: null });
    const charge = await ledger.getCharge(result.chargeId ?? '');
    expect(charge).toMatchObject({ payment: 'settled', fulfillment: 'completed' });
    expect((await ledger.getAuthorization(charge?.authorizationId ?? ''))?.data).toEqual({ proofId: 'p1', payer: 'test-payer' });
  });

  it('keeps the signature while settlement is unknown, and drops it once reconciliation settles', async () => {
    const { toll, rail, ledger, clock } = setup();
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
    const { toll, rail, ledger } = setup({ authorization: 'reusable' });
    const gate = toll.price('$0.10');

    const first = await call(gate, 'test proof=c limit=$1', 'succeeded', undefined, 'order-1');
    const retry = await call(gate, 'test proof=c limit=$1', 'succeeded', undefined, 'order-1');

    expect(first.status).toBe(200);
    expect(retry).toMatchObject({ status: 409, body: { error: { code: 'already_paid' }, chargeId: first.chargeId } });
    expect(rail.effects.settled).toEqual([100_000n]);
    expect((await ledger.getCharge(first.chargeId ?? ''))?.requestHash).toEqual(expect.any(String));
  });

  it('returns the result reference the handler stored to a keyed retry that is already paid', async () => {
    const { toll, rail, ledger } = setup({ authorization: 'reusable' });
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
    const { toll, rail, ledger } = setup();
    const gate = toll.price('$0.01');

    const failed = await call(gate, 'test proof=p1', 'failed');
    expect(await ledger.getCharge(failed.chargeId ?? '')).toMatchObject({ payment: 'released', fulfillment: 'failed' });
    expect((await call(gate, 'test proof=p1')).status).toBe(200);
    expect((await call(gate, 'test proof=p1')).status).toBe(409);
    expect(rail.effects).toMatchObject({ settlements: 1, releases: 1 });
  });

  it('records unknown when settlement times out, then reconciles through lookup without settling again', async () => {
    const { toll, rail, ledger, clock, errors } = setup();
    rail.simulate({ settle: 'timeout-after-effect' });
    const result = await call(toll.price('$0.01'), 'test proof=p1');

    expect(result.status).toBe(200);
    expect(errors[0]).toMatchObject({ code: 'PROVIDER_TIMEOUT' });
    const charge = await ledger.getCharge(result.chargeId ?? '');
    expect(charge).toMatchObject({ payment: 'unknown', pending: 'settle', fulfillment: 'completed' });
    expect(await ledger.getAuthorization(charge?.authorizationId ?? '')).toMatchObject({ reserved: money('USD', 10_000n) });

    rail.simulate({});
    clock.advance(60_000);
    expect(await toll.reconcile({ olderThanMs: 1_000 })).toEqual({ examined: 1, resolved: 1, pending: 0 });
    expect(await ledger.getCharge(result.chargeId ?? '')).toMatchObject({ payment: 'settled', pending: null });
    expect(await ledger.getAuthorization(charge?.authorizationId ?? '')).toMatchObject({ reserved: money('USD', 0n), consumed: money('USD', 10_000n) });
    expect(rail.effects.settlements).toBe(1);
  });

  it('retries settlement on reconciliation when the timeout happened before the effect', async () => {
    const { toll, rail, ledger, clock } = setup();
    rail.simulate({ settle: 'timeout-before-effect' });
    const result = await call(toll.price('$0.01'), 'test proof=p1');

    rail.simulate({});
    clock.advance(60_000);
    await toll.reconcile({ olderThanMs: 1_000 });
    expect(await ledger.getCharge(result.chargeId ?? '')).toMatchObject({ payment: 'settled', fulfillment: 'completed' });
    expect(rail.effects.settlements).toBe(1);
  });

  it('releases a charge whose handler was running when the process died', async () => {
    const { toll, rail, ledger, clock } = setup();
    const entry = await toll.price('$0.01').enter(httpContext(new Request('http://localhost/weather', { headers: { payment: 'test proof=p1' } })));
    if (entry.kind !== 'admitted') throw new Error('expected admission');

    clock.advance(60_000);
    await toll.reconcile({ olderThanMs: 1_000 });
    expect(await ledger.getCharge(entry.pass.payment.chargeId ?? '')).toMatchObject({ payment: 'released', fulfillment: 'failed' });
    expect(rail.effects.settlements).toBe(0);
  });

  it('records credit reservations against an unlimited authorization', async () => {
    const { toll, ledger } = setup();
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
