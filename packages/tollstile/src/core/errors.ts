export type TollstileErrorCode =
  | 'CONFIG_INVALID'
  | 'CAPABILITY_MISSING'
  | 'CURRENCY_MISMATCH'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_TIMEOUT'
  | 'INVALID_TRANSITION'
  | 'TRANSITION_CONFLICT'
  | 'ALREADY_COMPLETED'
  | 'INVALID_AMOUNT'
  | 'FULFILLMENT_MISSING'
  | 'SETTLEMENT_REJECTED'
  | 'REFUND_REJECTED'
  | 'RECONCILIATION_SKIPPED'
  | 'LEDGER_INCONSISTENT'
  | 'UNREACHABLE';

/** The only error type Tollstile throws. `code` is part of the public API. */
export class TollstileError extends Error {
  override readonly name = 'TollstileError';
  readonly code: TollstileErrorCode;

  constructor(code: TollstileErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

export function isProviderFailure(error: unknown): error is TollstileError {
  return (
    error instanceof TollstileError &&
    (error.code === 'PROVIDER_UNAVAILABLE' || error.code === 'PROVIDER_TIMEOUT')
  );
}
