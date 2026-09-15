# @tollstile/hono

Hono middleware for [Tollstile](https://tollstile.com): charge per call for Hono routes on Node, Bun, Deno, and Cloudflare Workers.

```bash
npm install tollstile @tollstile/hono hono
```

```ts
import { Hono } from "hono";
import { createTollstile, memoryLedger, testRail } from "tollstile";
import { tollstile } from "@tollstile/hono";

const toll = createTollstile({ rails: [testRail()], ledger: memoryLedger() });
const app = new Hono();

app.get("/weather", tollstile(toll.price("$0.05")), (c) => c.json({ forecast: "clear" }));
```

| Option | Purpose |
|---|---|
| `principal: (c) => Principal \| null` | The authenticated caller, for `subscriber()` and `credits()` |

The handler succeeds when it returns a status below 400 without throwing; otherwise the charge is released or refunded. `c.get("payment")` exposes the payment, including `fulfill({ amount })` for `upTo()` prices.

Guide: https://tollstile.com/docs/guides/add-pay-per-call-pricing

MIT © 2026 Paradigm AI Inc.
