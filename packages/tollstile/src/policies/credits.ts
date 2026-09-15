import type { AccessPolicy, Balance, Context } from '../core/types';

export type CreditsOptions = {
  readonly balance: Balance;
  /** The caller's credit account. Defaults to the authenticated principal's id. */
  readonly account?: (context: Context) => string | undefined | Promise<string | undefined>;
  /** Distinguishes several credit policies with different balances. Defaults to `"credits"`. */
  readonly name?: string;
};

/**
 * Pays from a prepaid balance. The price is reserved before the handler runs, committed when it
 * succeeds, and released when it fails — so a crash never loses or double-spends credits.
 */
export function credits(options: CreditsOptions): AccessPolicy {
  const resolveAccount = options.account ?? ((context: Context) => context.principal?.id);
  return {
    name: options.name ?? 'credits',
    balance: options.balance,
    async evaluate(context) {
      const account = await resolveAccount(context);
      return account === undefined ? { kind: 'skip' } : { kind: 'reserve', account };
    },
  };
}
