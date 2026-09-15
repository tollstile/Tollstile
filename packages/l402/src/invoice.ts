export type LightningNetwork = 'mainnet' | 'testnet' | 'signet' | 'regtest';

export type Invoice = {
  /** Hex-encoded 32-byte payment hash. */
  readonly paymentHash: string;
  /** BOLT 11 payment request. */
  readonly paymentRequest: string;
};

export type InvoiceState =
  | { readonly status: 'settled'; readonly amountPaidMsat: bigint }
  /** Unpaid, or paid with HTLCs still held (hold invoices). */
  | { readonly status: 'open' }
  | { readonly status: 'canceled' }
  | { readonly status: 'not_found' };

/**
 * Creates and looks up Lightning invoices on the merchant's node. Implementations throw
 * `TollstileError` with `PROVIDER_UNAVAILABLE` when the node cannot be reached, and
 * `PROVIDER_TIMEOUT` when the call is aborted or the answer is ambiguous.
 *
 * @example
 * const invoices: InvoiceProvider = lndRest({ url: 'https://127.0.0.1:8080', macaroon: process.env.LND_INVOICE_MACAROON_HEX });
 */
export type InvoiceRequest = {
  readonly amountMsat: bigint;
  readonly memo: string;
  readonly expirySeconds: number;
  readonly signal: AbortSignal;
};

export type InvoiceProvider = {
  createInvoice(request: InvoiceRequest): Promise<Invoice>;
  lookupInvoice(paymentHash: string, signal: AbortSignal): Promise<InvoiceState>;
};

const CURRENCY: Readonly<Record<string, LightningNetwork>> = { bc: 'mainnet', tb: 'testnet', tbs: 'signet', bcrt: 'regtest' };
/** BOLT 11 human-readable part: `ln` + currency + optional amount, then the `1` separator. */
const PREFIX = /^ln(bcrt|bc|tbs|tb)(?:(\d+)([munp])?)?1[02-9ac-hj-np-z]+$/;
const MSAT_PER_BTC = 100_000_000_000n;
/** Divisors of MSAT_PER_BTC for each multiplier; `p` is a tenth of a millisatoshi. */
const MULTIPLIER = { m: 1_000n, u: 1_000_000n, n: 1_000_000_000n } as const;

/**
 * The network and amount a BOLT 11 invoice commits to, read from its human-readable part. The
 * signature and tagged fields are not checked: this guards against a misconfigured node, not a hostile one.
 */
export function describeInvoice(
  paymentRequest: string,
): { readonly network: LightningNetwork; readonly amountMsat: bigint | undefined } | undefined {
  const match = PREFIX.exec(paymentRequest.toLowerCase());
  const network = match === null ? undefined : CURRENCY[match[1] ?? ''];
  if (match === null || network === undefined) return undefined;

  const digits = match[2];
  if (digits === undefined) return { network, amountMsat: undefined };
  const amount = BigInt(digits);
  const multiplier = match[3];
  switch (multiplier) {
    case undefined:
      return { network, amountMsat: amount * MSAT_PER_BTC };
    case 'm':
    case 'u':
    case 'n':
      return { network, amountMsat: (amount * MSAT_PER_BTC) / MULTIPLIER[multiplier] };
    case 'p':
      return amount % 10n === 0n ? { network, amountMsat: amount / 10n } : undefined;
    default:
      return undefined;
  }
}
