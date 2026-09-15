<p align="center">
  <strong>Tollstile</strong><br />
  Open-source payment middleware for APIs, MCP tools, and AI agents.
</p>

<p align="center">
  <a href="https://tollstile.com/docs">Docs</a> ·
  <a href="https://tollstile.com/docs/quickstart">Quickstart</a> ·
  <a href="https://tollstile.com/llms.txt">llms.txt</a> ·
  <a href="./PHILOSOPHY.md">Philosophy</a> ·
  <a href="./DESIGN.md">Design</a>
</p>

---

Charge AI agents and API clients per call with HTTP 402. Accept **x402** and **MPP** payments, let **subscribers** through, draw down **credits**, cap **spend per payer**, **refund** failed work, and keep every charge in **your own database** — without taking custody of funds.

```ts
import { Hono } from "hono";
import { createTollstile, memoryLedger, testRail } from "tollstile";
import { tollstile } from "@tollstile/hono";

const toll = createTollstile({ rails: [testRail()], ledger: memoryLedger() });
const app = new Hono();

app.get("/weather", tollstile(toll.price("$0.05")), (c) => c.json({ forecast: "clear" }));
```

```bash
curl -i localhost:3000/weather                      # 402 Payment Required + signed quote
curl -i -H "Payment: test" localhost:3000/weather   # 200 OK + receipt
```

> **Pre-release, not on npm yet.** Every package is implemented and tested against fakes, published test vectors, and reference libraries. No rail has been verified against a live provider yet; each rail's README lists the exact steps. AP2 and the MPP Tempo session intent are experimental.

## Prompt your coding agent

```txt
Add $0.05 pay-per-call pricing to this Hono endpoint using Tollstile.
```

```txt
Let signed-in users pay from prepaid credits with Tollstile, and require payment from everyone else.
```

Agents can read [`/llms.txt`](https://tollstile.com/llms.txt) and the skill in [`skills/tollstile/SKILL.md`](./skills/tollstile/SKILL.md).

## Why Tollstile

- **Any 402 rail on one route** — x402, MPP, L402, KYAPay — with truthful per-rail capabilities.
- **Quotes** — the price charged is the price the payer saw, even on dynamic routes, and a quote only pays for the request it priced.
- **Who pays is separate from how** — `subscriber()`, `credits()`, `payPerCall()`.
- **Pay for what ran** — `upTo("$0.50")` and `payment.fulfill({ amount })`.
- **No duplicate economic effects** — charges are state machines; unknown outcomes are reconciled, never guessed.
- **Your ledger** — no account, no dashboard, no telemetry.
- **Test rail** — the full lifecycle locally, with failure simulation.

## Packages

| Package | What it is | Status |
|---|---|---|
| [`tollstile`](./packages/tollstile) | Core, policies, requirements, test rail, memory ledger | Tested |
| [`@tollstile/hono`](./packages/hono) · [`express`](./packages/express) · [`next`](./packages/next) · [`fetch`](./packages/fetch) | HTTP adapters | Tested |
| [`@tollstile/mcp`](./packages/mcp) | Paid MCP tools | Tested with the MCP SDK |
| [`@tollstile/x402`](./packages/x402) · [`mpp`](./packages/mpp) · [`l402`](./packages/l402) · [`kyapay`](./packages/kyapay) | Payment rails | Tested against fakes; not yet verified live |
| [`@tollstile/postgres`](./packages/postgres) · [`sqlite`](./packages/sqlite) | Ledgers | Shared conformance suite |
| [`@tollstile/web-bot-auth`](./packages/web-bot-auth) · [`ap2`](./packages/ap2) | Agent identity and user mandates | Spec vectors; AP2 experimental |
| [`create-tollstile`](./packages/create-tollstile) | Project generator | Tested |

## Contributing

Read [PHILOSOPHY.md](./PHILOSOPHY.md), [SPEC.md](./SPEC.md) (the internal contract every rail, ledger, and adapter follows), [DESIGN.md](./DESIGN.md), and [CODING_RULES.md](./CODING_RULES.md). Run `pnpm check` (Node 22).

## License

MIT © 2026 Paradigm AI Inc.
