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
  return `-- Tollstile ledger schema for PostgreSQL (@tollstile/postgres).
--
-- ${authorizations}: what a payer authorized. reserved_micros and consumed_micros are the
--   in-flight and committed totals of its charges, kept in step by the ledger in the same transaction.
-- ${charges}: one economic effect against an authorization, on two axes: payment and fulfillment.
-- ${transitions}: append-only history. Row 1 is the charge's creation; every transition adds one.
-- ${claims}: single-use keys (nonces, replay windows) until expires_at.
--
-- Money: integer micros (1 USD = 1,000,000) in bigint, with a currency code. Never floating point.
-- Time: timestamptz, written with millisecond precision.
-- JSON: jsonb.
--
-- Every statement uses IF NOT EXISTS, so applying this twice is harmless. Later schema changes ship
-- as separate migrations.

CREATE TABLE IF NOT EXISTS ${authorizations} (
  id                text        PRIMARY KEY,
  rail              text        NOT NULL,
  payer             text        NOT NULL,
  kind              text        NOT NULL CHECK (kind IN (${list(authorizationKinds)})),
  limit_currency    text,
  limit_micros      bigint      CHECK (limit_micros >= 0),
  consumed_currency text        NOT NULL,
  consumed_micros   bigint      NOT NULL CHECK (consumed_micros >= 0),
  reserved_currency text        NOT NULL,
  reserved_micros   bigint      NOT NULL CHECK (reserved_micros >= 0),
  quote_id          text,
  expires_at        timestamptz,
  data              jsonb       NOT NULL,
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL,
  CHECK ((limit_currency IS NULL) = (limit_micros IS NULL))
);

CREATE TABLE IF NOT EXISTS ${charges} (
  id                   text        PRIMARY KEY,
  authorization_id     text        NOT NULL REFERENCES ${authorizations} (id),
  request_id           text        NOT NULL,
  resource             text        NOT NULL,
  payer                text        NOT NULL,
  flow                 text        NOT NULL CHECK (flow IN (${list(flows)})),
  currency             text        NOT NULL,
  reserved_micros      bigint      NOT NULL CHECK (reserved_micros >= 0),
  amount_micros        bigint      NOT NULL CHECK (amount_micros >= 0),
  payment              text        NOT NULL CHECK (payment IN (${list(paymentStates)})),
  fulfillment          text        NOT NULL CHECK (fulfillment IN (${list(fulfillmentStates)})),
  pending              text        CHECK (pending IN (${list(pendingOperations)})),
  settlement_reference text,
  settlement_details   jsonb,
  refund_reference     text,
  version              integer     NOT NULL CHECK (version >= 1),
  created_at           timestamptz NOT NULL,
  updated_at           timestamptz NOT NULL,
  CHECK ((settlement_reference IS NULL) = (settlement_details IS NULL))
);

CREATE TABLE IF NOT EXISTS ${transitions} (
  charge_id     text        NOT NULL REFERENCES ${charges} (id),
  version       integer     NOT NULL CHECK (version >= 1),
  payment       text        NOT NULL CHECK (payment IN (${list(paymentStates)})),
  fulfillment   text        NOT NULL CHECK (fulfillment IN (${list(fulfillmentStates)})),
  pending       text        CHECK (pending IN (${list(pendingOperations)})),
  amount_micros bigint      NOT NULL CHECK (amount_micros >= 0),
  at            timestamptz NOT NULL,
  PRIMARY KEY (charge_id, version)
);

CREATE TABLE IF NOT EXISTS ${claims} (
  scope      text        NOT NULL,
  key        text        NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (scope, key)
);

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
 * through your migration tool before using `postgresLedger()`. For another `tablePrefix`, apply
 * `postgresSchema.replaceAll('tollstile_', prefix)`.
 *
 * @example
 * ```ts
 * import { postgresSchema } from '@tollstile/postgres';
 *
 * await pool.query(postgresSchema); // or paste it into a migration file
 * ```
 */
export const postgresSchema: string = schemaFor(DEFAULT_TABLE_PREFIX);
