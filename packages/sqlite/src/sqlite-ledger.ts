import { formatMoney, TollstileError, type Clock, type Ledger, type Money } from 'tollstile';
import {
  AUTHORIZATION_COLUMNS,
  CHARGE_COLUMNS,
  inconsistent,
  isStorable,
  microsParam,
  parseAuthorization,
  parseCharge,
  parseSpend,
  parseStatus,
  type SqliteRow,
  unstorable,
} from './rows';
import { DEFAULT_TABLE_PREFIX, tableNames } from './schema';
import { raw, sql, type SqliteStatement, type SqliteValue } from './statement';
import { accountingCondition, excludedFromSpend, list, nonTerminalCondition } from './states';

export type SqliteLedgerOptions = {
  /** Runs one statement with anonymous `?` parameters and returns its rows as objects keyed by column name. */
  readonly execute: (sql: string, params: readonly SqliteValue[]) => readonly SqliteRow[] | Promise<readonly SqliteRow[]>;
  /**
   * Runs the statements in order inside one write transaction and returns each statement's rows,
   * in order. All of them take effect or none do. `BEGIN IMMEDIATE … COMMIT` on node:sqlite,
   * `db.transaction(…).immediate()` on better-sqlite3 and bun:sqlite, `db.batch()` on D1.
   *
   * The ledger never needs to read between the statements of one transaction, so batch-only
   * drivers such as D1 work.
   */
  readonly transaction: (statements: readonly SqliteStatement[]) => readonly (readonly SqliteRow[])[] | Promise<readonly (readonly SqliteRow[])[]>;
  /** Prefix for table and index names. Must match the schema you applied. Defaults to `"tollstile_"`. */
  readonly tablePrefix?: string;
  /** Decides when claims have expired. Defaults to the system clock. */
  readonly clock?: Clock;
};

const CREATE_STATUSES = ['created', 'exists', 'missing', 'expired', 'invalid_amount', 'currency_mismatch', 'busy', 'insufficient'] as const;

/**
 * A ledger in SQLite: node:sqlite, better-sqlite3, bun:sqlite, or Cloudflare D1, through the
 * driver you already use. Apply `sqliteSchema` first.
 *
 * @example
 * ```ts
 * import { DatabaseSync } from 'node:sqlite';
 * import { createTollstile, testRail } from 'tollstile';
 * import { sqliteLedger, sqliteSchema } from '@tollstile/sqlite';
 *
 * const db = new DatabaseSync('ledger.db');
 * db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
 * db.exec(sqliteSchema);
 *
 * const all = (sql: string, params: readonly (string | number | null)[]) => db.prepare(sql).all(...params);
 * const ledger = sqliteLedger({
 *   execute: all,
 *   transaction: (statements) => {
 *     db.exec('BEGIN IMMEDIATE');
 *     try {
 *       const results = statements.map((statement) => all(statement.sql, statement.params));
 *       db.exec('COMMIT');
 *       return results;
 *     } catch (error) {
 *       db.exec('ROLLBACK');
 *       throw error;
 *     }
 *   },
 * });
 * const toll = createTollstile({ rails: [testRail()], ledger });
 * ```
 */
export function sqliteLedger(options: SqliteLedgerOptions): Ledger {
  const names = tableNames(options.tablePrefix ?? DEFAULT_TABLE_PREFIX);
  const authorizations = raw(names.authorizations);
  const charges = raw(names.charges);
  const transitions = raw(names.transitions);
  const claims = raw(names.claims);
  const clock = options.clock ?? { now: () => new Date() };

  const execute = async (statement: SqliteStatement): Promise<readonly SqliteRow[]> => options.execute(statement.sql, statement.params);

  async function transaction(statements: readonly SqliteStatement[]): Promise<(index: number) => SqliteRow | undefined> {
    const results = await options.transaction(statements);
    if (results.length !== statements.length) {
      throw inconsistent(`transaction() returned ${String(results.length)} results for ${String(statements.length)} statements. Return the rows of every statement, in order.`);
    }
    return (index) => results[index]?.[0];
  }

  const selectAuthorization = (id: SqliteValue | SqliteStatement) =>
    sql`SELECT ${raw(AUTHORIZATION_COLUMNS)} FROM ${authorizations} WHERE id = ${id}`;
  const selectCharge = (id: string) => sql`SELECT ${raw(CHARGE_COLUMNS)} FROM ${charges} WHERE id = ${id}`;

  return {
    async openAuthorization(input) {
      const at = input.at.getTime();
      const currency = input.limit?.currency ?? 'USD';
      const row = await transaction([
        sql`INSERT INTO ${authorizations}
              (id, rail, payer, kind, limit_currency, limit_micros, consumed_currency, consumed_micros,
               reserved_currency, reserved_micros, quote_id, expires_at, data, created_at, updated_at)
            VALUES (${input.id}, ${input.rail}, ${input.payer}, ${input.kind}, ${input.limit?.currency ?? null},
              CAST(${input.limit === null ? null : microsParam(input.limit)} AS INTEGER), ${currency}, 0, ${currency}, 0,
              ${input.quoteId}, ${input.expiresAt?.getTime() ?? null}, ${JSON.stringify(input.data)}, ${at}, ${at})
            ON CONFLICT (id) DO NOTHING
            RETURNING id`,
        selectAuthorization(input.id),
      ]);
      const stored = row(1);
      if (stored === undefined) throw inconsistent(`Authorization ${input.id} was opened but could not be read back.`);
      return { created: row(0) !== undefined, authorization: parseAuthorization(stored) };
    },

    async createCharge(input) {
      const storable = isStorable(input.amount);
      // An unstorable amount is bound as 0 so the statements stay valid; the status refuses it before anything is written.
      const amount = sql`CAST(${storable ? microsParam(input.amount) : '0'} AS INTEGER)`;
      const at = input.at.getTime();
      // Evaluated against the state before this transaction writes anything; memoryLedger's checks, in its order.
      const status = sql`
        SELECT CASE
          WHEN EXISTS (SELECT 1 FROM ${charges} WHERE id = ${input.id}) THEN 'exists'
          WHEN a.id IS NULL THEN 'missing'
          WHEN a.expires_at IS NOT NULL AND ${at} >= a.expires_at THEN 'expired'
          WHEN ${storable ? 0 : 1} THEN 'invalid_amount'
          WHEN COALESCE(a.limit_currency, CASE WHEN a.reserved_micros <> 0 THEN a.reserved_currency WHEN a.consumed_micros <> 0 THEN a.consumed_currency END)
            <> ${input.amount.currency} THEN 'currency_mismatch'
          WHEN a.kind = 'single' AND EXISTS (
            SELECT 1 FROM ${charges} WHERE authorization_id = a.id AND payment <> 'released'
          ) THEN 'busy'
          WHEN a.limit_micros IS NOT NULL AND a.consumed_micros + a.reserved_micros + ${amount} > a.limit_micros THEN 'insufficient'
          ELSE 'created'
        END AS status
        FROM (SELECT 1) LEFT JOIN ${authorizations} AS a ON a.id = ${input.authorizationId}`;
      // The charge is inserted first, which changes what `status` sees. The reservation and the
      // creation history row are therefore keyed on a charge that has no history yet: within this
      // transaction, that is exactly a charge the insert above just created.
      const fresh = sql`EXISTS (SELECT 1 FROM ${charges} WHERE id = ${input.id} AND authorization_id = ${input.authorizationId})
        AND NOT EXISTS (SELECT 1 FROM ${transitions} WHERE charge_id = ${input.id})`;

      const row = await transaction([
        status,
        sql`INSERT INTO ${charges}
              (id, authorization_id, request_id, resource, payer, flow, currency, reserved_micros, amount_micros,
               payment, fulfillment, request_hash, version, created_at, updated_at)
            SELECT ${input.id}, ${input.authorizationId}, ${input.requestId}, ${input.resource}, ${input.payer}, ${input.flow},
              ${input.amount.currency}, ${amount}, ${amount}, 'reserved', ${input.fulfillment}, ${input.requestHash}, 1, ${at}, ${at}
            WHERE (${status}) = 'created'`,
        sql`UPDATE ${authorizations} SET
              reserved_currency = CASE WHEN reserved_micros = 0 THEN ${input.amount.currency} ELSE reserved_currency END,
              consumed_currency = CASE WHEN consumed_micros = 0 THEN ${input.amount.currency} ELSE consumed_currency END,
              reserved_micros = reserved_micros + ${amount},
              updated_at = ${at}
            WHERE id = ${input.authorizationId} AND ${fresh}`,
        sql`INSERT INTO ${transitions} (charge_id, version, payment, fulfillment, pending, amount_micros, at)
            SELECT id, version, payment, fulfillment, pending, amount_micros, created_at FROM ${charges}
            WHERE id = ${input.id} AND ${fresh}`,
        selectCharge(input.id),
        selectAuthorization(input.authorizationId),
      ]);

      const result = parseStatus(row(0), CREATE_STATUSES);
      const charge = row(4);
      const authorization = row(5);
      switch (result) {
        case 'invalid_amount':
          throw unstorable(input.amount);
        case 'currency_mismatch': {
          if (authorization === undefined) throw inconsistent(`Authorization ${input.authorizationId} could not be read back.`);
          const { limit, reserved, consumed } = parseAuthorization(authorization);
          const held = limit ?? (reserved.micros !== 0n ? reserved : consumed);
          throw currencyMismatch(`Authorization ${input.authorizationId} is in ${held.currency}`, input.amount);
        }
        case 'created':
          if (charge === undefined || authorization === undefined) throw inconsistent(`Charge ${input.id} was created but could not be read back.`);
          return { status: result, charge: parseCharge(charge), authorization: parseAuthorization(authorization) };
        case 'exists':
          if (charge === undefined) throw inconsistent(`Charge ${input.id} exists but could not be read back.`);
          return { status: result, charge: parseCharge(charge) };
        case 'missing':
        case 'expired':
        case 'busy':
        case 'insufficient':
          return { status: result };
      }
    },

    async transitionCharge(id, from, to, at, patch = {}) {
      const time = at.getTime();
      const storable = patch.amount === undefined || isStorable(patch.amount);
      const amount =
        patch.amount === undefined ? raw('c.amount_micros') : sql`CAST(${storable ? microsParam(patch.amount) : '0'} AS INTEGER)`;
      const pending = patch.pending === undefined ? raw('c.pending') : sql`${patch.pending}`;
      const settlementReference = patch.settlement === undefined ? raw('c.settlement_reference') : sql`${patch.settlement.reference}`;
      const settlementDetails = patch.settlement === undefined ? raw('c.settlement_details') : sql`${JSON.stringify(patch.settlement.details)}`;
      const refundReference = patch.refundReference === undefined ? raw('c.refund_reference') : sql`${patch.refundReference}`;
      const resultRef = patch.resultRef === undefined ? raw('c.result_ref') : sql`${patch.resultRef}`;
      // Compare-and-set on both axes. Every statement below uses this condition, and only the last
      // one changes the columns it reads, so all of them see the charge as it was before.
      const matches = sql`c.id = ${id} AND c.payment = ${from.payment} AND c.fulfillment = ${from.fulfillment}
        AND EXISTS (SELECT 1 FROM ${authorizations} WHERE id = c.authorization_id)
        ${patch.amount === undefined ? raw('') : sql`AND c.currency = ${patch.amount.currency} AND ${storable ? 1 : 0}`}`;
      const toPayment = sql`${to.payment}`;

      const row = await transaction([
        // applyAccounting: take the charge out of its old class and add it to its new one.
        sql`UPDATE ${authorizations} AS a SET
              reserved_micros = a.reserved_micros
                - CASE WHEN ${accountingCondition('reserved', raw('c.payment'), raw('c.pending'))} THEN c.reserved_micros ELSE 0 END
                + CASE WHEN ${accountingCondition('reserved', toPayment, pending)} THEN c.reserved_micros ELSE 0 END,
              consumed_micros = a.consumed_micros
                - CASE WHEN ${accountingCondition('committed', raw('c.payment'), raw('c.pending'))} THEN c.amount_micros ELSE 0 END
                + CASE WHEN ${accountingCondition('committed', toPayment, pending)} THEN ${amount} ELSE 0 END,
              reserved_currency = c.currency,
              consumed_currency = c.currency,
              updated_at = ${time}
            FROM ${charges} AS c
            WHERE ${matches} AND a.id = c.authorization_id`,
        sql`INSERT INTO ${transitions} (charge_id, version, payment, fulfillment, pending, amount_micros, at)
            SELECT c.id, c.version + 1, ${to.payment}, ${to.fulfillment}, ${pending}, ${amount}, ${time}
            FROM ${charges} AS c WHERE ${matches}`,
        sql`UPDATE ${charges} AS c SET
              payment = ${to.payment}, fulfillment = ${to.fulfillment}, amount_micros = ${amount}, pending = ${pending},
              settlement_reference = ${settlementReference}, settlement_details = ${settlementDetails},
              refund_reference = ${refundReference}, result_ref = ${resultRef}, version = c.version + 1, updated_at = ${time}
            WHERE ${matches}
            RETURNING id`,
        selectCharge(id),
        selectAuthorization(sql`(SELECT authorization_id FROM ${charges} WHERE id = ${id})`),
      ]);

      const stored = row(3);
      const charge = stored === undefined ? undefined : parseCharge(stored);
      const authorization = row(4);
      if (row(2) !== undefined) {
        if (charge === undefined || authorization === undefined) throw inconsistent(`Charge ${id} moved but could not be read back.`);
        return { status: 'moved', charge, authorization: parseAuthorization(authorization) };
      }
      // The guards on the patched amount are the only way a matching charge is left unmoved.
      if (charge?.payment === from.payment && charge.fulfillment === from.fulfillment && patch.amount !== undefined) {
        if (!storable) throw unstorable(patch.amount);
        if (patch.amount.currency !== charge.amount.currency) throw currencyMismatch(`Charge ${id} is in ${charge.amount.currency}`, patch.amount);
      }
      return { status: 'conflict', charge };
    },

    async replaceAuthorizationData(id, data, at) {
      await execute(sql`UPDATE ${authorizations} SET data = ${JSON.stringify(data)}, updated_at = ${at.getTime()} WHERE id = ${id}`);
    },

    async getAuthorization(id) {
      const [row] = await execute(selectAuthorization(id));
      return row === undefined ? undefined : parseAuthorization(row);
    },

    async getCharge(id) {
      const [row] = await execute(selectCharge(id));
      return row === undefined ? undefined : parseCharge(row);
    },

    async pendingCharges(before, limit) {
      const rows = await execute(
        sql`SELECT ${raw(CHARGE_COLUMNS)} FROM ${charges}
            WHERE ${raw(nonTerminalCondition)} AND updated_at < ${before.getTime()}
            ORDER BY updated_at DESC, id DESC
            LIMIT ${limit}`,
      );
      return rows.map(parseCharge);
    },

    async spendSince(payer, since) {
      const rows = await execute(
        sql`SELECT currency, count(*) AS count, CAST(sum(amount_micros) AS TEXT) AS total
            FROM ${charges}
            WHERE payer = ${payer} AND created_at >= ${since.getTime()} AND payment NOT IN (${raw(list(excludedFromSpend))})
            GROUP BY currency
            ORDER BY currency`,
      );
      const spend = rows.map(parseSpend);
      return { count: spend.reduce((sum, row) => sum + row.count, 0), total: spend.map((row) => row.total) };
    },

    async claim(scope, key, expiresAt) {
      // One statement: a live claim is left untouched, an expired one is taken over atomically.
      const rows = await execute(
        sql`INSERT INTO ${claims} (scope, key, expires_at) VALUES (${scope}, ${key}, ${expiresAt.getTime()})
            ON CONFLICT (scope, key) DO UPDATE SET expires_at = excluded.expires_at
            WHERE ${claims}.expires_at <= ${clock.now().getTime()}
            RETURNING scope`,
      );
      return rows.length === 1 ? 'claimed' : 'exists';
    },
  };
}

function currencyMismatch(holder: string, amount: Money): TollstileError {
  return new TollstileError('CURRENCY_MISMATCH', `${holder}; cannot record ${formatMoney(amount)}. Tollstile never converts currencies.`);
}
