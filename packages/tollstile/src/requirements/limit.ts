import { TollstileError } from '../core/errors';
import { formatMoney, parseMoney } from '../core/money';
import type { Requirement } from '../core/types';

type Window = 'minute' | 'hour' | 'day';

const WINDOW_MS: Record<Window, number> = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };

export type LimitOptions = {
  /** Maximum payments per payer in a rolling window, e.g. `"100/hour"`. */
  readonly perPayer?: `${number}/${Window}`;
  /** Maximum spend per payer in a rolling day, e.g. `"$20"`. */
  readonly spendPerDay?: string;
};

/**
 * Caps how often and how much one payer can spend. Counts come from the ledger, so concurrent
 * requests from the same payer can briefly exceed the limit by the number in flight.
 */
export function limit(options: LimitOptions): Requirement {
  const rate = options.perPayer === undefined ? undefined : parseRate(options.perPayer);
  const cap = options.spendPerDay === undefined ? undefined : parseMoney(options.spendPerDay);
  if (rate === undefined && cap === undefined) {
    throw new TollstileError('CONFIG_INVALID', 'limit() needs perPayer, spendPerDay, or both.');
  }

  return {
    name: 'limit',
    async check({ payer, price, ledger, now }) {
      if (rate !== undefined) {
        const { count } = await ledger.spendSince(payer, new Date(now.getTime() - rate.windowMs));
        if (count >= rate.max) {
          return { ok: false, status: 429, reason: `More than ${rate.max} payments per ${rate.window} from this payer.` };
        }
      }
      if (cap !== undefined) {
        const { total } = await ledger.spendSince(payer, new Date(now.getTime() - WINDOW_MS.day));
        const spent = total.find((amount) => amount.currency === cap.currency)?.micros ?? 0n;
        if (price.currency === cap.currency && spent + price.micros > cap.micros) {
          return { ok: false, status: 429, reason: `This payment would exceed the ${formatMoney(cap)} daily spend limit.` };
        }
      }
      return { ok: true };
    },
  };
}

function parseRate(input: string): { readonly max: number; readonly window: Window; readonly windowMs: number } {
  const match = /^(\d+)\/(minute|hour|day)$/.exec(input);
  const max = Number(match?.[1]);
  const window = match?.[2];
  if (window !== 'minute' && window !== 'hour' && window !== 'day') {
    throw new TollstileError('CONFIG_INVALID', `Invalid rate "${input}": use "<count>/minute", "/hour", or "/day".`);
  }
  if (!Number.isSafeInteger(max) || max < 1) {
    throw new TollstileError('CONFIG_INVALID', `Invalid rate "${input}": the count must be a positive integer.`);
  }
  return { max, window, windowMs: WINDOW_MS[window] };
}
