import { TollstileError } from '../core/errors';
import type { Requirement } from '../core/types';

export type PayersOptions = {
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
};

/** Allows or denies specific payers — wallet addresses, accounts, or other rail payer ids. */
export function payers(options: PayersOptions): Requirement {
  if (options.allow === undefined && options.deny === undefined) {
    throw new TollstileError('CONFIG_INVALID', 'payers() needs allow, deny, or both.');
  }
  const allow = options.allow === undefined ? undefined : new Set(options.allow.map(normalize));
  const deny = new Set((options.deny ?? []).map(normalize));

  return {
    name: 'payers',
    check({ payer }) {
      const id = normalize(payer);
      if (deny.has(id)) return Promise.resolve({ ok: false, status: 403, reason: 'This payer is not allowed.' });
      if (allow !== undefined && !allow.has(id)) {
        return Promise.resolve({ ok: false, status: 403, reason: 'This payer is not on the allow list.' });
      }
      return Promise.resolve({ ok: true });
    },
  };
}

/**
 * Rails return canonical payer ids (SPEC.md §6); lists are still compared case-insensitively, so a
 * deny list written with different casing than a rail reports never misses a payer.
 */
function normalize(payer: string): string {
  return payer.trim().toLowerCase();
}
