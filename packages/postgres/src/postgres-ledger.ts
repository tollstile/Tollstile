import { applyAccounting, formatMoney, TollstileError, type Authorization, type Charge, type Clock, type Ledger, type Money } from 'tollstile';
import { AUTHORIZATION_COLUMNS, CHARGE_COLUMNS, microsParam, parseAuthorization, parseCharge, parseSpend, type PostgresRow } from './rows';
import { DEFAULT_TABLE_PREFIX, tableNames } from './schema';
import { excludedFromSpend, list, nonTerminalCondition } from './states';

/**
 * Runs one parameterized statement (`$1`, `$2`, …) and resolves with its rows as objects keyed by
 * column name. Parameters are always text or null; the ledger casts them in SQL.
 */
export type PostgresQuery = (sql: string, params: (string | null)[]) => Promise<{ readonly rows: readonly PostgresRow[] }>;

export type PostgresLedgerOptions = {
  /** Runs a statement outside a transaction. A pool, an HTTP driver, or a single connection all work. */
  readonly query: PostgresQuery;
  /**
   * Runs `work` inside one transaction on one connection: `BEGIN`, then `COMMIT` when it resolves
   * or `ROLLBACK` when it rejects. The ledger takes row locks inside it, so it must be interactive
   * (not a batch of statements) and use the default READ COMMITTED isolation.
   */
  readonly transaction: <T>(work: (query: PostgresQuery) => Promise<T>) => Promise<T>;
  /** Prefix for table and index names. Must match the schema you applied. Defaults to `"tollstile_"`. */
  readonly tablePrefix?: string;
  /** Decides when claims have expired. Defaults to the system clock. */
  readonly clock?: Clock;
};

/**
 * A ledger in your PostgreSQL database, through the client you already use. Apply
 * `postgresSchema` first.
 *
 * @example
 * ```ts
 * import pg from 'pg';
 * import { createTollstile, testRail } from 'tollstile';
 * import { postgresLedger } from '@tollstile/postgres';
 *
 * const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
 * const ledger = postgresLedger({
 *   query: (sql, params) => pool.query(sql, params),
 *   transaction: async (work) => {
 *     const client = await pool.connect();
 *     try {
 *       await client.query('BEGIN');
 *       const result = await work((sql, params) => client.query(sql, params));
 *       await client.query('COMMIT');
 *       return result;
 *     } catch (error) {
 *       await client.query('ROLLBACK');
 *       throw error;
 *     } finally {
 *       client.release();
 *     }
 *   },
 * });
 * const toll = createTollstile({ rails: [testRail()], ledger });
 * ```
 */
export function postgresLedger(options: PostgresLedgerOptions): Ledger {
  const tables = tableNames(options.tablePrefix ?? DEFAULT_TABLE_PREFIX);
  const clock = options.clock ?? { now: () => new Date() };
  const { query, transaction } = options;

  async function readAuthorization(run: PostgresQuery, id: string): Promise<Authorization | undefined> {
    const { rows } = await run(`SELECT ${AUTHORIZATION_COLUMNS} FROM ${tables.authorizations} WHERE id = $1`, [id]);
    return rows[0] === undefined ? undefined : parseAuthorization(rows[0]);
  }

  /**
   * Every write to a charge first locks its authorization row, so checks and accounting made while
   * holding it cannot interleave with another process changing the same authorization.
   */
  async function lockAuthorization(run: PostgresQuery, where: string, id: string): Promise<Authorization | undefined> {
    const { rows } = await run(`SELECT ${AUTHORIZATION_COLUMNS} FROM ${tables.authorizations} WHERE id = ${where} FOR UPDATE`, [id]);
    return rows[0] === undefined ? undefined : parseAuthorization(rows[0]);
  }

  async function readCharge(run: PostgresQuery, id: string): Promise<Charge | undefined> {
    const { rows } = await run(`SELECT ${CHARGE_COLUMNS} FROM ${tables.charges} WHERE id = $1`, [id]);
    return rows[0] === undefined ? undefined : parseCharge(rows[0]);
  }

  async function writeTotals(run: PostgresQuery, authorization: Authorization): Promise<Authorization> {
    const { rows } = await run(
      `UPDATE ${tables.authorizations} SET
         reserved_currency = $2, reserved_micros = $3::bigint,
         consumed_currency = $4, consumed_micros = $5::bigint,
         updated_at = $6::timestamptz
       WHERE id = $1
       RETURNING ${AUTHORIZATION_COLUMNS}`,
      [
        authorization.id,
        authorization.reserved.currency,
        microsParam(authorization.reserved),
        authorization.consumed.currency,
        microsParam(authorization.consumed),
        authorization.updatedAt.toISOString(),
      ],
    );
    if (rows[0] === undefined) throw inconsistent(`Authorization ${authorization.id} was updated but could not be read back.`);
    return parseAuthorization(rows[0]);
  }

  return {
    async openAuthorization(input) {
      const currency = input.limit?.currency ?? 'USD';
      const { rows } = await query(
        `INSERT INTO ${tables.authorizations}
           (id, rail, payer, kind, limit_currency, limit_micros, consumed_currency, consumed_micros,
            reserved_currency, reserved_micros, quote_id, expires_at, data, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::bigint, $7, 0, $7, 0, $8, $9::timestamptz, $10::jsonb, $11::timestamptz, $11::timestamptz)
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [
          input.id,
          input.rail,
          input.payer,
          input.kind,
          input.limit?.currency ?? null,
          input.limit === null ? null : microsParam(input.limit),
          currency,
          input.quoteId,
          input.expiresAt?.toISOString() ?? null,
          JSON.stringify(input.data),
          input.at.toISOString(),
        ],
      );
      // A second statement, so a row committed by a concurrent insert of the same id is visible.
      const authorization = await readAuthorization(query, input.id);
      if (authorization === undefined) throw inconsistent(`Authorization ${input.id} was opened but could not be read back.`);
      return { created: rows.length === 1, authorization };
    },

    async createCharge(input) {
      return transaction(async (run) => {
        const authorization = await lockAuthorization(run, '$1', input.authorizationId);
        const existing = await readCharge(run, input.id);
        if (existing !== undefined) return { status: 'exists', charge: existing };
        if (authorization === undefined) return { status: 'missing' };
        if (authorization.expiresAt !== null && input.at >= authorization.expiresAt) return { status: 'expired' };
        const amount = microsParam(input.amount);
        const held = authorization.limit ?? [authorization.reserved, authorization.consumed].find((total) => total.micros !== 0n);
        if (held !== undefined && held.currency !== input.amount.currency) {
          throw currencyMismatch(`Authorization ${authorization.id} is in ${held.currency}`, input.amount);
        }

        if (authorization.kind === 'single') {
          const { rows } = await run(
            `SELECT id FROM ${tables.charges} WHERE authorization_id = $1 AND payment <> 'released' LIMIT 1`,
            [authorization.id],
          );
          if (rows.length > 0) return { status: 'busy' };
        }
        const reserved = sameCurrency(authorization.reserved, input.amount);
        const consumed = sameCurrency(authorization.consumed, input.amount);
        if (authorization.limit !== null && consumed.micros + reserved.micros + input.amount.micros > authorization.limit.micros) {
          return { status: 'insufficient' };
        }

        // ON CONFLICT covers a charge with this id created under another authorization's lock.
        const { rows } = await run(
          `WITH created AS (
             INSERT INTO ${tables.charges}
               (id, authorization_id, request_id, resource, payer, flow, currency, reserved_micros, amount_micros,
                payment, fulfillment, version, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::bigint, $8::bigint, 'reserved', $9, 1, $10::timestamptz, $10::timestamptz)
             ON CONFLICT (id) DO NOTHING
             RETURNING *
           ), recorded AS (
             INSERT INTO ${tables.transitions} (charge_id, version, payment, fulfillment, pending, amount_micros, at)
             SELECT id, version, payment, fulfillment, pending, amount_micros, created_at FROM created
           )
           SELECT ${CHARGE_COLUMNS} FROM created`,
          [
            input.id,
            input.authorizationId,
            input.requestId,
            input.resource,
            input.payer,
            input.flow,
            input.amount.currency,
            amount,
            input.fulfillment,
            input.at.toISOString(),
          ],
        );
        if (rows[0] === undefined) {
          const charge = await readCharge(run, input.id);
          if (charge === undefined) throw inconsistent(`Charge ${input.id} conflicted on insert but could not be read.`);
          return { status: 'exists', charge };
        }

        const updated = await writeTotals(run, {
          ...authorization,
          reserved: { currency: reserved.currency, micros: reserved.micros + input.amount.micros },
          consumed,
          updatedAt: input.at,
        });
        return { status: 'created', charge: parseCharge(rows[0]), authorization: updated };
      });
    },

    async transitionCharge(id, from, to, at, patch = {}) {
      return transaction(async (run) => {
        const authorization = await lockAuthorization(run, `(SELECT authorization_id FROM ${tables.charges} WHERE id = $1)`, id);
        const current = await readCharge(run, id);
        if (current?.payment !== from.payment || current.fulfillment !== from.fulfillment || authorization === undefined) {
          return { status: 'conflict', charge: current };
        }
        const amount = microsParam(patch.amount ?? current.amount);
        if (patch.amount !== undefined && patch.amount.currency !== current.amount.currency) {
          throw currencyMismatch(`Charge ${id} is in ${current.amount.currency}`, patch.amount);
        }

        const settlement = patch.settlement ?? current.settlement;
        // The compare-and-set is repeated in SQL so a writer that skipped the lock still cannot be overwritten.
        const { rows } = await run(
          `WITH moved AS (
             UPDATE ${tables.charges} SET
               payment = $4, fulfillment = $5, amount_micros = $6::bigint, pending = $7,
               settlement_reference = $8, settlement_details = $9::jsonb, refund_reference = $10,
               version = version + 1, updated_at = $11::timestamptz
             WHERE id = $1 AND payment = $2 AND fulfillment = $3
             RETURNING *
           ), recorded AS (
             INSERT INTO ${tables.transitions} (charge_id, version, payment, fulfillment, pending, amount_micros, at)
             SELECT id, version, payment, fulfillment, pending, amount_micros, updated_at FROM moved
           )
           SELECT ${CHARGE_COLUMNS} FROM moved`,
          [
            id,
            from.payment,
            from.fulfillment,
            to.payment,
            to.fulfillment,
            amount,
            patch.pending === undefined ? current.pending : patch.pending,
            settlement?.reference ?? null,
            settlement === null ? null : JSON.stringify(settlement.details),
            patch.refundReference ?? current.refundReference,
            at.toISOString(),
          ],
        );
        if (rows[0] === undefined) return { status: 'conflict', charge: await readCharge(run, id) };

        const next = parseCharge(rows[0]);
        const updated = await writeTotals(run, applyAccounting(authorization, current, next, at));
        return { status: 'moved', charge: next, authorization: updated };
      });
    },

    async replaceAuthorizationData(id, data, at) {
      await query(`UPDATE ${tables.authorizations} SET data = $2::jsonb, updated_at = $3::timestamptz WHERE id = $1`, [
        id,
        JSON.stringify(data),
        at.toISOString(),
      ]);
    },

    getAuthorization: (id) => readAuthorization(query, id),
    getCharge: (id) => readCharge(query, id),

    async pendingCharges(before) {
      const { rows } = await query(
        `SELECT ${CHARGE_COLUMNS} FROM ${tables.charges}
         WHERE ${nonTerminalCondition} AND updated_at < $1::timestamptz
         ORDER BY updated_at, id`,
        [before.toISOString()],
      );
      return rows.map(parseCharge);
    },

    async spendSince(payer, since) {
      const { rows } = await query(
        `SELECT currency, count(*)::text AS count, sum(amount_micros)::text AS total
         FROM ${tables.charges}
         WHERE payer = $1 AND created_at >= $2::timestamptz AND payment NOT IN (${list(excludedFromSpend)})
         GROUP BY currency
         ORDER BY currency`,
        [payer, since.toISOString()],
      );
      const spend = rows.map(parseSpend);
      return { count: spend.reduce((sum, row) => sum + row.count, 0), total: spend.map((row) => row.total) };
    },

    async claim(scope, key, expiresAt) {
      // One statement: a live claim is left untouched, an expired one is taken over atomically.
      const { rows } = await query(
        `INSERT INTO ${tables.claims} (scope, key, expires_at) VALUES ($1, $2, $3::timestamptz)
         ON CONFLICT (scope, key) DO UPDATE SET expires_at = EXCLUDED.expires_at
         WHERE ${tables.claims}.expires_at <= $4::timestamptz
         RETURNING scope`,
        [scope, key, expiresAt.toISOString(), clock.now().toISOString()],
      );
      return rows.length === 1 ? 'claimed' : 'exists';
    },
  };
}

/** Authorizations opened without a limit start in USD; adopt the charge's currency while they are empty. */
function sameCurrency(amount: Money, like: Money): Money {
  return amount.micros === 0n ? { currency: like.currency, micros: 0n } : amount;
}

function currencyMismatch(holder: string, amount: Money): TollstileError {
  return new TollstileError('CURRENCY_MISMATCH', `${holder}; cannot record ${formatMoney(amount)}. Tollstile never converts currencies.`);
}

function inconsistent(message: string): TollstileError {
  return new TollstileError('LEDGER_INCONSISTENT', message);
}
