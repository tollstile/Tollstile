# Tollstile Core Design

This document defines the core model: the concepts, their states, how flows compose them, and the contracts rails, policies, ledgers, and adapters implement. The TypeScript definitions in [`packages/tollstile/src/core/types.ts`](./packages/tollstile/src/core/types.ts) are authoritative; the snippets here are abridged. [PHILOSOPHY.md](./PHILOSOPHY.md) explains why; [CODING_RULES.md](./CODING_RULES.md) explains how code is written.

## Why this model

Per-call payment protocols are not "one request, one payment":

- **x402** defines several flows — `authorization` (verify → resource → settle), `upfront` (settle → resource), and `escrow` (settle → resource → settle).
- **L402** credentials are paid before they are presented and are reusable until they expire.
- **KYAPay** tokens are funded holds that can be charged many times, partially, until exhausted.
- **MPP sessions** authorize once and are drawn down by many calls.
- **AP2 and Visa TAP** require the verifier to issue nonces and reject reuse.

So the core separates **what was offered** (Quote), **what the payer authorized** (Authorization), **each economic effect against it** (Charge), and **whether the service was delivered** (the fulfillment axis of a Charge).

```
                         route: price + access + requirements + flow
                                           │
            no valid payment ──────────────┼────────────── valid proof
                   │                                            │
                   ▼                                            ▼
      Quote (signed, never stored)                  Authorization (stored)
      price · offers · expiry · nonce                rail · payer · limit · kind
                   │                                            │ 1..n
                   └──── echoed back inside the proof ──────────▼
                                                    Charge (stored)
                                          payment axis     ×   fulfillment axis
```

---

## Money

```ts
type Money = { currency: string; micros: bigint };   // $0.04 → { currency: "USD", micros: 40000n }
```

- Integers only, in millionths of the currency's major unit — a fixed scale of 6. That covers sub-cent prices and 6-decimal stablecoins, keeps ledger sums trivial, and nothing ever becomes a float. Amounts with more than 6 decimals are refused.
- `price("$0.04")` is the public spelling; it parses once into `Money`.
- **Price and settlement asset are different things.** A route is priced in a currency (USD). A rail settles in an asset (USDC on Base, sats, card USD). Each rail turns the price into an **Offer** in its own asset.
- Tollstile never converts currencies. When a rail settles in an asset that is not the price currency, the conversion basis is explicit in the rail's configuration (`denomination: "USD"` for a USD stablecoin at par, or a merchant-supplied `rate` function) and is recorded on the Offer.

```ts
type Offer = {
  rail: string;
  asset: { code: string; network?: string; scale: number };  // USDC · eip155:8453 · 6
  amount: string;                                            // integer, in asset units
  basis: "par" | "rate";
  flow: Flow;
};
```

---

## Quote

A Quote is what the server offered. It is **immutable**, **signed**, and **never written to storage** — writing on unauthenticated requests would let anyone fill the ledger.

```ts
type Quote = {
  id: string;             // random
  resource: string;
  commitment: string;     // hash of what the quote was priced for; see Request commitment
  price: Money;
  variable: boolean;      // price is a maximum
  offers: Offer[];
  nonce: string;          // for protocols that bind evidence to a verifier nonce (AP2, TAP)
  issuedAt: number;
  expiresAt: number;
};
```

- Serialized as a compact token: `base64url(json).base64url(hmac-sha256(secret, json))`. The secret is configuration; multiple secrets allow rotation.
- Rails carry the quote token inside their own protocol where it is echoed and bound — MPP `opaque`, x402 `extra`, L402 macaroon caveat, test rail `quote=` parameter — and return it from `verify`.
- When a proof carries a quote, core checks the signature, expiry, resource, and commitment, and **charges the quoted price, not a recomputed one.** This makes dynamic prices safe across the 402 → retry gap.
- Rails that cannot carry a quote declare `capabilities.quotes: false`. They can serve fixed-price routes only; a dynamic-price route with such a rail is refused at startup.

### Request commitment

A price computed from the request is only as good as the request it was computed for. Without a binding, a payer could quote `POST /translate {"text":"hello"}` and spend that quote on a million-word body. So every quote commits to its request, and a proof whose request no longer matches is refused with `402 quote_mismatch` and a fresh quote, before any authorization or charge is written.

| `commit` | Bound to | Default for |
|---|---|---|
| `"request"` | method, resource, path and query, SHA-256 of the exact body bytes; for MCP, tool name and canonical (sorted-key) arguments instead of the JSON-RPC envelope | dynamic prices |
| `"route"` | method and resource | fixed prices, which cannot depend on the request |
| `(context) => string` | method, resource, and the returned value, e.g. canonical pricing fields | routes whose clients re-serialize bodies |

- The commitment is computed by core, never supplied by the client. The price function and a custom `commit` receive a clone of the request, so the handler can still read the body. A body already consumed before Tollstile runs is a configuration error.
- A custom `commit` must cover every input the price depends on. Anything left out can be changed after quoting.
- **Reusable authorizations** (L402, KYAPay, test rail `reusable`) outlive a single request. For them the quote only establishes the offer: each request is charged its own current price against the authorization's limit, and the commitment is not compared. Single authorizations always pay the quoted price and must match the commitment.

---

## Authorization

What the payer authorized, created when a rail verifies a proof.

```ts
type Authorization = {
  id: string;             // derived from rail + proofId → replay protection and idempotency
  rail: string;
  payer: string;
  kind: "single" | "reusable";
  limit: Money;           // price for single; token balance, channel deposit, or credential value for reusable
  consumed: Money;        // committed charges
  reserved: Money;        // in-flight charges
  quoteId: string | null;
  expiresAt: Date | null;
  data: Json;             // rail-specific, everything needed to settle, refund, and look up later
};
```

- **single** (x402 exact, MPP charge): at most one non-released charge at a time. If every charge on it was released — the handler failed before anything settled — the same proof can be presented again. That is how a retry after failure works without charging twice.
- **reusable** (L402, KYAPay, MPP session, credits): many charges until `limit` is consumed or `expiresAt` passes.
- Opening an authorization that already exists returns the stored one; this is both replay protection (single, already consumed) and reuse (reusable, still active).

---

## Charge — two axes

One economic effect against an authorization, plus the delivery of the service it pays for.

```
payment axis
  reserved ──► settling ──► settled ──► refund_pending ──► refunded
     │            │  ▲                      │
     │            ▼  │                      ▼
     │         unknown (pending: settle | refund) ── resolved by lookup
     │            │
     ▼            ▼
  released     failed

fulfillment axis
  pending ──► running ──► completed
                 │
                 ▼
               failed
```

```ts
type Charge = {
  id: string;
  authorizationId: string;
  requestId: string;
  resource: string;
  reservedAmount: Money;      // held on the authorization while in flight
  amount: Money;              // charged: the reserved amount, or the fulfilled amount on variable routes
  flow: Flow;
  payment: "reserved" | "settling" | "settled" | "failed" | "unknown" | "released" | "refund_pending" | "refunded";
  pending: "settle" | "refund" | null;
  fulfillment: "pending" | "running" | "completed" | "failed";
  settlement: { reference: string; details: Json } | null;
  refundReference: string | null;
  createdAt: Date;
  updatedAt: Date;
};
```

- Creating a charge **reserves** capacity on the authorization atomically. Settling commits it; releasing returns it.
- Every provider call is preceded by a write (`settling`, `refund_pending`) and followed by one. Retries reuse the charge's idempotency keys.
- Writes are combined where it is safe: `reserved + running` is one write before the handler; `completed + settling` is one write before settlement. The authorization flow costs three writes per paid call.

---

## Flows

A flow is the order in which the two axes advance. Rails declare which flows they support; a route picks one (or core picks the first the rail supports, in the order below).

| Flow | Order | Handler fails | Used by |
|---|---|---|---|
| `authorization` | reserve · run · complete · settle | release — nothing moved | x402 exact/upto, KYAPay, MPP session, L402 (consume), credits |
| `upfront` | reserve · settle · run · complete | refund (requires `refund`) | MPP Stripe charge; payments that move during verification (MPP Tempo push) |
| `escrow` | reserve · settle deposit · run · complete · settle final or partial refund | refund the deposit | x402 escrow, deposit-based APIs — **in the model, not implemented yet**; routes that ask for it are refused at startup |

- `authorization` is preferred: the payer is charged only for work that ran.
- A variable price (`upTo`) needs `authorization` or `escrow` and a rail with `variableAmount`.
- Explicit fulfillment: `payment.fulfill({ amount })` marks `completed` at the point the service exists; after that, a later handler failure does not undo the charge.
- **Paid at verification.** A rail whose payment already moved when it verified (a pushed on-chain transfer) returns `settled` from `verify`. Core records the charge as `upfront`, settled before the handler. If the handler fails, core refunds when the rail can; otherwise the charge stays `settled/failed`, an error event asks the merchant to refund outside Tollstile, and reconciliation leaves it alone.

### Completion

`pass.complete(outcome)` is called once after the handler and reports what happened to the money:

```ts
type Completion = {
  settlement: "settled" | "rejected" | "unknown" | "none";
  receipt: Receipt;          // attach when settled
  denial: Denial | null;     // set when rejected: a fresh 402 that replaces the output
};
```

| settlement | Adapter does |
|---|---|
| `settled` | serves the output with the receipt |
| `rejected` | withholds the output and sends `denial` (reason `settlement_rejected`; without a new quote if the handler already read the body) |
| `unknown` | serves the output without a receipt; reconciliation resolves the charge |
| `none` | serves the handler's own result; nothing was charged |

Withholding on `unknown` would be wrong: a charge that later reconciles as settled would have been paid for a service never delivered. If recording the outcome itself fails (the ledger is down), core emits an `error` event and rethrows.

---

## Access policies and reservations

Policies decide *whether* a caller pays. Policies that move value implement **reserve → commit / release**, recorded in the ledger like a charge:

```ts
type AccessPolicy = {
  name: string;
  balance?: Balance;                                  // required for reserve decisions
  evaluate(context: Context, price: Money): Promise<AccessDecision>;
};

type AccessDecision =
  | { kind: "skip" }
  | { kind: "pay" }                                   // use a rail
  | { kind: "grant"; account: string }                // free, e.g. subscriber
  | { kind: "reserve"; account: string };             // credits, from the policy's balance

type Balance = {
  reserve(account: string, amount: Money, key: string): Promise<"reserved" | "insufficient">;
  commit(key: string): Promise<void>;
  release(key: string): Promise<void>;
  status(key: string): Promise<"reserved" | "committed" | "released" | "none">;
};
```

A `reserve` decision creates a charge against a `reusable` authorization for the account (rail name `policy:<name>`). A crash between reserve and commit leaves a `reserved` charge that reconciliation commits or releases using `status` and the fulfillment axis.

---

## Requirements

Conditions every admitted request must meet — after the payer is known, before anything is reserved.

```ts
type Requirement = {
  name: string;
  check(input: { context: Context; price: Money; payer: string; quote: Quote | null; ledger: LedgerReader; claims: Claims; now: Date; signal: AbortSignal }):
    Promise<{ ok: true } | { ok: false; status: 402 | 403 | 429 | 503; reason: string }>;
};
```

A requirement that cannot check its evidence right now (an agent key directory is down) returns `503` or throws `PROVIDER_UNAVAILABLE` / `PROVIDER_TIMEOUT`, which core answers with `503 requirement_unavailable`. A temporary outage must not look like a permanent `403`.

`claims` is a single-use store for nonces and replay windows (Visa TAP nonces, AP2 KB-JWT nonces, MPP challenge ids): `claim(scope, key, expiresAt) → "claimed" | "exists"`.

---

## Context

Core never sees a framework object.

```ts
type Context = {
  transport: "http" | "mcp";
  request: Request | null;          // Web standard; null for MCP calls without an HTTP carrier
  mcp: { tool: string; arguments: Json; meta: JsonObject; clientCapabilities: JsonObject } | null;
  principal: { id: string; [key: string]: Json } | null;   // resolved by the adapter from your auth
  resource: string;
  requestId: string;
  extras: unknown;                  // the framework object, for escape hatches only
};
```

---

## Rail contract

`packages/tollstile/src/core/types.ts` is authoritative.

```ts
type Rail<Name, Data> = {
  name: Name;
  livemode: boolean;
  capabilities: { flows: Flow[]; authorization: "single" | "reusable"; variableAmount: boolean; quotes: boolean; refund: boolean; partialRefund: boolean; lookup: boolean };
  offer(terms: { resource; price: Money; variable: boolean }): Promise<Offer | null>;       // null: cannot serve this price
  challenge(quote: Quote, quoteToken: string, offer: Offer, context: Context, operation: Operation): Promise<RailChallenge>;
  verify(context: Context, terms: VerifyTerms, operation: Operation): Promise<Verification<Data>>;
                     // absent | invalid{reason} | valid{proofId, payer, quote, limit, expiresAt, data, settled?}
  settle(authorization, charge, operation): Promise<SettleResult>;
  refund(authorization, charge, operation): Promise<RefundResult>;
  release(authorization, charge, operation): Promise<void>;
  lookup(authorization, charge, operation): Promise<LookupResult>;
  receipt(authorization, charge, context): Receipt;
  redact?(data: Data): Data;          // drop payer evidence once a single-use charge is final
};
```

- `lookup: false` is refused at startup: without it, an ambiguous outcome cannot be resolved without guessing.
- `upfront` without `refund` is refused at startup.
- Throwing `PROVIDER_UNAVAILABLE` / `PROVIDER_TIMEOUT` means "outcome unknown"; everything else is a value.
- A provider failure in `challenge` (e.g. a Lightning node that cannot issue an invoice) omits that rail's offer from the 402. If no rail can offer, the answer is `503 payment_unavailable`.
- `redact` runs after a charge on a single-use authorization reaches a terminal state other than `released` (a released proof may be presented again, and its evidence lapses at the proof's own expiry); what remains must still serve `lookup` and `refund`. It is not atomic with the transition: a crash in between leaves the evidence until the next redaction.

---

## Ledger contract

```ts
type Ledger = LedgerReader & {
  openAuthorization(input: NewAuthorization): Promise<Authorization>;          // insert or return existing
  createCharge(input: NewCharge): Promise<{ status: "created"; charge: Charge; authorization: Authorization } | { status: "insufficient" | "busy" | "inactive" }>;
  transitionCharge(id: string, from: ChargeStates, to: ChargeStates, at: Date, patch?: ChargePatch): Promise<{ status: "moved"; charge: Charge; authorization: Authorization } | { status: "conflict"; charge: Charge | undefined }>;
  replaceAuthorizationData(id: string, data: Json, at: Date): Promise<void>;
  pendingCharges(before: Date): Promise<Charge[]>;
  claim(scope: string, key: string, expiresAt: Date): Promise<"claimed" | "exists">;
};
```

- An authorization holds one currency. A charge or patched amount in another currency is rejected with `CURRENCY_MISMATCH`; amounts outside `0..2^63−1` micros with `INVALID_AMOUNT`. `spendSince` totals are sorted by currency code. The memory, Postgres, and SQLite ledgers share one conformance suite.

- `createCharge` atomically checks the authorization is active, has capacity (`limit − consumed − reserved ≥ amount`), and — for `single` — has no other non-released charge.
- `transitionCharge` is compare-and-set on both axes and updates the authorization's `reserved`/`consumed` in the same transaction.
- The ledger is the merchant's **operational** record. The payment network or provider is the final authority on whether money moved; reconciliation keeps the two in agreement.

---

## Reconciliation

`toll.reconcile({ olderThanMs })` examines non-terminal charges older than the window:

| Payment | Fulfillment | Action |
|---|---|---|
| reserved | pending / running / failed | release — the service may not exist |
| reserved | completed | settle (authorization, escrow final) |
| settling / unknown(settle) | any | lookup → settled, or retry / release |
| settled | not completed (upfront, escrow) | refund — the service may not exist; skipped and reported when the rail cannot refund |
| refund_pending / unknown(refund) | any | lookup → refunded, or retry |

Run it on a schedule: a cron trigger on Workers, an interval in Node, or `npx tollstile reconcile` with a ledger config. The window must exceed your slowest handler.

---

## Events

`onEvent(event)` receives typed events — `quote.issued`, `authorization.opened`, `charge.moved`, `request.denied`, `error` — with stable fields suitable for logs, metrics, and OpenTelemetry spans.
