import {
  formatMoney,
  money,
  TollstileError,
  type Clock,
  type Context,
  type Money,
  type Rail,
  type Receipt,
} from 'tollstile';
import { challengeValue, parseCredential } from './credential';
import { fromHex, toBase64 } from './encoding';
import { describeInvoice, type InvoiceProvider, type LightningNetwork } from './invoice';
import { mintToken, readToken } from './token';

export type L402Options = {
  /** The network your node issues invoices on. Invoices from any other network are refused. */
  readonly network: LightningNetwork;
  /** Your Lightning node, e.g. `lndRest({ url, macaroon })`. */
  readonly invoices: InvoiceProvider;
  /**
   * Converts an amount in the price currency to millisatoshis. Tollstile never knows a BTC price:
   * this is your exchange rate, applied when a challenge is issued. Return whole satoshis
   * (multiples of 1000) if your payers' wallets cannot pay millisatoshi amounts.
   */
  readonly rate: (amount: Money) => bigint | Promise<bigint>;
  /**
   * Derives each macaroon's root key as HMAC-SHA256(secret, identifier). At least 32 characters.
   * With several, the first mints and all verify; removing one invalidates credentials already paid for.
   */
  readonly secret: string | readonly string[];
  /** How many calls at the challenged price one credential pays for. Defaults to 1. */
  readonly calls?: number;
  /** How long a credential can be used after its challenge. Defaults to 24 hours. */
  readonly credentialTtlMs?: number;
  /**
   * Also ask the node whether the invoice is settled on every verification. A correct preimage
   * already proves payment, so this costs a round trip per request and turns node outages into 503s;
   * it guards against preimages that leaked without payment (a compromised node or hold invoices).
   * Defaults to false.
   */
  readonly confirmSettled?: boolean;
  /** Upper bound for creating an invoice while issuing a challenge. Defaults to 10 seconds. */
  readonly invoiceTimeoutMs?: number;
  /** Defaults to the system clock. */
  readonly clock?: Clock;
};

/** What an authorization keeps. Never the macaroon or preimage: together they are a bearer credential. */
export type L402Data = { readonly paymentHash: string };

export type L402Rail = Rail<'l402', L402Data>;

/** MCP `_meta` key carrying `L402 <macaroon>:<preimage>`. L402 defines no MCP transport; this one is Tollstile's. */
export const L402_CREDENTIAL_META = 'l402/credential';
export const L402_RECEIPT_META = 'l402/receipt';

const MEMO = 'L402';
const MSAT_SCALE = 11;
const MIN_SECRET_LENGTH = 32;
const DEFAULT_CREDENTIAL_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_INVOICE_TIMEOUT_MS = 10_000;
const NETWORKS: readonly LightningNetwork[] = ['mainnet', 'testnet', 'signet', 'regtest'];

/**
 * A rail for L402 (formerly LSAT): the payer pays a Lightning invoice, then presents the macaroon and
 * preimage on each call until the credential's value or lifetime runs out. Every call consumes part
 * of what was prepaid; a failed call gives its part back.
 *
 * @example
 * const toll = createTollstile({
 *   rails: [
 *     l402({
 *       network: 'mainnet',
 *       invoices: lndRest({ url: 'https://127.0.0.1:8080', macaroon: invoiceMacaroonHex }),
 *       rate: (amount) => usdToMsat(amount),
 *       secret: process.env.L402_SECRET,
 *       calls: 100,
 *     }),
 *   ],
 *   ledger,
 *   secret: process.env.TOLLSTILE_SECRET,
 * });
 */
export function l402(options: L402Options): L402Rail {
  const secrets = typeof options.secret === 'string' ? [options.secret] : options.secret;
  const [mintingSecret] = secrets;
  if (mintingSecret === undefined || secrets.some((secret) => secret.length < MIN_SECRET_LENGTH)) {
    throw new TollstileError('CONFIG_INVALID', `l402() needs \`secret\` of at least ${String(MIN_SECRET_LENGTH)} random characters.`);
  }
  if (!NETWORKS.includes(options.network)) {
    throw new TollstileError('CONFIG_INVALID', `l402() \`network\` must be one of ${NETWORKS.join(', ')}.`);
  }
  const calls = BigInt(positiveInteger(options.calls ?? 1, 'calls'));
  const credentialTtlMs = positiveInteger(options.credentialTtlMs ?? DEFAULT_CREDENTIAL_TTL_MS, 'credentialTtlMs');
  const invoiceTimeoutMs = positiveInteger(options.invoiceTimeoutMs ?? DEFAULT_INVOICE_TIMEOUT_MS, 'invoiceTimeoutMs');
  const clock = options.clock ?? { now: () => new Date() };
  const asset = { code: 'BTC', network: `lightning:${options.network}`, scale: MSAT_SCALE };

  return {
    name: 'l402',
    livemode: true,
    capabilities: {
      flows: ['authorization'],
      authorization: 'reusable',
      variableAmount: true,
      quotes: true,
      refund: false,
      partialRefund: false,
      lookup: true,
    },

    async offer({ price }) {
      const value = money(price.currency, price.micros * calls);
      const amountMsat = await options.rate(value);
      if (amountMsat <= 0n) return null;
      return { rail: 'l402', asset, amount: amountMsat.toString(), basis: 'rate', details: { calls: Number(calls), value: formatMoney(value) } };
    },

    async challenge(quote, quoteToken, offer, _context, operation) {
      const now = clock.now();
      const amountMsat = BigInt(offer.amount);
      // Paying after the quote expires is still honored on fixed-price routes, but the invoice should not outlive it.
      const expirySeconds = Math.max(1, Math.floor((quote.expiresAt.getTime() - now.getTime()) / 1000));
      const invoice = await options.invoices.createInvoice({
        amountMsat,
        memo: MEMO,
        expirySeconds,
        signal: AbortSignal.any([operation.signal, AbortSignal.timeout(invoiceTimeoutMs)]),
      });

      const described = describeInvoice(invoice.paymentRequest);
      if (described?.network !== options.network) {
        throw new TollstileError(
          'CONFIG_INVALID',
          `The invoice provider issued an invoice that is not for ${options.network}. Point \`invoices\` at a ${options.network} node or change \`network\`.`,
        );
      }
      const paymentHash = fromHex(invoice.paymentHash);
      if (described.amountMsat !== amountMsat || paymentHash?.length !== 32) {
        throw new TollstileError('PROVIDER_UNAVAILABLE', 'The invoice provider returned an invoice that does not match the requested amount.');
      }

      const value = money(quote.price.currency, quote.price.micros * calls);
      const validUntil = new Date(now.getTime() + credentialTtlMs);
      const macaroon = toBase64(await mintToken(mintingSecret, paymentHash, { quoteToken, limit: value, validUntil }));
      const details = {
        macaroon,
        invoice: invoice.paymentRequest,
        paymentHash: invoice.paymentHash,
        value: formatMoney(value),
        calls: Number(calls),
        validUntil: validUntil.toISOString(),
      };
      return {
        // Spec §10: send the legacy scheme first so older clients pick one they understand.
        headers: [
          ['www-authenticate', challengeValue('LSAT', macaroon, invoice.paymentRequest)],
          ['www-authenticate', challengeValue('L402', macaroon, invoice.paymentRequest)],
        ],
        accepts: { scheme: 'L402', header: 'authorization', ...details },
        mcp: { style: 'tollstile', rail: 'l402', meta: L402_CREDENTIAL_META, format: 'L402 <macaroon>:<preimage>', ...details },
      };
    },

    async verify(context, terms, operation) {
      const parsed = parseCredential(readProof(context));
      if (parsed.status !== 'present') return parsed;

      const token = await readToken(secrets, parsed.credential, clock.now());
      if (token.status === 'invalid') return token;

      // The macaroon signs the quote caveat, so a quote that no longer opens was ours and has only
      // expired or is presented on another resource. The prepaid value is still owed to the payer:
      // later calls are charged at the route's current fixed price, and dynamic routes need a fresh quote.
      const quote = (await terms.openQuote(token.quoteToken)) ?? null;
      const price = quote?.price ?? terms.price;
      if (price === null) return { status: 'invalid', reason: 'quote_required' };
      if (price.currency !== token.limit.currency) return { status: 'invalid', reason: 'currency_mismatch' };

      if (options.confirmSettled === true) {
        const invoice = await options.invoices.lookupInvoice(token.paymentHash, operation.signal);
        if (invoice.status !== 'settled') return { status: 'invalid', reason: 'invoice_not_settled' };
      }

      return {
        status: 'valid',
        proofId: token.paymentHash,
        payer: `l402:${token.paymentHash}`,
        quote,
        limit: token.limit,
        expiresAt: token.validUntil,
        data: { paymentHash: token.paymentHash },
      };
    },

    // Consumption of prepaid value: the Lightning payment already happened, so nothing is sent and
    // the result is the same on every retry.
    settle(authorization, charge) {
      return Promise.resolve({
        status: 'settled',
        reference: `${authorization.data.paymentHash}:${charge.id}`,
        details: { paymentHash: authorization.data.paymentHash, consumed: formatMoney(charge.amount) },
      });
    },

    refund() {
      return Promise.resolve({ status: 'rejected', reason: 'lightning_payments_are_not_refundable' });
    },

    // The ledger returns the reserved value to the credential; the node has nothing to undo.
    release() {
      return Promise.resolve();
    },

    // Per-charge consumption is recorded only in the ledger, and lookup is asked only about charges the
    // ledger has not recorded as settled. The invoice being paid says nothing about one charge: reporting
    // `settled` from it would consume value for a call whose service may not exist, then attempt a
    // refund Lightning cannot make. `none` lets reconciliation re-run the deterministic settle for
    // completed charges and release the rest.
    lookup() {
      return Promise.resolve({ status: 'none' });
    },

    receipt(authorization, charge, context): Receipt {
      const reference = charge.settlement?.reference ?? charge.id;
      const remaining =
        authorization.limit === null
          ? null
          : formatMoney(
              money(authorization.limit.currency, authorization.limit.micros - authorization.consumed.micros - authorization.reserved.micros),
            );
      return context.transport === 'mcp'
        ? { headers: [], meta: { [L402_RECEIPT_META]: { reference, remaining } } }
        : { headers: [['l402-receipt', reference], ...(remaining === null ? [] : [['l402-remaining', remaining] as const])], meta: {} };
    },
  };
}

function readProof(context: Context): string | undefined {
  if (context.transport === 'http') return context.request?.headers.get('authorization') ?? undefined;
  const value = context.mcp?.meta[L402_CREDENTIAL_META];
  return typeof value === 'string' ? value : undefined;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TollstileError('CONFIG_INVALID', `l402() \`${name}\` must be a positive integer, got ${String(value)}.`);
  }
  return value;
}
