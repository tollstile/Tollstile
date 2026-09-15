# @tollstile/sqlite

A Tollstile ledger in SQLite: a local file through `node:sqlite`, `better-sqlite3`, or `bun:sqlite`, or Cloudflare D1. Authorizations, charges, their full transition history, and replay claims live in four tables you can read, query, and export.

- **Bring your own driver.** You pass two functions, `execute` and `transaction`. Zero runtime dependencies.
- **Same behavior as `memoryLedger`.** Both run the same conformance suite, including the reservation accounting across `reserved → settling → settled → refunded` and `unknown`.
- **Batch transactions only.** The ledger never needs to read between the statements of a transaction, so D1, whose transactions are batches, is supported by design rather than by a weaker fallback.

## Install

```bash
npm install tollstile @tollstile/sqlite
```

## Quick start (node:sqlite)

```ts
import { DatabaseSync } from 'node:sqlite';
import { createTollstile, testRail } from 'tollstile';
import { sqliteLedger, sqliteSchema } from '@tollstile/sqlite';

const db = new DatabaseSync('ledger.db');
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
db.exec(sqliteSchema); // once, or through your migration tool (see below)

const all = (sql: string, params: readonly (string | number | null)[]) => db.prepare(sql).all(...params);
const ledger = sqliteLedger({
  execute: all,
  transaction: (statements) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(({ sql, params }) => all(sql, params));
      db.exec('COMMIT');
      return results;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  },
});

const toll = createTollstile({ rails: [testRail()], ledger });
```

## Applying the schema

`sqliteSchema` is a string of plain DDL: four `STRICT` tables, their indexes, and a header comment describing the representation. It needs SQLite 3.38 or later. Every statement uses `IF NOT EXISTS`, so applying it again is harmless.

- **At startup:** `db.exec(sqliteSchema)`.
- **With a migration tool**, including D1: print the DDL once and commit it as a migration.

  ```bash
  npx wrangler d1 migrations create DB tollstile
  node --input-type=module -e "import('@tollstile/sqlite').then((m) => console.log(m.sqliteSchema))" > migrations/0001_tollstile.sql
  npx wrangler d1 migrations apply DB
  ```

- **Another table prefix:** every identifier starts with `tollstile_`, so `sqliteSchema.replaceAll('tollstile_', 'billing_')` gives the DDL for `tablePrefix: 'billing_'`.

Later releases that change the schema will ship a separate, additive migration and say so in the changelog. The ledger never alters tables itself.

> **Pre-release schema changes.** Until the first release, `sqliteSchema` is edited in place and no migration is shipped. The `request_hash` column on `tollstile_charges` (the hash of the request an idempotency key was first used with) was added this way. A database created from an earlier build needs `ALTER TABLE tollstile_charges ADD COLUMN request_hash TEXT;`, because `CREATE TABLE IF NOT EXISTS` leaves an existing table unchanged.

## The driver contract

`execute(sql, params)` runs one statement with anonymous `?` parameters and returns its rows as objects keyed by column name, synchronously or as a promise.

`transaction(statements)` runs the statements in order inside **one write transaction** and returns each statement's rows, in order. All of them take effect or none do.

Parameters are only strings, numbers, and `null`. Money is bound as decimal text and cast to `INTEGER` in SQL, and read back as `TEXT`, so it never passes through a JavaScript number. Timestamps and counts may come back as `number` or `bigint`; both are accepted, and a number beyond `Number.MAX_SAFE_INTEGER`, which a driver may already have rounded, is refused.

### Why batches

A transaction in which the application reads, decides, and writes needs a connection held across `await`s. Synchronous drivers share one connection across all concurrent requests, so another request's statements would land inside the open transaction, and D1 cannot hold one open at all. The ledger avoids both problems by expressing every decision in SQL:

- **`createCharge`** is one batch. Its first statement computes the status (`exists`, `missing`, `expired`, an unstorable amount, a currency other than the authorization's, `busy`, `insufficient`, or `created`) in a single `CASE`; the insert is conditioned on that same expression. The reservation and the creation history row are conditioned on "this charge has no history row yet", which within the batch means the insert just created it.
- **`transitionCharge`** is one batch. Every statement carries the same compare-and-set condition (`id`, `payment`, `fulfillment`), and only the last one changes the charge, so the authorization's `reserved` / `consumed` update, the history row, and the charge update all see the same charge or none of them match. The accounting classes are generated from core's `accountingClass`.
- **`replaceAuthorizationData`** is one `UPDATE`. Core calls it with the rail's `redact` output when a single-use charge becomes final, to drop evidence such as payer signatures.
- **`openAuthorization`** is `INSERT … ON CONFLICT DO NOTHING RETURNING` plus a `SELECT` in one batch. **`claim`** is one `INSERT … ON CONFLICT DO UPDATE … WHERE expired RETURNING` statement; of several concurrent claims of one key, one wins.

Because SQLite runs one write transaction at a time, concurrent `createCharge` calls on one authorization cannot over-reserve it: for a single-use authorization, one wins and the rest are `busy`.

### better-sqlite3

```ts
import Database from 'better-sqlite3';

const db = new Database('ledger.db');
db.pragma('journal_mode = WAL');
db.exec(sqliteSchema);

// better-sqlite3 refuses .all() on statements that return no rows.
const all = (sql: string, params: readonly (string | number | null)[]) => {
  const statement = db.prepare(sql);
  return statement.reader ? statement.all(...params) : (statement.run(...params), []);
};
const ledger = sqliteLedger({
  execute: all,
  transaction: (statements) => db.transaction(() => statements.map(({ sql, params }) => all(sql, params))).immediate(),
});
```

### bun:sqlite

```ts
import { Database } from 'bun:sqlite';

const db = new Database('ledger.db');
db.exec('PRAGMA journal_mode = WAL;');
db.exec(sqliteSchema);

const all = (sql: string, params: readonly (string | number | null)[]) => db.query(sql).all(...params);
const ledger = sqliteLedger({
  execute: all,
  transaction: (statements) => db.transaction(() => statements.map(({ sql, params }) => all(sql, params))).immediate(),
});
```

### Cloudflare D1

D1 has no interactive transactions: `db.batch()` runs a list of statements atomically, and that is exactly what `transaction` asks for.

```ts
const ledger = sqliteLedger({
  execute: async (sql, params) => (await env.DB.prepare(sql).bind(...params).all()).results,
  transaction: async (statements) =>
    (await env.DB.batch(statements.map(({ sql, params }) => env.DB.prepare(sql).bind(...params)))).map((result) => result.results),
});
```

D1 returns every `INTEGER` as a JavaScript number, which is why money is read as `TEXT`.

## Options

| Option | Type | Default | |
|---|---|---|---|
| `execute` | `(sql, params) => rows \| Promise<rows>` | required | Runs one statement. |
| `transaction` | `(statements) => rows[] \| Promise<rows[]>` | required | Runs the statements atomically in one write transaction, returning each statement's rows in order. |
| `tablePrefix` | `string` | `"tollstile_"` | Lowercase letters, digits, underscores. Must match the schema you applied. |
| `clock` | `{ now(): Date }` | system clock | Decides when claims have expired. Use the same clock as `createTollstile`. |

## Tables

| Table | Holds |
|---|---|
| `tollstile_authorizations` | What a payer authorized: rail, kind, `limit`, and the `reserved` / `consumed` totals of its charges. |
| `tollstile_charges` | Each economic effect: amount, `payment` × `fulfillment` state, pending operation, settlement and refund references. `version` counts its history rows. |
| `tollstile_charge_transitions` | Append-only history. Version 1 is the creation; every transition adds a row in the same transaction. |
| `tollstile_claims` | Single-use keys (nonces, replay windows) until `expires_at`. |

- **Money** is integer micros (`1 USD = 1,000,000`) in a 64-bit `INTEGER` with a currency code. Amounts outside `0 … 2^63 − 1` are refused with `INVALID_AMOUNT`, and a charge or patched amount in another currency than the authorization holds is refused with `CURRENCY_MISMATCH`, as in `memoryLedger`. SQLite silently turns integer overflow into `REAL`; `STRICT` tables refuse to store it, so an overflowing total fails the transaction instead.
- **Timestamps** are `INTEGER` milliseconds since the Unix epoch, UTC: `strftime('%Y-%m-%dT%H:%M:%fZ', created_at / 1000.0, 'unixepoch')` makes them readable.
- **JSON** is `TEXT`, checked with `json_valid`.
- `pendingCharges` uses a partial index whose condition is generated from core's `isChargeTerminal`; `spendSince` uses `(payer, created_at)`.

Expired claims can be deleted at any time:

```sql
DELETE FROM tollstile_claims WHERE expires_at < (unixepoch() - 86400) * 1000;
```

## Verification status

Tested in this repository, with `node:sqlite` (SQLite 3.50.4) on Node 22:

- The shared ledger conformance suite, run against `memoryLedger` and twice against `sqliteLedger`: once with the synchronous adapter above, and once through an adapter that behaves like D1 (every call resolves on a later turn, so calls interleave between batches) with `INTEGER` columns returned as `bigint`. It covers every `createCharge` status, single-use busy versus a released retry, reusable capacity, concurrent charges on one authorization (one wins), compare-and-set conflicts on both axes, accounting through settled, refunded, released, and `unknown` with each pending operation, patches, request hashes, an existing charge id under another authorization, currency and amount refusals, `replaceAuthorizationData`, history rows, `pendingCharges`, `spendSince`, claim expiry, and amounts beyond 2^53 up to 2^63 − 1.
- End-to-end flows through `createTollstile` with the test rail: quote round-trip, replay refusal, retry after a failed handler, an idempotency-key retry answered as `already_paid`, signature redaction after settlement, settlement timeout → `unknown` → `reconcile()`, crash recovery, and credits on an unlimited authorization.
- Rollback of a whole batch when one statement fails; two connections sharing one WAL file; the query plans use the partial and payer indexes; overflow and rounded-integer refusal.

Not verified:

- **D1, better-sqlite3, and bun:sqlite.** Their adapters above were written from their documentation and not executed here. D1's batch atomicity, `STRICT` tables, `json_valid`, `UPDATE … FROM`, and `RETURNING` support are taken from its documentation. To verify, run `test/ledger-conformance.ts` against each adapter (for D1, inside `@cloudflare/vitest-pool-workers` or `wrangler dev` with a local database).
- **Multi-process contention.** Two connections in one process were tested; separate processes writing one file rely on SQLite's file locking and `busy_timeout`, as any SQLite application does.
