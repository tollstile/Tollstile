import type { Context, JsonObject } from 'tollstile';
import type { Settings } from './options';
import { containsSubset, jsonEqual } from './wire';

export type Scheme = 'exact' | 'upto';

/** One entry of x402 V2 `accepts`. */
export type PaymentRequirements = {
  readonly scheme: Scheme;
  readonly network: string;
  /** Atomic units. For `upto`, the maximum at verification and the actual amount at settlement. */
  readonly amount: string;
  readonly asset: string;
  readonly payTo: string;
  readonly maxTimeoutSeconds: number;
  readonly extra: { readonly [key: string]: string };
};

/**
 * Where the signed Tollstile quote travels. x402 V2 clients must echo every advertised `extra`
 * field in `accepted`, so the quote comes back bound to the payment the payer signed.
 */
export const QUOTE_EXTRA_KEY = 'tollstileQuote';

export function requirementsFor(
  settings: Settings,
  terms: { readonly amount: string; readonly variable: boolean; readonly quoteToken: string | null },
): PaymentRequirements {
  const { asset } = settings;
  const quote = terms.quoteToken === null ? {} : { [QUOTE_EXTRA_KEY]: terms.quoteToken };
  const upto =
    terms.variable && settings.upto !== null
      ? { assetTransferMethod: 'permit2', facilitatorAddress: settings.upto.facilitatorAddress }
      : {};
  return {
    scheme: terms.variable ? 'upto' : 'exact',
    network: settings.network,
    amount: terms.amount,
    asset: asset.address,
    payTo: settings.payTo,
    maxTimeoutSeconds: settings.maxTimeoutSeconds,
    extra: { name: asset.name, version: asset.version, ...upto, ...quote },
  };
}

/**
 * x402 V2 matching, as in the reference `paymentRequirementsMatchAccepted`: every field except
 * `extra` must be identical, and `accepted.extra` must contain everything the server advertised.
 */
export function acceptedMatches(requirements: PaymentRequirements, accepted: JsonObject): boolean {
  const { extra, ...core } = requirements;
  const { extra: acceptedExtra, ...acceptedCore } = accepted;
  return jsonEqual(core, acceptedCore) && containsSubset(extra, acceptedExtra);
}

export function paymentRequired(requirements: PaymentRequirements, context: Context): JsonObject {
  return { x402Version: 2, resource: { url: resourceUrl(context) }, accepts: [requirements] };
}

function resourceUrl(context: Context): string {
  if (context.transport === 'mcp' && context.mcp !== null) return `mcp://tool/${context.mcp.tool}`;
  return context.request?.url ?? context.resource;
}
