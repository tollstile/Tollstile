import { TollstileError } from './errors';
import { callProvider } from './provider-call';
import type { QuoteSigner } from './quote';
import { assertChargeTransition, isChargeTerminal, type ChargeStates, type FulfillmentState } from './states';
import type {
  Authorization,
  Balance,
  Charge,
  ChargePatch,
  Clock,
  Ledger,
  LookupResult,
  Operation,
  Rail,
  RefundResult,
  SettleResult,
  Settlement,
  TollstileEvent,
  TransitionResult,
} from './types';

export type Runtime = {
  readonly rails: readonly Rail[];
  readonly ledger: Ledger;
  readonly clock: Clock;
  readonly providerTimeoutMs: number;
  readonly quotes: QuoteSigner;
  /** Balances of policies that reserve value, by policy name. */
  readonly balances: Map<string, Balance>;
  emit(event: TollstileEvent): void;
};

/** What performs a charge's economic operations: a rail, or a policy's balance. */
export type Executor = {
  readonly name: string;
  /** Rails declare this; policy balances never refund because they settle only after fulfillment. */
  readonly capabilities?: { readonly refund: boolean };
  settle(authorization: Authorization, charge: Charge, operation: Operation): Promise<SettleResult>;
  refund(authorization: Authorization, charge: Charge, operation: Operation): Promise<RefundResult>;
  release(authorization: Authorization, charge: Charge, operation: Operation): Promise<void>;
  lookup(authorization: Authorization, charge: Charge, operation: Operation): Promise<LookupResult>;
};

export type Current = { readonly charge: Charge; readonly authorization: Authorization };

export async function tryMove(runtime: Runtime, charge: Charge, to: ChargeStates, patch?: ChargePatch): Promise<TransitionResult> {
  const from: ChargeStates = { payment: charge.payment, fulfillment: charge.fulfillment };
  assertChargeTransition(from, to);
  const result = await runtime.ledger.transitionCharge(charge.id, from, to, runtime.clock.now(), patch);
  if (result.status !== 'moved') return result;
  runtime.emit({ type: 'charge.moved', charge: result.charge, from });
  // A released single-use proof can be presented again, so its evidence is kept until money is final.
  if (!isChargeTerminal(from) && isChargeTerminal(to) && to.payment !== 'released') await redact(runtime, result.authorization);
  return result;
}

/** Drops rail data a finished single-use authorization no longer needs. Not atomic with the move: a crash leaves the data in place. */
async function redact(runtime: Runtime, authorization: Authorization): Promise<void> {
  if (authorization.kind !== 'single') return;
  const rail = runtime.rails.find((candidate) => candidate.name === authorization.rail);
  if (rail?.redact === undefined) return;
  await runtime.ledger.replaceAuthorizationData(authorization.id, rail.redact(authorization.data), runtime.clock.now());
}

/** For a live request, a conflict means another process changed the charge. Surface it. */
export async function move(runtime: Runtime, charge: Charge, to: ChargeStates, patch?: ChargePatch): Promise<Current> {
  const result = await tryMove(runtime, charge, to, patch);
  if (result.status === 'conflict') {
    const current = result.charge;
    throw new TollstileError(
      'TRANSITION_CONFLICT',
      `Charge ${charge.id} was expected to be ${charge.payment}/${charge.fulfillment} but is ${current === undefined ? 'missing' : `${current.payment}/${current.fulfillment}`}. Another process changed it; run reconcile() instead of retrying.`,
    );
  }
  return { charge: result.charge, authorization: result.authorization };
}

export type SettleOutcome =
  | ({ readonly status: 'settled' } & Current)
  | ({ readonly status: 'rejected' | 'unknown' } & Current);

/** Write-ahead: `settling` is recorded before the provider is called. */
export async function settleCharge(
  runtime: Runtime,
  executor: Executor,
  current: Current,
  fulfillment: FulfillmentState = current.charge.fulfillment,
): Promise<SettleOutcome> {
  const settling = await move(runtime, current.charge, { payment: 'settling', fulfillment }, { pending: 'settle' });
  const call = await callProvider(`${settling.charge.id}:settle`, runtime.providerTimeoutMs, (operation) =>
    executor.settle(settling.authorization, settling.charge, operation),
  );

  if (!call.ok) {
    const unknown = await move(runtime, settling.charge, { payment: 'unknown', fulfillment }, { pending: 'settle' });
    runtime.emit({ type: 'error', error: call.error, charge: unknown.charge });
    return { status: 'unknown', ...unknown };
  }

  if (call.value.status === 'rejected') {
    const failed = await move(runtime, settling.charge, { payment: 'failed', fulfillment }, { pending: null });
    runtime.emit({
      type: 'error',
      error: new TollstileError('SETTLEMENT_REJECTED', `"${executor.name}" rejected settlement: ${call.value.reason}.`),
      charge: failed.charge,
    });
    return { status: 'rejected', ...failed };
  }

  const settled = await move(
    runtime,
    settling.charge,
    { payment: 'settled', fulfillment },
    { pending: null, settlement: { reference: call.value.reference, details: call.value.details } },
  );
  return { status: 'settled', ...settled };
}

/** Records a payment that already moved during verification. */
export async function recordSettled(runtime: Runtime, current: Current, settlement: Settlement): Promise<Current> {
  const settling = await move(runtime, current.charge, { payment: 'settling', fulfillment: 'pending' }, { pending: 'settle' });
  return move(runtime, settling.charge, { payment: 'settled', fulfillment: 'running' }, { pending: null, settlement });
}

export async function refundCharge(
  runtime: Runtime,
  executor: Executor,
  current: Current,
  fulfillment: FulfillmentState = current.charge.fulfillment,
): Promise<void> {
  const pending = await move(runtime, current.charge, { payment: 'refund_pending', fulfillment }, { pending: 'refund' });
  await performRefund(runtime, executor, pending);
}

/** Runs the refund for a charge already in `refund_pending`. */
export async function performRefund(runtime: Runtime, executor: Executor, current: Current): Promise<void> {
  const { charge } = current;
  const call = await callProvider(`${charge.id}:refund`, runtime.providerTimeoutMs, (operation) =>
    executor.refund(current.authorization, charge, operation),
  );

  if (!call.ok) {
    const unknown = await move(runtime, charge, { payment: 'unknown', fulfillment: charge.fulfillment }, { pending: 'refund' });
    runtime.emit({ type: 'error', error: call.error, charge: unknown.charge });
    return;
  }

  if (call.value.status === 'rejected') {
    runtime.emit({
      type: 'error',
      error: new TollstileError(
        'REFUND_REJECTED',
        `"${executor.name}" rejected the refund for ${charge.id}: ${call.value.reason}. It stays refund_pending for reconciliation.`,
      ),
      charge,
    });
    return;
  }

  await move(
    runtime,
    charge,
    { payment: 'refunded', fulfillment: charge.fulfillment },
    { pending: null, refundReference: call.value.reference },
  );
}

/** Nothing moved, so the provider call is a courtesy; a failure is reported, not recorded. */
export async function releaseCharge(
  runtime: Runtime,
  executor: Executor,
  current: Current,
  fulfillment: FulfillmentState,
): Promise<void> {
  const released = await move(runtime, current.charge, { payment: 'released', fulfillment }, { pending: null });
  const call = await callProvider(`${released.charge.id}:release`, runtime.providerTimeoutMs, (operation) =>
    executor.release(released.authorization, released.charge, operation),
  );
  if (!call.ok) runtime.emit({ type: 'error', error: call.error, charge: released.charge });
}
