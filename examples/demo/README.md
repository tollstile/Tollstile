# Tollstile demo

The live demo at **[demo.tollstile.com](https://demo.tollstile.com)**: a paid API, a paid MCP tool, and the ledger filling up as people pay. It runs on Cloudflare Workers with `@tollstile/fetch`, `@tollstile/mcp`, and the SQLite ledger on D1.

The rail is the **test rail**, so anyone can pay: send `Payment: test quote=<quote>`. No wallet, no account, no money.

| Route | Price | What it shows |
|---|---|---|
| `GET /v1/forecast?city=` | $0.01 | A fixed price: `402` with a signed quote, pay it, `200` with a receipt |
| `POST /v1/translate` | $0.001 per word | A price computed from the body. The quote binds to that body, so a cheap quote cannot pay for a bigger request |
| `POST /v1/summarize` | up to $0.50 | `upTo()`: the handler reports what it used and only that is charged. `x-api-key: demo-member` draws on prepaid credits instead |
| `POST /mcp` | $0.01 per `forecast` call | The same thing over MCP: agents pay in `_meta`, and the receipt comes back in the result's `_meta` |
| `GET /api/charges` | free | The ledger behind the live table on the page |

Retries are safe everywhere: send `Idempotency-Key` (or `_meta["tollstile/idempotency-key"]`) and a repeat is answered `409 already_paid` instead of being charged again.

## Run it locally

From the repository root, with Node 22.12+ and pnpm 9:

```bash
pnpm install
pnpm --filter @tollstile-examples/demo migrate:local   # create the ledger tables in local D1
echo 'TOLLSTILE_SECRET="a-local-secret-of-32-characters-plus"' > examples/demo/.dev.vars
pnpm --filter @tollstile-examples/demo dev             # http://localhost:8787
```

```bash
curl -i 'http://localhost:8787/v1/forecast?city=Osaka'
curl -i -H "Payment: test quote=<quote>" 'http://localhost:8787/v1/forecast?city=Osaka'
```

`pnpm vitest run examples/demo` runs the same worker against D1's shape over `node:sqlite`, so the tests exercise exactly what is deployed.

## Deploy it

```bash
npx wrangler d1 create tollstile-demo          # put the id in wrangler.jsonc
pnpm --filter @tollstile-examples/demo migrate # apply the ledger schema to the remote database
npx wrangler secret put TOLLSTILE_SECRET       # 32+ random characters; quotes must verify across isolates
pnpm --filter @tollstile-examples/demo deploy
```

A scheduled trigger can run reconciliation; the worker exports `scheduled` for it.

## What this demo is not

- The credits balance is in memory, so it resets with each isolate. A real deployment keeps balances in its own database.
- The test rail moves no money. To take real payments, swap it for `x402(...)` or `mppStripe(...)` in `src/toll.ts` — the rest of the code does not change.
