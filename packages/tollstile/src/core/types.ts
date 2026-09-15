import type { DenialCode, DenialError } from './denials';
import type { Money } from './money';
import type { ChargeStates, Flow, FulfillmentState, PaymentState, PendingOperation } from './states';

export type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };
export type JsonObject = { readonly [key: string]: Json };
export type Header = readonly [name: string, value: string];
export type Clock = { now(): Date };
export type Transport = 'http' | 'mcp';

// ─── Context ──────────────────────────────────────────────────────────────────

export type Principal = { readonly id: string } & JsonObject;

/** One inbound request for a priced resource. Core never sees a framework object. */
export type Context = {
  readonly transport: Transport;
  /** The HTTP request. `null` for MCP calls that arrive without an HTTP carrier. */
  readonly request: Request | null;
  readonly mcp: {
    readonly tool: string;
    /** The tool call's arguments. Part of the quote commitment on dynamic routes. */
    readonly arguments: Json;
    readonly meta: JsonObject;
    readonly clientCapabilities: JsonObject;
  } | null;
  /** The caller as resolved by your authentication, if any. */
  readonly principal: Principal | null;
  readonly resource: string;
  /** Unique per inbound request. */
  readonly requestId: string;
  /**
   * The client's idempotency key: the `Idempotency-Key` header, or `_meta["tollstile/idempotency-key"]`.
   * Retries with the same key and proof find the same charge instead of paying again. See SPEC.md §11.
   */
  readonly idempotencyKey: string | null;
  /** The framework object. An escape hatch; prefer `request` and `principal`. */
  readonly extras: unknown;
};

// ─── Offers and quotes ────────────────────────────────────────────────────────

export type Asset = {
  readonly code: string;
  readonly network: string | null;
  /** Decimal places of the asset's smallest unit. */
  readonly scale: number;
};

/** What a rail asks for to cover a price, in its own asset. */
export type Offer = {
  readonly rail: string;
  readonly asset: Asset;
  readonly amount: string;
  /** `par`: a stablecoin or same-currency asset at 1:1. `rate`: converted by a merchant-supplied rate. */
  readonly basis: 'par' | 'rate';
  readonly flow: Flow;
  readonly details: JsonObject;
};

/** What the server offered. Immutable, signed, and never stored. */
export type Quote = {
  readonly id: string;
  readonly resource: string;
  /** Binds the quote to the request it priced. See `Commitment`. */
  readonly commitment: string;
  readonly price: Money;
  readonly variable: boolean;
  readonly offers: readonly Offer[];
  /** A fresh value for protocols that bind evidence to a verifier nonce. */
  readonly nonce: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
};

export type RouteTerms = {
  readonly resource: string;
  readonly price: Money;
  readonly variable: boolean;
  readonly flow: Flow;
};

// ─── Authorizations and charges ───────────────────────────────────────────────

export type AuthorizationKind = 'single' | 'reusable';

export type Authorization = {
  readonly id: string;
  readonly rail: string;
  readonly payer: string;
  readonly kind: AuthorizationKind;
  /** `null` when capacity is enforced elsewhere, e.g. by a credit balance. */
  readonly limit: Money | null;
  readonly consumed: Money;
  readonly reserved: Money;
  readonly quoteId: string | null;
  readonly expiresAt: Date | null;
  readonly data: Json;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type Settlement = {
  readonly reference: string;
  readonly details: Json;
};

export type Charge = {
  readonly id: string;
  readonly authorizationId: string;
  readonly requestId: string;
  readonly resource: string;
  readonly payer: string;
  readonly flow: Flow;
  /** Capacity held on the authorization while the charge is in flight. */
  readonly reservedAmount: Money;
  /** The amount charged: the reserved amount, or the fulfilled amount on variable routes. */
  readonly amount: Money;
  readonly payment: PaymentState;
  readonly fulfillment: FulfillmentState;
  readonly pending: PendingOperation | null;
  readonly settlement: Settlement | null;
  readonly refundReference: string | null;
  /** Hash of the request an idempotency key was first used with; `null` without a key. */
  readonly requestHash: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type NewAuthorization = Omit<Authorization, 'consumed' | 'reserved' | 'createdAt' | 'updatedAt'> & {
  readonly at: Date;
};

export type NewCharge = {
  readonly id: string;
  readonly authorizationId: string;
  readonly requestId: string;
  readonly resource: string;
  readonly payer: string;
  readonly flow: Flow;
  readonly amount: Money;
  readonly fulfillment: FulfillmentState;
  readonly requestHash: string | null;
  readonly at: Date;
};

export type ChargePatch = {
  readonly amount?: Money;
  readonly pending?: PendingOperation | null;
  readonly settlement?: Settlement;
  readonly refundReference?: string;
};

export type CreateChargeResult =
  | { readonly status: 'created'; readonly charge: Charge; readonly authorization: Authorization }
  | { readonly status: 'exists'; readonly charge: Charge }
  | { readonly status: 'busy' | 'insufficient' | 'expired' | 'missing' };

export type TransitionResult =
  | { readonly status: 'moved'; readonly charge: Charge; readonly authorization: Authorization }
  | { readonly status: 'conflict'; readonly charge: Charge | undefined };

// ─── Ledger ───────────────────────────────────────────────────────────────────

export type LedgerReader = {
  getAuthorization(id: string): Promise<Authorization | undefined>;
  getCharge(id: string): Promise<Charge | undefined>;
  /** Charges by a payer since a point in time that are not released, failed, or refunded. Totals are sorted by currency code. */
  spendSince(payer: string, since: Date): Promise<{ readonly count: number; readonly total: readonly Money[] }>;
};

export type Claims = {
  /** Records `key` in `scope` until `expiresAt`. Returns `exists` if it is already recorded. */
  claim(scope: string, key: string, expiresAt: Date): Promise<'claimed' | 'exists'>;
};

/**
 * The merchant's operational record. The provider is the final authority on whether money moved;
 * reconciliation keeps the two in agreement.
 */
export type Ledger = LedgerReader &
  Claims & {
    /** Inserts the authorization, or returns the existing one with the same id. */
    openAuthorization(input: NewAuthorization): Promise<{ readonly created: boolean; readonly authorization: Authorization }>;
    /**
     * Atomically reserves `amount` on the authorization. Returns `busy` when a single-use
     * authorization already has a charge that was not released, `insufficient` when the limit
     * would be exceeded, and `expired` when the authorization has expired.
     */
    createCharge(input: NewCharge): Promise<CreateChargeResult>;
    /** Compare-and-set on both axes; updates the authorization's reserved and consumed amounts in the same step. */
    transitionCharge(id: string, from: ChargeStates, to: ChargeStates, at: Date, patch?: ChargePatch): Promise<TransitionResult>;
    /** Replaces an authorization's rail data, e.g. to drop a signature once it can no longer be used. */
    replaceAuthorizationData(id: string, data: Json, at: Date): Promise<void>;
    /** Charges that are not terminal and were last updated before `before`. */
    pendingCharges(before: Date): Promise<readonly Charge[]>;
  };

// ─── Rails ────────────────────────────────────────────────────────────────────

export type Capabilities = {
  readonly flows: readonly Flow[];
  readonly authorization: AuthorizationKind;
  readonly variableAmount: boolean;
  /** The rail carries a signed quote through its protocol and returns it from `verify`. */
  readonly quotes: boolean;
  readonly refund: boolean;
  readonly partialRefund: boolean;
  /** The rail can ask its provider what happened to a charge. Required. */
  readonly lookup: boolean;
};

export type Operation = {
  /** Idempotency key. Reusing it must never produce a second economic effect. */
  readonly key: string;
  readonly signal: AbortSignal;
};

export type RailChallenge = {
  readonly headers: readonly Header[];
  /** Included in Tollstile's 402 body. */
  readonly accepts: Json;
  /**
   * The rail's MCP payment-required payload. `style` names the MCP payment convention the rail
   * follows; the MCP adapter renders the styles it knows and falls back to Tollstile's `_meta` form.
   */
  readonly mcp: JsonObject & { readonly style: string };
};

export type VerifyTerms = {
  readonly resource: string;
  /** The route's price when it is fixed. `null` on dynamic routes, where the proof must carry a quote. */
  readonly price: Money | null;
  readonly variable: boolean;
  readonly flow: Flow;
  /** Opens a quote token the proof carried. `undefined` when it is forged, expired, or for another resource. */
  openQuote(token: string): Promise<Quote | undefined>;
};

export type Verification<Data extends Json = Json> =
  | { readonly status: 'absent' }
  | {
      readonly status: 'invalid';
      readonly reason: string;
      /**
       * Set when the proof is well-formed and identifies what it paid for, even though it can no longer
       * be accepted (e.g. the provider says its nonce was already used). Core then answers a retry of a
       * request that was already paid from the ledger, instead of asking the client to pay again.
       */
      readonly proofId?: string;
      /** The proof's protocol payment identifier, as on a valid result. */
      readonly idempotencyKey?: string;
    }
  | {
      readonly status: 'valid';
      /** Stable for the same proof. Authorizations are keyed by rail + proofId. */
      readonly proofId: string;
      readonly payer: string;
      /** The quote the proof was made against, when the rail carries quotes. */
      readonly quote: Quote | null;
      readonly limit: Money | null;
      readonly expiresAt: Date | null;
      readonly data: Data;
      /**
       * Set when the payment already moved during verification, e.g. a transfer the payer pushed
       * on-chain. Core records the charge as settled before the handler runs; if the handler fails,
       * it is refunded when the rail can refund, and otherwise stays settled and is reported.
       */
      readonly settled?: Settlement;
      /** A payment identifier from the protocol, used as the idempotency key when the client sent none. */
      readonly idempotencyKey?: string;
    };

export type SettleResult =
  | ({ readonly status: 'settled' } & Settlement)
  | { readonly status: 'rejected'; readonly reason: string };

export type RefundResult =
  | { readonly status: 'refunded'; readonly reference: string }
  | { readonly status: 'rejected'; readonly reason: string };

export type LookupResult =
  | ({ readonly status: 'settled' } & Settlement)
  | { readonly status: 'refunded'; readonly reference: string }
  | { readonly status: 'none' };

export type Receipt = {
  readonly headers: readonly Header[];
  readonly meta: JsonObject;
};

/**
 * How a payment is made and proven. Rails throw `TollstileError` with `PROVIDER_UNAVAILABLE` or
 * `PROVIDER_TIMEOUT` when an outcome is unknown; every other outcome is a returned value.
 */
export type Rail<Name extends string = string, Data extends Json = Json> = {
  readonly name: Name;
  /** False for rails that never move real money. */
  readonly livemode: boolean;
  readonly capabilities: Capabilities;
  /** The offer that covers `terms.price`, or `null` if this rail cannot serve it (e.g. below a minimum). */
  offer(terms: Omit<RouteTerms, 'flow'>): Promise<Omit<Offer, 'flow'> | null>;
  /** May call the provider, e.g. to create an invoice. A provider failure omits this rail's offer from the 402. */
  challenge(quote: Quote, quoteToken: string, offer: Offer, context: Context, operation: Operation): Promise<RailChallenge>;
  verify(context: Context, terms: VerifyTerms, operation: Operation): Promise<Verification<Data>>;
  settle(authorization: Authorization & { readonly data: Data }, charge: Charge, operation: Operation): Promise<SettleResult>;
  refund(authorization: Authorization & { readonly data: Data }, charge: Charge, operation: Operation): Promise<RefundResult>;
  /** Tells the provider the reserved amount will not be charged. Nothing has moved; failures are reported, not recorded. */
  release(authorization: Authorization & { readonly data: Data }, charge: Charge, operation: Operation): Promise<void>;
  lookup(authorization: Authorization & { readonly data: Data }, charge: Charge, operation: Operation): Promise<LookupResult>;
  receipt(authorization: Authorization & { readonly data: Data }, charge: Charge, context: Context): Receipt;
  /**
   * Drops what a single-use authorization no longer needs once its charge is settled, failed, or
   * refunded, such as a payer signature. Not called on `released`: the same proof may be presented
   * again. What remains must still serve `lookup` and `refund`.
   */
  redact?(data: Data): Data;
};

// ─── Access policies and requirements ─────────────────────────────────────────

/** A balance that reserves before charging, so a crash never loses or double-spends value. */
export type Balance = {
  reserve(account: string, amount: Money, key: string): Promise<'reserved' | 'insufficient'>;
  commit(key: string): Promise<void>;
  release(key: string): Promise<void>;
  status(key: string): Promise<'reserved' | 'committed' | 'released' | 'none'>;
};

export type AccessDecision =
  | { readonly kind: 'skip' }
  | { readonly kind: 'pay' }
  | { readonly kind: 'grant'; readonly account: string }
  | { readonly kind: 'reserve'; readonly account: string };

export type AccessPolicy = {
  readonly name: string;
  /** Required when the policy returns `reserve` decisions, so reconciliation can settle or release them. */
  readonly balance?: Balance;
  evaluate(context: Context, price: Money): Promise<AccessDecision>;
};

export type RequirementInput = {
  readonly context: Context;
  readonly price: Money;
  readonly payer: string;
  readonly quote: Quote | null;
  readonly ledger: LedgerReader;
  readonly claims: Claims;
  readonly now: Date;
  /** Aborted when the provider timeout elapses. */
  readonly signal: AbortSignal;
};

export type RequirementResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 402 | 403 | 429 | 503; readonly reason: string };

/** Throw `PROVIDER_UNAVAILABLE` or `PROVIDER_TIMEOUT` when evidence cannot be checked right now; the request gets `503`. */
export type Requirement = {
  readonly name: string;
  check(input: RequirementInput): Promise<RequirementResult>;
};

// ─── Events ───────────────────────────────────────────────────────────────────

export type TollstileEvent =
  | { readonly type: 'quote.issued'; readonly quote: Quote }
  | { readonly type: 'authorization.opened'; readonly authorization: Authorization; readonly created: boolean }
  | { readonly type: 'charge.moved'; readonly charge: Charge; readonly from: ChargeStates }
  | { readonly type: 'request.denied'; readonly resource: string; readonly status: number; readonly code: DenialCode }
  | { readonly type: 'error'; readonly error: Error; readonly charge: Charge | null };

// ─── Configuration and routes ─────────────────────────────────────────────────

export type TollstileConfig<Rails extends readonly Rail[]> = {
  readonly rails: Rails;
  readonly ledger: Ledger;
  /**
   * Secrets that sign quotes. The first signs; all verify, for rotation. Required with live rails.
   * With only test rails, a random secret is generated on first use, per instance: quotes do not
   * survive a restart or verify across processes (e.g. Workers isolates) without a configured secret.
   */
  readonly secret?: string | readonly string[] | undefined;
  /** How long a quote is honored. Defaults to 5 minutes. */
  readonly quoteTtlMs?: number;
  readonly clock?: Clock;
  /** Upper bound for any single provider call. Defaults to 10 seconds. */
  readonly providerTimeoutMs?: number;
  readonly onEvent?: (event: TollstileEvent) => void;
};

/** A variable price: the payer authorizes `amount`, and the handler settles what it used. */
export type UpTo = { readonly kind: 'up-to'; readonly amount: string };

export type PriceInput = string | UpTo;

/** A price computed per request. It is evaluated when a quote is issued, and the quote fixes it. */
export type DynamicPrice = (context: Context) => PriceInput | Promise<PriceInput>;

/**
 * What a quote is bound to, so it cannot be spent on a different request.
 * - `route`: method and resource. The default for fixed prices, which do not depend on the request.
 * - `request`: method, resource, path, query, and the exact body bytes (or MCP arguments). The default for dynamic prices.
 * - a function: method, resource, and the pricing-relevant input you return, e.g. a canonical subset of the body.
 */
export type Commitment = 'route' | 'request' | ((context: Context) => string | Promise<string>);

export type PriceOptions = {
  /** Defaults to `request` for dynamic prices and `route` for fixed ones. */
  readonly commit?: Commitment;
  /** Tried in order. Omit to require payment from everyone. */
  readonly access?: readonly AccessPolicy[];
  readonly require?: readonly Requirement[];
  /** Omit to use the first flow each rail supports, preferring `authorization`. */
  readonly flow?: Flow;
  /** Overrides the resource name the adapter derives. */
  readonly resource?: string;
};

export type FulfillOptions = {
  /** The final amount on a variable route, e.g. `"$0.12"`. */
  readonly amount?: string;
};

export type RailName<Rails extends readonly Rail[]> = Rails[number]['name'];

export type Payment<Rails extends readonly Rail[]> =
  | {
      readonly via: 'rail';
      readonly rail: RailName<Rails>;
      readonly payer: string;
      readonly authorizationId: string;
      readonly chargeId: string;
      readonly amount: Money;
      fulfill(options?: FulfillOptions): Promise<void>;
    }
  | {
      readonly via: 'policy';
      readonly policy: string;
      readonly account: string;
      readonly chargeId: string | null;
      readonly amount: Money;
      fulfill(options?: FulfillOptions): Promise<void>;
    };

export type Outcome = 'succeeded' | 'failed';

/**
 * What happened to the money after the handler.
 * - `settled`: charged. Attach the receipt.
 * - `rejected`: the provider refused settlement. Withhold the output and send `denial`, a fresh 402.
 * - `unknown`: the outcome is not known yet and reconciliation will resolve it. Serve the output.
 * - `none`: nothing was charged, e.g. the handler failed, a subscriber was granted, or a credit balance paid.
 */
export type Completion = {
  readonly settlement: 'settled' | 'rejected' | 'unknown' | 'none';
  readonly receipt: Receipt;
  readonly denial: Denial | null;
};

export type Pass<Rails extends readonly Rail[]> = {
  readonly payment: Payment<Rails>;
  /** Call exactly once, after the handler, with whether it succeeded. */
  complete(outcome: Outcome): Promise<Completion>;
};

export type ChallengeOffer = {
  readonly offer: Offer;
  readonly challenge: RailChallenge;
};

/** Why a request was not admitted, in a form any transport can render. */
export type Denial = {
  readonly status: number;
  /** Also in `body.error`. */
  readonly error: DenialError;
  readonly body: JsonObject;
  readonly headers: readonly Header[];
  readonly offers: readonly ChallengeOffer[];
};

export type Entry<Rails extends readonly Rail[]> =
  | { readonly kind: 'denied'; readonly denial: Denial }
  | { readonly kind: 'admitted'; readonly pass: Pass<Rails> };

export type Gate<Rails extends readonly Rail[]> = {
  readonly resource: string | undefined;
  enter(context: Context): Promise<Entry<Rails>>;
};
