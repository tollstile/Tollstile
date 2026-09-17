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

Wrap routes with an adapter such as [`@tollstile/hono`](../hono).

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
