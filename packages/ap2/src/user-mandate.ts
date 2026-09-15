import { TollstileError, type Context, type JsonObject, type Requirement, type RequirementResult } from 'tollstile';
import { verifyMandateChain } from './mandate-chain';
import { coversPrice, matchesMerchant, satisfiesOpenMandate, type Merchant } from './payment-mandate';

export type UserMandateOptions = {
  /**
   * The public P-256 JWK that signs root mandates with this protected header (e.g. by `kid`), or
   * `undefined` when the issuer is not trusted. Trust in user credentials or agent providers is yours.
   */
  readonly resolveKey: (header: JsonObject) => Promise<JsonWebKey | undefined>;
  /** This merchant as it must appear as `payee` in the closed mandate. `id` is compared; `name` and `website` too when given. */
  readonly payee: Merchant;
  /** Accepted `aud` values of the agent's key-binding JWT, e.g. your origin. */
  readonly audience: string | readonly string[];
  /** HTTP request header carrying the mandate chain. Defaults to `AP2-Mandate`. */
  readonly header?: string;
  /** MCP `_meta` key carrying the mandate chain. Defaults to `ap2/mandate`. */
  readonly metaKey?: string;
  /** Oldest key-binding `iat` accepted, in milliseconds. Defaults to 5 minutes. */
  readonly maxAgeMs?: number;
  /** Tolerated clock difference with issuers and agents, in milliseconds. Defaults to 30 seconds. */
  readonly clockSkewMs?: number;
};

const CLAIM_SCOPE = 'ap2-mandate';
const MAX_MANDATE_BYTES = 16 * 1024;

/**
 * **Experimental.** Admits only requests carrying an AP2 v0.2 Payment Mandate chain (an open mandate
 * the user approved, and a closed mandate the agent signed with the key the user delegated) that
 * authorizes paying this merchant at least the price. When the payment carried a Tollstile quote,
 * the agent's key-binding `nonce` must be the quote's nonce. Each mandate is accepted once.
 * Denies with 402 `mandate_required` or `mandate_invalid:<detail>`.
 *
 * @example
 * ```ts
 * import { userMandate } from "@tollstile/ap2";
 *
 * toll.price("$5.00", {
 *   require: [userMandate({
 *     resolveKey: async ({ kid }) => trustedIssuers.get(String(kid)),
 *     payee: { id: "merchant_1" },
 *     audience: "https://api.example",
 *   })],
 * });
 * ```
 */
export function userMandate(options: UserMandateOptions): Requirement {
  const header = options.header ?? 'AP2-Mandate';
  const metaKey = options.metaKey ?? 'ap2/mandate';
  const audience = new Set(typeof options.audience === 'string' ? [options.audience] : options.audience);
  const maxAgeMs = duration('maxAgeMs', options.maxAgeMs, 300_000);
  const clockSkewMs = duration('clockSkewMs', options.clockSkewMs, 30_000);
  if (audience.size === 0 || [...audience].some((value) => value === '')) {
    throw new TollstileError('CONFIG_INVALID', 'userMandate() needs at least one non-empty audience.');
  }
  if (options.payee.id === '') {
    throw new TollstileError('CONFIG_INVALID', 'userMandate() payee.id must be the merchant id agents put in mandates.');
  }

  return {
    name: 'user-mandate',
    async check({ context, price, quote, claims, now }) {
      const presented = readMandate(context, header, metaKey);
      if (presented === undefined) return deny('mandate_required');
      if (presented.length > MAX_MANDATE_BYTES) return invalid('too_large');

      const chain = await verifyMandateChain(presented, { resolveKey: options.resolveKey, now, clockSkewMs });
      if (typeof chain === 'string') return invalid(chain);

      const { binding, closed } = chain;
      if (!audience.has(binding.aud)) return invalid('audience_mismatch');
      // The quote's nonce is the verifier nonce AP2 expects; it ties the mandate to the offer this payment answers.
      if (quote !== null && binding.nonce !== quote.nonce) return invalid('nonce_mismatch');
      const nowSeconds = now.getTime() / 1000;
      if (nowSeconds - binding.iat > (maxAgeMs + clockSkewMs) / 1000) return invalid('stale');

      const unmet = satisfiesOpenMandate(closed, chain.open, now);
      if (unmet !== undefined) return invalid(unmet);
      if (closed.executionDate !== undefined && closed.executionDate > now.getTime() + clockSkewMs) return invalid('execution_date_future');
      if (!matchesMerchant(closed.payee, options.payee)) return invalid('payee_mismatch');
      if (!coversPrice(closed, price)) return invalid(closed.currency === price.currency ? 'amount_insufficient' : 'currency_mismatch');

      const acceptableUntil = new Date(binding.iat * 1000 + maxAgeMs + clockSkewMs);
      if ((await claims.claim(CLAIM_SCOPE, chain.id, acceptableUntil)) === 'exists') return invalid('mandate_reused');
      return { ok: true };
    },
  };
}

function readMandate(context: Context, header: string, metaKey: string): string | undefined {
  if (context.request !== null) {
    const value = context.request.headers.get(header);
    if (value !== null) return value.trim();
  }
  const meta = context.mcp?.meta[metaKey];
  return typeof meta === 'string' ? meta.trim() : undefined;
}

function duration(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TollstileError('CONFIG_INVALID', `userMandate() ${name} must be a non-negative integer number of milliseconds, got ${String(value)}.`);
  }
  return value;
}

function deny(reason: string): RequirementResult {
  return { ok: false, status: 402, reason };
}

function invalid(detail: string): RequirementResult {
  return deny(`mandate_invalid:${detail}`);
}
