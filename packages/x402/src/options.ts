import { TollstileError, type Money } from 'tollstile';
import { isFacilitator, type Facilitator } from './facilitator';
import { isAddress, KNOWN_NETWORKS, type X402Asset } from './networks';
import type { Fetch } from './provider-fetch';

export type X402FacilitatorOptions = {
  /** Base URL; `/verify` and `/settle` are appended. */
  readonly url: string;
  /** Headers for each request, e.g. a freshly signed CDP JWT. Called once per request. */
  readonly headers?: () => Promise<Record<string, string>>;
};

export type X402Options = {
  /** CAIP-2 network, e.g. `"eip155:84532"` (Base Sepolia) or `"eip155:8453"` (Base). */
  readonly network: string;
  /** Your address. Payments are signed to it and checked against it. */
  readonly payTo: string;
  /**
   * The currency the asset is pegged to, for conversion at par: `"USD"` for USDC. Set exactly one
   * of `denomination` and `rate`; Tollstile never assumes a conversion.
   */
  readonly denomination?: string;
  /** Converts a price to atomic units of the asset when it is not at par. The quote fixes the result. */
  readonly rate?: (price: Money) => Promise<bigint>;
  /** Defaults to USDC on Base and Base Sepolia. Required on other networks. */
  readonly asset?: X402Asset;
  /**
   * The facilitator that verifies and settles: `{ url, headers }` for an x402 facilitator's HTTP
   * API, or your own implementation of the `Facilitator` contract (a different provider API, or a
   * choice among several). Defaults to https://x402.org/facilitator on Base Sepolia only; required
   * everywhere else.
   */
  readonly facilitator?: X402FacilitatorOptions | Facilitator;
  /**
   * JSON-RPC endpoint for `network`. Facilitators have no status endpoint and `/settle` is not
   * idempotent, so reconciliation reads authorization nonces and transfer logs from the chain.
   */
  readonly rpcUrl: string;
  /**
   * Enables `upTo()` prices with the `upto` scheme (Permit2). `facilitatorAddress` is the address
   * your facilitator lists for `upto` in `GET /supported`; payers bind their signature to it.
   */
  readonly upto?: { readonly facilitatorAddress: string };
  /**
   * How long a payer's signature stays valid. Defaults to 60. The handler and settlement must both
   * finish before it runs out, or settlement is rejected after the service was delivered.
   */
  readonly maxTimeoutSeconds?: number;
  readonly fetch?: Fetch;
};

export type Basis =
  | { readonly kind: 'par'; readonly currency: string }
  | { readonly kind: 'rate'; readonly rate: (price: Money) => Promise<bigint> };

export type Settings = {
  readonly network: string;
  readonly asset: X402Asset;
  readonly payTo: string;
  readonly basis: Basis;
  readonly facilitator: X402FacilitatorOptions | Facilitator;
  readonly rpcUrl: string;
  readonly upto: { readonly facilitatorAddress: string } | null;
  readonly maxTimeoutSeconds: number;
  readonly fetch: Fetch;
};

const CAIP2_EVM = /^eip155:[1-9]\d{0,19}$/;
const CURRENCY = /^[A-Z]{3}$/;
const DEFAULT_MAX_TIMEOUT_SECONDS = 60;

export function resolveOptions(options: X402Options): Settings {
  const { network } = options;
  if (!CAIP2_EVM.test(network)) {
    throw invalid(`network "${network}" is not a CAIP-2 EVM network. Use "eip155:<chainId>", e.g. "eip155:84532".`);
  }
  const known = KNOWN_NETWORKS[network];
  const asset = options.asset ?? known?.asset;
  if (asset === undefined) {
    throw invalid(`network "${network}" has no built-in asset. Pass asset: { code, address, decimals, name, version }.`);
  }
  if (!isAddress(asset.address)) throw invalid(`asset address "${asset.address}" is not an EVM address.`);
  // Tollstile amounts have six decimals. Fewer asset decimals would make some prices impossible to
  // charge exactly, and rounding money is not an option.
  if (!Number.isInteger(asset.decimals) || asset.decimals < 6 || asset.decimals > 18) {
    throw invalid(`asset ${asset.code} has ${String(asset.decimals)} decimals; x402 assets need between 6 and 18.`);
  }
  if (!isAddress(options.payTo)) throw invalid(`payTo "${options.payTo}" is not an EVM address.`);
  if (!URL.canParse(options.rpcUrl)) throw invalid('rpcUrl must be an absolute URL.');

  const facilitator =
    options.facilitator ?? (known === undefined || known.facilitator === null ? undefined : { url: known.facilitator });
  if (facilitator === undefined) {
    throw invalid(
      `network "${network}" needs an explicit facilitator: { url, headers } or a Facilitator implementation. The public x402.org facilitator is used by default only on Base Sepolia.`,
    );
  }
  if (!isFacilitator(facilitator)) {
    if (typeof facilitator.url !== 'string' || !URL.canParse(facilitator.url)) {
      throw invalid('facilitator must be { url, headers } with an absolute URL, or an object with verify() and settle().');
    }
    if (facilitator.headers !== undefined && typeof facilitator.headers !== 'function') {
      throw invalid('facilitator.headers must be a function returning the headers for one request.');
    }
  }

  if (options.upto !== undefined && !isAddress(options.upto.facilitatorAddress)) {
    throw invalid(`upto.facilitatorAddress "${options.upto.facilitatorAddress}" is not an EVM address.`);
  }

  const maxTimeoutSeconds = options.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS;
  if (!Number.isInteger(maxTimeoutSeconds) || maxTimeoutSeconds <= 0) {
    throw invalid(`maxTimeoutSeconds must be a positive integer, got ${String(maxTimeoutSeconds)}.`);
  }

  return {
    network,
    asset,
    payTo: options.payTo,
    basis: resolveBasis(options, known === undefined || options.asset !== undefined ? null : known.peg, asset.code),
    facilitator,
    rpcUrl: options.rpcUrl,
    upto: options.upto ?? null,
    maxTimeoutSeconds,
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
  };
}

function resolveBasis(options: X402Options, peg: string | null, code: string): Basis {
  if (options.denomination !== undefined && options.rate !== undefined) {
    throw invalid('set either denomination (conversion at par) or rate, not both.');
  }
  if (options.rate !== undefined) return { kind: 'rate', rate: options.rate };
  if (options.denomination === undefined) {
    throw invalid(
      `${code} needs an explicit conversion basis. Use denomination: "${peg ?? 'USD'}" if one ${code} is worth one ${peg ?? 'unit of your price currency'}, or rate: (price) => atomic units.`,
    );
  }
  if (!CURRENCY.test(options.denomination)) throw invalid(`denomination "${options.denomination}" is not a currency code like "USD".`);
  if (peg !== null && options.denomination !== peg) {
    throw invalid(`the built-in ${code} is pegged to ${peg}, not ${options.denomination}. Use rate for other currencies.`);
  }
  return { kind: 'par', currency: options.denomination };
}

function invalid(message: string): TollstileError {
  return new TollstileError('CONFIG_INVALID', `x402: ${message}`);
}
