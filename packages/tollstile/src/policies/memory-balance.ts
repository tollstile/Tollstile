import { compare, parseMoney, type Money } from '../core/money';
import type { Balance } from '../core/types';

type Reservation = { readonly account: string; readonly amount: Money; state: 'reserved' | 'committed' | 'released' };

/** In-memory balances for tests and local development. Not shared across processes. */
export function memoryBalance(initial: Readonly<Record<string, string>> = {}): Balance & {
  available(account: string): Money | undefined;
} {
  const available = new Map(Object.entries(initial).map(([account, amount]) => [account, parseMoney(amount)]));
  const reservations = new Map<string, Reservation>();

  return {
    reserve(account, amount, key) {
      if (reservations.has(key)) return Promise.resolve('reserved');
      const current = available.get(account);
      if (current === undefined || current.currency !== amount.currency || compare(current, amount) < 0) {
        return Promise.resolve('insufficient');
      }
      available.set(account, { currency: current.currency, micros: current.micros - amount.micros });
      reservations.set(key, { account, amount, state: 'reserved' });
      return Promise.resolve('reserved');
    },
    commit(key) {
      const reservation = reservations.get(key);
      if (reservation?.state === 'reserved') reservation.state = 'committed';
      return Promise.resolve();
    },
    release(key) {
      const reservation = reservations.get(key);
      if (reservation?.state === 'reserved') {
        reservation.state = 'released';
        const current = available.get(reservation.account);
        if (current !== undefined) available.set(reservation.account, { currency: current.currency, micros: current.micros + reservation.amount.micros });
      }
      return Promise.resolve();
    },
    status: (key) => Promise.resolve(reservations.get(key)?.state ?? 'none'),
    available: (account) => available.get(account),
  };
}
