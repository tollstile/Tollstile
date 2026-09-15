# @tollstile/l402

An [L402](https://github.com/lightninglabs/L402) (formerly LSAT) rail for [Tollstile](https://tollstile.com). The payer pays a Lightning invoice once, then presents the macaroon and preimage on every call until the credential's value or lifetime runs out. Each call consumes part of what was prepaid; a call whose handler fails gives its part back. Works with aperture-style clients such as `lnget`.

```bash
npm install tollstile @tollstile/l402
```

```ts
import { createTollstile, memoryLedger } from "tollstile";
import { tollstile } from "@tollstile/hono";
import { l402, lndRest } from "@tollstile/l402";

const toll = createTollstile({
  rails: [
    l402({
      network: "signet",
      invoices: lndRest({ url: "https://127.0.0.1:8080", macaroon: invoiceMacaroonHex }),
      // Your exchange rate: USD micros → millisatoshis. Tollstile never fetches or hardcodes a BTC price.
      rate: (amount) => (amount.micros * msatPerUsd()) / 1_000_000n,
      secret: l402Secret,
      calls: 100, // one invoice buys 100 calls at the challenged price
    }),
  ],
  ledger: memoryLedger(),
  secret: quoteSecret,
});

app.get("/weather", tollstile(toll.price("$0.01")), (c) => c.json({ forecast: "clear" }));
```

```bash
curl -i localhost:3000/weather
# HTTP/1.1 402 Payment Required
# WWW-Authenticate: LSAT macaroon="AgE…", invoice="lntbs…"
# WWW-Authenticate: L402 macaroon="AgE…", invoice="lntbs…"

# pay the invoice, then:
curl -i -H "Authorization: L402 AgE…:<preimage hex>" localhost:3000/weather
# HTTP/1.1 200 OK
# l402-receipt: <payment hash>:chg_…
# l402-remaining: $0.99
```

## Options

| Option | Default | Purpose |
|---|---|---|
| `network` | required | `mainnet`, `testnet`, `signet`, or `regtest`. Invoices for another network are refused. |
| `invoices` | required | An `InvoiceProvider`: `{ createInvoice(amountMsat, memo, expirySeconds, signal), lookupInvoice(paymentHash, signal) }`. `lndRest()` is built in. |
| `rate` | required | `(amount: Money) => bigint \| Promise<bigint>`: millisatoshis for an amount in the price currency. Return whole satoshis if your payers' wallets need them. Returning `0n` or less makes the rail offer nothing for that price. |
| `secret` | required | At least 32 characters. Each macaroon's root key is `HMAC-SHA256(secret, identifier)`, so no root keys are stored. Pass an array to rotate: the first mints, all verify. Removing a secret invalidates credentials already paid for. |
| `calls` | `1` | How many calls at the challenged price one credential pays for. The invoice is for `price × calls`. |
| `credentialTtlMs` | 24 hours | How long a credential can be used after its challenge. |
| `confirmSettled` | `false` | Also ask the node, on every verification, whether the invoice is settled. See below. |
| `invoiceTimeoutMs` | 10 seconds | Upper bound for creating an invoice while issuing a challenge. |
| `clock` | system clock | For tests. |

`lndRest({ url, macaroon, fetch })`: `macaroon` is hex (`xxd -p -c 1000 invoice.macaroon`); the invoice macaroon is enough. LND serves a self-signed certificate: pass a `fetch` that trusts it, or set `NODE_EXTRA_CA_CERTS`.

**`confirmSettled`.** A correct preimage already proves the invoice was paid: the node reveals it only when it settles the payment. Confirming costs a round trip to your node per request and turns node outages into `503`s for credentials that were already paid. It guards against preimages that became known without payment — a compromised node, or hold invoices settled out of band. Leave it off unless one of those applies.

## Capabilities

| Capability | Value | Why |
|---|---|---|
| `flows` | `authorization` | The payment happened before the credential was presented. Each call reserves part of its value, runs, and then consumes it; a failed handler releases it. No Lightning payment moves at settlement, so `upfront` would add nothing. |
| `authorization` | `reusable` | A credential is used until its value (`limit`) or expiry (`tollstile_valid_until`) runs out. |
| `variableAmount` | `true` | Consumption can be any amount up to the reservation, so `upTo()` prices work. |
| `quotes` | `true` | The quote token is a first-party caveat, `tollstile_quote=<token>`, in the macaroon minted for that quote. |
| `refund` / `partialRefund` | `false` | A settled Lightning payment cannot be pulled back. `refund()` returns `rejected`. |
| `lookup` | `true`, always `none` | See below. |

**Settlement is consumption.** `settle` sends nothing to the node and returns the same reference (`<payment hash>:<charge id>`) on every retry, so it is never ambiguous. The ledger moves the amount from reserved to consumed on the authorization.

**Lookup returns `none` for every charge.** Consumption of one call exists only as the ledger's `settled` transition, and core asks `lookup` only about charges the ledger has not recorded as settled. The invoice being paid is a fact about the credential, not about any single call: reporting `settled` from it would let reconciliation consume value for a call whose service may not exist, and then attempt a refund Lightning cannot make. With `none`, reconciliation re-runs the deterministic settle for charges whose fulfillment completed and releases the rest. A `settled` result can therefore never be fabricated.

**Proof id is the payment hash.** aperture and `lnget` append `preimage=<hex>` to the macaroon before sending it, which changes its bytes and signature. Keying on the payment hash makes the minted and the appended macaroon the same credential.

## How verification works

1. Read `Authorization: L402 <macaroon>:<preimage>` (or `LSAT`; both lines of aperture's client, joined by `Headers.get`, are accepted). Over MCP, the same string in `_meta["l402/credential"]`.
2. Decode the V2 macaroon; the identifier is aperture's v0 layout (`version | payment_hash | token_id`).
3. Verify the HMAC chain with the key-generator step used by go-macaroon and libmacaroons, against every configured secret, in constant time.
4. Check `sha256(preimage) == payment_hash`.
5. Read caveats. The chain signs caveat order, so the first three are the terms this rail minted (`tollstile_quote`, `tollstile_limit`, `tollstile_valid_until`). Anything after them was appended by a holder and may only restrict: `preimage=` must match the presented preimage, a later `tollstile_valid_until` shortens that presentation (not the stored authorization), a restated quote or limit must be identical, and any other condition is refused (`caveat_unsupported`).
6. Open the quote. If it opens, its price is charged. If it no longer opens — expired, or presented on another resource — the credential is still ours and still prepaid, so the call is charged at the route's current fixed price; a dynamic-price route answers `quote_required`.
7. Optionally confirm the invoice with the node.

Invalid reasons: `malformed_credential`, `conflicting_credentials`, `multiple_macaroons_unsupported`, `macaroon_invalid`, `preimage_mismatch`, `caveat_missing`, `caveat_malformed`, `caveat_conflict`, `caveat_unsupported`, `credential_expired`, `quote_required`, `currency_mismatch`, `invoice_not_settled`. Every invalid credential gets a `402` with a fresh challenge, which is what aperture does and what `lnget` expects (it drops the cached token and pays again).

## MCP

L402 defines no MCP transport. The challenge is `challenge.mcp = { style: "tollstile", rail: "l402", meta: "l402/credential", format: "L402 <macaroon>:<preimage>", macaroon, invoice, paymentHash, value, calls, validUntil }`. Send the credential as `_meta["l402/credential"]`; the receipt is `_meta["l402/receipt"] = { reference, remaining }`.

## Things to know

- **Every challenge creates an invoice on your node**, including for unauthenticated requests. aperture works the same way. Rate-limit unpaid requests in front of Tollstile.
- If invoice creation fails, the challenge throws `PROVIDER_UNAVAILABLE` and the request fails (your adapter answers 5xx) instead of offering an invoice that cannot be paid — including other rails' offers on that request.
- The macaroon carries the quote token, so challenge headers are a few kilobytes when several rails are configured.
- L402 uses the `Authorization` header. Routes that also authenticate callers with `Authorization` cannot use this rail on the same request.
- **On dynamic-price routes, a credential works only while its quote opens** (core's `quoteTtlMs`, 5 minutes by default, and only on the quoted resource). After that the route answers `quote_required` and `lnget` pays a new invoice, leaving the old credential's remaining value unused. Sell multi-call credentials (`calls > 1`) for fixed-price routes.
- A credential's value is fixed in the price currency when it is issued. It can be spent on any route priced in that currency; another currency answers `currency_mismatch`.
- The `l402-receipt` and `l402-remaining` response headers are Tollstile's; the L402 spec defines no receipt.

## Verification status

Tested only against fakes and published vectors:

- Macaroon V2 encoding and the HMAC chain: libmacaroons README signatures and `test/unit/*_v2_*.vtest` vectors (byte-for-byte re-encoding, right and wrong key), and go-macaroon's `TestMarshalBinaryRoundTrip` bytes.
- `preimage=` appended the way go-macaroon's `AddFirstPartyCaveat` does it (reimplemented with `node:crypto` in the tests), and the challenge parsed with `lnget`'s regular expression.
- LND REST request and response shapes against a fake `fetch` built from `lnrpc/lightning.yaml` and `rpcserver.go`, not a running node.
- BOLT 11 amounts and networks from the human-readable part only; invoice signatures are not checked.

Not yet verified against real software: a running LND, a real Lightning payment, `lnget`, aperture's client, and `Headers.get` joining of real duplicate `Authorization` lines behind your framework.

To verify live on regtest (or signet with a funded wallet):

```bash
# 1. Two LND nodes with a channel (e.g. Polar, or `docker compose` from lightninglabs/aperture's itest setup).
#    Merchant node: note its REST port and invoice macaroon.
export LND_URL=https://127.0.0.1:8081
export LND_INVOICE_MACAROON_HEX=$(xxd -p -c 1000 ~/.polar/networks/1/volumes/lnd/bob/data/chain/bitcoin/regtest/invoice.macaroon)
export NODE_EXTRA_CA_CERTS=~/.polar/networks/1/volumes/lnd/bob/tls.cert

# 2. Run a server with l402({ network: "regtest", invoices: lndRest({ url: LND_URL, macaroon: LND_INVOICE_MACAROON_HEX }), rate, secret, calls: 3 }).

# 3. Challenge, pay from the other node, call:
curl -si localhost:3000/weather | grep -i www-authenticate
lncli --network regtest --rpcserver localhost:10001 payinvoice --force <invoice>   # prints the preimage
curl -si -H "Authorization: L402 <macaroon>:<preimage>" localhost:3000/weather     # 200, l402-remaining: $0.02
lncli --network regtest --rpcserver localhost:10002 lookupinvoice <payment hash>   # state SETTLED

# 4. With lnget (lightninglabs/lnget), configured against the paying node:
lnget http://localhost:3000/weather   # pays once, then reuses the cached token for later calls until 402
```

Check: the three calls succeed and the fourth is challenged; a handler that returns 500 leaves `l402-remaining` unchanged on the next call; `lnget`'s requests (which append `preimage=`) map to one authorization in the ledger; with `confirmSettled: true`, stopping the merchant node makes paid calls answer `503` without running the handler.

MIT © 2026 Paradigm AI Inc.
