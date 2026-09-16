import type { Header, JsonObject } from './types';

/** Stable, core-owned reasons a request was not admitted. Clients branch on these; see SPEC.md §12. */
export type DenialCode =
  | 'payment_required'
  | 'quote_required'
  | 'quote_invalid'
  | 'quote_mismatch'
  | 'quote_offer_missing'
  | 'proof_invalid'
  | 'insufficient_authorization'
  | 'authorization_expired'
  | 'payment_rejected'
  | 'settlement_rejected'
  | 'requirement_failed'
  | 'access_denied'
  | 'proof_already_used'
  | 'request_in_progress'
  | 'already_paid'
  | 'idempotency_key_reused'
  | 'invalid_request'
  | 'payment_unavailable'
  | 'payment_outcome_unknown'
  | 'requirement_unavailable';

/**
 * What the client should do next.
 * - `pay`: pay using `accepts` in this response.
 * - `retry_later`: send the same request, with the same proof and idempotency key, after `Retry-After`.
 * - `fix_request`: change the request.
 * - `stop`: do not retry.
 */
export type DenialAction = 'pay' | 'retry_later' | 'fix_request' | 'stop';

export type DenialError = {
  readonly code: DenialCode;
  readonly retryable: boolean;
  readonly action: DenialAction;
  /** For humans. May change between versions. */
  readonly message: string;
  /** The rail's or requirement's own reason, e.g. `transfer_mismatch`. Not for branching. */
  readonly detail: string | null;
};

type Behavior = { readonly status: number; readonly action: DenialAction };

const PAY: Behavior = { status: 402, action: 'pay' };
const LATER: Behavior = { status: 503, action: 'retry_later' };

const BEHAVIOR = {
  payment_required: PAY,
  quote_required: PAY,
  quote_invalid: PAY,
  quote_mismatch: PAY,
  quote_offer_missing: PAY,
  proof_invalid: PAY,
  insufficient_authorization: PAY,
  authorization_expired: PAY,
  payment_rejected: PAY,
  settlement_rejected: PAY,
  requirement_failed: { status: 403, action: 'stop' },
  access_denied: { status: 403, action: 'stop' },
  proof_already_used: { status: 409, action: 'stop' },
  request_in_progress: { status: 409, action: 'retry_later' },
  already_paid: { status: 409, action: 'stop' },
  idempotency_key_reused: { status: 422, action: 'fix_request' },
  invalid_request: { status: 400, action: 'fix_request' },
  payment_unavailable: LATER,
  payment_outcome_unknown: LATER,
  requirement_unavailable: LATER,
} as const satisfies Record<DenialCode, Behavior>;

/**
 * Seconds a client waits before retrying a `retry_later` denial, on average. The value sent is
 * spread around it: clients denied at the same instant would otherwise all return at the same one.
 */
export const RETRY_AFTER_SECONDS = 5;

/** Half the width of that spread, so a wait is `RETRY_AFTER_SECONDS` ± this. */
const RETRY_AFTER_SPREAD = 2;

/** The wait for one denial. Both the `Retry-After` header and the body carry this same number. */
export function retryAfterSeconds(): number {
  const range = RETRY_AFTER_SPREAD * 2 + 1;
  const [byte = 0] = crypto.getRandomValues(new Uint8Array(1));
  return RETRY_AFTER_SECONDS - RETRY_AFTER_SPREAD + (byte % range);
}

export function statusFor(code: DenialCode): number {
  return BEHAVIOR[code].status;
}

/** A requirement chooses its own status; its action follows from it. */
export function actionFor(code: DenialCode, status: number): DenialAction {
  if (code !== 'requirement_failed') return BEHAVIOR[code].action;
  if (status === 402) return 'pay';
  if (status === 429 || status === 503) return 'retry_later';
  return 'stop';
}

export function denialError(code: DenialCode, status: number, message: string, detail: string | null = null): DenialError {
  const action = actionFor(code, status);
  return { code, retryable: action !== 'stop' && action !== 'fix_request', action, message, detail };
}

export function denialHeaders(error: DenialError, retryAfter: number | null): readonly Header[] {
  const headers: Header[] = [['cache-control', 'no-store']];
  if (retryAfter !== null && error.action === 'retry_later') headers.push(['retry-after', String(retryAfter)]);
  return headers;
}

export function errorJson(error: DenialError): JsonObject {
  return { code: error.code, retryable: error.retryable, action: error.action, message: error.message, detail: error.detail };
}
