import { DatabaseSync } from 'node:sqlite';
import { sqliteLedger, sqliteSchema } from '@tollstile/sqlite';
import { createTollstile, memoryBalance, testRail } from 'tollstile';

// The example keeps the test rail easy to run while persisting payment state in SQLite.
export const toll = createTollstile({
  rails: [testRail()],
  ledger: persistentLedger(),
});

function persistentLedger() {
  const db = new DatabaseSync(process.env.TOLLSTILE_DB ?? './tollstile.db');
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(sqliteSchema);
  const all = (sql: string, params: readonly (string | number | null)[]) => db.prepare(sql).all(...params) as readonly Record<string, unknown>[];
  return sqliteLedger({
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
  });
}

/** Prepaid credits by customer account. In memory here; back it with your database in production. */
export const creditBalance = memoryBalance({ acct_demo: '$0.10' });

// ─── Use real payments ────────────────────────────────────────────────────────
// To accept USDC on Base Sepolia through x402, replace `toll` above with the block below.
// Routes and handlers do not change. Set PAY_TO (your receiving address) and TOLLSTILE_SECRET
// (32+ random characters); a missing value fails at startup with a message saying which.
// See "Use real payments" in README.md: this path has not been verified against a live facilitator.
//
// import { x402 } from '@tollstile/x402';
//
// export const toll = createTollstile({
//   rails: [
//     x402({
//       network: 'eip155:84532', // Base Sepolia
//       payTo: process.env.PAY_TO ?? '',
//       denomination: 'USD', // 1 USDC = 1 USD, stated explicitly
//       rpcUrl: process.env.RPC_URL ?? 'https://sepolia.base.org', // used by toll.reconcile()
//     }),
//   ],
//   ledger: memoryLedger(), // use a database ledger in production
//   secret: process.env.TOLLSTILE_SECRET, // required with live rails: startup fails with a clear message if missing
// });
