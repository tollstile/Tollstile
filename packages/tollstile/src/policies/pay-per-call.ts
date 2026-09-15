import type { AccessPolicy } from '../core/types';

/** Requires a payment on one of the configured rails. */
export function payPerCall(): AccessPolicy {
  return {
    name: 'payPerCall',
    evaluate: () => Promise.resolve({ kind: 'pay' }),
  };
}
