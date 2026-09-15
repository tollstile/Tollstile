# Cloudflare Workers example

A paid Worker with `@tollstile/fetch`, the adapter for Web-standard `Request` → `Response` handlers. It runs on the test rail and an in-memory ledger: no wallet, account, or network, and `wrangler dev` runs it locally without a Cloudflare login.

| Route | Price | What it shows |
|---|---|---|
| `GET /weather` | $0.01 | A fixed price: `402` with a signed quote, pay the quote, `200` with a receipt. |
| `POST /translate` | $0.001 per word | A price computed from the body. The quote commits to that body, so the paid retry must send the same bytes; different text gets a fresh `402` with error code `quote_mismatch`. |

## Run it

From the repository root, with Node 22.12+ and pnpm 9:

```bash
pnpm install
pnpm --filter @tollstile-examples/cloudflare-workers dev   # wrangler dev, http://localhost:8787
```

In a second terminal:

```bash
pnpm --filter @tollstile-examples/cloudflare-workers agent
```

Expected output (charge ids differ):

```
GET /weather → 402 payment_required (pay), price $0.01
GET /weather  Payment: test quote=… → 200, receipt test_settlement_chg_306ba03fa2618057efe4bc05
  {"city":"Tokyo","forecast":"clear"}
GET /weather → 402 payment_required (pay), price $0.01
GET /weather  Payment + Idempotency-Key → 200, receipt test_settlement_chg_150f4c1ed192526fd8db2f57
  {"city":"Tokyo","forecast":"clear"}
GET /weather  the same retry → 409, receipt none
  {"error":{"code":"already_paid","retryable":false,"action":"stop","message":"This request was already paid (chg_150f4c1ed192526fd8db2f57). It is not charged or run again.","detail":null},"resource":"GET /weather","chargeId":"chg_150f4c1ed192526fd8db2f57","settlement":"test_settlement_chg_150f4c1ed192526fd8db2f57"}
POST /translate → 402 payment_required (pay), price $0.008
POST /translate  Payment: test quote=…  (a longer body) → 402 quote_mismatch (pay), price $0.017
POST /translate  Payment: test quote=…  (the same body) → 200, receipt test_settlement_chg_ebcc30e488b7cfea666d7d23
  {"translation":"[fr] The weather in Tokyo is clear all week"}
```

Or with curl:

```bash
curl -i localhost:8787/weather                                   # 402, with "quote" in the body
curl -i -H "Payment: test quote=<quote>" localhost:8787/weather  # 200, with a payment-receipt header
```

The smoke test imports the Worker and calls its exported `fetch` directly, with no runtime or port: `pnpm vitest run examples/cloudflare-workers` from the repository root.

## Files

| File | |
|---|---|
| `wrangler.jsonc` | The Worker's name, entry point, and compatibility date. |
| `src/toll.ts` | `createToll()`: the Tollstile instance, with rail and ledger. |
| `src/index.ts` | The Worker: routes by method and pathname. |
| `src/agent.ts` | A client that meets each `402`, pays with the test rail, and prints the receipt. |
| `test/smoke.test.ts` | The `402` → pay → `200` flows through the exported `fetch`. |

## Notes

- **The instance is created on the first request.** With real payments, the quote secret and receiving address are Worker bindings, which arrive with the request. (A module-scope `createTollstile()` also works: without a `secret`, the random signing key is generated on first use, inside a request.)
- **Deploying needs more than this example.** Every isolate has its own memory ledger and, without a `secret`, its own signing key, so a quote issued by one isolate is refused by another. Set `secret` from a Worker secret and use a database ledger before `wrangler deploy`. This example has been run with `wrangler dev` only, not deployed.
- Inside this repository, `tsconfig.json` maps `tollstile` and `@tollstile/*` to their sources, and Wrangler's bundler follows the mapping, so nothing needs building. In your own project, install the packages and delete `paths`.

## Use real payments

> **Live rails have not yet been verified against real providers.** `@tollstile/x402` is tested against a fake facilitator, a fake chain, and the x402 reference library only, and has not run on Workers. Nothing in these examples has settled a real payment. Run the live checks below on a testnet before trusting it with money.

To accept USDC on Base Sepolia through x402:

1. In `src/toll.ts`, replace `createToll` with the commented x402 block below it, which takes the Worker's `env`. In `src/index.ts`, accept `env` as the second argument of `fetch` and pass it through: `fetch(request: Request, env: Env)`, `createRoutes(env)`, `createToll(env)`.
2. Put `PAY_TO` (the address that receives USDC) and `TOLLSTILE_SECRET` (32 or more random characters, for example `openssl rand -base64 32`) in `.dev.vars` for `wrangler dev`, or set them with `wrangler secret put` for a deployment. A missing or invalid value fails on the first request with a message naming it.
3. Pay with an x402 client. `src/agent.ts` speaks only the test rail. The steps and a reference-client script are in [Verify live on Base Sepolia](../../packages/x402/README.md#verify-live-on-base-sepolia-with-the-x402org-facilitator).
4. Before deploying, replace `memoryLedger()` with a database ledger and run `toll.reconcile()` from a Cron Trigger.
