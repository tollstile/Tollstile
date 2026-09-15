# Hono example

A paid API on [Hono](https://hono.dev) and Node with `@tollstile/hono`. It runs on the test rail and an in-memory ledger: no wallet, account, or network.

| Route | Price | What it shows |
|---|---|---|
| `GET /weather` | $0.01 | A fixed price: `402` with a signed quote, pay the quote, `200` with a receipt. |
| `POST /translate` | $0.001 per word | A price computed from the body. The quote commits to that body, so the paid retry must send the same bytes; different text gets a fresh `402` with reason `quote_mismatch`. |
| `GET /forecast` | $0.05 | `credits()` before `payPerCall()`: a caller with an API key draws down prepaid credits (`demo-key` starts with $0.10); everyone else, and anyone out of credits, pays per call. |

## Run it

From the repository root, with Node 22.12+ and pnpm 9:

```bash
pnpm install
pnpm --filter @tollstile-examples/hono start   # http://localhost:3000
```

In a second terminal:

```bash
pnpm --filter @tollstile-examples/hono agent
```

Expected output (charge ids differ):

```
GET /weather → 402 payment_required, price $0.01
GET /weather  Payment: test quote=… → 200, receipt test_settlement_chg_5701887ca2cb2f795545ded9
  {"city":"Tokyo","forecast":"clear"}
POST /translate → 402 payment_required, price $0.008
POST /translate  Payment: test quote=…  (a longer body) → 402 quote_mismatch, price $0.017
POST /translate  Payment: test quote=…  (the same body) → 200, receipt test_settlement_chg_58f2280bf70baf6beb0baca8
  {"translation":"[fr] The weather in Tokyo is clear all week"}
GET /forecast  X-API-Key: demo-key → 200, receipt none
  {"city":"Tokyo","week":["clear","clear","rain","clear","cloudy","clear","clear"],"paidWith":"credits"}
```

Or with curl:

```bash
curl -i localhost:3000/weather                                   # 402, with "quote" in the body
curl -i -H "Payment: test quote=<quote>" localhost:3000/weather  # 200, with a payment-receipt header
```

The smoke test runs the same flows in process, including credits running out: `pnpm vitest run examples/hono` from the repository root.

## Files

| File | |
|---|---|
| `src/toll.ts` | The Tollstile instance (rail and ledger) and the credit balance. |
| `src/app.ts` | The three routes. |
| `src/server.ts` | Serves `app` on port 3000. |
| `src/agent.ts` | A client that meets each `402`, pays with the test rail, and prints the receipt. |
| `test/smoke.test.ts` | The `402` → pay → `200` flows through `app.request()`, without a port. |

## Notes

- On a dynamically priced route, put `tollstile()` before any middleware that reads the body, such as a validator. Tollstile prices from a copy of the unread body and refuses a request whose body was already consumed.
- The ledger and the credit balance live in memory: restarting the server forgets every charge and resets credits.
- Inside this repository, `tsconfig.json` maps `tollstile` and `@tollstile/*` to their sources, and `tsx` follows the mapping, so nothing needs building. In your own project, install the packages and delete `paths`.

## Use real payments

> **Live rails have not yet been verified against real providers.** `@tollstile/x402` is tested against a fake facilitator, a fake chain, and the x402 reference library only. Nothing in these examples has settled a real payment. Run the live checks below on a testnet before trusting it with money.

To accept USDC on Base Sepolia through x402:

1. In `src/toll.ts`, replace `toll` with the commented x402 block below it. Routes and handlers stay the same.
2. Set `PAY_TO` to the address that receives USDC, and `TOLLSTILE_SECRET` to 32 or more random characters (for example `openssl rand -base64 32`). `RPC_URL` is optional and defaults to `https://sepolia.base.org`. A missing or invalid value fails at startup with a message naming it.
3. Pay with an x402 client. `src/agent.ts` speaks only the test rail. The steps and a reference-client script are in [Verify live on Base Sepolia](../../packages/x402/README.md#verify-live-on-base-sepolia-with-the-x402org-facilitator).
4. Before production, replace `memoryLedger()` with a database ledger and run `toll.reconcile()` on a schedule.
