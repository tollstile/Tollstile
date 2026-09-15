import {
  TollstileError,
  toAssetUnits,
  type Authorization,
  type Charge,
  type Clock,
  type JsonObject,
  type LookupResult,
  type Money,
  type Rail,
} from 'tollstile';
import { asciiRealm, challengeSecrets, quoteChallenge } from './challenge';
import { chargeTerms, readCredential, rejected, sameRequest } from './credential';
import { isIntegerString, isObject } from './encoding';
import { paymentReceipt } from './receipt';
import {
  listData,
  metadataOf,
  parsePaymentIntent,
  parseRefund,
  stripeCall,
  type PaymentIntent,
  type StripeConfig,
} from './stripe-api';

export type MppStripeOptions = {
  /** The protection space advertised in challenges, e.g. `"api.example.com"`. ASCII. */
  readonly realm: string;
  /** Binds challenge ids (HMAC-SHA256). At least 32 characters. Pass a list to rotate: the first signs, all verify. */
  readonly secret: string | readonly string[];
  /** Stripe secret key (`sk_live_…` or `sk_test_…`). Never leaves the Authorization header. */
  readonly secretKey: string;
  /** Your Stripe Business Network Profile id (`profile_…`), advertised as `methodDetails.networkId`. */
  readonly networkId: string;
  /** Payment method types you can process. Defaults to `["card"]`. */
  readonly paymentMethodTypes?: readonly string[];
  /** `Stripe-Version` sent with every call. SPTs need a preview version. Defaults to `"2026-07-29.preview"`. */
  readonly apiVersion?: string;
  /**
   * The PaymentIntent parameter carrying the SPT. The MPP spec and mppx use
   * `shared_payment_granted_token`; Stripe's SPT guide shows
   * `payment_method_data[shared_payment_granted_token]`. Defaults to the spec's form.
   */
  readonly sptParameter?: 'shared_payment_granted_token' | 'payment_method_data[shared_payment_granted_token]';
  /**
   * How long after an ambiguous settlement a Stripe Search miss is trusted as "no payment".
   * Search is eventually consistent (usually under a minute). Defaults to 10 minutes.
   */
  readonly searchLagMs?: number;
  /** Defaults to `https://api.stripe.com`. */
  readonly apiBase?: string;
  readonly fetch?: typeof fetch;
  readonly clock?: Clock;
};

/** What `settle`, `refund`, and `lookup` need in any process. The SPT itself is never stored. */
export type MppStripeData = {
  readonly challengeId: string;
  /** In the currency's minor unit. */
  readonly amount: string;
  readonly currency: string;
};

export type MppStripeRail = Rail<'mpp-stripe', MppStripeData>;

const NAME = 'mpp-stripe';
const METHOD = 'stripe';
const INTENT = 'charge';
const IDEMPOTENCY_PREFIX = 'tollstile_mpp_';

/** Decimal places and Stripe's general minimum charge, in minor units, per currency. */
const CURRENCIES: Readonly<Record<string, { readonly scale: number; readonly minimum: bigint }>> = {
  USD: { scale: 2, minimum: 50n },
  EUR: { scale: 2, minimum: 50n },
  GBP: { scale: 2, minimum: 30n },
  CAD: { scale: 2, minimum: 50n },
  AUD: { scale: 2, minimum: 50n },
  NZD: { scale: 2, minimum: 50n },
  CHF: { scale: 2, minimum: 50n },
  SGD: { scale: 2, minimum: 50n },
  HKD: { scale: 2, minimum: 400n },
  SEK: { scale: 2, minimum: 300n },
  NOK: { scale: 2, minimum: 300n },
  DKK: { scale: 2, minimum: 250n },
  MXN: { scale: 2, minimum: 1_000n },
  JPY: { scale: 0, minimum: 50n },
};

/** Card PaymentIntents in these states may still capture; nothing can be concluded yet. */
const IN_FLIGHT = new Set(['processing', 'requires_capture']);

/**
 * MPP `stripe` `charge`: the payer sends a Shared Payment Token and the rail confirms a
 * PaymentIntent with it. Stripe captures synchronously, so this rail settles before the handler
 * (`upfront`) and refunds when the handler fails.
 *
 * @example
 * ```ts
 * const toll = createTollstile({
 *   rails: [
 *     mppStripe({
 *       realm: 'api.example.com',
 *       secret: process.env.MPP_SECRET,
 *       secretKey: process.env.STRIPE_SECRET_KEY,
 *       networkId: 'profile_1MqDcVKA5fEO2tZvKQm9g8Yj',
 *     }),
 *   ],
 *   ledger,
 *   secret: process.env.TOLLSTILE_SECRET,
 * });
 * app.get('/report', tollstile(toll.price('$1.00')), handler);
 * ```
 */
export function mppStripe(options: MppStripeOptions): MppStripeRail {
  const secrets = challengeSecrets(options.secret, NAME);
  const realm = asciiRealm(options.realm);
  const clock = options.clock ?? { now: () => new Date() };
  const searchLagMs = options.searchLagMs ?? 10 * 60_000;
  const sptParameter = options.sptParameter ?? 'shared_payment_granted_token';
  const paymentMethodTypes = options.paymentMethodTypes ?? ['card'];
  const stripe: StripeConfig = {
    secretKey: options.secretKey,
    apiBase: options.apiBase ?? 'https://api.stripe.com',
    apiVersion: options.apiVersion ?? '2026-07-29.preview',
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
  };
  if (options.networkId.length === 0) {
    throw new TollstileError('CONFIG_INVALID', 'mppStripe() needs `networkId`, your Stripe Business Network Profile id.');
  }

  // SPTs are bearer tokens: they stay in memory, never in the ledger, until their challenge expires.
  // Keyed by request, so a concurrent replay cannot swap the token another request settles with.
  // Keeping the token after settlement lets a repeated settle replay the PaymentIntent through
  // Stripe's idempotency instead of failing; after expiry the token is useless to Stripe anyway.
  const tokens = new Map<string, { readonly spt: string; readonly expiresAt: number }>();

  const request = (amount: bigint, currency: string): JsonObject => ({
    amount: amount.toString(),
    currency: currency.toLowerCase(),
    methodDetails: { networkId: options.networkId, paymentMethodTypes },
  });

  return {
    name: NAME,
    livemode: true,
    capabilities: {
      flows: ['upfront'],
      authorization: 'single',
      variableAmount: false,
      quotes: true,
      refund: true,
      partialRefund: true,
      lookup: true,
    },

    offer({ price }) {
      const minor = minorUnits(price);
      if (minor === undefined) return Promise.resolve(null);
      return Promise.resolve({
        rail: NAME,
        asset: { code: price.currency, network: 'stripe', scale: minor.scale },
        amount: minor.amount.toString(),
        basis: 'par',
        details: { method: METHOD, intent: INTENT },
      });
    },

    challenge(quote, token, offer) {
      return quoteChallenge(
        secrets,
        { realm, method: METHOD, intent: INTENT, request: request(BigInt(offer.amount), offer.asset.code) },
        quote,
        token,
      );
    },

    async verify(context, terms) {
      const now = clock.now();
      for (const [id, entry] of tokens) if (entry.expiresAt <= now.getTime()) tokens.delete(id);

      const read = await readCredential(context, { realm, method: METHOD, intent: INTENT, secrets, now });
      if (read.status === 'absent') return read;
      if (read.status === 'invalid') return rejected(read);
      const { credential } = read;

      const resolved = await chargeTerms(credential, terms, NAME);
      if (resolved.status === 'invalid') return rejected(resolved);
      const minor = resolved.offer === null ? minorUnits(resolved.price) : { amount: BigInt(resolved.offer.amount) };
      if (minor === undefined) return { status: 'invalid', reason: 'price_not_payable' };
      if (!sameRequest(credential, request(minor.amount, resolved.price.currency))) {
        return { status: 'invalid', reason: 'challenge_terms_mismatch' };
      }

      const { spt } = credential.payload;
      if (typeof spt !== 'string' || !/^spt_[A-Za-z0-9_]+$/.test(spt)) return { status: 'invalid', reason: 'invalid_payload' };

      const challengeId = credential.challenge.id;
      tokens.set(context.requestId, { spt, expiresAt: Date.parse(credential.challenge.expires) });
      return {
        status: 'valid',
        proofId: challengeId,
        // An SPT does not identify the payer before it is charged; the challenge is the only stable handle.
        payer: `stripe:${challengeId}`,
        quote: resolved.quote,
        limit: resolved.price,
        expiresAt: new Date(Date.parse(credential.challenge.expires)),
        data: { challengeId, amount: minor.amount.toString(), currency: resolved.price.currency.toLowerCase() },
        // A challenge is issued for one 402 and paid once: every retry of that credential is the same
        // logical request, the same key Stripe deduplicates the PaymentIntent on.
        idempotencyKey: challengeId,
      };
    },

    async settle(authorization, charge, operation) {
      const data = stripeData(authorization);
      const entry = tokens.get(charge.requestId);
      if (entry === undefined) {
        throw new TollstileError(
          'PROVIDER_UNAVAILABLE',
          `The shared payment token for ${authorization.id} is not held by this process, so ${charge.id} cannot be settled here. Reconciliation will look it up.`,
        );
      }

      const body = new URLSearchParams({
        amount: data.amount,
        currency: data.currency,
        confirm: 'true',
        'automatic_payment_methods[enabled]': 'true',
        'automatic_payment_methods[allow_redirects]': 'never',
        'metadata[challenge_id]': data.challengeId,
        'metadata[tollstile_authorization]': authorization.id,
      });
      body.set(sptParameter, entry.spt);

      const response = await stripeCall(stripe, {
        method: 'POST',
        path: '/v1/payment_intents',
        body,
        // One key per challenge, not per charge: a retry of the same credential after a released
        // charge must replay the PaymentIntent, never create a second one.
        idempotencyKey: `${IDEMPOTENCY_PREFIX}${data.challengeId}`,
        signal: operation.signal,
      });
      if (!response.ok) return { status: 'rejected', reason: response.code };

      const intent = parsePaymentIntent(response.body);
      if (intent === undefined) throw new TollstileError('PROVIDER_TIMEOUT', 'Stripe returned a PaymentIntent without id or status.');
      if (IN_FLIGHT.has(intent.status)) {
        throw new TollstileError('PROVIDER_TIMEOUT', `PaymentIntent for ${charge.id} is ${intent.status}; its outcome is not final yet.`);
      }
      if (intent.status !== 'succeeded') return { status: 'rejected', reason: `payment_intent_${intent.status}` };
      if (String(intent.amount) !== data.amount || intent.currency !== data.currency) {
        throw new TollstileError('LEDGER_INCONSISTENT', `PaymentIntent ${intent.id} does not match the amount recorded for ${charge.id}.`);
      }
      return settled(intent, response.replayed);
    },

    async refund(authorization, charge, operation) {
      const data = stripeData(authorization);
      const paymentIntent = charge.settlement?.reference;
      if (paymentIntent === undefined) {
        throw new TollstileError('LEDGER_INCONSISTENT', `Charge ${charge.id} has no PaymentIntent to refund.`);
      }
      const response = await stripeCall(stripe, {
        method: 'POST',
        path: '/v1/refunds',
        body: new URLSearchParams({
          payment_intent: paymentIntent,
          amount: data.amount,
          'metadata[tollstile_charge]': charge.id,
          'metadata[challenge_id]': data.challengeId,
        }),
        idempotencyKey: operation.key,
        signal: operation.signal,
      });
      if (!response.ok) return { status: 'rejected', reason: response.code };
      const refund = parseRefund(response.body);
      if (refund === undefined) throw new TollstileError('PROVIDER_TIMEOUT', 'Stripe returned a refund without id or status.');
      return refund.status === 'succeeded' || refund.status === 'pending'
        ? { status: 'refunded', reference: refund.id }
        : { status: 'rejected', reason: `refund_${refund.status}` };
    },

    release(_authorization, charge) {
      // Stripe has nothing to cancel: a released upfront charge had no PaymentIntent that lookup could find.
      tokens.delete(charge.requestId);
      return Promise.resolve();
    },

    async lookup(authorization, charge, operation) {
      const data = stripeData(authorization);
      const intent = await findPaymentIntent(stripe, data, charge, operation.signal);
      if (intent === undefined) {
        if (clock.now().getTime() - charge.updatedAt.getTime() < searchLagMs) {
          throw new TollstileError(
            'PROVIDER_TIMEOUT',
            `No PaymentIntent is searchable yet for ${charge.id}; Stripe Search can lag, so the answer waits until ${String(searchLagMs)}ms have passed.`,
          );
        }
        return { status: 'none' };
      }
      if (IN_FLIGHT.has(intent.status)) {
        throw new TollstileError('PROVIDER_TIMEOUT', `PaymentIntent for ${charge.id} is still ${intent.status}.`);
      }
      if (intent.status !== 'succeeded') return { status: 'none' };
      return (await findRefund(stripe, intent, charge, operation.signal)) ?? settled(intent, false);
    },

    receipt(authorization, charge, context) {
      return paymentReceipt(context, {
        method: METHOD,
        reference: charge.settlement?.reference ?? charge.id,
        settledAt: charge.updatedAt,
        challengeId: stripeData(authorization).challengeId,
      });
    },
  };
}

async function findPaymentIntent(
  stripe: StripeConfig,
  data: MppStripeData,
  charge: Charge,
  signal: AbortSignal,
): Promise<PaymentIntent | undefined> {
  const known = charge.settlement?.reference;
  if (known !== undefined) {
    const response = await stripeCall(stripe, { method: 'GET', path: `/v1/payment_intents/${encodeURIComponent(known)}`, signal });
    if (!response.ok) throw new TollstileError('PROVIDER_UNAVAILABLE', `Stripe could not return the PaymentIntent of ${charge.id} (${response.code}).`);
    return readIntent(response.body);
  }

  // The PaymentIntent id is unknown when settlement timed out, so search by the challenge id the
  // rail wrote into its metadata. Challenge ids are base64url and need no escaping.
  const query = new URLSearchParams({ query: `metadata['challenge_id']:'${data.challengeId}'`, limit: '10' });
  const response = await stripeCall(stripe, { method: 'GET', path: `/v1/payment_intents/search?${query.toString()}`, signal });
  if (!response.ok) throw new TollstileError('PROVIDER_UNAVAILABLE', `Stripe Search failed for ${charge.id} (${response.code}).`);
  const items = listData(response.body);
  if (items === undefined) throw new TollstileError('PROVIDER_UNAVAILABLE', 'Stripe Search returned an unexpected shape.');
  const intents = items.map(readIntent).filter((intent) => metadataMatches(items, intent, data.challengeId));
  return intents.find((intent) => intent.status === 'succeeded') ?? intents[0];
}

async function findRefund(
  stripe: StripeConfig,
  intent: PaymentIntent,
  charge: Charge,
  signal: AbortSignal,
): Promise<LookupResult | undefined> {
  const query = new URLSearchParams({ payment_intent: intent.id, limit: '100' });
  const response = await stripeCall(stripe, { method: 'GET', path: `/v1/refunds?${query.toString()}`, signal });
  if (!response.ok) throw new TollstileError('PROVIDER_UNAVAILABLE', `Stripe could not list refunds for ${charge.id} (${response.code}).`);
  const items = listData(response.body);
  if (items === undefined) throw new TollstileError('PROVIDER_UNAVAILABLE', 'Stripe returned an unexpected refund list.');
  for (const item of items) {
    const refund = parseRefund(item);
    if (refund === undefined || metadataOf(item).tollstile_charge !== charge.id) continue;
    if (refund.status === 'succeeded' || refund.status === 'pending') return { status: 'refunded', reference: refund.id };
  }
  return undefined;
}

function readIntent(body: JsonObject): PaymentIntent {
  const intent = parsePaymentIntent(body);
  if (intent === undefined) throw new TollstileError('PROVIDER_UNAVAILABLE', 'Stripe returned a PaymentIntent without id or status.');
  return intent;
}

/** Search results are re-checked: the rail trusts the metadata it wrote, not the query engine. */
function metadataMatches(items: readonly JsonObject[], intent: PaymentIntent, challengeId: string): boolean {
  const item = items.find((candidate) => candidate.id === intent.id);
  return item !== undefined && metadataOf(item).challenge_id === challengeId;
}

function settled(intent: PaymentIntent, replayed: boolean) {
  return {
    status: 'settled',
    reference: intent.id,
    details: { paymentIntent: intent.id, amount: intent.amount, currency: intent.currency, replayed },
  } as const;
}

/** `undefined` when Stripe cannot charge the price: unsupported currency, below the minimum, or finer than the minor unit. */
function minorUnits(price: Money): { readonly amount: bigint; readonly scale: number } | undefined {
  const currency = CURRENCIES[price.currency];
  if (currency === undefined) return undefined;
  const divisor = 10n ** BigInt(6 - currency.scale);
  if (price.micros % divisor !== 0n) return undefined;
  const amount = toAssetUnits(price, currency.scale);
  return amount < currency.minimum ? undefined : { amount, scale: currency.scale };
}

function stripeData(authorization: Authorization): MppStripeData {
  const { data } = authorization;
  if (
    !isObject(data) ||
    typeof data.challengeId !== 'string' ||
    !isIntegerString(data.amount) ||
    typeof data.currency !== 'string'
  ) {
    throw new TollstileError('LEDGER_INCONSISTENT', `Authorization ${authorization.id} does not hold mpp-stripe data.`);
  }
  return { challengeId: data.challengeId, amount: data.amount, currency: data.currency };
}
