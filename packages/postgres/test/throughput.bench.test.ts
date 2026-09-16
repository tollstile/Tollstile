import pg from 'pg';
import { createTollstile, testRail, type Rail } from 'tollstile';
import { httpContext } from 'tollstile/testing';
import { afterAll, describe, expect, it } from 'vitest';
import { postgresLedger, postgresSchema, type PostgresRow } from '../src/index';

/**
 * What one payer's charges cost when they contend, measured rather than guessed: a reusable
 * authorization is one row, and every charge against it takes it in turn. Runs with the same
 * TOLLSTILE_TEST_DATABASE_URL as the concurrency suite; it asserts correctness, and prints timings
 * for whoever ran it. Numbers depend on the machine and the pool size, so compare runs, not systems.
 */
const url = process.env.TOLLSTILE_TEST_DATABASE_URL;
const admin = url === undefined ? undefined : new pg.Pool({ connectionString: url, max: 4 });
const pools: pg.Pool[] = [];

afterAll(async () => {
  await Promise.all(pools.map((pool) => pool.end()));
  await admin?.end();
});

async function instances(count: number, prefix: string, authorization: 'single' | 'reusable' = 'reusable') {
  if (admin === undefined || url === undefined) throw new Error('no database');
  await admin.query(postgresSchema.replaceAll('tollstile_', prefix));
  const rail: Rail = testRail({ authorization });
  return Array.from({ length: count }, () => {
    const pool = new pg.Pool({ connectionString: url, max: 10 });
    pools.push(pool);
    const ledger = postgresLedger({
      query: (sql, params) => pool.query<PostgresRow>(sql, params as unknown[]),
      transaction: async (work) => {
        const client = await pool.connect();
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
    return createTollstile({ rails: [rail], ledger, secret: 'bench-secret-0123456789abcdefghij-32' });
  });
}

type Toll = Awaited<ReturnType<typeof instances>>[number];

async function one(toll: Toll, proof: string): Promise<{ ms: number; outcome: string }> {
  const started = performance.now();
  const entry = await toll
    .price('$0.05', { resource: 'GET /report' })
    .enter(httpContext(new Request('https://api.example.com/report', { headers: { payment: `test proof=${proof} limit=$1000` } })));
  const outcome = entry.kind === 'denied' ? entry.denial.error.code : (await entry.pass.complete('succeeded')).settlement;
  return { ms: performance.now() - started, outcome };
}

function report(label: string, started: number, results: { ms: number; outcome: string }[]) {
  const wall = performance.now() - started;
  const sorted = results.map((r) => r.ms).sort((a, b) => a - b);
  const at = (q: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0);
  const settled = results.filter((r) => r.outcome === 'settled').length;
  console.log(
    `${label}: ${String(results.length)} calls in ${wall.toFixed(0)}ms · ${(results.length / (wall / 1000)).toFixed(0)}/s · ` +
      `p50 ${String(at(0.5))}ms p95 ${String(at(0.95))}ms max ${String(at(1))}ms · settled ${String(settled)}`,
  );
}

describe.skipIf(url === undefined)('throughput against one hot row', () => {
  it('100 concurrent calls on a single payer, then spread across 20', async () => {
    const [toll] = await instances(1, `bench_hot_${String(Date.now())}_`);
    if (toll === undefined) throw new Error('no instance');

    const hotStart = performance.now();
    const hot = await Promise.all(Array.from({ length: 100 }, () => one(toll, 'one-credential')));
    report('one payer, one authorization', hotStart, hot);

    const [spread] = await instances(1, `bench_spread_${String(Date.now())}_`);
    if (spread === undefined) throw new Error('no instance');
    const spreadStart = performance.now();
    const many = await Promise.all(Array.from({ length: 100 }, (_, i) => one(spread, `payer-${String(i % 20)}`)));
    report('20 payers, 20 authorizations', spreadStart, many);

    const [single] = await instances(1, `bench_single_${String(Date.now())}_`, 'single');
    if (single === undefined) throw new Error('no instance');
    const singleStart = performance.now();
    const separate = await Promise.all(Array.from({ length: 100 }, (_, i) => one(single, `proof-${String(i)}`)));
    report('one payer, 100 single-use authorizations', singleStart, separate);

    expect(hot.filter((r) => r.outcome === 'settled')).toHaveLength(100);
    expect(many.filter((r) => r.outcome === 'settled')).toHaveLength(100);
  }, 120_000);
});
