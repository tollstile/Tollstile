import { TollstileError } from './errors';
import type { Executor } from './lifecycle';
import type { Balance } from './types';

/** Performs a reservation policy's charges against its balance. */
export function policyExecutor(policy: string, balance: Balance): Executor {
  return {
    name: `policy:${policy}`,
    async settle(_authorization, charge) {
      await balance.commit(charge.id);
      return { status: 'settled', reference: charge.id, details: null };
    },
    refund() {
      return Promise.reject(
        new TollstileError('UNREACHABLE', `Policy "${policy}" charges settle after fulfillment and are never refunded.`),
      );
    },
    async release(_authorization, charge) {
      await balance.release(charge.id);
    },
    async lookup(_authorization, charge) {
      const status = await balance.status(charge.id);
      return status === 'committed' ? { status: 'settled', reference: charge.id, details: null } : { status: 'none' };
    },
  };
}
