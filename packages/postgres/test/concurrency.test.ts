import pg from 'pg';
import { createTollstile, testRail, type Rail, type TestRail, type TestRailOptions } from 'tollstile';
import { httpContext } from 'tollstile/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { postgresLedger, postgresSchema, type PostgresRow } from '../src/index';

/**
 * Concurrency against a real Postgres server, with real connections and row locks: what PGlite,
 * which serializes transactions, cannot show. Runs when TOLLSTILE_TEST_DATABASE_URL is set (CI
 * provides a Postgres service; locally: `createdb tollstile_test` and
 * `TOLLSTILE_TEST_DATABASE_URL=postgres:///tollstile_test`).
 */
const url = process.env.TOLLSTILE_TEST_DATABASE_URL;
const CONCURRENCY = 100;

let admin: pg.Pool | undefined;
let tables = 0;
const pools: pg.Pool[] = [];

beforeAll(() => {
  if (url !== undefined) admin = new pg.Pool({ connectionString: url, max: 2 });
});

// Each scenario's pools close when it ends, so scenarios never exhaust the server's connections.
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
});

afterAll(async () => {
  await admin?.end();
});

/** Tables for one scenario, shared by several "processes": each gets its own pool and Tollstile instance. */
async function database() {
  if (admin === undefined || url === undefined) throw new Error('TOLLSTILE_TEST_DATABASE_URL is not set');
  tables += 1;
  const prefix = `c${String(Date.now())}_${String(tables)}_`;
  await admin.query(postgresSchema.replaceAll('tollstile_', prefix));

  const instance = (rail: Rail) => {
    const pool = new pg.Pool({ connectionString: url, max: 10 });
    pools.push(pool);
    const ledger = postgresLedger({
      query: (sql, params) => pool.query<PostgresRow>(sql, params as unknown[]),
      transaction: async (work) => {
        const client = await pool.connect();
        // catch-reason: the documented pg adapter shape; a failed transaction must roll back before release.
        try {
          await client.query('BEGIN');
          const result = await work((sql, params) => client.query<PostgresRow>(sql, params as unknown[]));
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      },
      tablePrefix: prefix,
    });
    return createTollstile({ rails: [rail], ledger, secret: 'concurrency-test-secret-0123456789ab' });
  };

  const rows = async (sql: string) => (await admin?.query<PostgresRow>(sql.replaceAll('$prefix', prefix)))?.rows ?? [];
  return { instance, rows };
}

/** Four Tollstile instances on four pools, like four processes behind a load balancer, sharing one rail provider. */
async function processes(options: TestRailOptions = {}) {
  const db = await database();
  const rail: TestRail = testRail(options);
  const tolls = [0, 1, 2, 3].map(() => db.instance(rail));
  /** The instance a request lands on, round robin. */
  const on = (i: number) => {
    const toll = tolls[i % tolls.length];
    if (toll === undefined) throw new Error('no instance');
    return toll;
  };
  return { ...db, rail, on };
}

async function send(toll: ReturnType<Awaited<ReturnType<typeof database>>['instance']>, price: string, headers: Record<string, string>) {
  const entry = await toll.price(price, { resource: 'GET /report' }).enter(httpContext(new Request('https://api.example.com/report', { headers })));
  if (entry.kind === 'denied') return entry.denial.error.code;
  const completion = await entry.pass.complete('succeeded');
  return completion.settlement;
}

describe.skipIf(url === undefined)('postgres ledger under real concurrency', () => {
  it(`admits one of ${String(CONCURRENCY)} concurrent requests carrying the same single-use proof`, async () => {
    const { on, rail, rows } = await processes();
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) => send(on(i), '$0.05', { payment: 'test proof=same-signature' })),
    );

    expect(results.filter((result) => result === 'settled')).toHaveLength(1);
    expect(results.filter((result) => result === 'proof_already_used')).toHaveLength(CONCURRENCY - 1);
    expect(rail.effects.settlements).toBe(1);
    expect(await rows(`SELECT count(*)::text AS n FROM $prefixcharges WHERE payment <> 'released'`)).toEqual([{ n: '1' }]);
  });

  it(`charges once for ${String(CONCURRENCY)} concurrent retries with the same idempotency key`, async () => {
    const { on, rail, rows } = await processes({ authorization: 'reusable' });
    const headers = { payment: 'test proof=credential limit=$100', 'idempotency-key': 'order-42' };
    const results = await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => send(on(i), '$0.05', headers)));

    expect(results.filter((result) => result === 'settled')).toHaveLength(1);
    expect(new Set(results.filter((result) => result !== 'settled'))).toEqual(
      new Set(results.filter((result) => result !== 'settled').filter((result) => result === 'request_in_progress' || result === 'already_paid')),
    );
    expect(rail.effects.settlements).toBe(1);
    expect(await rows(`SELECT count(*)::text AS n FROM $prefixcharges`)).toEqual([{ n: '1' }]);
  });

  it(`never spends past a reusable authorization's limit with ${String(CONCURRENCY)} concurrent charges`, async () => {
    const { on, rail, rows } = await processes({ authorization: 'reusable' });
    const headers = { payment: 'test proof=funded-token limit=$1' };
    const results = await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => send(on(i), '$0.05', headers)));

    expect(results.filter((result) => result === 'settled')).toHaveLength(20);
    expect(results.filter((result) => result === 'insufficient_authorization')).toHaveLength(CONCURRENCY - 20);
    expect(rail.effects.settled.reduce((sum, micros) => sum + micros, 0n)).toBe(1_000_000n);
    expect(await rows(`SELECT consumed_micros::text AS consumed, reserved_micros::text AS reserved FROM $prefixauthorizations`)).toEqual([
      { consumed: '1000000', reserved: '0' },
    ]);
  });

  it('settles every lost settlement exactly once when two reconcile workers run at the same time', async () => {
    const { on, rail, rows } = await processes();
    rail.simulate({ settle: 'timeout-after-effect' });
    const lost = await Promise.all(Array.from({ length: 40 }, (_, i) => send(on(i), '$0.05', { payment: `test proof=p${String(i)}` })));
    expect(new Set(lost)).toEqual(new Set(['unknown']));
    rail.simulate({});

    const reports = await Promise.all([on(0).reconcile({ olderThanMs: 0 }), on(1).reconcile({ olderThanMs: 0 })]);

    expect(reports.every((report) => report.examined > 0)).toBe(true);
    expect(rail.effects.settlements).toBe(40);
    expect(await rows(`SELECT payment, fulfillment, count(*)::text AS n FROM $prefixcharges GROUP BY payment, fulfillment`)).toEqual([
      { payment: 'settled', fulfillment: 'completed', n: '40' },
    ]);
  });

  it('recovers charges left mid-settlement by a crashed process, from another process', async () => {
    const { on, rail, rows } = await processes();
    // The first process admits and fulfills, then dies before it can settle.
    for (let i = 0; i < 25; i += 1) {
      const entry = await on(0).price('$0.05', { resource: 'GET /report' }).enter(
        httpContext(new Request('https://api.example.com/report', { headers: { payment: `test proof=crash-${String(i)}` } })),
      );
      if (entry.kind !== 'admitted') throw new Error('expected admission');
      await entry.pass.payment.fulfill();
    }

    await on(2).reconcile({ olderThanMs: 0 });

    expect(rail.effects.settlements).toBe(25);
    expect(await rows(`SELECT payment, count(*)::text AS n FROM $prefixcharges GROUP BY payment`)).toEqual([{ payment: 'settled', n: '25' }]);
  });
});
