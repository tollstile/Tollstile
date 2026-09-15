import { compare, TollstileError, type Authorization, type Charge, type Clock, type Context, type JsonObject, type Rail, type Settlement } from 'tollstile';
import { weighChargeEvidence } from './charge-evidence';
import { issuerKeySet, type KeySet } from './key-set';
import { skyfireApi } from './skyfire-api';
import { readPaymentTokens, verifyPaymentToken, type PaymentTokenType, type TokenPolicy } from './token';
import { formatUsdDecimal } from './usd-decimal';

export type KyapayEnvironment = 'production' | 'sandbox';

export type KyapayOptions = {
  /** Skyfire environment. Selects the default issuer and API, and the `env` claim tokens must carry. */
  readonly environment: KyapayEnvironment;
  /** Your Skyfire seller agent id. Tokens must name it in `aud`. */
  readonly sellerId: string;
  /** Your Skyfire seller service id. Tokens must name it in `tsi` (or the older `ssi`). */
  readonly serviceId: string;
  /** Your seller agent API key, used to charge tokens and list their charges. Keep it in your secret store. */
  readonly apiKey: string;
  /**
   * Token types accepted. Defaults to `["pay", "kya-pay"]`. The ledger stores each token to charge it
   * later, and `kya-pay` tokens carry buyer identity claims; accept only `pay` to keep them out.
   */
  readonly tokenTypes?: readonly PaymentTokenType[];
  /** Trusted token issuers (origins). Defaults to Skyfire's issuer for `environment`. */
  readonly issuers?: readonly string[];
  /** Skyfire API origin. Defaults to Skyfire's API for `environment`. */
  readonly apiUrl?: string;
  /**
   * Tolerated clock difference with the issuer and Skyfire, in seconds, from 5 to 60. Defaults to 30,
   * as the KYAPay draft recommends. Also bounds how charge lookups compare Skyfire timestamps.
   */
  readonly clockSkewSeconds?: number;
  /**
   * Verifies the RFC 9421 HTTP message signature that proves possession of the key in a
   * sender-constrained token's `cnf` claim. Without it, such tokens are refused: accepting them as
   * bearer tokens would defeat the constraint.
   */
  readonly verifyRequestSignature?: (input: {
    readonly context: Context;
    readonly confirmation: JsonObject;
    readonly signal: AbortSignal;
  }) => Promise<boolean>;
  /** For tests. Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** For tests. Defaults to the system clock. */
  readonly clock?: Clock;
};

/**
 * Stored on the authorization. `token` is the compact JWT: Skyfire charges only against the full
 * signed token, and the charge runs after fulfillment, possibly in another process. It is chargeable
 * only by the seller named in `aud` with that seller's API key, and card-settled tokens are refused
 * before anything is stored.
 */
export type KyapayData = {
  readonly token: string;
  readonly tokenId: string;
};

export type KyapayRail = Rail<'kyapay', KyapayData>;

/** HTTP request header carrying KYAPay tokens (draft-skyfire-oauth-using-kyapay-tokens). */
export const KYAPAY_TOKEN_HEADER = 'KYAPay-Token';
/** MCP `_meta` key carrying a KYAPay token. KYAPay defines no MCP binding; this is Tollstile's convention. */
export const KYAPAY_TOKEN_META = 'kyapay/token';
/** HTTP response header carrying a JSON receipt shaped like the A2A KYAPay charge response. */
export const KYAPAY_RECEIPT_HEADER = 'kyapay-receipt';
/** MCP `_meta` key carrying the same receipt. */
export const KYAPAY_RECEIPT_META = 'kyapay/receipt';

const ENVIRONMENTS = {
  production: { issuer: 'https://app.skyfire.xyz', apiUrl: 'https://api.skyfire.xyz' },
  sandbox: { issuer: 'https://app-sandbox.skyfire.xyz', apiUrl: 'https://api-sandbox.skyfire.xyz' },
} as const satisfies Record<KyapayEnvironment, { readonly issuer: string; readonly apiUrl: string }>;

const CREATE_TOKEN_DOCS = 'https://docs.skyfire.xyz/reference/create-token';
/** The A2A KYAPay extension spells the combined token type with a plus. */
const A2A_TOKEN_TYPES = { pay: 'pay', 'kya-pay': 'kya+pay' } as const satisfies Record<PaymentTokenType, string>;

/**
 * Accepts Skyfire KYAPay `pay` and `kya-pay` tokens. A token is a funded hold: it is verified on
 * every request, the handler runs, and the delivered amount is charged against it until it is used up.
 *
 * @example
 * ```ts
 * const toll = createTollstile({
 *   rails: [kyapay({ environment: "production", sellerId, serviceId, apiKey: process.env.SKYFIRE_API_KEY })],
 *   ledger: postgresLedger(db),
 *   secret: process.env.TOLLSTILE_SECRET,
 * });
 * ```
 */
export function kyapay(options: KyapayOptions): KyapayRail {
  const defaults = ENVIRONMENTS[options.environment];
  const clock = options.clock ?? { now: () => new Date() };
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  const tokenTypes = options.tokenTypes ?? ['pay', 'kya-pay'];
  const issuers = options.issuers ?? [defaults.issuer];
  const apiUrl = options.apiUrl ?? defaults.apiUrl;
  const clockSkewSeconds = options.clockSkewSeconds ?? 30;
  validate(options, { tokenTypes, issuers, apiUrl, clockSkewSeconds });

  const keySets = new Map<string, KeySet>(issuers.map((issuer) => [issuer, issuerKeySet({ issuer, fetch: fetchImpl, clock })]));
  const policy: TokenPolicy = {
    issuers: keySets,
    audience: options.sellerId,
    serviceId: options.serviceId,
    environment: options.environment,
    tokenTypes,
    clockSkewSeconds,
  };
  const api = skyfireApi({ url: apiUrl, apiKey: options.apiKey, fetch: fetchImpl });
  const primaryIssuer = issuers[0] ?? defaults.issuer;

  const evidenceFor = async (authorization: Authorization & { readonly data: KyapayData }, charge: Charge, signal: AbortSignal) => {
    const listing = await api.listCharges(authorization.data.tokenId, signal);
    if (listing.status === 'not_found') return listing;
    return weighChargeEvidence({ charges: listing.charges, authorization, charge, clockSkewMs: clockSkewSeconds * 1000 });
  };

  return {
    name: 'kyapay',
    livemode: true,
    capabilities: {
      flows: ['authorization'],
      authorization: 'reusable',
      variableAmount: true,
      quotes: false,
      refund: false,
      partialRefund: false,
      lookup: true,
    },

    offer({ price }) {
      // Skyfire tokens are denominated in USD only.
      if (price.currency !== 'USD') return Promise.resolve(null);
      return Promise.resolve({
        rail: 'kyapay',
        asset: { code: 'USD', network: `skyfire:${options.environment}`, scale: 6 },
        amount: price.micros.toString(),
        basis: 'par',
        details: { header: KYAPAY_TOKEN_HEADER, tokenTypes: [...tokenTypes] },
      });
    },

    challenge(quote, _quoteToken, _offer, context) {
      const tokenAmount = formatUsdDecimal(quote.price);
      const guidance = {
        header: KYAPAY_TOKEN_HEADER,
        meta: KYAPAY_TOKEN_META,
        tokenTypes: [...tokenTypes],
        issuer: primaryIssuer,
        createToken: CREATE_TOKEN_DOCS,
        message: `Send a Skyfire ${tokenTypes.map((type) => `\`${type}\``).join(' or ')} token for seller service ${options.serviceId} worth at least ${tokenAmount} USD in the ${KYAPAY_TOKEN_HEADER} header. Create an account at ${primaryIssuer} and create a token: ${CREATE_TOKEN_DOCS}.`,
        kyapay_version: 1,
        accepts: tokenTypes.map((type) => ({
          seller_service_id: options.serviceId,
          token_amount: tokenAmount,
          token_type: A2A_TOKEN_TYPES[type],
          description: `Payment for ${context.resource}`,
          resource: context.resource,
        })),
      };
      return Promise.resolve({ headers: [], accepts: guidance, mcp: { style: 'tollstile', ...guidance } });
    },

    async verify(context, terms, operation) {
      const value = readProof(context);
      if (value === undefined) return { status: 'absent' };
      const [candidate, ...rest] = readPaymentTokens(value);
      if (candidate === undefined) return { status: 'absent' };
      // Charging one of several tokens would be a guess about which hold the payer meant to use.
      if (rest.length > 0) return { status: 'invalid', reason: 'multiple_payment_tokens' };

      const check = await verifyPaymentToken(candidate, policy, clock.now(), operation.signal);
      if (!check.ok) return { status: 'invalid', reason: check.reason };
      const { token } = check;

      if (token.confirmation !== null) {
        if (options.verifyRequestSignature === undefined) return { status: 'invalid', reason: 'sender_constrained_token_unsupported' };
        const possessed = await options.verifyRequestSignature({ context, confirmation: token.confirmation, signal: operation.signal });
        if (!possessed) return { status: 'invalid', reason: 'request_signature_invalid' };
      }

      if (terms.price === null) return { status: 'invalid', reason: 'quote_required' };
      if (terms.price.currency !== token.amount.currency) return { status: 'invalid', reason: 'currency_mismatch' };
      if (compare(token.amount, terms.price) < 0) return { status: 'invalid', reason: 'insufficient_token_amount' };

      return {
        status: 'valid',
        proofId: `${token.issuer} ${token.tokenId}`,
        payer: token.subject,
        quote: null,
        limit: token.amount,
        expiresAt: new Date(token.expiresAt * 1000),
        data: { token: token.compact, tokenId: token.tokenId },
      };
    },

    async settle(authorization, charge, operation) {
      // Skyfire has no idempotency key. Core calls settle for a charge on its first attempt (written
      // ahead as `settling`) or after lookup proved it absent, so an undetermined or lagging list does
      // not stop the call. Proof that the charge is already listed does, and so do charges the ledger
      // cannot explain, because charging on top of them could repeat one.
      const evidence = await evidenceFor(authorization, charge, operation.signal);
      switch (evidence.status) {
        case 'charged':
          return { status: 'settled', ...listedSettlement(authorization.data.tokenId, charge, evidence) };
        case 'inconsistent':
          throw ambiguous(charge, evidence.detail);
        case 'not_found':
        case 'absent':
        case 'undetermined':
        case 'lagging':
          break;
      }

      const outcome = await api.charge(authorization.data.token, charge.amount, operation.signal);
      if (outcome.status === 'rejected') return { status: 'rejected', reason: outcome.code.toLowerCase() };
      return {
        status: 'settled',
        reference: reference(authorization.data.tokenId, charge),
        details: { tokenId: authorization.data.tokenId, amountCharged: outcome.amountCharged, remainingBalance: outcome.remainingBalance },
      };
    },

    refund() {
      // Skyfire documents no refund or reversal API; capabilities declare it, so core never asks.
      return Promise.resolve({ status: 'rejected', reason: 'refund_unsupported' });
    },

    release() {
      // Nothing to tell Skyfire: an uncharged balance returns to the buyer when the token lapses.
      return Promise.resolve();
    },

    async lookup(authorization, charge, operation) {
      const evidence = await evidenceFor(authorization, charge, operation.signal);
      switch (evidence.status) {
        case 'charged':
          return { status: 'settled', ...listedSettlement(authorization.data.tokenId, charge, evidence) };
        case 'absent':
          return { status: 'none' };
        case 'not_found':
          throw ambiguous(charge, 'Skyfire answered 404 for the token, which is not documented to mean "no charges"');
        case 'undetermined':
        case 'lagging':
        case 'inconsistent':
          throw ambiguous(charge, evidence.detail);
      }
    },

    receipt(authorization, charge, context) {
      const receipt = { success: true, amount_charged: formatUsdDecimal(charge.amount), token_id: authorization.data.tokenId };
      return context.transport === 'mcp'
        ? { headers: [], meta: { [KYAPAY_RECEIPT_META]: receipt } }
        : { headers: [[KYAPAY_RECEIPT_HEADER, JSON.stringify(receipt)]], meta: {} };
    },
  };
}

function readProof(context: Context): string | undefined {
  if (context.transport === 'http') return context.request?.headers.get(KYAPAY_TOKEN_HEADER) ?? undefined;
  const value = context.mcp?.meta[KYAPAY_TOKEN_META];
  return typeof value === 'string' ? value : undefined;
}

/** Skyfire returns no charge id, so the reference names the token and the Tollstile charge. */
function reference(tokenId: string, charge: Charge): string {
  return `${tokenId}:${charge.id}`;
}

function listedSettlement(
  tokenId: string,
  charge: Charge,
  evidence: { readonly chargedMicros: bigint; readonly recordedMicros: bigint },
): Settlement {
  return {
    reference: reference(tokenId, charge),
    details: {
      tokenId,
      evidence: 'charge_list',
      chargedTotal: formatUsdDecimal({ currency: 'USD', micros: evidence.chargedMicros }),
      recordedTotal: formatUsdDecimal({ currency: 'USD', micros: evidence.recordedMicros }),
    },
  };
}

function ambiguous(charge: Charge, detail: string): TollstileError {
  return new TollstileError(
    'PROVIDER_TIMEOUT',
    `Skyfire's charge list cannot prove whether charge ${charge.id} was made: ${detail}. It stays unknown; reconcile again later, or resolve it by hand against the Skyfire dashboard.`,
  );
}

function validate(
  options: KyapayOptions,
  resolved: { readonly tokenTypes: readonly string[]; readonly issuers: readonly string[]; readonly apiUrl: string; readonly clockSkewSeconds: number },
): void {
  for (const [name, value] of [['sellerId', options.sellerId], ['serviceId', options.serviceId], ['apiKey', options.apiKey]] as const) {
    if (value.trim() === '') throw config(`kyapay() needs ${name}. Find it in your Skyfire seller dashboard.`);
  }
  if (resolved.tokenTypes.length === 0 || resolved.tokenTypes.some((type) => type !== 'pay' && type !== 'kya-pay')) {
    throw config('kyapay() tokenTypes must list "pay", "kya-pay", or both.');
  }
  if (resolved.issuers.length === 0) throw config('kyapay() issuers must name at least one trusted issuer.');
  for (const origin of [...resolved.issuers, resolved.apiUrl]) {
    if (!isHttpsOrigin(origin)) throw config(`"${origin}" must be an https origin with no path or trailing slash, e.g. "https://app.skyfire.xyz".`);
  }
  const skew = resolved.clockSkewSeconds;
  if (!Number.isInteger(skew) || skew < 5 || skew > 60) {
    throw config(`kyapay() clockSkewSeconds must be an integer from 5 to 60, got ${String(skew)}.`);
  }
}

function isHttpsOrigin(value: string): boolean {
  return URL.canParse(value) && new URL(value).protocol === 'https:' && new URL(value).origin === value;
}

function config(message: string): TollstileError {
  return new TollstileError('CONFIG_INVALID', message);
}
