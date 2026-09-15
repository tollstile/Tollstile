import { TollstileError } from 'tollstile';
import {
  authorizationKinds,
  flows,
  fulfillmentStates,
  list,
  nonTerminalCondition,
  paymentStates,
  pendingOperations,
} from './states';

export const DEFAULT_TABLE_PREFIX = 'tollstile_';

const PREFIX = /^[a-z_][a-z0-9_]*$/;

export type TableNames = {
  readonly authorizations: string;
  readonly charges: string;
  readonly transitions: string;
  readonly claims: string;
};

export function tableNames(prefix: string): TableNames {
  if (!PREFIX.test(prefix)) {
    throw new TollstileError(
      'CONFIG_INVALID',
      `Invalid tablePrefix "${prefix}": use lowercase letters, digits, and underscores, not starting with a digit, e.g. "billing_".`,
    );
  }
  return {
    authorizations: `${prefix}authorizations`,
    charges: `${prefix}charges`,
    transitions: `${prefix}charge_transitions`,
    claims: `${prefix}claims`,
  };
}

function schemaFor(prefix: string): string {
  const { authorizations, charges, transitions, claims } = tableNames(prefix);
  return `-- Tollstile ledger schema for SQLite (@tollstile/sqlite). Requires SQLite 3.38 or later.
--
-- ${authorizations}: what a payer authorized. reserved_micros and consumed_micros are the
--   in-flight and committed totals of its charges, kept in step by the ledger in the same transaction.
-- ${charges}: one economic effect against an authorization, on two axes: payment and fulfillment.
-- ${transitions}: append-only history. Row 1 is the charge's creation; every transition adds one.
-- ${claims}: single-use keys (nonces, replay windows) until expires_at.
--
-- Money: integer micros (1 USD = 1,000,000) in 64-bit INTEGER, with a currency code. Never REAL.
--   STRICT tables turn an overflow, which SQLite would otherwise store as REAL, into an error.
-- Time: INTEGER milliseconds since the Unix epoch, UTC. Readable with
--   strftime('%Y-%m-%dT%H:%M:%fZ', created_at / 1000.0, 'unixepoch').
-- JSON: TEXT holding valid JSON.
--
-- Every statement uses IF NOT EXISTS, so applying this twice is harmless. Later schema changes ship
-- as separate migrations.

CREATE TABLE IF NOT EXISTS ${authorizations} (
  id                TEXT    NOT NULL PRIMARY KEY,
  rail              TEXT    NOT NULL,
  payer             TEXT    NOT NULL,
  kind              TEXT    NOT NULL CHECK (kind IN (${list(authorizationKinds)})),
  limit_currency    TEXT,
  limit_micros      INTEGER CHECK (limit_micros >= 0),
  consumed_currency TEXT    NOT NULL,
  consumed_micros   INTEGER NOT NULL CHECK (consumed_micros >= 0),
  reserved_currency TEXT    NOT NULL,
  reserved_micros   INTEGER NOT NULL CHECK (reserved_micros >= 0),
  quote_id          TEXT,
  expires_at        INTEGER,
  data              TEXT    NOT NULL CHECK (json_valid(data)),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  CHECK ((limit_currency IS NULL) = (limit_micros IS NULL))
) STRICT;

CREATE TABLE IF NOT EXISTS ${charges} (
  id                   TEXT    NOT NULL PRIMARY KEY,
  authorization_id     TEXT    NOT NULL REFERENCES ${authorizations} (id),
  request_id           TEXT    NOT NULL,
  resource             TEXT    NOT NULL,
  payer                TEXT    NOT NULL,
  flow                 TEXT    NOT NULL CHECK (flow IN (${list(flows)})),
  currency             TEXT    NOT NULL,
  reserved_micros      INTEGER NOT NULL CHECK (reserved_micros >= 0),
  amount_micros        INTEGER NOT NULL CHECK (amount_micros >= 0),
  payment              TEXT    NOT NULL CHECK (payment IN (${list(paymentStates)})),
  fulfillment          TEXT    NOT NULL CHECK (fulfillment IN (${list(fulfillmentStates)})),
  pending              TEXT    CHECK (pending IN (${list(pendingOperations)})),
  settlement_reference TEXT,
  settlement_details   TEXT    CHECK (json_valid(settlement_details)),
  refund_reference     TEXT,
  request_hash         TEXT,
  result_ref           TEXT,
  version              INTEGER NOT NULL CHECK (version >= 1),
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  CHECK ((settlement_reference IS NULL) = (settlement_details IS NULL))
) STRICT;

CREATE TABLE IF NOT EXISTS ${transitions} (
  charge_id     TEXT    NOT NULL REFERENCES ${charges} (id),
  version       INTEGER NOT NULL CHECK (version >= 1),
  payment       TEXT    NOT NULL CHECK (payment IN (${list(paymentStates)})),
  fulfillment   TEXT    NOT NULL CHECK (fulfillment IN (${list(fulfillmentStates)})),
  pending       TEXT    CHECK (pending IN (${list(pendingOperations)})),
  amount_micros INTEGER NOT NULL CHECK (amount_micros >= 0),
  at            INTEGER NOT NULL,
  PRIMARY KEY (charge_id, version)
) STRICT;

CREATE TABLE IF NOT EXISTS ${claims} (
  scope      TEXT    NOT NULL,
  key        TEXT    NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (scope, key)
) STRICT;

-- createCharge: a single-use authorization's other charges.
CREATE INDEX IF NOT EXISTS ${charges}_authorization_idx
  ON ${charges} (authorization_id);

-- pendingCharges (reconcile): unfinished charges by last update. Finished charges, the vast majority, are not indexed.
CREATE INDEX IF NOT EXISTS ${charges}_pending_idx
  ON ${charges} (updated_at)
  WHERE ${nonTerminalCondition};

-- spendSince (limit requirement): a payer's charges since a point in time.
CREATE INDEX IF NOT EXISTS ${charges}_payer_created_idx
  ON ${charges} (payer, created_at);

-- Periodic cleanup of expired claims.
CREATE INDEX IF NOT EXISTS ${claims}_expires_idx
  ON ${claims} (expires_at);
`;
}

/**
 * The DDL for the ledger tables and indexes, with the default `tollstile_` prefix. Apply it
 * through your migration tool before using `sqliteLedger()`. For another `tablePrefix`, apply
 * `sqliteSchema.replaceAll('tollstile_', prefix)`.
 *
 * @example
 * ```ts
 * import { DatabaseSync } from 'node:sqlite';
 * import { sqliteSchema } from '@tollstile/sqlite';
 *
 * new DatabaseSync('ledger.db').exec(sqliteSchema); // or: wrangler d1 migrations, paste it in
 * ```
 */
export const sqliteSchema: string = schemaFor(DEFAULT_TABLE_PREFIX);
