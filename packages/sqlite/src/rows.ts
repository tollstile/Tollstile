import { TollstileError, type Authorization, type Charge, type Json, type Money } from 'tollstile';
import { authorizationKinds, flows, fulfillmentStates, paymentStates, pendingOperations } from './states';

export type SqliteRow = Readonly<Record<string, unknown>>;

const MAX_INTEGER = 9_223_372_036_854_775_807n;
const DIGITS = /^(0|[1-9]\d*)$/;

// Money is read as TEXT: drivers return INTEGER as a number (losing precision past 2^53), a bigint,
// or throw, depending on the driver and its settings. Every driver returns TEXT the same way.
export const AUTHORIZATION_COLUMNS = `id, rail, payer, kind,
  limit_currency, CAST(limit_micros AS TEXT) AS limit_micros,
  consumed_currency, CAST(consumed_micros AS TEXT) AS consumed_micros,
  reserved_currency, CAST(reserved_micros AS TEXT) AS reserved_micros,
  quote_id, expires_at, data, created_at, updated_at`;

export const CHARGE_COLUMNS = `id, authorization_id, request_id, resource, payer, flow, currency,
  CAST(reserved_micros AS TEXT) AS reserved_micros, CAST(amount_micros AS TEXT) AS amount_micros,
  payment, fulfillment, pending, settlement_reference, settlement_details, refund_reference, request_hash, result_ref, created_at, updated_at`;

export function parseAuthorization(row: SqliteRow): Authorization {
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

export function parseCharge(row: SqliteRow): Charge {
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

export function parseSpend(row: SqliteRow): { readonly count: number; readonly total: Money } {
  return { count: safeInteger(row, 'count'), total: { currency: text(row, 'currency'), micros: micros(row, 'total') } };
}

export function parseStatus<T extends string>(row: SqliteRow | undefined, values: readonly T[]): T {
  if (row === undefined) throw inconsistent('A status query returned no row. Check that transaction() resolves with the rows of every statement, in order.');
  return oneOf(row, 'status', values);
}

export function isStorable(amount: Money): boolean {
  return amount.micros >= 0n && amount.micros <= MAX_INTEGER;
}

export function unstorable(amount: Money): TollstileError {
  return new TollstileError(
    'INVALID_AMOUNT',
    `Amount of ${amount.micros.toString()} ${amount.currency} micros cannot be stored: the ledger holds 0 to ${MAX_INTEGER.toString()} micros.`,
  );
}

/** Money is bound as decimal text and cast to INTEGER in SQL, so no driver converts it through a float. */
export function microsParam(amount: Money): string {
  if (!isStorable(amount)) throw unstorable(amount);
  return amount.micros.toString();
}

export function inconsistent(message: string): TollstileError {
  return new TollstileError('LEDGER_INCONSISTENT', message);
}

function read<T>(row: SqliteRow, column: string, expected: string, parse: (value: unknown) => T | undefined): T {
  const value = parse(row[column]);
  if (value === undefined) {
    throw inconsistent(
      `Ledger column "${column}" is not ${expected}. Check that the tables were created from sqliteSchema and that execute() resolves rows as objects keyed by column name.`,
    );
  }
  return value;
}

function text(row: SqliteRow, column: string): string {
  return read(row, column, 'TEXT', (value) => (typeof value === 'string' ? value : undefined));
}

function nullable<T>(row: SqliteRow, column: string, parse: (row: SqliteRow, column: string) => T): T | null {
  return row[column] === null ? null : parse(row, column);
}

function oneOf<T extends string>(row: SqliteRow, column: string, values: readonly T[]): T {
  return read(row, column, `one of ${values.join(', ')}`, (value) => values.find((candidate) => candidate === value));
}

function micros(row: SqliteRow, column: string): bigint {
  return read(row, column, 'an INTEGER from 0 to 2^63 - 1 read as TEXT', (value) =>
    typeof value === 'string' && DIGITS.test(value) && BigInt(value) <= MAX_INTEGER ? BigInt(value) : undefined,
  );
}

/** Drivers return INTEGER as a number or a bigint. A number beyond 2^53 may already be rounded, so it is refused. */
function safeInteger(row: SqliteRow, column: string): number {
  return read(row, column, 'a safe integer', (value) => {
    if (typeof value === 'number') return Number.isSafeInteger(value) ? value : undefined;
    if (typeof value === 'bigint') return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
    return undefined;
  });
}

function timestamp(row: SqliteRow, column: string): Date {
  const date = new Date(safeInteger(row, column));
  return read(row, column, 'milliseconds since the Unix epoch', () => (Number.isNaN(date.getTime()) ? undefined : date));
}

function json(row: SqliteRow, column: string): Json {
  // The column is checked with json_valid, so JSON.parse can only produce a Json value.
  return read(row, column, 'JSON text', (value) => (typeof value === 'string' ? (JSON.parse(value) as Json) : undefined));
}
