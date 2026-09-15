import { assertRailServesRoute } from './capabilities';
import { TollstileError } from './errors';
import { createGate, parsePriceInput, type Route } from './gate';
import type { Runtime } from './lifecycle';
import { createQuoteSigner } from './quote';
import { reconcile, type ReconcileReport } from './reconcile';
import type { Balance, DynamicPrice, Gate, PriceInput, PriceOptions, Rail, TollstileConfig, UpTo } from './types';

const DEFAULT_PROVIDER_TIMEOUT_MS = 10_000;
const DEFAULT_QUOTE_TTL_MS = 5 * 60_000;
/** Must exceed your slowest handler, or reconciliation can act on a request that is still running. */
const DEFAULT_RECONCILE_AFTER_MS = 15 * 60_000;
const MIN_SECRET_LENGTH = 32;

export type Tollstile<Rails extends readonly Rail[]> = {
  /** Validates the route against every rail. Call it where routes are defined. */
  price(price: PriceInput | DynamicPrice, options?: PriceOptions): Gate<Rails>;
  /** Resolves charges left mid-lifecycle. Run it on a schedule. */
  reconcile(options?: { readonly olderThanMs?: number }): Promise<ReconcileReport>;
};

export function createTollstile<const Rails extends readonly Rail[]>(config: TollstileConfig<Rails>): Tollstile<Rails> {
  validateRails(config.rails);
  const clock = config.clock ?? { now: () => new Date() };
  const providerTimeoutMs = positiveInteger(config.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS, 'providerTimeoutMs');
  const quoteTtlMs = positiveInteger(config.quoteTtlMs ?? DEFAULT_QUOTE_TTL_MS, 'quoteTtlMs');
  const balances = new Map<string, Balance>();

  const runtime: Runtime = {
    rails: config.rails,
    ledger: config.ledger,
    clock,
    providerTimeoutMs,
    quotes: createQuoteSigner(secretsFor(config), quoteTtlMs, clock),
    balances,
    emit: (event) => config.onEvent?.(event),
  };

  return {
    price(price, options = {}) {
      const fixed = typeof price === 'function' ? undefined : parsePriceInput(price, options.resource ?? describe(price));
      const name = options.resource ?? (typeof price === 'function' ? 'dynamic price' : describe(price));

      for (const rail of config.rails) {
        assertRailServesRoute(rail, { name, flow: options.flow, variable: fixed?.variable, dynamic: fixed === undefined });
      }
      for (const policy of options.access ?? []) registerBalance(balances, policy.name, policy.balance);

      const route: Route = {
        name,
        resource: options.resource,
        price: typeof price === 'function' ? { kind: 'dynamic', compute: price } : { kind: 'fixed', ...parsePriceInput(price, name) },
        access: options.access,
        requirements: options.require ?? [],
        flow: options.flow,
        commit: options.commit ?? (typeof price === 'function' ? 'request' : 'route'),
      };
      return createGate<Rails>(runtime, route);
    },

    reconcile(options = {}) {
      return reconcile(runtime, options.olderThanMs ?? DEFAULT_RECONCILE_AFTER_MS);
    },
  };
}

/** A variable price. The payer authorizes `amount`; the handler settles what it used with `payment.fulfill({ amount })`. */
export function upTo(amount: string): UpTo {
  return { kind: 'up-to', amount };
}

function registerBalance(balances: Map<string, Balance>, policy: string, balance: Balance | undefined): void {
  if (balance === undefined) return;
  const registered = balances.get(policy);
  if (registered !== undefined && registered !== balance) {
    throw new TollstileError(
      'CONFIG_INVALID',
      `Two different balances are registered for policy "${policy}". Give each balance its own policy name.`,
    );
  }
  balances.set(policy, balance);
}

function validateRails(rails: readonly Rail[]): void {
  if (rails.length === 0) {
    throw new TollstileError('CONFIG_INVALID', 'createTollstile() needs at least one rail, e.g. rails: [testRail()].');
  }
  const names = rails.map((rail) => rail.name);
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate !== undefined) {
    throw new TollstileError('CONFIG_INVALID', `Rail "${duplicate}" is configured twice. Each rail name must be unique.`);
  }
  if (names.some((name) => name.startsWith('policy:'))) {
    throw new TollstileError('CONFIG_INVALID', 'Rail names starting with "policy:" are reserved for access policies.');
  }
  const live = rails.filter((rail) => rail.livemode).map((rail) => rail.name);
  const test = rails.filter((rail) => !rail.livemode).map((rail) => rail.name);
  if (live.length > 0 && test.length > 0) {
    throw new TollstileError(
      'CONFIG_INVALID',
      `Test rails (${test.join(', ')}) cannot run alongside live rails (${live.join(', ')}). Use separate instances per environment.`,
    );
  }
}

function secretsFor<Rails extends readonly Rail[]>(config: TollstileConfig<Rails>): readonly string[] | 'ephemeral' {
  const secrets = config.secret === undefined ? [] : typeof config.secret === 'string' ? [config.secret] : config.secret;
  if (secrets.length === 0) {
    if (config.rails.some((rail) => rail.livemode)) {
      throw new TollstileError('CONFIG_INVALID', 'Live rails need `secret` to sign quotes. Use at least 32 random characters from your secret store.');
    }
    return 'ephemeral';
  }
  if (secrets.some((secret) => secret.length < MIN_SECRET_LENGTH)) {
    throw new TollstileError('CONFIG_INVALID', `Quote secrets must be at least ${String(MIN_SECRET_LENGTH)} characters.`);
  }
  return secrets;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TollstileError('CONFIG_INVALID', `${name} must be a positive integer, got ${String(value)}.`);
  }
  return value;
}

function describe(price: PriceInput): string {
  return typeof price === 'string' ? price : `upTo("${price.amount}")`;
}
