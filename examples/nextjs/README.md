# Next.js example

A paid App Router route handler with `@tollstile/next`: `GET /api/weather` costs $0.01. It runs on the test rail and an in-memory ledger: no wallet, account, or network.

## Run it

From the repository root, with Node 22.12+ and pnpm 9:

```bash
pnpm install
pnpm --filter @tollstile-examples/nextjs dev   # http://localhost:3000
```

In a second terminal:

```bash
pnpm --filter @tollstile-examples/nextjs agent
```

Expected output (the charge id differs):

```
GET http://localhost:3000/api/weather → 402, price $0.01
GET http://localhost:3000/api/weather  Payment: test quote=… → 200, receipt test_settlement_chg_1990708727ce1e03211b478e
  {"city":"Tokyo","forecast":"clear"}
```

Or with curl:

```bash
curl -i localhost:3000/api/weather                                   # 402, with "quote" in the body
curl -i -H "Payment: test quote=<quote>" localhost:3000/api/weather  # 200, with a payment-receipt header
```

The smoke test calls the exported `GET` the way Next.js does: `pnpm vitest run examples/nextjs` from the repository root.

## Files

| File | |
|---|---|
| `lib/toll.ts` | The Tollstile instance: rail and ledger. |
| `app/api/weather/route.ts` | The paid route handler. |
| `scripts/agent.ts` | A client that meets the `402`, pays with the test rail, and prints the receipt. |
| `test/smoke.test.ts` | The `402` → pay → `200` flow, in process. |

## Notes

- Next.js is pinned to 15.5, the version `@tollstile/next` documents. `next dev` has been run with this example; `next build` and Next.js 16 have not.
- The resource is the pathname, `GET /api/weather`. For routes with dynamic segments, name the route with `toll.price(amount, { resource: 'GET /reports/[id]' })` so every id is not its own resource.
- The route imports `lib/toll` by relative path so the repository's test runner can load it; in your app, use your `@/` alias.
- `memoryLedger()` lives in one process. It works for `next dev`, but serverless deployments may run each request in a different instance: use a database ledger there.
- Inside this repository, `tsconfig.json` maps `tollstile` and `@tollstile/*` to their sources, and Next.js follows the mapping, so nothing needs building. In your own project, install the packages and delete `paths`.

## Use real payments

> **Live verification status.** The x402 `exact` flow has been verified on Base Sepolia with x402.org, including a successful USDC transfer, replay rejection, handler failure and retry, and a restart with a persistent SQLite ledger. `upto`, reconciliation after an ambiguous settlement, and production providers remain to be verified. MPP Stripe has been verified in Stripe test mode, including retries, refunds, and reconciliation. Every other rail is tested against fakes and published vectors only. Run the live checks below on a testnet before trusting any of it with money.

To accept USDC on Base Sepolia through x402:

1. In `lib/toll.ts`, replace `toll` with the commented x402 block below it. The route handler stays the same.
2. Set `PAY_TO` to the address that receives USDC, and `TOLLSTILE_SECRET` to 32 or more random characters (for example `openssl rand -base64 32`), in `.env.local`. `RPC_URL` is optional and defaults to `https://sepolia.base.org`. A missing or invalid value fails when the route is first loaded, with a message naming it.
3. Pay with an x402 client. `scripts/agent.ts` speaks only the test rail. The steps and a reference-client script are in [Verify live on Base Sepolia](../../packages/x402/README.md#verify-live-on-base-sepolia-with-the-x402org-facilitator).
4. Before production, replace `memoryLedger()` with a database ledger and run `toll.reconcile()` on a schedule.
