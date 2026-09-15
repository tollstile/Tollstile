# Tollstile Philosophy

> **Tollstile is the open-source payment middleware for APIs and agent tools.**
>
> Define who pays, how much, and which payment protocols you accept. Tollstile handles verification, replay protection, receipts, and the payment lifecycle — without taking custody of your funds or your data.

This document explains **why Tollstile exists, what it believes, what it guarantees, and what it refuses to become**. When a design decision is unclear, this is the tie-breaker. Code-level rules live in [CODING_RULES.md](./CODING_RULES.md).

---

## The Problem

Software is starting to buy software. Agents call APIs, run tools, and fetch data on behalf of people, and HTTP `402 Payment Required` is finally being used to let a machine pay for a single request.

Protocols such as x402 and MPP define how a payment is requested and proven. That part is being standardized, and it will keep evolving.

What nobody standardizes is everything a **merchant** has to build around it:

- Deciding **who has to pay at all** — subscribers, credit holders, or anonymous agents.
- **Verifying** proofs against the server's own price, and rejecting replays.
- **Settling** at the right moment, and **refunding** when the work didn't happen.
- Surviving **timeouts, retries, and crashes** without charging twice or refunding twice.
- **Recording** every outcome somewhere the business can trust.

Every team rebuilds this. Payment code rebuilt in a hurry is payment code that leaks money.

## What Tollstile Is

Tollstile is a **merchant-side payment runtime**. The protocol is a detail; the lifecycle is the product.

```
                     Tollstile
                         │
      ┌──────────────────┼──────────────────┐
      │                  │                  │
   Access &           Lifecycle           Ledger
   Pricing         verify · settle      receipts ·
 who pays, how    fulfill · refund     replay · state
     much                │
                         │
                   Payment Rails
                  how they pay
                   ┌─────┴─────┐
                 x402         MPP        …
```

```ts
import { createTollstile, subscriber, credits, payPerCall } from "tollstile";
import { x402 } from "@tollstile/x402";
import { mpp } from "@tollstile/mpp";
import { postgresLedger } from "@tollstile/postgres";

const toll = createTollstile({
  rails: [x402(), mpp()],        // how agents can pay
  ledger: postgresLedger(db),    // your source of truth
});

server.tool(
  "generate_image",
  toll.price("$0.04", {
    access: [subscriber(), credits(), payPerCall()],  // who pays, in order
  }),
  async (input, { payment }) => {
    // Runs only when access is granted. `payment` is fully typed.
  },
);
```

The goal is for this line:

```ts
server.tool("generate_image", toll.price("$0.04"), handler);
```

to become as ordinary as this one:

```ts
app.get("/admin", auth(), handler);
```

## What Tollstile Is Not

| Tollstile is not… | Because… |
|---|---|
| **A payment processor** | Settlement is performed by the rail's provider. Tollstile requests it and records the result. |
| **A custodian** | Tollstile never takes custody of funds. Money moves only between the payer, the provider, and you. |
| **A token** | Tollstile will never issue a token, coin, or points currency. |
| **A hosted gateway** | The library runs inside your app. Nothing phones home. |
| **An agent framework** | It sits in front of your handler, not inside your agent. |
| **A dynamic pricing engine** | Tollstile does not decide what your service should cost. It evaluates the pricing and access policy you define. |

---

## Core Beliefs

### 1. The lifecycle is the product, not the protocol.

Protocols will converge, fork, and absorb each other. A wrapper around one protocol lives exactly as long as that protocol's SDK stays inconvenient.

What every merchant needs regardless of protocol is the same: price, grant access, verify, settle, fulfill, refund, record.

**Which means:** Tollstile's public concepts are lifecycle concepts. Protocol details stay inside rails. If one protocol eventually wins, Tollstile remains useful.

### 2. Who pays is separate from how they pay.

A subscription is not a payment protocol. x402 is not a pricing model. Mixing them makes both harder to reason about.

**Which means:**

- **Rails** answer *how* a payment is made and proven — x402, MPP, a test rail.
- **Access policies** answer *whether* this caller must pay and *what it costs them* — subscriber, credits, pay-per-call.

They are configured separately and composed per endpoint.

### 3. Rails share a lifecycle, not a lowest common denominator.

Rails genuinely differ: some support refunds, delayed settlement, sessions, subscriptions, partial refunds, or multiple assets; some don't. Pretending they are identical either hides features or invents promises a rail cannot keep.

**Which means:** every rail implements the same **lifecycle contract** and **declares its capabilities**. Tollstile checks capabilities at startup — a configuration that requires refunds on a rail that can't refund fails immediately, not in production.

### 4. You own the ledger.

Payment records are business records. They should not live in someone else's gateway, behind someone else's dashboard, in someone else's database.

**Which means:** the ledger is your operational record of every quote-backed authorization and charge, in your database, in a schema you can read, query, and export. The payment network or provider remains the final authority on whether money moved; reconciliation keeps the two in agreement. There is no Tollstile account, no required dashboard, and no telemetry.

### 5. Tollstile never takes custody of funds.

A library that holds money is a financial institution with a README. Staying out of custody keeps Tollstile small, auditable, and safe to adopt.

**Which means:** Tollstile verifies proofs, asks the rail's provider to settle or refund, and records the outcome. It never holds balances, never routes funds through its own accounts, and never converts assets.

### 6. No duplicate economic effects.

Exactly-once *execution* across a network, a database, a payment provider, and your handler is not achievable, and Tollstile does not claim it. What it can guarantee is that **retries, replays, and recovery never create a second charge or a second refund**.

**Which means:**

- Every charge is a **state machine** persisted in the ledger (see [Payment Lifecycle](#payment-lifecycle)).
- Every provider call carries an **idempotency key** derived from the charge.
- The intended transition is recorded **before** calling the provider; the result is recorded **after**.
- When an outcome cannot be known — a settlement call times out — the state is **`unknown`**. Tollstile never guesses. It reconciles with the provider and then transitions.

### 7. Fail closed, and make trade-offs explicit.

In payments there are two bad outcomes: **serving what wasn't paid for**, and **charging for what wasn't served**. Some failures force a choice between them. Hiding that choice is worse than either outcome.

**Which means:**

- A failure while **verifying** access always denies the request.
- **The flow** is explicit: `authorization` (reserve, run, then settle what ran) or `upfront` (settle, run, refund on failure). Each rail declares which flows it supports.
- **Fulfillment** is defined by you. By default, a handler that completes successfully has fulfilled the request. For long or multi-step work, you mark fulfillment explicitly at the point where the service truly exists.
- Every outcome, including the uncomfortable ones, is recorded and surfaced — never swallowed.

### 8. The first paid request takes five minutes.

The worst part of payment SDKs is everything before hello world: wallets, test tokens, networks, facilitators.

**Which means:** Tollstile ships a **test rail** and an in-memory ledger. No wallet, no network, no account.

```ts
const toll = createTollstile({ rails: [testRail()], ledger: memoryLedger() });
```

```bash
curl -i localhost:3000/weather
# HTTP/1.1 402 Payment Required

curl -i -H "Payment: test" localhost:3000/weather
# HTTP/1.1 200 OK
```

Switching to a real rail is a config change. The handler does not change.

---

## Engineering Values

- **Types carry the truth.** Configuration flows into types by inference. Adding a rail or policy extends the handler's `payment` context automatically — no manual generics, no module augmentation.
- **Runs everywhere the web runs.** Core uses only Web standard APIs and has zero runtime dependencies. Node, Bun, Deno, and edge runtimes are first-class. Frameworks are thin adapters: Hono, Next.js, Express, MCP, Workers.
- **Small core, open edges.** Core is the lifecycle, access evaluation, and ledger contracts. Everything else is a plugin anyone can write. Saying no is part of the job.
- **Boring is a feature.** Stable APIs, strict semver, a changeset for every user-visible change, and a conformance suite every rail must pass before release.

---

## Payment Lifecycle

The full model is in [DESIGN.md](./DESIGN.md). In short:

- A **Quote** is what the server offered. It is signed and never stored, and the payer's proof carries it back — so the price charged is the price the payer saw.
- An **Authorization** is what the payer authorized: a single-use proof, or a reusable credential, token, or channel with a limit.
- A **Charge** is one economic effect against an authorization, tracked on two independent axes:

```
payment      reserved → settling → settled → refund_pending → refunded
                  ↘ released    ↘ failed / unknown (resolved by lookup)

fulfillment  pending → running → completed
                           ↘ failed
```

Rules that hold in every path:

- Creating a charge reserves capacity atomically; settling commits it; releasing returns it.
- A transition is written to the ledger before its side effect is acknowledged.
- A repeated operation with the same idempotency key returns the recorded result; it never repeats the effect.
- `unknown` is resolved only by asking the provider, never by assumption.
- Value held by access policies, such as credits, follows the same reserve → commit / release discipline.

---

## Guarantees

**Tollstile guarantees:**

- A protected handler never runs unless an access policy grants access or a payment proof has been verified against the quoted or configured price.
- Retries, replays, and crash recovery do not produce duplicate settlements or duplicate refunds, provided the rail declares idempotent operations. Rails that cannot must say so, and Tollstile surfaces the risk at startup.
- Every charge transition is recorded in your ledger.
- Ambiguous outcomes are recorded as `unknown` and surfaced for reconciliation.

**Tollstile does not guarantee:**

- That your handler executes exactly once.
- That a response reaches the client after it is sent.
- That costs your handler incurred before failing are recoverable.
- The behavior, availability, or finality of a rail's provider.

Stating these limits is part of being trustworthy.

---

## How We Decide

When principles pull in different directions, resolve in this order:

1. **Money correctness** — no unpaid access, no duplicate economic effects, no hidden outcomes.
2. **Security** — verify everything, trust nothing from the wire.
3. **Neutrality** — no rail, provider, or platform gets special treatment.
4. **Developer experience** — small, typed, obvious.
5. **Simplicity** — less code, fewer concepts.
6. **Performance** — only with a benchmark.

## What We Say No To

- **Claiming exactly-once execution.** We promise what distributed systems allow, and say what they don't.
- **Guessing the outcome of an ambiguous settlement.** `unknown` is a state, not an error to paper over.
- **Built-in token swaps or currency conversion.** That's custody. See belief 5.
- **A default or recommended rail.** That's picking a side.
- **Required cloud services, accounts, or telemetry.** See belief 4.
- **"Just log the error and let the request through."** See belief 7.
- **Deciding prices for you.** Dynamic or AI-driven pricing belongs on top of Tollstile, not inside it.
- **Framework-specific behavior in core.** It belongs in that adapter, or nowhere.

## Open Source Promise

- Tollstile is **MIT-licensed and complete**. Everything needed to charge for APIs and tools in production is in the open-source library, free, forever.
- If a hosted product ever exists, it will offer things that genuinely require hosting — never features removed from, or withheld from, the library.
- Rails and policies are held to the same standard regardless of who maintains them or which company is behind the protocol.

---

## Glossary

| Term | Meaning |
|---|---|
| **Rail** | How a payment is made and proven (e.g. x402, MPP, test). Implements the lifecycle contract and declares capabilities. |
| **Capabilities** | What a rail supports: refunds, partial refunds, delayed settlement, sessions, subscriptions, idempotent operations, assets. |
| **Access policy** | Whether a caller must pay and what it costs them (e.g. subscriber, credits, pay-per-call). Evaluated in order per endpoint. |
| **Price** | A server-defined amount in a currency, attached to an endpoint or tool. Never taken from the client. |
| **Quote** | A signed, unstored record of the price and offers the server made; carried back inside the proof. |
| **Offer** | A rail's terms for covering a price in its own asset, e.g. USDC on Base at par. |
| **Authorization** | What a payer authorized: single-use, or reusable up to a limit. |
| **Charge** | One economic effect against an authorization, with a payment state and a fulfillment state. |
| **Flow** | The order in which a charge settles and the service runs: `authorization` or `upfront`. |
| **Challenge** | The `402` response describing what to pay, how, and where. |
| **Proof** | What the payer sends to show payment was authorized. |
| **Provider** | The third party that verifies and settles on a rail (sometimes called a facilitator). Tollstile calls it; it moves the funds. |
| **Settlement** | The provider finalizing the transfer of funds to you. |
| **Fulfillment** | The point at which the paid service exists. Defaults to handler success; can be marked explicitly. |
| **Receipt** | The verified, recorded result of a payment, available to your handler. |
| **Ledger** | Your operational record of authorizations, charges, claims, and transitions. Reconciled with providers. |
| **Economic effect** | A charge, settlement, or refund that changes who holds money. Tollstile never duplicates one. |
