-- Tollstile ledger schema for SQLite (@tollstile/sqlite). Requires SQLite 3.38 or later.
--
-- tollstile_authorizations: what a payer authorized. reserved_micros and consumed_micros are the
--   in-flight and committed totals of its charges, kept in step by the ledger in the same transaction.
-- tollstile_charges: one economic effect against an authorization, on two axes: payment and fulfillment.
-- tollstile_charge_transitions: append-only history. Row 1 is the charge's creation; every transition adds one.
-- tollstile_claims: single-use keys (nonces, replay windows) until expires_at.
--
-- Money: integer micros (1 USD = 1,000,000) in 64-bit INTEGER, with a currency code. Never REAL.
--   STRICT tables turn an overflow, which SQLite would otherwise store as REAL, into an error.
-- Time: INTEGER milliseconds since the Unix epoch, UTC. Readable with
--   strftime('%Y-%m-%dT%H:%M:%fZ', created_at / 1000.0, 'unixepoch').
-- JSON: TEXT holding valid JSON.
--
-- Every statement uses IF NOT EXISTS, so applying this twice is harmless. Later schema changes ship
-- as separate migrations.

CREATE TABLE IF NOT EXISTS tollstile_authorizations (
  id                TEXT    NOT NULL PRIMARY KEY,
  rail              TEXT    NOT NULL,
  payer             TEXT    NOT NULL,
  kind              TEXT    NOT NULL CHECK (kind IN ('single', 'reusable')),
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

CREATE TABLE IF NOT EXISTS tollstile_charges (
  id                   TEXT    NOT NULL PRIMARY KEY,
  authorization_id     TEXT    NOT NULL REFERENCES tollstile_authorizations (id),
  request_id           TEXT    NOT NULL,
  resource             TEXT    NOT NULL,
  payer                TEXT    NOT NULL,
  flow                 TEXT    NOT NULL CHECK (flow IN ('authorization', 'upfront', 'escrow')),
  currency             TEXT    NOT NULL,
  reserved_micros      INTEGER NOT NULL CHECK (reserved_micros >= 0),
  amount_micros        INTEGER NOT NULL CHECK (amount_micros >= 0),
  payment              TEXT    NOT NULL CHECK (payment IN ('reserved', 'settling', 'settled', 'failed', 'unknown', 'released', 'refund_pending', 'refunded')),
  fulfillment          TEXT    NOT NULL CHECK (fulfillment IN ('pending', 'running', 'completed', 'failed')),
  pending              TEXT    CHECK (pending IN ('settle', 'refund')),
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

CREATE TABLE IF NOT EXISTS tollstile_charge_transitions (
  charge_id     TEXT    NOT NULL REFERENCES tollstile_charges (id),
  version       INTEGER NOT NULL CHECK (version >= 1),
  payment       TEXT    NOT NULL CHECK (payment IN ('reserved', 'settling', 'settled', 'failed', 'unknown', 'released', 'refund_pending', 'refunded')),
  fulfillment   TEXT    NOT NULL CHECK (fulfillment IN ('pending', 'running', 'completed', 'failed')),
  pending       TEXT    CHECK (pending IN ('settle', 'refund')),
  amount_micros INTEGER NOT NULL CHECK (amount_micros >= 0),
  at            INTEGER NOT NULL,
  PRIMARY KEY (charge_id, version)
) STRICT;

CREATE TABLE IF NOT EXISTS tollstile_claims (
  scope      TEXT    NOT NULL,
  key        TEXT    NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (scope, key)
) STRICT;

-- createCharge: a single-use authorization's other charges.
CREATE INDEX IF NOT EXISTS tollstile_charges_authorization_idx
  ON tollstile_charges (authorization_id);

-- pendingCharges (reconcile): unfinished charges by last update. Finished charges, the vast majority, are not indexed.
CREATE INDEX IF NOT EXISTS tollstile_charges_pending_idx
  ON tollstile_charges (updated_at)
  WHERE (payment IN ('reserved', 'settling', 'unknown', 'refund_pending') OR (payment = 'settled' AND fulfillment IN ('pending', 'running', 'failed')));

-- spendSince (limit requirement): a payer's charges since a point in time.
CREATE INDEX IF NOT EXISTS tollstile_charges_payer_created_idx
  ON tollstile_charges (payer, created_at);

-- Periodic cleanup of expired claims.
CREATE INDEX IF NOT EXISTS tollstile_claims_expires_idx
  ON tollstile_claims (expires_at);

