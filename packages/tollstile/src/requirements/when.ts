import { compare, parseMoney } from '../core/money';
import type { Requirement, RequirementInput } from '../core/types';

export type Condition = (input: RequirementInput) => boolean;

/** Applies `requirement` only when `condition` holds. */
export function when(condition: Condition, requirement: Requirement): Requirement {
  return {
    name: requirement.name,
    check: (input) => (condition(input) ? requirement.check(input) : Promise.resolve({ ok: true })),
  };
}

/** True when the price is strictly greater than `amount` in the same currency. */
export function amountOver(amount: string): Condition {
  const threshold = parseMoney(amount);
  return ({ price }) => price.currency === threshold.currency && compare(price, threshold) > 0;
}
