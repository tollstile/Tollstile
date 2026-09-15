import type { Money } from 'tollstile';
import { isRecord, type JsonRecord } from './sd-jwt';

// AP2 v0.2 Payment Mandates (docs/ap2/payment_mandate.md and the JSON Schemas under
// code/sdk/schemas/ap2): the closed mandate a verifier charges against, the open mandate the user
// approved, and the constraints that connect them.

export const CLOSED_VCT = 'mandate.payment.1';
export const OPEN_VCT = 'mandate.payment.open.1';

export type Merchant = { readonly id: string; readonly name?: string; readonly website?: string };

export type PaymentMandate = {
  readonly claims: JsonRecord;
  readonly payee: { readonly id: string; readonly name: string; readonly website: string | undefined };
  /** Integer minor units of `currency` (ISO 4217). */
  readonly amount: number;
  readonly currency: string;
  /** Milliseconds since the epoch; `undefined` means immediate execution. */
  readonly executionDate: number | undefined;
};

export type OpenPaymentMandate = {
  readonly claims: JsonRecord;
  readonly constraints: readonly JsonRecord[];
  readonly holderKey: unknown;
};

/** Claims of an open mandate that are about the mandate itself, not pre-set values of the closed one. */
const OPEN_ONLY_CLAIMS = new Set(['vct', 'constraints', 'cnf', 'iat', 'exp', 'nbf']);

/** ISO 4217 minor-unit exponents other than 2. */
const MINOR_UNIT_EXPONENTS: Readonly<Record<string, number>> = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0, RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  CLF: 4, UYW: 4,
};

const ISO_8601 = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

export function readClosedMandate(claims: JsonRecord): PaymentMandate | string {
  if (claims.vct !== CLOSED_VCT) return 'vct_mismatch';
  if ('cnf' in claims) return 'closed_mandate_has_cnf';
  const { payee, payment_amount: amount, payment_instrument: instrument } = claims;
  if (typeof claims.transaction_id !== 'string') return 'transaction_id_missing';
  if (!isRecord(instrument) || typeof instrument.id !== 'string' || typeof instrument.type !== 'string') return 'payment_instrument_invalid';
  if (!isRecord(payee) || typeof payee.id !== 'string' || typeof payee.name !== 'string' || !optionalString(payee.website)) return 'payee_invalid';
  if (!isRecord(amount) || !Number.isSafeInteger(amount.amount) || typeof amount.currency !== 'string' || !/^[A-Z]{3}$/.test(amount.currency)) {
    return 'payment_amount_invalid';
  }
  const minor = amount.amount as number;
  if (minor < 0) return 'payment_amount_invalid';

  const executionDate = claims.execution_date === undefined ? undefined : isoDate(claims.execution_date);
  if (executionDate === null) return 'execution_date_invalid';
  return {
    claims,
    payee: { id: payee.id, name: payee.name, website: payee.website },
    amount: minor,
    currency: amount.currency,
    executionDate,
  };
}

export function readOpenMandate(claims: JsonRecord): OpenPaymentMandate | string {
  if (claims.vct !== OPEN_VCT) return 'vct_mismatch';
  const { constraints, cnf } = claims;
  if (!Array.isArray(constraints) || !constraints.every(isRecord)) return 'constraints_invalid';
  if (!isRecord(cnf) || !isRecord(cnf.jwk)) return 'cnf_missing';
  return { claims, constraints, holderKey: cnf.jwk };
}

/**
 * Checks the closed mandate against what the user approved: every pre-set value must be equal, and
 * every constraint must be understood and satisfied. Unknown constraints fail (AP2 §Constraints).
 */
export function satisfiesOpenMandate(closed: PaymentMandate, open: OpenPaymentMandate, now: Date): string | undefined {
  for (const [name, value] of Object.entries(open.claims)) {
    if (!OPEN_ONLY_CLAIMS.has(name) && !deepEqual(value, closed.claims[name])) return `preset_mismatch:${name}`;
  }
  for (const constraint of open.constraints) {
    const violation = evaluateConstraint(constraint, closed, now);
    if (violation !== undefined) return violation;
  }
  return undefined;
}

/** The mandate's amount covers `price` in the same currency. Sub-unit prices need a whole minor unit. */
export function coversPrice(mandate: PaymentMandate, price: Money): boolean {
  if (mandate.currency !== price.currency) return false;
  const exponent = MINOR_UNIT_EXPONENTS[mandate.currency] ?? 2;
  return BigInt(mandate.amount) * 10n ** BigInt(6 - exponent) >= price.micros;
}

export function matchesMerchant(payee: PaymentMandate['payee'], merchant: Merchant): boolean {
  return (
    payee.id === merchant.id &&
    (merchant.name === undefined || merchant.name === payee.name) &&
    (merchant.website === undefined || merchant.website === payee.website)
  );
}

function evaluateConstraint(constraint: JsonRecord, closed: PaymentMandate, now: Date): string | undefined {
  switch (constraint.type) {
    case 'payment.amount_range': {
      const { currency, max, min } = constraint;
      if (typeof currency !== 'string' || !Number.isSafeInteger(max) || !(min === undefined || Number.isSafeInteger(min))) {
        return 'constraint_invalid:payment.amount_range';
      }
      if (closed.currency !== currency) return 'constraint_failed:payment.amount_range';
      if (closed.amount > (max as number) || (min !== undefined && closed.amount < (min as number))) {
        return 'constraint_failed:payment.amount_range';
      }
      return undefined;
    }
    case 'payment.allowed_payees': {
      const { allowed } = constraint;
      if (!Array.isArray(allowed)) return 'constraint_invalid:payment.allowed_payees';
      return allowed.some((candidate) => isRecord(candidate) && samePayee(candidate, closed.payee))
        ? undefined
        : 'constraint_failed:payment.allowed_payees';
    }
    case 'payment.execution_date': {
      const notBefore = constraint.not_before === undefined ? undefined : isoDate(constraint.not_before);
      const notAfter = constraint.not_after === undefined ? undefined : isoDate(constraint.not_after);
      if (notBefore === null || notAfter === null) return 'constraint_invalid:payment.execution_date';
      // A mandate without execution_date executes now, so now must be inside the window.
      const execution = closed.executionDate ?? now.getTime();
      if ((notBefore !== undefined && execution < notBefore) || (notAfter !== undefined && execution > notAfter)) {
        return 'constraint_failed:payment.execution_date';
      }
      return undefined;
    }
    default:
      return `unsupported_constraint:${typeof constraint.type === 'string' ? constraint.type : 'unknown'}`;
  }
}

/** AP2 SDK `merchant_matches`: by `id` when both carry one, otherwise by non-empty `name` and `website`. */
function samePayee(candidate: JsonRecord, payee: PaymentMandate['payee']): boolean {
  if (typeof candidate.id === 'string' && candidate.id !== '') return candidate.id === payee.id;
  return (
    typeof candidate.name === 'string' &&
    candidate.name !== '' &&
    candidate.name === payee.name &&
    typeof candidate.website === 'string' &&
    candidate.website !== '' &&
    candidate.website === payee.website
  );
}

/** Milliseconds for an ISO 8601 date or date-time; `null` when it is not one. */
function isoDate(value: unknown): number | null {
  if (typeof value !== 'string' || !ISO_8601.test(value)) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  if (isRecord(a)) {
    if (!isRecord(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
  }
  return a === b;
}
