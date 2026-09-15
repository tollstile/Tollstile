import { TollstileError } from './errors';

/** The order in which a charge's payment and fulfillment advance. */
export type Flow = 'authorization' | 'upfront' | 'escrow';

export type PaymentState =
  | 'reserved'
  | 'settling'
  | 'settled'
  | 'failed'
  | 'unknown'
  | 'released'
  | 'refund_pending'
  | 'refunded';

export type FulfillmentState = 'pending' | 'running' | 'completed' | 'failed';

export type PendingOperation = 'settle' | 'refund';

export type ChargeStates = {
  readonly payment: PaymentState;
  readonly fulfillment: FulfillmentState;
};

/**
 * authorization: reserved·running → reserved·completed → settling → settled   (handler fails: released)
 * upfront:       reserved·pending → settling → settled·running → settled·completed   (handler fails: refund)
 */
export const paymentTransitions = {
  reserved: ['settling', 'released'],
  settling: ['settled', 'failed', 'unknown'],
  settled: ['refund_pending'],
  unknown: ['settled', 'settling', 'failed', 'released', 'refund_pending', 'refunded'],
  refund_pending: ['refunded', 'unknown'],
  failed: [],
  released: [],
  refunded: [],
} as const satisfies Record<PaymentState, readonly PaymentState[]>;

export const fulfillmentTransitions = {
  pending: ['running', 'failed'],
  running: ['completed', 'failed'],
  completed: [],
  failed: [],
} as const satisfies Record<FulfillmentState, readonly FulfillmentState[]>;

export function assertChargeTransition(from: ChargeStates, to: ChargeStates): void {
  if (from.payment !== to.payment && !(paymentTransitions[from.payment] as readonly PaymentState[]).includes(to.payment)) {
    throw invalid('payment', from.payment, to.payment, paymentTransitions[from.payment]);
  }
  if (
    from.fulfillment !== to.fulfillment &&
    !(fulfillmentTransitions[from.fulfillment] as readonly FulfillmentState[]).includes(to.fulfillment)
  ) {
    throw invalid('fulfillment', from.fulfillment, to.fulfillment, fulfillmentTransitions[from.fulfillment]);
  }
}

/** A charge needs no further work when its money is final and, if money moved, the service was delivered. */
export function isChargeTerminal(states: ChargeStates): boolean {
  switch (states.payment) {
    case 'failed':
    case 'released':
    case 'refunded':
      return true;
    case 'settled':
      return states.fulfillment === 'completed';
    case 'reserved':
    case 'settling':
    case 'unknown':
    case 'refund_pending':
      return false;
  }
}

/** Whether a charge's amount counts as reserved, committed, or neither on its authorization. */
export function accountingClass(payment: PaymentState, pending: PendingOperation | null): 'reserved' | 'committed' | 'none' {
  switch (payment) {
    case 'reserved':
    case 'settling':
      return 'reserved';
    case 'settled':
    case 'refund_pending':
      return 'committed';
    case 'unknown':
      return pending === 'refund' ? 'committed' : 'reserved';
    case 'failed':
    case 'released':
    case 'refunded':
      return 'none';
  }
}

function invalid(axis: string, from: string, to: string, allowed: readonly string[]): TollstileError {
  return new TollstileError(
    'INVALID_TRANSITION',
    `Charge ${axis} cannot move from "${from}" to "${to}". Allowed from "${from}": ${allowed.join(', ') || 'none'}.`,
  );
}
