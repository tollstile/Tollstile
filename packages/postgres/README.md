# @tollstile/postgres

A Tollstile ledger in your PostgreSQL database. Authorizations, charges, their full transition history, and replay claims live in four tables you can read, query, and export.

- **Bring your own client.** You pass two functions, `query` and `transaction`. `pg`, `postgres.js`, Neon, and PGlite all work. Zero runtime dependencies.
- **Same behavior as `memoryLedger`.** Both run the same conformance suite, including the reservation accounting across `reserved → settling → settled → refunded` and `unknown`.
- **Concurrency-safe.** Every write to a charge locks its authorization row first, so concurrent requests against one authorization cannot over-reserve it: of several requests racing for a single-use authorization, one wins.

## Install

```bash
pnpm add tollstile @tollstile/postgres pg
```

## Quick start

```ts
import pg from 'pg';
import { createTollstile, testRail } from 'tollstile';
import { postgresLedger, postgresSchema } from '@tollstile/postgres';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await pool.query(postgresSchema); // once, or through your migration tool (see below)

const ledger = postgresLedger({
  query: (sql, params) => pool.query(sql, params),
  transaction: async (work) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work((sql, params) => client.query(sql, params));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
});

const toll = createTollstile({ rails: [testRail()], ledger });
```

## Applying the schema

`postgresSchema` is a string of plain DDL: four tables, their indexes, and a header comment describing the representation. Every statement uses `IF NOT EXISTS`, so applying it again is harmless.

- **At startup:** `await pool.query(postgresSchema)`. Fine for small deployments.
- **With a migration tool** (node-pg-migrate, Drizzle, Prisma, Flyway, sqitch, Supabase): print the DDL once and commit it as a migration file.

  ```bash
  node --input-type=module -e "import('@tollstile/postgres').then((m) => console.log(m.postgresSchema))" > migrations/001_tollstile.sql
  ```

- **Another table prefix:** every identifier starts with `tollstile_`, so `postgresSchema.replaceAll('tollstile_', 'billing_')` gives the DDL for `tablePrefix: 'billing_'`.

Later releases that change the schema will ship a separate, additive migration and say so in the changelog. The ledger never alters tables itself.

## Adapters

`query(sql, params)` runs one statement with `$1, $2, …` parameters and resolves with `{ rows }`, rows as objects keyed by column name. Parameters are always strings or `null`; the ledger casts them in SQL and reads every `bigint`, `jsonb`, and timestamp back as text, so driver type parsers and session time zones never matter.

`transaction(work)` runs `work` inside one **interactive** transaction on **one connection** and commits when it resolves, rolls back when it rejects. The ledger takes `SELECT … FOR UPDATE` locks inside it, so it needs the default `READ COMMITTED` isolation. Under `SERIALIZABLE`, concurrent requests fail with serialization errors instead of waiting.

### pg

Shown in the quick start.

### postgres.js

```ts
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL);
const ledger = postgresLedger({
  query: async (text, params) => ({ rows: await sql.unsafe(text, params) }),
  transaction: (work) => sql.begin((tx) => work(async (text, params) => ({ rows: await tx.unsafe(text, params) }))),
});
```

Behind PgBouncer in transaction mode, create the client with `prepare: false`.

### Neon

Neon's HTTP driver (`neon()`) only runs non-interactive transactions, which cannot hold a row lock while the ledger decides. Use the WebSocket `Pool`, which is `pg`-compatible:

```ts
import { Pool } from '@neondatabase/serverless';

const pool = new Pool({ connectionString: env.DATABASE_URL }); // on Workers: per request
// then exactly the pg adapter from the quick start
```

### PGlite

```ts
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite('./ledger');
await db.exec(postgresSchema);
const ledger = postgresLedger({
  query: (sql, params) => db.query(sql, params),
  transaction: (work) => db.transaction((tx) => work((sql, params) => tx.query(sql, params))),
});
```

## Options

| Option | Type | Default | |
|---|---|---|---|
| `query` | `(sql, params) => Promise<{ rows }>` | required | Runs one statement outside a transaction. |
| `transaction` | `(work) => Promise<T>` | required | Runs `work(query)` in one interactive transaction on one connection. |
| `tablePrefix` | `string` | `"tollstile_"` | Lowercase letters, digits, underscores. Must match the schema you applied. |
| `clock` | `{ now(): Date }` | system clock | Decides when claims have expired. Use the same clock as `createTollstile`. |

## How each operation stays correct

| Operation | Statements | Why it is safe |
|---|---|---|
| `openAuthorization` | `INSERT … ON CONFLICT (id) DO NOTHING`, then `SELECT` | The id is derived from rail + proof, so a replayed proof finds the stored row. The second statement sees a row a concurrent insert just committed. |
| `createCharge` | one transaction: lock the authorization (`FOR UPDATE`), check `exists` / `missing` / `expired` / `busy` / `insufficient`, insert the charge and its first history row, update `reserved` | The checks and the reservation happen under the authorization's row lock, so concurrent charges against it are serialized. A duplicate charge id returns `exists`. |
| `transitionCharge` | one transaction: lock the authorization, compare-and-set `WHERE id = $1 AND payment = $2 AND fulfillment = $3`, append history, update `reserved` / `consumed` with core's `applyAccounting` | The compare-and-set runs in SQL as well, so even a writer that skipped the lock cannot be overwritten. A mismatch returns `{ status: 'conflict', charge }`. |
| `replaceAuthorizationData` | one `UPDATE` of `data` and `updated_at` | Core calls it with the rail's `redact` output when a single-use charge becomes final, to drop evidence such as payer signatures. A missing id changes nothing. |
| `pendingCharges` | `SELECT` on a partial index | The index condition is generated from core's `isChargeTerminal`, so finished charges are never scanned. |
| `spendSince` | `SELECT … GROUP BY currency` on `(payer, created_at)` | Excludes `released`, `failed`, and `refunded`. |
| `claim` | `INSERT … ON CONFLICT DO UPDATE … WHERE expires_at <= now RETURNING` | One statement: a live claim is untouched, an expired one is taken over. Of several concurrent claims of one key, one wins. |

## Tables

| Table | Holds |
|---|---|
| `tollstile_authorizations` | What a payer authorized: rail, kind, `limit`, and the `reserved` / `consumed` totals of its charges. |
| `tollstile_charges` | Each economic effect: amount, `payment` × `fulfillment` state, pending operation, settlement and refund references. `version` counts its history rows. |
| `tollstile_charge_transitions` | Append-only history. Version 1 is the creation; every transition adds a row in the same transaction. |
| `tollstile_claims` | Single-use keys (nonces, replay windows) until `expires_at`. |

Money is integer micros (`1 USD = 1,000,000`) in `bigint` with a currency code, never floating point. Amounts outside `0 … 2^63 − 1` are refused with `INVALID_AMOUNT`, and an authorization holds one currency (its limit's, or what is already reserved or consumed on it): a charge or patched amount in another currency is refused with `CURRENCY_MISMATCH`, as in `memoryLedger`. Timestamps are `timestamptz`. JSON is `jsonb`.

Useful queries:

```sql
-- Revenue settled today, per currency
SELECT currency, sum(amount_micros)::numeric / 1000000 AS amount
FROM tollstile_charges WHERE payment = 'settled' AND updated_at >= current_date GROUP BY currency;

-- Everything that happened to one charge
SELECT * FROM tollstile_charge_transitions WHERE charge_id = $1 ORDER BY version;

-- Expired claims can be deleted at any time
DELETE FROM tollstile_claims WHERE expires_at < now() - interval '1 day';
```

## Verification status

Tested in this repository:

- The shared ledger conformance suite, run against both `memoryLedger` and `postgresLedger` on **PGlite 0.5.8** (PostgreSQL 17 compiled to WASM): every `createCharge` status, single-use busy versus a released retry, reusable capacity, compare-and-set conflicts on both axes, accounting through settled, refunded, released, and `unknown` with each pending operation, patches, currency and amount refusals, `replaceAuthorizationData`, history rows, `pendingCharges`, `spendSince`, claim expiry, and amounts beyond 2^53 up to 2^63 − 1.
- End-to-end flows through `createTollstile` with the test rail: quote round-trip, replay refusal, retry after a failed handler, signature redaction after settlement, settlement timeout → `unknown` → `reconcile()`, crash recovery, and credits on an unlimited authorization.
- Rollback when a statement fails mid-transaction.

Not verified:

- **Real lock contention.** PGlite has one connection and serializes transactions, so the concurrency tests confirm the outcome (one wins, totals stay within the limit) but not `FOR UPDATE` waiting between connections. To verify against a real server, run the conformance suite with a `pg.Pool` adapter of 10+ connections and fire 50 concurrent `createCharge` calls at one authorization; only one may return `created` for a single-use authorization, and `reserved_micros` must never exceed `limit_micros`.
- **The `postgres.js` and Neon adapters** above were written from their documentation and not executed here. Run the conformance file (`test/ledger-conformance.ts`) against them before production use.
- PostgreSQL versions other than 17. The schema uses only features available since PostgreSQL 9.5 (`ON CONFLICT`, partial indexes, `jsonb`).
