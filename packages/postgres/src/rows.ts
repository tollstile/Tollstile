import { TollstileError, type Authorization, type Charge, type Json, type Money } from 'tollstile';
import { authorizationKinds, flows, fulfillmentStates, paymentStates, pendingOperations } from './states';

export type PostgresRow = Readonly<Record<string, unknown>>;

const MAX_BIGINT = 9_223_372_036_854_775_807n;
const DIGITS = /^(0|[1-9]\d*)$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Timestamps are read as fixed-format UTC text rather than driver `Date`s, so every client
 * returns the same shape regardless of its type parsers or session time zone.
 */
const isoText = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// bigint and jsonb are cast to text: drivers disagree on how to decode them, but not on text.
export const AUTHORIZATION_COLUMNS = `id, rail, payer, kind,
  limit_currency, limit_micros::text AS limit_micros,
  consumed_currency, consumed_micros::text AS consumed_micros,
  reserved_currency, reserved_micros::text AS reserved_micros,
  quote_id, ${isoText('expires_at')} AS expires_at, data::text AS data,
  ${isoText('created_at')} AS created_at, ${isoText('updated_at')} AS updated_at`;

export const CHARGE_COLUMNS = `id, authorization_id, request_id, resource, payer, flow, currency,
  reserved_micros::text AS reserved_micros, amount_micros::text AS amount_micros,
  payment, fulfillment, pending, settlement_reference, settlement_details::text AS settlement_details,
  refund_reference, request_hash, result_ref, ${isoText('created_at')} AS created_at, ${isoText('updated_at')} AS updated_at`;

export function parseAuthorization(row: PostgresRow): Authorization {
  const limitCurrency = nullable(row, 'limit_currency', text);
  return {
    id: text(row, 'id'),
    rail: text(row, 'rail'),
    payer: text(row, 'payer'),
    kind: oneOf(row, 'kind', authorizationKinds),
    limit: limitCurrency === null ? null : { currency: limitCurrency, micros: micros(row, 'limit_micros') },
    consumed: { currency: text(row, 'consumed_currency'), micros: micros(row, 'consumed_micros') },
    reserved: { currency: text(row, 'reserved_currency'), micros: micros(row, 'reserved_micros') },
    quoteId: nullable(row, 'quote_id', text),
    expiresAt: nullable(row, 'expires_at', timestamp),
    data: json(row, 'data'),
    createdAt: timestamp(row, 'created_at'),
    updatedAt: timestamp(row, 'updated_at'),
  };
}

export function parseCharge(row: PostgresRow): Charge {
  const currency = text(row, 'currency');
  const reference = nullable(row, 'settlement_reference', text);
  return {
    id: text(row, 'id'),
    authorizationId: text(row, 'authorization_id'),
    requestId: text(row, 'request_id'),
    resource: text(row, 'resource'),
    payer: text(row, 'payer'),
    flow: oneOf(row, 'flow', flows),
    reservedAmount: { currency, micros: micros(row, 'reserved_micros') },
    amount: { currency, micros: micros(row, 'amount_micros') },
    payment: oneOf(row, 'payment', paymentStates),
    fulfillment: oneOf(row, 'fulfillment', fulfillmentStates),
    pending: nullable(row, 'pending', (r, column) => oneOf(r, column, pendingOperations)),
    settlement: reference === null ? null : { reference, details: json(row, 'settlement_details') },
    refundReference: nullable(row, 'refund_reference', text),
    requestHash: nullable(row, 'request_hash', text),
    resultRef: nullable(row, 'result_ref', text),
    createdAt: timestamp(row, 'created_at'),
    updatedAt: timestamp(row, 'updated_at'),
  };
}

export function parseSpend(row: PostgresRow): { readonly count: number; readonly total: Money } {
  const count = read(row, 'count', 'a count', (value) => {
    const parsed = typeof value === 'string' && DIGITS.test(value) ? BigInt(value) : undefined;
    return parsed !== undefined && parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : undefined;
  });
  // A sum is numeric in Postgres and may exceed bigint, which Money represents without loss.
  const total = read(row, 'total', 'a non-negative integer', (value) =>
    typeof value === 'string' && DIGITS.test(value) ? BigInt(value) : undefined,
  );
  return { count, total: { currency: text(row, 'currency'), micros: total } };
}

/** Money is written as decimal text so no driver ever converts it through a float. */
export function microsParam(amount: Money): string {
  if (amount.micros < 0n || amount.micros > MAX_BIGINT) {
    throw new TollstileError(
      'INVALID_AMOUNT',
      `Amount of ${amount.micros.toString()} ${amount.currency} micros cannot be stored: the ledger holds 0 to ${MAX_BIGINT.toString()} micros.`,
    );
  }
  return amount.micros.toString();
}

function read<T>(row: PostgresRow, column: string, expected: string, parse: (value: unknown) => T | undefined): T {
  const value = parse(row[column]);
  if (value === undefined) {
    throw new TollstileError(
      'LEDGER_INCONSISTENT',
      `Ledger column "${column}" is not ${expected}. Check that the tables were created from postgresSchema and that query() resolves rows as objects keyed by column name.`,
    );
  }
  return value;
}

function text(row: PostgresRow, column: string): string {
  return read(row, column, 'text', (value) => (typeof value === 'string' ? value : undefined));
}

function nullable<T>(row: PostgresRow, column: string, parse: (row: PostgresRow, column: string) => T): T | null {
  return row[column] === null ? null : parse(row, column);
}

function oneOf<T extends string>(row: PostgresRow, column: string, values: readonly T[]): T {
  return read(row, column, `one of ${values.join(', ')}`, (value) => values.find((candidate) => candidate === value));
}

function micros(row: PostgresRow, column: string): bigint {
  return read(row, column, 'a non-negative bigint', (value) =>
    typeof value === 'string' && DIGITS.test(value) && BigInt(value) <= MAX_BIGINT ? BigInt(value) : undefined,
  );
}

function timestamp(row: PostgresRow, column: string): Date {
  return read(row, column, 'a UTC timestamp', (value) => {
    const date = typeof value === 'string' && ISO_UTC.test(value) ? new Date(value) : undefined;
    return date !== undefined && !Number.isNaN(date.getTime()) ? date : undefined;
  });
}

function json(row: PostgresRow, column: string): Json {
  // The column is jsonb, so its text is valid JSON and JSON.parse can only produce a Json value.
  return read(row, column, 'JSON text', (value) => (typeof value === 'string' ? (JSON.parse(value) as Json) : undefined));
}
