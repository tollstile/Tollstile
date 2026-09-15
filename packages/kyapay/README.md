# @tollstile/kyapay

A [Tollstile](../../README.md) rail that accepts Skyfire **KYAPay** `pay` and `kya-pay` tokens.

A KYAPay payment token is a funded hold minted by the buyer with Skyfire. The rail verifies the token on every request, runs your handler on a reservation, and then charges the delivered amount against the token with Skyfire's seller API. One token pays for many requests until its amount is used up or it expires.

## Install

```bash
pnpm add tollstile @tollstile/kyapay
```

## Example

```ts
import { Hono } from "hono";
import { createTollstile } from "tollstile";
import { tollstile } from "@tollstile/hono";
import { kyapay } from "@tollstile/kyapay";
import { postgresLedger } from "@tollstile/postgres";

const toll = createTollstile({
  rails: [
    kyapay({
      environment: "sandbox",
      sellerId: process.env.SKYFIRE_SELLER_ID,
      serviceId: process.env.SKYFIRE_SERVICE_ID,
      apiKey: process.env.SKYFIRE_API_KEY,
    }),
  ],
  ledger: postgresLedger(db),
  secret: process.env.TOLLSTILE_SECRET,
});

const app = new Hono();
app.get("/report", tollstile(toll.price("$0.01")), (c) => c.json({ ok: true }));

// Run on a schedule: resolves charges whose outcome Skyfire left unknown.
setInterval(() => void toll.reconcile(), 5 * 60_000);
```

Buyers send the token in the `KYAPay-Token` header (over MCP: `_meta["kyapay/token"]`).

## Options

| Option | Default | Meaning |
|---|---|---|
| `environment` | required | `"production"` or `"sandbox"`. Selects the issuer, API, and the `env` claim tokens must carry. |
| `sellerId` | required | Your seller agent id. Tokens must name it in `aud`. |
| `serviceId` | required | Your seller service id. Tokens must name it in `tsi` (or the older `ssi`). |
| `apiKey` | required | Seller agent API key, sent as `skyfire-api-key` to charge and list charges. Never logged or stored. |
| `tokenTypes` | `["pay", "kya-pay"]` | Accepted token types. `["pay"]` keeps buyer identity claims out of your ledger (see [Stored data](#stored-data)). |
| `issuers` | Skyfire issuer for `environment` | Trusted issuer origins. Checked before any key fetch; JWKS is read from `<issuer>/.well-known/jwks.json`. |
| `apiUrl` | Skyfire API for `environment` | Seller API origin. |
| `clockSkewSeconds` | `30` | Clock tolerance, 5–60 s (the draft's bounds). Also used when comparing Skyfire charge timestamps. |
| `verifyRequestSignature` | none | RFC 9421 check for sender-constrained tokens (`cnf`). Without it those tokens are refused. |
| `fetch`, `clock` | globals | For tests. |

## Capabilities

| Capability | Value | Why |
|---|---|---|
| `flows` | `["authorization"]` | Skyfire's documented flow is verify → deliver → charge; a token's funds are committed when it is minted. |
| `authorization` | `reusable` | A token is a hold charged many times until exhausted. `limit` = `amt`/`cur`, `expiresAt` = `exp`, proof id = `iss` + `jti`, payer = `sub`. |
| `variableAmount` | `true` | `chargeAmount` may be any amount up to the remaining balance. |
| `quotes` | `false` | Buyers mint tokens with Skyfire; nothing the server sends comes back inside the token. Fixed-price routes only. |
| `refund`, `partialRefund` | `false` | Skyfire documents no refund, void, or reversal API. Not charging is the only release. |
| `lookup` | `true` | `GET /api/v1/tokens/{jti}/charges`, with the accounting proof below. |

`livemode` is `true` in both environments.

## Verification

In order, with no network until the issuer is trusted:

1. Read `KYAPay-Token` (comma-separated, repeated headers joined). Members are classified by `typ` (`pay+jwt`, `kya-pay+jwt`, case-insensitive); `kya` tokens and unparseable members are ignored. No payment token → `absent`; more than one → `multiple_payment_tokens`.
2. `alg` must be `ES256` (rejects `none` and algorithm substitution); `crit` is refused; `kid` required; token type must be accepted.
3. `iss` must be on the allow list (`untrusted_issuer`, no fetch).
4. ES256 signature via `crypto.subtle` against the issuer's JWK (`kty EC`, `crv P-256`, matching `alg`/`use` if present). JWKS cached 60 minutes; unknown `kid` refetches at most once a minute.
5. `aud` = `sellerId`, `env` = `environment`, `tsi`/`ssi` = `serviceId`, `sub` present, `jti` a UUID, `exp`/`iat`/`nbf` within `clockSkewSeconds`, lifetime ≤ 24 h.
6. Payment claims: `cur` = `USD`, `amt` > 0 with at most 6 decimals, `val` a positive integer. **Card tokens are refused** (`stp: card`, a card `sti.type`, or any card credential member) so card credentials never reach the ledger. When `sti` is present, `sti.verified` must be `true`.
7. `cnf` present → `verifyRequestSignature` must pass, or the token is refused.
8. `amt` must cover the route price.

## Settlement and lookup — experimental

Skyfire's charge API **accepts no idempotency key and returns no charge id**, so a Tollstile charge can never be matched to a Skyfire charge record directly. This rail therefore reasons from the ledger's own accounting for the token:

```
excess = Skyfire's listed total − ledger `consumed`    (charges recorded as settled)
others = ledger `reserved` − this charge's reservation  (the most other in-flight charges could add)

"charged" is possible  ⇔  0 ≤ excess − amount ≤ others, and a listed charge is not older than this charge (less skew)
"absent"  is possible  ⇔  0 ≤ excess ≤ others
```

| List shows | `lookup` | `settle` before charging |
|---|---|---|
| only "charged" possible | `settled` | returns `settled` without charging |
| only "absent" possible | `none` | charges |
| both possible (same-amount charges in flight) | throws `PROVIDER_TIMEOUT` → stays `unknown` | charges |
| less than the ledger recorded (list lagging) | throws `PROVIDER_TIMEOUT` | charges |
| neither possible (something else charged the token) | throws `PROVIDER_TIMEOUT` | throws `PROVIDER_TIMEOUT` |
| HTTP 404 | throws `PROVIDER_TIMEOUT` (404 is not documented to mean "no charges") | charges |

`settle` charges in the "both possible" and "lagging" cases because core only calls it on a charge's first attempt (after writing `settling`) or after `lookup` proved the charge absent.

Charge responses: `200` with `amountCharged` equal to the requested amount → settled. A 4xx with a documented Skyfire error `code` → rejected (the list call that precedes it proves the API key works, so `NOT_AUTHORIZED` means the token was refused). Anything else — 5xx, non-JSON, unknown code, a different `amountCharged`, a timeout — is unknown and goes to reconciliation.

**Residual risks, precisely:**

- The proofs assume this ledger is the **only** party charging these tokens with your API key. Charging them elsewhere shows up as "neither possible" (unknown) or, if it happens to fit the arithmetic, could make `lookup` report a charge that another system made.
- They assume the charge list shows every accepted charge by the time it is read. If a charge is accepted but not yet listed when `lookup` runs, `lookup` can return `none` and reconciliation charges again. Run `reconcile()` with an `olderThanMs` well above Skyfire's list delay (the default 15 minutes).
- The time rule assumes your clock and Skyfire's `chargedAt` agree within `clockSkewSeconds` (plus 1 s for timestamp truncation).
- Two or more charges with overlapping amounts on one token that are **both** unknown can stay unknown permanently. They are reported through `onEvent` on every reconcile and must be resolved by hand against the Skyfire dashboard.
- Charges are accepted for 24 hours after `exp`. A charge still unresolved after that is rejected by Skyfire.
- Settlement `reference` is `<jti>:<charge id>` because Skyfire returns no charge id.

## Stored data

The authorization's `data` is `{ token, tokenId }`. The compact JWT is stored because Skyfire charges only against the full signed token, and the charge happens after the handler, possibly in another process (reconciliation). The token can be charged only by the seller in `aud` with that seller's API key, which is never stored. `kya-pay` tokens carry buyer identity claims (`hid`, `apd`, `aid`); set `tokenTypes: ["pay"]` to keep them out of the ledger. Card-settled tokens are refused before anything is stored.

## 402 challenge

KYAPay defines no challenge format. Following Skyfire's guidance, `accepts[].details` names the `KYAPay-Token` header, the accepted token types, the issuer, where to create tokens, and a human-readable message, and includes the A2A extension's `kyapay.payment.required` shape (`kyapay_version: 1`, `accepts: [{ seller_service_id, token_amount, token_type, description, resource }]`). MCP challenges use `{ style: "tollstile", ... }` with the same fields. Receipts: `kyapay-receipt` header / `_meta["kyapay/receipt"]`, `{ success, amount_charged, token_id }`.

Skyfire recommends 403 for a missing token and 401 for an invalid one; Tollstile answers 402 for both, with the reason in the body.

## Verification status

Everything here was tested **only against fakes**: ES256 keys generated in the test, a fake JWKS endpoint, and a fake Skyfire API built from the documented request and response shapes. Nothing has been run against Skyfire.

Confirm with Skyfire before production:

1. Whether charges are visible in `GET /api/v1/tokens/{jti}/charges` immediately after `POST /tokens/charge` returns, and the maximum delay if not.
2. Whether that endpoint returns `404` or `200 { data: [] }` for a token with no charges.
3. Whether any 4xx response from `POST /tokens/charge` can accompany a charge that was applied.
4. Whether `chargedAt` is Skyfire's server time and its precision.
5. That `value` in the charge list is exactly the submitted `chargeAmount` (decimal USD string).
6. Whether production tokens carry `env`, `tsi` or `ssi`, and `sti.verified: true` on coin settlement.
7. Whether an idempotency key or client charge reference is planned, which would replace the accounting proof.

To verify live in sandbox: create a sandbox seller agent and service, mint a `pay` token for it with a buyer agent, send it to a route priced below the token amount, and check that (a) the request succeeds, (b) the charge list shows exactly one charge per request, (c) cutting the network during a charge leaves the charge `unknown` and `reconcile()` resolves it to the Skyfire outcome without a second charge, and (d) repeating a request after the token is exhausted is refused.
