# @tollstile/mpp

[Machine Payments Protocol](https://paymentauth.org) rails for [Tollstile](https://tollstile.com): `WWW-Authenticate: Payment` challenges and credentials over HTTP and MCP, with three payment methods.

| Rail | MPP method / intent | Status |
|---|---|---|
| `mppStripe()` | `stripe` / `charge` (Shared Payment Tokens) | Stable wire, fakes only |
| `mppTempo()` | `tempo` / `charge` (TIP-20 transfer, pull and push) | Stable wire, fakes only |
| `mppTempoSession()` | `tempo` / `session` v2 (payment channels, `voucher` action) | **Experimental** |

```bash
npm install tollstile @tollstile/mpp
```

```ts
import { createTollstile } from "tollstile";
import { mppStripe, mppTempo } from "@tollstile/mpp";
import { tollstile } from "@tollstile/hono";

const toll = createTollstile({
  rails: [
    mppStripe({
      realm: "api.example.com",
      secret: process.env.MPP_SECRET!,          // binds challenge ids; ≥ 32 chars, list to rotate
      secretKey: process.env.STRIPE_SECRET_KEY!,
      networkId: "profile_1MqDcVKA5fEO2tZvKQm9g8Yj",
    }),
    mppTempo({
      realm: "api.example.com",
      secret: process.env.MPP_SECRET!,
      rpcUrl: "https://rpc.moderato.tempo.xyz",
      chainId: 42431,
      recipient: "0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00",
      token: { address: "0x20c0000000000000000000000000000000000000", code: "pathUSD" },
      denomination: "USD",
    }),
  ],
  ledger,                                         // e.g. postgresLedger(db)
  secret: process.env.TOLLSTILE_SECRET!,
});

app.get("/report", tollstile(toll.price("$1.00")), (c) => c.json({ ok: true }));
```

## Wire format (shared by every rail)

- **Challenge**: one `WWW-Authenticate: Payment id, realm, method, intent, request, expires, opaque` per rail. `request` and `opaque` are base64url (no padding) of RFC 8785 JCS JSON. `expires` is always set (the quote's expiry, rounded down to the second). `header` and `description` are never issued, so the credential is always read from `Authorization`.
- **Binding**: `id = base64url(HMAC-SHA256(secret, realm|method|intent|request|expires|digest|opaque))` via `crypto.subtle`, matching the spec's recommended slots and mppx's published vectors. The first secret signs; every secret in the list verifies (rotation). Ids are compared in constant time against all secrets.
- **Quote carriage**: Tollstile's signed quote token travels in `opaque` as `{"tollstile_quote": …}`. It is bound by the HMAC and opened with `terms.openQuote`, so the quoted price is what is charged.
- **Verification** of a credential: HMAC id → realm → expiry → quote → the echoed `request` must be byte-identical (JCS) to what this server issues for that quote → method-specific proof. Credentials for another `method`/`intent` are `absent`, so several MPP rails share one request.
- **Receipts**: `Payment-Receipt` (base64url JCS JSON, with `challengeId`) plus `Cache-Control: private` on HTTP; `_meta["org.paymentauth/receipt"]` on MCP.
- **MCP**: credentials from `_meta["org.paymentauth/credential"]` (native `request` JSON is accepted); `challenge.mcp` is `{ style: "mpp", challenge }` for the adapter's `-32042` error.
- **proofId** is the challenge id (single-use enforced by the ledger), except for sessions, where it is the channel id.
- **Idempotency key**: the charge rails return the challenge id as `idempotencyKey` (a client `Idempotency-Key` takes precedence). A challenge is issued for one 402 and paid once, so every presentation of its credential is the same logical request: a retry after success answers `409 already_paid` with the settlement reference, a retry while the outcome is unknown answers `503 payment_outcome_unknown`, and a retry after a release runs again. For Stripe it is also the key the PaymentIntent is deduplicated on. Sessions return none: one channel pays many requests, so only the client can say which requests are retries.
- **Rejected but already paid**: when a credential this server issued can no longer be accepted (its challenge or quote expired, or a Tempo pull transaction is past `validBefore`), the charge rails still return its `proofId`, so a retry of a request that was paid is answered from the ledger (`409`) instead of a `402` asking the client to pay again. Sessions do not, since their proof id is the channel.
- **Payers** are canonical: `did:pkh:eip155:<chainId>:<lowercase address>` for Tempo charge and session, `stripe:<challengeId>` for Stripe.

## `mppStripe(options)`

| Option | Default | Purpose |
|---|---|---|
| `realm`, `secret` | required | Challenge realm and HMAC secret(s) |
| `secretKey` | required | Stripe API key, sent only as `Authorization: Bearer` |
| `networkId` | required | Stripe Business Network Profile id (`methodDetails.networkId`) |
| `paymentMethodTypes` | `["card"]` | `methodDetails.paymentMethodTypes` |
| `apiVersion` | `"2026-07-29.preview"` | `Stripe-Version`. SPTs require a preview version (mppx 0.9.3 uses this one) |
| `sptParameter` | `"shared_payment_granted_token"` | The MPP spec / mppx name. Stripe's SPT guide shows `payment_method_data[shared_payment_granted_token]`; switch if your account needs it |
| `searchLagMs` | 10 minutes | How long a Stripe Search miss is not trusted after an ambiguous settlement |
| `apiBase`, `fetch`, `clock` | Stripe, global, system | Injection points |

| Capability | Value | Why |
|---|---|---|
| `flows` | `['upfront']` | Confirming a PaymentIntent captures immediately; there is no hold to release |
| `authorization` | `single` | One SPT, one payment |
| `refund` / `partialRefund` | `true` / `true` | Stripe Refunds API, idempotency key = `operation.key` |
| `variableAmount` | `false` | The SPT is granted for the challenged amount |
| `quotes` | `true` | Carried in `opaque` |
| `lookup` | `true` | See below |

- **Offers**: `null` for currencies without a known minor unit, amounts finer than the minor unit (sub-cent USD), and amounts below Stripe's general minimum (USD $0.50, GBP £0.30, …). A route priced below the minimum with `mppStripe` as its only rail answers `402` with an empty `accepts`; add a rail that can serve small amounts.
- **Idempotency key: `tollstile_mpp_<challengeId>`**, not the spec's `${challenge.id}_${spt}` and not `operation.key`. A single challenge may be presented again after its charge was released (the core retry path). A per-charge key would let that retry create a second PaymentIntent; a key containing the SPT would do the same if the payer retried with a new SPT. One key per challenge means Stripe replays the first PaymentIntent (or answers an idempotency conflict, which is treated as ambiguous) instead of charging twice. Challenges expire in minutes, well inside Stripe's 24-hour key retention. Parameters are identical across retries (metadata holds only `challenge_id` and `tollstile_authorization`), so replays succeed. A replayed PaymentIntent is judged by its status.
- **The SPT never reaches the ledger.** It is a bearer token, so it stays in process memory, keyed by request, until its challenge expires (so a repeated `settle` replays the PaymentIntent through Stripe's idempotency). Another process cannot settle with it, and does not need to: the upfront flow never re-settles from reconciliation, it looks up.
- **Lookup without creating a charge**: retrieve by PaymentIntent id when the charge has one; otherwise Stripe Search `metadata['challenge_id']:'<id>'`, re-checking the metadata of every hit. `processing`/`requires_capture` stay unknown. Refunds are found by `metadata.tollstile_charge`.
- **Eventual-consistency risk**: Stripe Search is typically current within a minute but can lag longer during incidents. A miss younger than `searchLagMs` (measured from the charge's last transition) stays unknown. If Search lags longer than that, reconciliation releases the charge while a PaymentIntent exists: the payer is charged and the ledger says released. A retry of the same credential still replays that PaymentIntent (no second charge), but without a retry it is only visible in Stripe. Keep `searchLagMs` generous and reconcile Stripe payouts against the ledger.

## `mppTempo(options)`

| Option | Default | Purpose |
|---|---|---|
| `realm`, `secret` | required | Challenge realm and HMAC secret(s) |
| `rpcUrl`, `chainId` | required | Tempo JSON-RPC (`4217` mainnet, `42431` Moderato) |
| `recipient` | required | Payee address |
| `token` | required | TIP-20 `{ address, code }` (6 decimals) |
| `denomination` | required | Price currency the token is worth at par, e.g. `"USD"`. Other currencies get no offer |
| `modes` | `["pull"]` | `"push"` is opt-in (see below) |
| `splits` | none | `(amount) => [{ recipient, amount, memo? }]` in base units; sum must stay below the total |
| `validityMarginMs` | 60 s | Block-timestamp skew allowed past a transaction's `validBefore` |
| `fetch`, `clock` | global, system | Injection points |

| Capability | Value | Why |
|---|---|---|
| `flows` | `['authorization']` | A pull transaction can be broadcast any time before `validBefore`, so it is broadcast only after the handler succeeds; a failed handler costs the payer nothing |
| `authorization` | `single` | One transfer |
| `refund` | `false` | Refunding would require the rail to sign transfers with a merchant key |
| `variableAmount` | `false` | The signed amount is fixed |
| `quotes` | `true` | Carried in `opaque` |
| `lookup` | `true` | `eth_getTransactionReceipt` by the transaction hash |

- **Challenge binding on-chain**: every request carries `methodDetails.memo = keccak256("tollstile/mpp:<realm>:<quote id>:<quote nonce>")`, and the primary transfer must be `transferWithMemo` with it. A transfer made for one challenge cannot satisfy another, so one on-chain payment cannot be presented twice under two challenge ids.
- **Pull verification (offline)**: strict RLP decode of the `0x76` envelope, secp256k1 sender recovery (low-s), chain id, `validBefore` present, in the future and not after the challenge `expires`, `validAfter` not in the future, and the calls must be exactly the required transfers on the token (primary with memo, plus splits). Refused as local policy: fee-payer sponsorship (`feePayer` is never offered), key authorizations, authorization lists, non-secp256k1 signatures, and extra calls.
- **Signed transaction in the ledger**: stored in authorization data so settlement survives a crash, and dropped by `redact` when a charge becomes final (the hash and `validBefore` stay for lookup). A released charge keeps it, so the same credential can be retried. Settling again after redaction answers from the transaction receipt.
- **Settlement**: `eth_sendRawTransactionSync`. Rebroadcasting the same bytes cannot transfer twice (one nonce). A lost answer or a refusal without a receipt stays unknown until the transaction can no longer be included (`validBefore` + margin); only then is it rejected.
- **Residual risk (authorization flow)**: between verification and broadcast the payer can spend the nonce or the balance. The handler has then run unpaid; the charge ends `failed/completed` and `onEvent` reports `SETTLEMENT_REJECTED`. The window is the handler's duration. Balance simulation before admission is not implemented.
- **Push mode** (`modes: ["pull", "push"]`): the payer broadcasts and sends the hash; the receipt's `Transfer`/`TransferWithMemo` logs are checked at verification, and `verify` returns `settled` with the transaction hash. Core records the charge with flow `upfront` (money moved before the handler, even though the rail declares only `authorization` for pull mode) as `settled/running` before the handler. Because this rail cannot refund, a failed handler leaves the charge `settled/failed` with a `REFUND_REJECTED` event, and reconciliation skips it (`RECONCILIATION_SKIPPED`). Presenting the credential again answers `409 already_paid`. Enable push only if you are willing to keep payments for failed handlers and handle them yourself.

## `mppTempoSession(options)` — experimental

Options: `realm`, `secret`, `rpcUrl`, `chainId`, `recipient` (payee), `token`, `denomination`, `escrow` (default TIP-20 channel precompile `0x4d50…0000`), `operator` (default none), `fetch`, `clock`.

| Capability | Value | Why |
|---|---|---|
| `flows` | `['upfront']` | Voucher coverage can only be checked in `settle`, where the authorization's consumption is known; settling before the handler means an uncovered call is refused before it runs |
| `authorization` | `reusable` | The authorization is the channel (`proofId` = channel id) |
| `limit` | deposit − on-chain `settled`, at first sight | Ledger capacity |
| `refund` | `true` | Nothing is captured per charge; a refund removes the charge from consumption, and the close helper captures consumption only |
| `partialRefund`, `variableAmount` | `false` | Not implemented |
| `lookup` | `true` | Settle and refund have no external effect, so lookup is exact: interrupted refunds are complete, interrupted settlements never happened |

- **Verification** (`action: "voucher"`): descriptor payee/token/operator, recomputed v2 channel id, EIP-712 `Voucher(bytes32 channelId,uint96 cumulativeAmount)` under the `TIP20 Channel Reserve` domain recovered to `authorizedSigner` or payer (low-s), and live channel state via `getChannelState`: exists, no close requested, voucher ≤ deposit and ≥ settled.
- **Settlement of a charge** accepts the voucher only if `cumulativeAmount ≥ baseline + consumed + reserved` of the authorization, where `reserved` already includes this charge and every other in-flight charge. Concurrent calls therefore can never be covered by the same voucher value; replaying a voucher is harmless. The voucher is recorded in the charge's `settlement.details`.
- **What `settled` means here**: the payee holds a payer-signed voucher covering the charge. It does **not** mean funds moved. Funds move when you close the channel on-chain with `tempoSessionClose({ authorization, charges, settledOnChain? })`, which returns `{ to, data, captureAmount, cumulativeAmount }` for `close(descriptor, cumulativeAmount, captureAmount, signature)`: it captures `max(baseline + ledger consumption, settledOnChain)` using the highest voucher, and refunds the rest of the deposit to the payer. Submit it from the payee account with your own wallet; the package holds no keys.
- **Guarantee gap**: a payer can `requestClose()` and `withdraw()` after the escrow's grace period (15 minutes in the reference contract). Anything not captured by then is lost to the merchant, even though the ledger says `settled`. Watch for `CloseRequested` and close promptly. Never call the escrow's `settle()` with the highest voucher directly: it captures the full voucher, including refunded or unused value.
- **Not supported**: `open`, `topUp`, and `close` credentials (the payer must open and fund the channel on-chain before sending vouchers), session protocol v1, top-ups raising the ledger limit, and SSE/WebSocket metering.
- **Why experimental**: vouchers pass from `verify` to `settle` in process memory (a rail cannot write to the authorization after it is opened), and the rail cannot see consumption at verification. Both are safe in the upfront flow as implemented, but they rule out the authorization flow and variable prices. The core change that removes this: pass the stored authorization (or a `LedgerReader`) into `verify` for rails with `authorization: 'reusable'`, and let `openAuthorization` carry a per-charge proof payload onto `NewCharge` (e.g. `NewCharge.proof: Json`, handed to `settle` as `charge.proof`).

## Core change needed

- **Sessions** (deferred past v0.1): `NewCharge.proof` (per-request proof data persisted with the charge and passed to `settle`) and read access to the existing authorization in `verify`, as described above.

## Verification status

Everything here was tested **only against in-process fakes and published vectors**, never against Stripe or a Tempo node.

**Rail conformance** (`railConformance()` from `tollstile/testing`, `test/conformance.test.ts`):

| Rail | Result |
|---|---|
| `mppStripe` | all cases pass; redaction skipped (no evidence is stored) |
| `mppTempo` pull | all cases pass |
| `mppTempo` push | all run cases pass (a failed handler leaves the charge `settled/failed`). The settle-fault and tamper cases are skipped: the rail never settles push payments, and a tampered push proof is itself an on-chain transfer the kit would count as a settlement |
| `mppTempoSession` | not run: experimental, reusable authorization whose settlement is off-chain until close |

- Challenge ids: mppx 0.9.3's HMAC test vectors (`test-vector-secret`), JCS: RFC 8785 examples.
- Stripe: an in-memory Stripe with idempotency replay/conflict, Search visibility lag, refunds, declines, 5xx, and dropped connections.
- Tempo: transactions built and signed in the tests with `@noble/curves` keys and the package's own RLP encoder, a fake JSON-RPC node for `eth_sendRawTransactionSync`, `eth_getTransactionReceipt`, and `eth_call`. The `0x76` field layout and sign hash follow `ox` `TxEnvelopeTempo`; EIP-712 voucher hashing follows `ox` `Channel.getVoucherSignPayload`. No bytes from a real Tempo client were used.

To verify live:

1. **Stripe (test mode)**: create an SPT with `POST /v1/test_helpers/shared_payment/granted_tokens` (`payment_method=pm_card_visa`, usage limits for the challenged amount, preview `Stripe-Version`), send it as the credential for a $0.50+ route, and confirm a `succeeded` PaymentIntent with `metadata.challenge_id`. Check which `sptParameter` your account accepts. Force a handler failure and confirm the refund. Then settle once with a blocked network and run `reconcile()` after `searchLagMs` to confirm Search finds the PaymentIntent. Run `npx mppx@latest validate <url>` against the endpoint.
2. **Tempo charge (Moderato, chain 42431)**: pay a challenge with the `mppx` client in pull mode and confirm the transaction hash in the receipt on the explorer; check that the client uses the challenge `memo` with `transferWithMemo` and does not request fee sponsorship. Repeat with push mode if enabled. Compare `decodeTempoTransaction` against a transaction serialized by `viem/tempo`.
3. **Tempo session**: open a v2 channel on Moderato with the `mppx` session client, send `voucher` credentials to a priced route, then submit `tempoSessionClose()` calldata from the payee and confirm the capture amount and payer refund on-chain.

MIT © 2026 Paradigm AI Inc.
