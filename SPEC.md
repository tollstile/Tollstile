# Tollstile Internal Contract v0.1

This document is normative. It defines what core, adapters, rails, policies, requirements, and ledgers must do so that any payment protocol can be added without changing core, and so that retries never produce duplicate economic effects.

The key words MUST, MUST NOT, SHOULD, and MAY are used as in RFC 2119. `packages/tollstile/src/core/types.ts` is the authoritative type definition; where this document and the types disagree, the disagreement is a bug in one of them.

DESIGN.md explains why the model looks the way it does. This document says what every implementation must guarantee.

---

## 0. Principles

1. **Outside is one line; inside is a runtime.** `toll.price("$0.04")` is the public surface. Everything below is internal contract.
2. **Core is protocol-neutral.** Core MUST NOT contain the name, data structures, header names, or error strings of any payment protocol. Protocol knowledge lives in rails; transport knowledge lives in adapters.
3. **No duplicate economic effects.** Tollstile never claims exactly-once execution. It guarantees that retries, replays, crashes, and reconciliation never settle or refund twice.
4. **Money is never guessed.** An ambiguous provider outcome is recorded as `unknown` and resolved only by asking the provider.
5. **Fail closed.** An error while deciding access denies. There is no path from an exception to serving a priced resource.
6. **Errors are for machines first.** Every denial carries a stable code, whether retrying can help, and what to do next.

---

## 1. The pipeline

A priced request passes through nine stages. Each stage is a separate concept with one owner.

```txt
Request → Policy → Price → Rail negotiation → Authorization → Execution → Metering → Settlement → Receipt
```

| # | Stage | Owner | Input | Output | Persisted |
|---|---|---|---|---|---|
| 1 | Request | adapter | framework request | `Context` | no |
| 2 | Policy | access policies, requirements | `Context`, price | skip · pay · grant · reserve; pass or deny | no (requirements may claim nonces) |
| 3 | Price | core | route price, `Context` | `Money`, variable flag | no |
| 4 | Rail negotiation | core + rails | price | `Quote` (signed) + one `Offer` and challenge per rail | no |
| 5 | Authorization | rail `verify` + core | proof in `Context` | `Authorization` | yes |
| 6 | Execution | core + handler | `Authorization` | `Charge` reserved, fulfillment running | yes |
| 7 | Metering | handler via `payment.fulfill` | usage | final amount ≤ authorized | yes |
| 8 | Settlement | rail `settle`/`refund`/`release`/`lookup` + core | `Charge` | settlement or refund reference | yes |
| 9 | Receipt | rail `receipt` + adapter | settled `Charge` | protocol receipt, `Completion` | no |

Stages 1–4 MUST NOT write to the ledger. A request that has not presented a verifiable proof MUST NOT be able to create records; otherwise unauthenticated traffic could fill the ledger.

---

## 2. Request

An adapter turns a framework request into a `Context`.

- Adapters MUST pass a Web-standard `Request` (or `null` for MCP calls without an HTTP carrier), the MCP tool name, arguments, `_meta`, and client capabilities, the resolved principal or `null`, a resource name, and a request id unique per inbound request.
- Adapters MUST NOT read the request body before the gate runs. Core prices and commits to a clone.
- Adapters MUST pass the client's idempotency key when present: the `Idempotency-Key` HTTP header, or `_meta["tollstile/idempotency-key"]` on MCP. See §11.
- Adapters MUST call `pass.complete(outcome)` exactly once after the handler, including when the handler throws, and MUST act on the returned `Completion` (§10).
- A handler succeeds when it returns without throwing and, on HTTP, with a status below 400; on MCP, without `isError` and with output that matches its declared schema.

---

## 3. Policy

**Access policies** decide whether a caller pays. They are tried in order; the first non-`skip` decision wins; no decision is `403 access_denied`.

| Decision | Meaning | Persisted |
|---|---|---|
| `skip` | this policy does not apply | — |
| `pay` | the caller pays through a rail | from stage 5 |
| `grant` | free for this caller (e.g. a subscriber) | nothing |
| `reserve` | paid from the policy's `Balance` (e.g. credits) | a charge on a `reusable` authorization named `policy:<name>` |

- A policy that returns `reserve` MUST provide a `Balance` implementing reserve → commit / release, idempotent by key.

**Requirements** are conditions every admitted request must meet, checked after the payer is known and before anything is reserved.

- A requirement MUST return `{ ok: true }` or `{ ok: false, status, reason }` with status `402`, `403`, `429`, or `503`.
- A requirement that cannot check its evidence right now MUST return `503` or throw `PROVIDER_UNAVAILABLE` / `PROVIDER_TIMEOUT`. It MUST NOT return `403` for a temporary failure.
- Requirements MUST use `claims` for any single-use value (nonces, signatures) and MUST honor `signal`.

---

## 4. Price

- Money is `{ currency, micros: bigint }` with six decimal places. Floating-point money MUST NOT exist anywhere.
- A route price is fixed (`"$0.04"`), a maximum (`upTo("$1.00")`), or computed per request (a function).
- A computed price MUST be fixed by a quote before payment (§5). A single-use proof MUST be charged the quoted price, not a recomputed one.
- Price currency and settlement asset are separate. A rail converts only by an explicit basis: `par` (configured as equal) or `rate` (merchant-supplied). Core MUST NOT convert currencies.

---

## 5. Rail negotiation

When a request carries no usable proof, core answers with a challenge.

1. Core computes the price and asks each configured rail for an `Offer` (`null` if the rail cannot serve the price).
2. Core issues one **Quote**: resource, **request commitment**, price, variable flag, offers, nonce, issuedAt, expiresAt; signed with HMAC-SHA256 over the serialized quote; never stored.
3. Each rail renders its protocol challenge for the quote. A rail that throws a provider error while doing so is omitted. If every rail was omitted, the response is `503 payment_unavailable`.

### Request commitment

A quote commits to the request it priced:

| `commit` | Bound to | Default for |
|---|---|---|
| `request` | method, resource, path and query, SHA-256 of the body bytes; on MCP, tool and canonical arguments | computed prices |
| `route` | method and resource | fixed prices |
| function | method, resource, and the returned value | clients that re-serialize bodies |

- A single-use proof whose request does not match its quote's commitment MUST be refused with `quote_mismatch` before any authorization or charge is written.
- A reusable authorization outlives one request: each request pays its own current price against the authorization's limit, and the commitment is not compared.

### Execution plan

When a route is defined, core compiles it against the configured rails into an **execution plan**: for each rail that can serve the route, its flow, when it settles relative to the handler, its authorization kind, whether it can settle less than it authorized, and what happens when the handler fails; for each rail that cannot, the capability it lacks.

- A rail whose declarations no route could use (no `lookup`; `upfront` without `refund`) MUST be refused at startup.
- A rail that cannot serve a particular route MUST be excluded from that route, with its reason. A route no rail can serve MUST be refused at startup.
- Core MUST verify proofs and issue offers only for the rails in the plan. A computed price that turns out to be `upTo()` uses only the planned rails that settle variable amounts.
- The plan is observable: `gate.plan`, and `toll.explain(gate)` for people.

### Rails and quotes

- A rail with `quotes: true` MUST carry the quote token inside its protocol so that it is echoed and integrity-protected by that protocol, and MUST return the opened quote from `verify`.
- A rail with `quotes: false` MUST NOT be configured on routes with computed prices; this is refused at startup.

---

## 6. Authorization

`rail.verify(context, terms, operation)` inspects the proof.

| Result | Meaning | Core does |
|---|---|---|
| `absent` | no proof for this rail | tries the next rail |
| `invalid` | a proof for this rail that fails verification | denies with a fresh challenge (§12); if it carries `proofId` of an authorization already charged, answers from the ledger instead (§11) |
| `valid` | verified | opens the authorization |
| throws `PROVIDER_*` | cannot verify now | `503`, handler does not run |

A valid result MUST contain:

- `proofId` — stable for the same proof. Authorization id = H(`auth`, rail, proofId). Presenting the same proof finds the same authorization.
- `payer` — a canonical identifier. Rails MUST normalize it (e.g. lowercase hex addresses), so requirements can compare exactly.
- `quote` — the opened quote, or `null` on fixed-price routes without one.
- `limit` — the authorized maximum, or `null` when capacity is enforced elsewhere.
- `expiresAt`, `data` — rail data needed to settle, refund, and look up.
- `settled` — only when the payment already moved during verification (§9).

Rails MUST check amount, asset, network, and recipient against the quote or server configuration, never against values taken from the client payload alone.

**Kinds.** A `single` authorization backs at most one charge that was not released. A `reusable` authorization backs charges until its limit is consumed or it expires.

---

## 7. Execution

Before the handler runs, core creates a **Charge** on the authorization. Creation atomically reserves the amount and enforces kind, capacity, expiry, and currency.

A charge moves on two independent axes:

```txt
payment      reserved → settling → settled → refund_pending → refunded
             reserved → released          settling → failed | unknown
fulfillment  pending → running → completed | failed
```

- Every transition MUST be a compare-and-set on both axes, validated against the transition tables in `core/states.ts`.
- A charge MUST be written before its provider effect is requested (`settling`, `refund_pending`) and after the result.

| Flow | Order | Handler fails |
|---|---|---|
| `authorization` | reserve · run · meter · settle | release — nothing moved |
| `upfront` | reserve · settle · run | refund; if the rail cannot refund, stays `settled/failed` and is reported |

Core picks `authorization` when the rail supports it. `upfront` without `refund` is refused at startup, except for payments that moved during verification (§9).

---

## 8. Metering

- On a fixed price, the charged amount is the price.
- On `upTo(max)`, the handler MUST call `payment.fulfill({ amount })` with the amount used, `0 ≤ amount ≤ max`. Succeeding without it releases the charge and emits `FULFILLMENT_MISSING`: nothing is charged, never the maximum.
- `fulfill` marks fulfillment `completed` at the point the service exists. A later handler failure MUST NOT undo a completed fulfillment.
- `fulfill({ resultRef })` MAY record where the handler stored the result (1–1024 characters, never a secret). Ledgers MUST persist it; it is returned to idempotent retries (§11). Tollstile never stores results.
- Metering is not a protocol feature. A rail declares `variableAmount: true` if it can settle less than it authorized; core never invents a variable-amount scheme on a rail that lacks one.

---

## 9. Settlement

Rail operations receive an `Operation { key, signal }`.

- `key` is derived from the charge and the operation. A repeated call with the same key MUST NOT produce a second economic effect and SHOULD return the recorded result.
- Rails MUST throw `PROVIDER_UNAVAILABLE` or `PROVIDER_TIMEOUT` when the outcome is unknown, and return values for every known outcome. Any other exception is a bug and propagates.

| Operation | Returns | Outcome unknown |
|---|---|---|
| `settle` | `settled { reference, details }` or `rejected { reason }` | charge → `unknown` |
| `refund` | `refunded { reference }` or `rejected { reason }` | charge → `unknown` |
| `release` | nothing | reported only; nothing moved |
| `lookup` | `settled`, `refunded`, or `none` | stays `unknown` |

- `lookup` is required. A rail that cannot look up a charge is refused at startup.
- **Paid at verification.** A rail whose payment already moved when it verified MUST return `settled` from `verify`. Core records the charge as `upfront` and settled before the handler.
- **Reconciliation** examines non-terminal charges older than a window and resolves each from the ledger and `lookup`, never from memory: settle completed reservations, release uncompleted ones, refund settled charges whose service may not exist, and resolve `unknown` by lookup. It MUST NOT refund on a rail that cannot, and reports those instead.
- **Evidence.** A rail MAY store payer evidence in authorization `data` when settling after a crash needs it. It MUST implement `redact` to drop that evidence once a single-use charge is settled, failed, or refunded, keeping what `lookup` and `refund` need. Redaction MUST NOT happen on `released`: the same proof may be presented again. Bearer credentials that can pay again MUST NOT be stored.

---

## 10. Receipt

`pass.complete(outcome)` returns a `Completion`:

| `settlement` | Adapter MUST |
|---|---|
| `settled` | serve the output with `receipt` |
| `rejected` | withhold the output and send `denial` (a fresh challenge, `settlement_rejected`) |
| `unknown` | serve the output without a receipt |
| `none` | serve the handler's own result |

- Withholding on `unknown` is forbidden: if reconciliation later finds the charge settled, the payer would have paid for a service never delivered.
- If recording the outcome fails, core emits an `error` event and rethrows; the adapter MUST NOT serve the output as paid.
- Receipts MUST NOT contain payer evidence or secrets.

---

## 11. Idempotency

### Identifiers

| Identifier | Derived from | Stable across |
|---|---|---|
| request id | adapter, per inbound request | nothing; operation keys for verify and requirements |
| authorization id | H(`auth`, rail, proofId) | every presentation of the same proof |
| charge id | H(`chg`, authorization id, request id) without a key; H(`chg`, payer, idempotency key, attempt) with one | every retry with the same key by the same payer |
| operation key | charge id + operation (`settle`, `refund`, `release`, `lookup`) | every attempt of that operation |
| settlement reference | the provider | — |
| receipt | rail, from the settled charge | — |

### Idempotency keys

The client MAY send an idempotency key (`Idempotency-Key` header, or `_meta["tollstile/idempotency-key"]`). A rail MAY supply one from its protocol (a payment identifier); the client's key takes precedence.

- Keys are scoped to the payer. A retry with the same key finds the first attempt's charge even when the client signed a new payment for it; the new proof is not charged. Payer ids are verified by the rail, so one payer cannot occupy another payer's keys. Rails whose payer id changes per payment (e.g. one id per challenge) get idempotency only within that id.
- The charge records a hash of the request it was created for (the `request` commitment). The same key with a different request MUST be refused with `422 idempotency_key_reused`.

A retry by the same payer with the same key finds the existing charge:

| Existing charge | Response |
|---|---|
| reserved or settling, fulfillment pending or running | `409 request_in_progress`, retry later |
| `unknown` | `503 payment_outcome_unknown`, retry later with the same proof and key |
| settled and completed | `409 already_paid` with the charge id, settlement reference, and `result` (the recorded `resultRef`, or `null`); the handler does not run again and nothing is charged |
| failed (settlement rejected) | `402 settlement_rejected` with a fresh challenge |
| released, or refunded | a new attempt: a new charge under the same key, and the handler runs |

A rail whose provider rejects a proof it already accepted (a used nonce) before core can see the ledger MUST return `invalid` with that proof's `proofId`. Core then answers the retry from the ledger, as above, instead of asking the client to pay again.

Without a key:

- A **single** proof presented again while its charge is not released is refused with `409 proof_already_used`. The payer is not asked to pay again.
- A **reusable** authorization presented again is a new request and is charged again. Clients that retry reusable credentials SHOULD send an idempotency key.

Tollstile does not store handler responses. A handler that must be able to return its original result records where it stored it with `payment.fulfill({ resultRef })`, and a retry receives that reference in `already_paid`.

---

## 12. Errors

Every denial body has this shape:

```json
{
  "error": {
    "code": "insufficient_authorization",
    "retryable": true,
    "action": "pay",
    "message": "The payment authorizes $0.03; this request costs $0.04.",
    "detail": null
  },
  "resource": "POST /v1/translate",
  "required": "$0.04",
  "authorized": "$0.03"
}
```

A `402` additionally carries `price`, `variable`, `quote`, `nonce`, `expiresAt`, and `accepts`.

- `code` is stable and owned by core. Clients branch on it.
- `retryable` says whether the same logical request can still succeed.
- `action` says how:
  - `pay`: pay using `accepts` in this response.
  - `retry_later`: send the same request with the same proof and idempotency key after `Retry-After`.
  - `fix_request`: change the request.
  - `stop`: do not retry.
- `message` is for humans and MAY change.
- `detail` is the rail's or requirement's own reason (e.g. `transfer_mismatch`), or `null`. Clients MUST NOT branch on it.
- Messages and details MUST NOT contain secrets or payer evidence.

| code | Status | retryable | action | When |
|---|---|---|---|---|
| `payment_required` | 402 | yes | pay | no proof |
| `quote_required` | 402 | yes | pay | computed price, proof without a quote |
| `quote_invalid` | 402 | yes | pay | forged, expired, or for another resource |
| `quote_mismatch` | 402 | yes | pay | request differs from the quote's commitment |
| `quote_offer_missing` | 402 | yes | pay | the quote has no offer for the rail used |
| `proof_invalid` | 402 | yes | pay | the rail rejected the proof; `detail` says why |
| `insufficient_authorization` | 402 | yes | pay | limit below the price; `required`, `authorized` |
| `authorization_expired` | 402 | yes | pay | the authorization expired |
| `payment_rejected` | 402 | yes | pay | the provider rejected an upfront settlement |
| `settlement_rejected` | 402 | yes | pay | the provider rejected settlement after the handler; output withheld |
| `requirement_failed` | 402 · 403 · 429 | 402, 429: yes · 403: no | 402: pay · 429: retry_later · 403: stop | a requirement refused; `requirement`, `detail` |
| `access_denied` | 403 | no | stop | no access policy admitted the caller |
| `proof_already_used` | 409 | no | stop | a single proof whose charge was not released |
| `request_in_progress` | 409 | yes | retry_later | same idempotency key, charge still running |
| `already_paid` | 409 | no | stop | same idempotency key, charge settled; `chargeId`, `settlement` |
| `idempotency_key_reused` | 422 | no | fix_request | same key, different request |
| `invalid_request` | 400 | no | fix_request | the transport envelope is malformed |
| `payment_unavailable` | 503 | yes | retry_later | a provider needed to verify or challenge is down |
| `payment_outcome_unknown` | 503 | yes | retry_later | settlement outcome unknown; retry with the same proof and key |
| `requirement_unavailable` | 503 | yes | retry_later | a requirement cannot check its evidence now |

`409` and `503` responses SHOULD carry `Retry-After`, and the body of any `retry_later` denial SHOULD carry the same wait as `retryAfter` (seconds), for transports without headers. The value is spread around a mean rather than fixed, so that clients denied at the same instant do not return at the same one. Rails MUST NOT invent denial codes; they report `invalid` with a `reason`, which core places in `detail` under `proof_invalid` (or `quote_invalid` when the quote could not be opened).

---

## 13. Protocol neutrality

- Core MUST NOT import from, name, or branch on any protocol.
- Adding a protocol MUST NOT require a core change. If it does, the missing capability is added to this contract as a capability or an optional hook, never as a protocol-specific branch.
- A capability a protocol lacks is declared, not emulated. Startup refuses a route that needs it.
- Transport conventions for payments inside MCP are defined by the protocols. A rail declares its MCP challenge with a `style`; the MCP adapter renders known styles and falls back to Tollstile's `_meta` form for unknown ones.

---

## 14. Conformance

| Component | Proven by |
|---|---|
| Rail | built with `createRail()`, which checks declarations and every `verify` result at runtime; proven by `railConformance()` from `tollstile/testing`, run in the rail's own test suite against its fake provider: offer, challenge, absent/invalid/valid verification, replay, settle idempotency by key, unknown outcomes, lookup after a lost response, refund and release, redaction |
| Ledger | the shared ledger conformance suite, run against memory, Postgres, and SQLite |
| Adapter | the adapter checklist in §2 and §10, tested with the test rail: 402 → pay → 200, handler failure releases, rejected settlement withholds output, idempotency headers forwarded |
| Core | the core test suite and mutation checks on every guard named in this document |

A component that does not pass its conformance suite MUST NOT be published under `@tollstile/*`.

---

## 15. Versioning

This contract is versioned separately from packages. A change that a conforming rail, ledger, or adapter would have to follow is a new contract version and is listed in the changelog with the migration. Additive optional hooks and capabilities are minor versions.
