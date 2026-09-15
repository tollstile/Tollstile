# @tollstile/ap2

> **Experimental.** AP2 does not yet define how a mandate travels with an API call or MCP tool call, and several of its rules assume a merchant-signed checkout. Read [AP2 gaps](#ap2-gaps) before relying on this in production.

`userMandate()` is a Tollstile requirement that admits a paid request only when it carries an [AP2](https://github.com/google-agentic-commerce/AP2) v0.2 Payment Mandate chain proving that a user authorized an agent to pay **this merchant** at least **this price**.

It does not move money. A rail still verifies and settles the payment; the mandate is evidence of user authorization that must accompany it. It runs after the payment proof is verified and before anything is reserved.

## Install

```bash
npm install tollstile @tollstile/ap2
```

## Example

```ts
import { createTollstile, memoryLedger, testRail } from 'tollstile';
import { paid } from '@tollstile/fetch';
import { userMandate } from '@tollstile/ap2';

const issuers = new Map<string, JsonWebKey>([['agent-provider-key-1', { kty: 'EC', crv: 'P-256', x: '…', y: '…' }]]);

const toll = createTollstile({ rails: [testRail()], ledger: memoryLedger(), secret: process.env.QUOTE_SECRET });

export default {
  fetch: paid(
    toll.price('$5.00', {
      require: [
        userMandate({
          resolveKey: async (header) => issuers.get(String(header.kid)),
          payee: { id: 'merchant_1' },
          audience: 'https://api.example',
        }),
      ],
    }),
    () => Response.json({ ok: true }),
  ),
};
```

The agent's round trip:

1. Call without payment → `402` whose body carries `quote` (the token the rail echoes) and `nonce`.
2. Build the KB-SD-JWT for the closed mandate with `nonce` = that `nonce` and `aud` = one of your audiences.
3. Retry with the rail's proof carrying the quote, plus `AP2-Mandate: <open SD-JWT>~<KB-SD-JWT>~<disclosures>~` (or `_meta["ap2/mandate"]` over MCP).

Failures are `402` with `{ "error": "requirement_failed", "requirement": "user-mandate", "reason": "mandate_required" | "mandate_invalid:<detail>" }`.

## Options

| Option | Default | Description |
|---|---|---|
| `resolveKey` | required | `(protectedHeader) => Promise<JsonWebKey \| undefined>`: the P-256 key of the root issuer (user credential or trusted agent provider), e.g. by `kid`. Validating `x5c` chains is up to you. |
| `payee` | required | `{ id, name?, website? }`. The closed mandate's `payee.id` must equal `id`; `name` and `website` are compared when given. |
| `audience` | required | Accepted KB-SD-JWT `aud` values. |
| `header` | `AP2-Mandate` | HTTP header carrying the chain. |
| `metaKey` | `ap2/mandate` | MCP `_meta` key carrying the chain. |
| `maxAgeMs` | `300000` | Oldest KB-SD-JWT `iat` accepted. |
| `clockSkewMs` | `30000` | Tolerance for `iat`, `exp`, `nbf`, and execution dates. |

## What is checked

The chain must be exactly an issuer-signed SD-JWT and one KB-SD-JWT, joined by `~~` as the AP2 SDK serializes them.

1. **Root.** `alg` is `ES256`; the signature verifies with `resolveKey(header)`; `typ` is not a key-binding type. Disclosures are resolved per RFC 9901 §7.1 (`_sd` digests and `{"...": digest}` array elements, recursively, with `_sd_alg` sha-256/384/512); a malformed, duplicated, or unreferenced disclosure fails. `delegate_payload` discloses exactly one object, whose `vct` is exactly `mandate.payment.open.1`, with `constraints` and `cnf.jwk`.
2. **Key binding.** `typ` is `kb+sd-jwt`; the signature verifies with the open mandate's `cnf.jwk`; exactly one of `sd_hash` (over the root SD-JWT including disclosures and trailing `~`) or `issuer_jwt_hash` (over the root JWT) matches; `iat`, `aud`, and `nonce` are present.
3. **Closed mandate.** One disclosed object with `vct` exactly `mandate.payment.1`, no `cnf`, `transaction_id`, `payee {id, name}`, `payment_amount {amount: integer minor units, currency}`, `payment_instrument {id, type}`.
4. **Times.** `exp`, `nbf`, and `iat` on both tokens and both mandates; KB `iat` within `maxAgeMs`; an `execution_date` must not be in the future.
5. **Binding to this request.** `aud` is a configured audience. When the payment carried a Tollstile quote, `nonce` equals `quote.nonce`.
6. **User intent.** Every claim the open mandate pre-sets (other than `vct`, `constraints`, `cnf`, `iat`, `exp`, `nbf`) is equal in the closed mandate. Constraints `payment.amount_range`, `payment.allowed_payees` (AP2 SDK matching), and `payment.execution_date` (absent `execution_date` means now) must hold; **any other constraint fails**.
7. **Merchant terms.** `payee` matches `payee`; `payment_amount` is in the price's currency and, converted with ISO 4217 minor units, at least the price.
8. **Single use.** The SHA-256 of the KB-SD-JWT signing input is claimed until the key binding could no longer be accepted; a second presentation is `mandate_reused`.

Details include `issuer_untrusted`, `issuer_signature_invalid`, `kb_signature_invalid`, `kb_binding_missing`, `kb_binding_mismatch`, `disclosure_unreferenced`, `open_mandate:vct_mismatch`, `closed_mandate:payment_amount_invalid`, `audience_mismatch`, `nonce_mismatch`, `stale`, `expired`, `preset_mismatch:<claim>`, `constraint_failed:<type>`, `unsupported_constraint:<type>`, `payee_mismatch`, `amount_insufficient`, `currency_mismatch`, `key_binding_required`, `delegation_depth_unsupported`, and `mandate_reused`.

## Behavior to know

- **Quote nonce.** AP2 expects the verifier to issue the key-binding nonce. Tollstile's quote is that nonce: it is signed, expires, and is bound to the route, so a mandate made for one 402 cannot be presented against another quote. Without a quote (a rail that does not echo one, or a fixed price paid without it), any `nonce` is accepted and replay protection rests on `maxAgeMs` and the single-use claim.
- **Direct mandates are refused** (`key_binding_required`). A Human Present Payment Mandate signed directly by the user has no `aud` or `nonce`, so nothing binds it to this verifier.
- **Delegation beyond one agent** (`kb+sd-jwt+kb` hops) is refused; AP2 v0.2 places agent-to-agent delegation out of scope.
- **Claims and retries.** The mandate is claimed before the charge is created. If the handler then fails and the charge is released, the same mandate cannot be presented again; the agent requests a new quote and signs a new key binding.
- **Mandate receipts** (a signed Mandate Receipt JWT the verifier returns) are not produced.

## AP2 gaps

These are open issues in AP2 v0.2 (google-agentic-commerce/AP2 @ e1ea56d) for per-call API payments, and how this package handles them:

1. **No carrier.** AP2 defines no HTTP header, x402 field, or MCP `_meta` key for mandates. `AP2-Mandate` and `ap2/mandate` are this package's conventions, configurable via `header` and `metaKey`.
2. **No per-call checkout.** `transaction_id` and the `payment.reference` constraint assume a merchant-signed checkout JWT and an open Checkout Mandate. The open mandate schema *requires* `payment.reference`, so fully schema-conformant open mandates are rejected here with `unsupported_constraint:payment.reference` until a per-call equivalent exists. `transaction_id` is required but not checked.
3. **Sub-cent prices.** `payment_amount` is integer minor units, so a `$0.001` call needs a mandate of at least `$0.01`.
4. **Mandate ↔ payer binding.** Nothing in AP2 binds the mandate to the rail's payer (wallet, card token); the AP2 x402 sample uses a keccak256 nonce, which is not specified. This package does not compare the mandate with the rail payer.
5. **Verifier nonce.** Closed here by the Tollstile quote nonce (above); AP2 itself has no nonce round trip for a single-request 402 flow.
6. **Receipts.** AP2 requires a signed Mandate Receipt; there is no verifier key or response carrier for one here.
7. **Root trust.** User credential `x5c` chains versus trusted agent provider `kid`s are deployment policy, delegated to `resolveKey`.
8. **Stateful constraints.** `payment.budget` and `payment.agent_recurrence` need a history of presentations (and the AP2 SDK's budget units disagree with `amount_range`), so they fail as unsupported.

## Verification status

Tested with Vitest (Node 22 WebCrypto) against:

- The encoded open → closed chain in AP2 `docs/ap2/payment_mandate.md`: `sd_hash` (`uixoHemm…PK0Ck`), disclosure digests (including the payee nested in `allowed_payees`), the KB-SD-JWT signature under the open mandate's `cnf.jwk`, tamper detection, and the amount. The root signature cannot be checked because the example's `agent-provider-key-1` is generated at runtime and not published; the full chain therefore fails closed with `issuer_signature_invalid`, and its `payment.reference` constraint is reported as unsupported.
- Generated ES256 chains through `createTollstile` with `testRail()`: the 402 → mandate bound to the quote nonce → 200 round trip, wrong nonce, audience, issuer, and agent keys, both binding modes, tampered disclosures, `vct` mismatches, amounts, currencies and ISO 4217 minor units, payee, each supported constraint, pre-set values, expiry and staleness, reuse, direct and deeper chains, malformed input, and the HTTP header and MCP meta carriers.

Not verified against chains produced by the AP2 Python SDK or any credential provider. To verify: run the AP2 SDK (`code/sdk/python`) to create an open Payment Mandate with only `amount_range` / `allowed_payees` / `execution_date` constraints and `cnf` set to an agent key, then a closed mandate with `kb_sd_jwt.create(..., aud=<your audience>, nonce=<nonce from the 402 body>)`, join with `~~`, and send it in `AP2-Mandate` alongside a real rail payment. Expect `200`, and `402 mandate_invalid:mandate_reused` on a second send.
