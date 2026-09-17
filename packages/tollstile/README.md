# tollstile

Open-source payment middleware for APIs, MCP tools, and AI agents. Accept x402 and MPP payments with subscriptions, credits, spend limits, refunds, and a merchant-owned ledger.

```bash
npm install tollstile
```

```ts
import { createTollstile, memoryLedger, testRail, upTo } from "tollstile";

const toll = createTollstile({ rails: [testRail()], ledger: memoryLedger() });

const perCall = toll.price("$0.05");       // fixed price
const perUse = toll.price(upTo("$0.50"));  // settle what the handler used
```

Put the price in front of a route with the adapter for your framework — the handler you already have stays as it is:

| Where | Adapter |
|---|---|
| Next.js App Router | [`@tollstile/next`](https://www.npmjs.com/package/@tollstile/next) — `export const GET = paid(toll.price("$0.05"), handler)` |
| Express | [`@tollstile/express`](https://www.npmjs.com/package/@tollstile/express) |
| Hono | [`@tollstile/hono`](https://www.npmjs.com/package/@tollstile/hono) |
| Workers, Deno, Bun, any `fetch` handler | [`@tollstile/fetch`](https://www.npmjs.com/package/@tollstile/fetch) |
| MCP servers | [`@tollstile/mcp`](https://www.npmjs.com/package/@tollstile/mcp) — `paidTool()`, with human approval and checkout |
| A service in any language | [`@tollstile/proxy`](https://www.npmjs.com/package/@tollstile/proxy) — a paid gateway in front of it |

Payment rails are separate packages too: [`@tollstile/x402`](https://www.npmjs.com/package/@tollstile/x402), [`@tollstile/mpp`](https://www.npmjs.com/package/@tollstile/mpp), [`@tollstile/l402`](https://www.npmjs.com/package/@tollstile/l402), [`@tollstile/kyapay`](https://www.npmjs.com/package/@tollstile/kyapay); ledgers: [`@tollstile/postgres`](https://www.npmjs.com/package/@tollstile/postgres), [`@tollstile/sqlite`](https://www.npmjs.com/package/@tollstile/sqlite). Docs: https://tollstile.com/docs

| Export | Purpose |
|---|---|
| `createTollstile`, `upTo` | Instance, prices, reconciliation |
| `subscriber`, `credits`, `payPerCall`, `memoryBalance` | Access policies |
| `limit`, `payers`, `when`, `amountOver` | Requirements |
| `testRail`, `memoryLedger` | Local development and tests |
| `createRail` | Build a rail for any payment protocol or provider ([guide](https://tollstile.com/docs/rails/build-a-rail)) |
| `tollstile/testing` | `fakeClock`, `httpContext`, `mcpContext`, `railConformance` |

Run reconciliation from a terminal or cron: `npx tollstile reconcile --config tollstile.config.mjs --older-than 15m` ([guide](https://tollstile.com/docs/guides/reconciliation)). Each run examines at most 500 charges, most recently updated first, and the CLI keeps going while `report.truncated` is true.

Docs: https://tollstile.com/docs · For coding agents: https://tollstile.com/llms.txt

MIT © 2026 Paradigm AI Inc.
