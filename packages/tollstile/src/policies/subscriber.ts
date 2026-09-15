import type { AccessPolicy, Context, Principal } from '../core/types';

export type SubscriberOptions = {
  /** Whether the authenticated caller has an active subscription. Callers without a principal are skipped. */
  readonly active: (principal: Principal, context: Context) => boolean | Promise<boolean>;
};

/** Lets active subscribers through without paying. */
export function subscriber(options: SubscriberOptions): AccessPolicy {
  return {
    name: 'subscriber',
    async evaluate(context) {
      const { principal } = context;
      if (principal === null || !(await options.active(principal, context))) return { kind: 'skip' };
      return { kind: 'grant', account: principal.id };
    },
  };
}
