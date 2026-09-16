---
name: tollstile
description: Add pay-per-call pricing, x402 or MPP payments, prepaid credits, subscriptions, spend limits, or usage-based charges to a TypeScript API or MCP server using Tollstile. Use when the user asks to monetize an API or MCP tool, charge AI agents, accept HTTP 402 payments, or add paid endpoints.
---

# Adding payments with Tollstile

Tollstile is payment middleware for APIs and MCP tools. It verifies payments on rails (x402, MPP, …), decides who pays with access policies, records every charge in the merchant's ledger, and never takes custody of funds.

Docs index for agents: https://tollstile.com/llms.txt

## Steps

1. Install the core and the adapter for the project's framework:
   - Next.js: `npm install tollstile @tollstile/next` · Hono: `@tollstile/hono` · Express: `@tollstile/express` · any `fetch` handler: `@tollstile/fetch`
   - MCP server: `npm install tollstile @tollstile/mcp`
   - Check https://tollstile.com/docs/installation for each adapter's status before choosing one.
2. Create **one** instance in its own module and import it where routes are defined:
   ```ts
   import { createTollstile, memoryLedger, testRail } from "tollstile";
   export const toll = createTollstile({ rails: [testRail()], ledger: memoryLedger() });
   ```
3. Put the price in front of the handler the project already has:
   ```ts
   export const GET = paid(toll.price("$0.05"), handler);          // Next.js
   app.get("/weather", tollstile(toll.price("$0.05")), handler);   // Hono
   ```
4. Verify locally: an unpaid request returns `402` with a `quote`; `curl -H "Payment: test"` returns `200` with a `payment-receipt` header.
5. For production, tell the user they must choose live rails and a database ledger, provide `secret` from the environment, and schedule `toll.reconcile()`.

## Patterns

| User wants | Use |
|---|---|
| Fixed price per call | `toll.price("$0.05")` |
| Charge actual usage up to a cap | `toll.price(upTo("$0.50"))` and `await c.get("payment").fulfill({ amount: "$0.12" })` |
| Price computed per request | `toll.price(async (context) => "$0.42")` — the quote fixes the price and is bound to the request body; retries must resend the same body, or set `commit` to the pricing fields |
| Subscribers free, others pay | `access: [subscriber({ active }), payPerCall()]` plus the adapter's `principal` option |
| Prepaid credits | `access: [credits({ balance }), payPerCall()]` with a `Balance` implementation |
| Spend caps | `require: [limit({ perPayer: "100/hour", spendPerDay: "$20" })]` |
| Settle before running, refund on failure | `flow: "upfront"` (rail must support refunds) |
| Charge for an MCP tool | `paidTool(server, name, config, toll.price("$0.01"), handler)` from `@tollstile/mcp` |
| Ask a person before charging an MCP call | `paidTool(…, { approval: { above: "$0.05" } })`. Needs a session: a stateless HTTP server cannot receive the answer |
| Send that person somewhere to pay | `paidTool(…, { checkout: (denial) => ({ url, message }) })` |
| Sell an MCP server to people, with no payment protocol at all | `principal` from `extra.authInfo` plus `access: [subscriber({ active }), credits({ balance })]` — **omit `payPerCall()`**, and no rail can admit anyone |

## Rules

- Prices are strings (`"$0.05"`) or `upTo("$0.50")`. Never pass numbers or floats.
- Do not wrap Tollstile calls in try/catch to hide errors. `TollstileError` codes such as `CAPABILITY_MISSING` and `CONFIG_INVALID` mean the configuration must change.
- Do not mix `testRail()` with live rails; `createTollstile` refuses it.
- Do not compute prices from client input without validation; the server decides the price.
- Do not claim payments are processed "exactly once". Tollstile guarantees no duplicate economic effects.
- Keep handlers returning status ≥ 400 on failure so the charge is released or refunded.

## Testing

```ts
import { fakeClock } from "tollstile/testing";
const rail = testRail();
rail.simulate({ settle: "timeout-after-effect" });
// …call the route, then:
await toll.reconcile({ olderThanMs: 0 });
```
