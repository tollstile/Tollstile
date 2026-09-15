# @tollstile/x402

The [x402](https://github.com/x402-foundation/x402) V2 rail for Tollstile. Agents pay per request in USDC (or another EVM token) with a signed authorization; Tollstile verifies it through a facilitator before your handler runs and settles it after the handler succeeded.

- **Schemes:** `exact` (EIP-3009 `transferWithAuthorization`) for fixed prices, `upto` (Permit2) for `upTo()` prices.
- **Transports:** HTTP (`PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE`, standard base64 JSON) and MCP (`_meta["x402/payment"]`, receipt in `_meta["x402/payment-response"]`, payment-required as an `isError` tool result).
- **Reconciliation:** on-chain, through your JSON-RPC endpoint. x402 facilitators have no status endpoint and `/settle` is not idempotent.

## Install

```bash
npm install tollstile @tollstile/x402
```

## Example

```ts
import { Hono } from 'hono';
import { createTollstile, memoryLedger, upTo } from 'tollstile';
import { tollstile } from '@tollstile/hono';
import { x402 } from '@tollstile/x402';

const toll = createTollstile({
  rails: [
    x402({
      network: 'eip155:84532', // Base Sepolia
      payTo: '0xYourAddress',
      denomination: 'USD', // 1 USDC = 1 USD, stated explicitly
      rpcUrl: 'https://sepolia.base.org',
      upto: { facilitatorAddress: '0xd407e409E34E0b9afb99EcCeb609bDbcD5e7f1bf' }, // from GET /supported
    }),
  ],
  ledger: memoryLedger(),
  secret: process.env.TOLLSTILE_SECRET, // 32+ random characters
});

const app = new Hono();
app.get('/weather', tollstile(toll.price('$0.01')), (c) => c.json({ sunny: true }));
app.post('/generate', tollstile(toll.price(upTo('$0.10'))), async (c) => {
  await c.get('payment').fulfill({ amount: '$0.03' }); // settles 0.03 USDC of the 0.10 authorized
  return c.json({ text: '…' });
});

setInterval(() => void toll.reconcile(), 60_000);
```

Start with `testRail()` from `tollstile` for local development; switching to `x402()` does not change handlers.

## Options

| Option | Default | Description |
|---|---|---|
| `network` | — | CAIP-2 EVM network. Built-in assets: `eip155:8453` (Base, USDC "USD Coin" v2) and `eip155:84532` (Base Sepolia, USDC "USDC" v2). |
| `payTo` | — | Your receiving address. Every payment is checked against it. |
| `denomination` | — | Conversion at par, e.g. `"USD"` for USDC. Required unless `rate` is set; the built-in USDC only accepts `"USD"`. |
| `rate` | — | `(price: Money) => Promise<bigint>`: atomic asset units for a price, for assets not at par. The quote fixes the result for the payer. |
| `asset` | built-in USDC | `{ code, address, decimals, name, version }` with the token's EIP-712 domain. Required on other networks; decimals 6–18. |
| `facilitator` | x402.org on Base Sepolia only | `{ url, headers?: () => Promise<Record<string, string>> }`. `headers` runs per request (e.g. a CDP JWT). **Required on mainnet and every other network**; the testnet facilitator is never used silently. |
| `rpcUrl` | — | JSON-RPC endpoint for `network`, used only by reconciliation. Must support the `finalized` block tag and `eth_getLogs`. |
| `upto` | disabled | `{ facilitatorAddress }` enables `upTo()` prices. Use the address your facilitator lists for `upto` in `GET /supported`; payers bind their Permit2 signature to it. |
| `maxTimeoutSeconds` | `60` | Advertised to payers, who sign authorizations valid for about this long. **The handler and settlement must both finish before it runs out** (facilitators also keep a few seconds of margin), or settlement is rejected after the service was delivered. Raise it for slow handlers. |
| `fetch` | global `fetch` | Injected for tests and custom transports. |

## Capabilities

| Capability | Value | Why |
|---|---|---|
| `flows` | `['authorization']` | verify → handler → settle. `exact` cannot be refunded or voided, so settling upfront would charge for work that failed. |
| `authorization` | `single` | One signed authorization pays for one request. After a released charge (handler failed, nothing settled) the same payment can be retried. |
| `variableAmount` | `true` with `upto` | Permit2 `upto` authorizes a maximum and settles the fulfilled amount. |
| `quotes` | `true` | The quote token travels in `accepts[].extra.tollstileQuote`. x402 V2 clients must echo every advertised `extra` field, so it comes back in `accepted`. |
| `refund` / `partialRefund` | `false` | Neither scheme has a refund; `refund()` throws `UNREACHABLE`. |
| `lookup` | `true` | On-chain, see below. |

`livemode` is `true`, including on testnets.

### How verification works

1. Read `PAYMENT-SIGNATURE` (HTTP) or `_meta["x402/payment"]` (MCP). Only `x402Version: 2` is accepted.
2. If `accepted.extra.tollstileQuote` is present, open the quote and derive the requirements from its x402 offer; otherwise use the route's fixed price (dynamic routes need the quote).
3. `accepted` must equal those requirements (every field except `extra` identical; `extra` must contain everything advertised, as in the reference `paymentRequirementsMatchAccepted`). The signed authorization must name `payTo`, the exact amount (or the `upto` maximum), the asset, the upto proxy as spender, and the configured facilitator.
4. Call the facilitator `/verify` with **this server's** requirements, never the client's.
5. The proof id is `network:asset:payer:nonce`, so a replayed payment maps to the same authorization. `limit` is the authorized value converted back to money; `expiresAt` is `validBefore` (or the Permit2 deadline).

Facilitator outcomes: `isValid: false` → 402 with the facilitator's reason (sanitized to `[a-z0-9_]`), whether it came as HTTP 200 or a non-2xx JSON body. Unreachable, timed out, non-JSON, or `unexpected_verify_error` → 503 and the handler does not run.

### How settlement works

`/settle` is called with the stored payload and requirements; for `upto`, `amount` is the fulfilled amount at the quoted ratio, rounded down. `success: false` is a rejection (`failed`), except `settlement_pending` and `unexpected_settle_error`, which — like timeouts, transport failures, and non-JSON answers — are `PROVIDER_TIMEOUT`: core records `unknown` and reconciliation asks the chain. Tollstile never calls `/settle` twice on a hunch.

### How lookup works

All reads happen at the `finalized` block.

- **exact:** `authorizationState(payer, nonce)` on the token. If used, find the token's `AuthorizationUsed(payer, nonce)` log and require a `Transfer(payer, payTo, value)` in the same successful transaction → `settled` with that transaction hash. An `AuthorizationCanceled` log → `none`.
- **upto:** Permit2 `nonceBitmap(payer, nonce >> 8)`. If the bit is set, find `Transfer(payer, payTo)` logs of the asset and accept one only if its transaction called the upto proxy (`settle` or `settleWithPermit`) with this nonce, owner, and token; the settled amount comes from the log. An `UnorderedNonceInvalidation` covering the nonce → `none`.
- **Unused nonce:** `none` only once the finalized block is past `validBefore` (or the deadline), when no later block can include it. Before that, lookup throws `PROVIDER_TIMEOUT` and the charge stays `unknown` until the next run.
- **Used nonce with no recognizable evidence** (e.g. a facilitator that settles through a batching contract): `PROVIDER_TIMEOUT` with a message to investigate. Tollstile does not guess.

Logs are searched between the charge's creation time (minus 10 minutes of clock-skew margin) and the signature's deadline. Block timestamps strictly increase, which bounds that block range without assuming a block time.

Selectors and topics are precomputed constants in `src/abi.ts` (no keccak dependency); each is documented with its signature.

### Stored data

The authorization's `data` holds the payer's signed payload, because settlement may run in another process after a crash. It never appears in errors, events, or receipts. The rail implements `redact`: once a charge is final, core replaces `paymentPayload` and `paymentRequirements` with `null`, keeping the scheme, network, asset, `payTo`, payer, nonce, deadline, and amounts that `lookup` needs. While a charge is `unknown` the payload stays, so reconciliation can still settle it. A `released` charge (the handler failed before anything settled) is not redacted, so the same payment can be retried.

## Verification status

**Tested only against fakes and the reference library.**

- `test/x402.test.ts` drives real flows through `createTollstile` with a fake facilitator and a fake JSON-RPC node sharing one simulated chain (injected `fetch`): 402 → pay with the echoed quote → 200 for `exact` and `upto` (fulfilled amount); dynamic prices; tampered `accepted` amount, recipient, network, asset, and timeout; signatures to another recipient, amount, spender, or facilitator; tampered and expired quotes; facilitator unreachable, hanging (abort), and `unexpected_verify_error` → 503; replay and concurrent replay; retry after a released charge; rejected settlement as 200 and non-2xx (fresh 402 `settlement_rejected` after the handler); `settlement_pending` → `unknown` → reconciled to `settled` from chain evidence (exact and upto) without a second `/settle`; unmined authorization kept `unknown` until expired, then `failed`; payer cancellation (EIP-3009 and Permit2 invalidation, with a decoy transfer) → nothing charged; RPC down → stays `unknown`; crash after fulfillment → settled by reconciliation; MCP challenge and receipt; redaction (payload kept until final and while `unknown`, kept after a release and dropped once the retry settles, dropped after settle, rejection, and reconciliation; lookup still works on redacted data); configuration errors.
- `test/conformance.test.ts` round-trips headers through `@x402/core` 2.25.0 (`decodePaymentRequiredHeader`, `encodePaymentSignatureHeader`, `decodePaymentResponseHeader`, V2 schema guards) and checks that the reference `x402ResourceServer.findMatchingRequirements` accepts what this rail advertises.
- ABI selectors and event topics were computed with keccak-256 and cross-checked against known selectors (`balanceOf`, `transferWithAuthorization`, `Transfer`); calldata layouts follow `x402UptoPermit2Proxy.sol` at x402-foundation/x402 `3a6605e`.

**Not verified against a real facilitator or chain.** In particular: signature acceptance by x402.org, real facilitator error bodies, `finalized` tag behaviour of your RPC provider, log range limits, and upto settlement through `settleWithPermit` or sponsored approvals.

### Verify live on Base Sepolia with the x402.org facilitator

1. **Wallets.** Create two test wallets: a receiver (`payTo`) and a payer. Fund the payer with Base Sepolia USDC from https://faucet.circle.com. For `exact`, the payer needs no ETH (the facilitator pays gas). For `upto`, the payer must approve Permit2 (`0x000000000022D473030F116dDEE9F6B43aC78BA3`) for USDC once, which needs a little Base Sepolia ETH.
2. **Facilitator address.** `curl https://x402.org/facilitator/supported` and copy `extra.facilitatorAddress` of the `upto` / `eip155:84532` entry (it was `0xd407e409E34E0b9afb99EcCeb609bDbcD5e7f1bf` on 2026-09-15).
3. **Server.** Run the example above with `network: 'eip155:84532'`, your `payTo`, `denomination: 'USD'`, `rpcUrl: 'https://sepolia.base.org'` (or a provider URL), `upto: { facilitatorAddress }`, a Postgres or memory ledger, and `onEvent: console.log`.
4. **Unpaid request.** `curl -i localhost:3000/weather` → `402`, `cache-control: no-store`, and a `PAYMENT-REQUIRED` header; `echo <header> | base64 -d` shows `scheme: "exact"`, `amount: "10000"`, and `extra.tollstileQuote`.
5. **Paid request with the reference client.**
   ```ts
   import { x402Client, wrapFetchWithPayment, decodePaymentResponseHeader } from '@x402/fetch';
   import { ExactEvmScheme } from '@x402/evm/exact/client';
   import { UptoEvmScheme } from '@x402/evm/upto/client';
   import { privateKeyToAccount } from 'viem/accounts';

   const signer = privateKeyToAccount(process.env.PAYER_KEY as `0x${string}`);
   const client = new x402Client().register('eip155:84532', new ExactEvmScheme(signer)).register('eip155:84532', new UptoEvmScheme(signer));
   const pay = wrapFetchWithPayment(fetch, client);

   const weather = await pay('http://localhost:3000/weather');
   console.log(weather.status, decodePaymentResponseHeader(weather.headers.get('payment-response') ?? ''));
   const generate = await pay('http://localhost:3000/generate', { method: 'POST' });
   console.log(generate.status, decodePaymentResponseHeader(generate.headers.get('payment-response') ?? ''));
   ```
   Expect `200` and a transaction hash. On https://sepolia.basescan.org, `/weather` shows a 0.01 USDC transfer to `payTo` with an `AuthorizationUsed` event; `/generate` shows 0.03 USDC through the upto proxy `0x4020…0002`. The ledger shows `settled/completed` charges.
6. **Replay.** Log the `PAYMENT-SIGNATURE` header the client sent (wrap its `fetch`) and send it again with `curl -H` → `402`, no second transfer.
7. **Handler failure.** Make the handler return 500 once → the charge is `released/failed`, no transfer; resend the same header within `maxTimeoutSeconds` → `200` and one transfer.
8. **Reconciliation.** Point `facilitator.url` at a small proxy that forwards `/verify` normally but forwards `/settle` to x402.org and then answers `504` → the charge is `unknown`. Wait for the finalized block to pass the settlement (a few minutes on Base Sepolia), run `toll.reconcile({ olderThanMs: 0 })` → `settled` with the on-chain hash and no second `/settle`. Repeat with a proxy that drops `/settle` without forwarding it, wait until finality passes `validBefore`, reconcile → `failed`, no transfer.
