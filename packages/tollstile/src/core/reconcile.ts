import { TollstileError } from './errors';
import {
  move,
  performRefund,
  refundCharge,
  releaseCharge,
  settleCharge,
  tryMove,
  type Current,
  type Executor,
  type Runtime,
} from './lifecycle';
import { policyExecutor } from './policy-executor';
import { callProvider } from './provider-call';
import { isChargeTerminal, type FulfillmentState } from './states';

export type ReconcileReport = {
  readonly examined: number;
  readonly resolved: number;
  readonly pending: number;
};

/**
 * Resolves charges left mid-lifecycle by crashes or unknown provider outcomes. Outcomes are
 * never guessed: the provider is asked, and when the service may not exist, nothing is kept.
 */
export async function reconcile(runtime: Runtime, olderThanMs: number): Promise<ReconcileReport> {
  const before = new Date(runtime.clock.now().getTime() - olderThanMs);
  const charges = await runtime.ledger.pendingCharges(before);
  let resolved = 0;

  for (const charge of charges) {
    const authorization = await runtime.ledger.getAuthorization(charge.authorizationId);
    const executor = authorization === undefined ? undefined : executorFor(runtime, authorization.rail);
    if (authorization === undefined || executor === undefined) {
      runtime.emit({
        type: 'error',
        error: new TollstileError(
          'RECONCILIATION_SKIPPED',
          authorization === undefined
            ? `Charge ${charge.id} references missing authorization ${charge.authorizationId}.`
            : `Charge ${charge.id} uses "${authorization.rail}", which is not configured. Add it back to reconcile the charge.`,
        ),
        charge,
      });
      continue;
    }

    await resolve(runtime, executor, { charge, authorization }).then(undefined, skipConflict);
    const current = await runtime.ledger.getCharge(charge.id);
    if (current !== undefined && isChargeTerminal(current)) resolved += 1;
  }

  return { examined: charges.length, resolved, pending: charges.length - resolved };
}

async function resolve(runtime: Runtime, executor: Executor, current: Current): Promise<void> {
  const { charge } = current;
  switch (charge.payment) {
    case 'reserved':
      if (charge.fulfillment !== 'completed' || charge.amount.micros === 0n) {
        await releaseCharge(runtime, executor, current, failedUnlessCompleted(charge.fulfillment));
        return;
      }
      await settleCharge(runtime, executor, current, 'completed');
      return;

    case 'settled':
      // Money moved, but the service was never confirmed to exist.
      if (executor.capabilities?.refund === false) {
        runtime.emit({
          type: 'error',
          error: new TollstileError(
            'RECONCILIATION_SKIPPED',
            `Charge ${charge.id} was paid but its fulfillment is ${charge.fulfillment}, and "${executor.name}" cannot refund. Refund the payer outside Tollstile.`,
          ),
          charge,
        });
        return;
      }
      await refundCharge(runtime, executor, current, 'failed');
      return;

    case 'refund_pending':
      await performRefund(runtime, executor, current);
      return;

    case 'settling': {
      const moved = await tryMove(runtime, charge, { payment: 'unknown', fulfillment: charge.fulfillment }, { pending: 'settle' });
      if (moved.status === 'moved') await resolveUnknown(runtime, executor, moved);
      return;
    }

    case 'unknown':
      await resolveUnknown(runtime, executor, current);
      return;

    case 'failed':
    case 'released':
    case 'refunded':
      return;
  }
}

async function resolveUnknown(runtime: Runtime, executor: Executor, current: Current): Promise<void> {
  const { charge, authorization } = current;
  const lookup = await callProvider(`${charge.id}:lookup`, runtime.providerTimeoutMs, (operation) =>
    executor.lookup(authorization, charge, operation),
  );
  if (!lookup.ok) {
    runtime.emit({ type: 'error', error: lookup.error, charge });
    return;
  }

  const result = lookup.value;
  const completed = charge.fulfillment === 'completed';
  switch (result.status) {
    case 'refunded':
      await move(runtime, charge, { payment: 'refunded', fulfillment: charge.fulfillment }, { pending: null, refundReference: result.reference });
      return;

    case 'settled': {
      const settlement = { reference: result.reference, details: result.details };
      if (charge.pending === 'refund' || !completed) {
        const pending = await move(
          runtime,
          charge,
          { payment: 'refund_pending', fulfillment: failedUnlessCompleted(charge.fulfillment) },
          { pending: 'refund', settlement },
        );
        await performRefund(runtime, executor, pending);
        return;
      }
      await move(runtime, charge, { payment: 'settled', fulfillment: charge.fulfillment }, { pending: null, settlement });
      return;
    }

    case 'none':
      if (charge.pending === 'refund') {
        const pending = await move(runtime, charge, { payment: 'refund_pending', fulfillment: charge.fulfillment }, { pending: 'refund' });
        await performRefund(runtime, executor, pending);
        return;
      }
      if (!completed) {
        await releaseCharge(runtime, executor, current, 'failed');
        return;
      }
      await settleCharge(runtime, executor, current, 'completed');
      return;
  }
}

/**
 * Another reconcile worker, or the live request itself, moved the charge first. Every provider effect
 * is preceded by a compare-and-set write, so the loser of that race has done nothing; it leaves the
 * charge to the winner instead of aborting the rest of the run.
 */
function skipConflict(error: unknown): void {
  // catch-reason: concurrent reconciliation is expected; only a transition conflict is recoverable here.
  if (error instanceof TollstileError && error.code === 'TRANSITION_CONFLICT') return;
  throw error;
}

function executorFor(runtime: Runtime, name: string): Executor | undefined {
  if (name.startsWith('policy:')) {
    const policy = name.slice('policy:'.length);
    const balance = runtime.balances.get(policy);
    return balance === undefined ? undefined : policyExecutor(policy, balance);
  }
  return runtime.rails.find((rail) => rail.name === name);
}

function failedUnlessCompleted(fulfillment: FulfillmentState): FulfillmentState {
  return fulfillment === 'completed' ? 'completed' : 'failed';
}
