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

> **Pre-release.** The core, test rail, memory ledger, Hono adapter, and `create-tollstile` are implemented and tested. Live rails, SQL ledgers, and the MCP, Next.js, Express, and fetch adapters are in development.

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

| Package | Status |
|---|---|
| [`tollstile`](./packages/tollstile) | Implemented |
| [`@tollstile/hono`](./packages/hono) | Implemented |
| [`create-tollstile`](./packages/create-tollstile) | Implemented |
| `@tollstile/x402` · `@tollstile/mpp` · `@tollstile/l402` · `@tollstile/kyapay` | In development |
| `@tollstile/postgres` · `@tollstile/sqlite` | In development |
| `@tollstile/mcp` · `@tollstile/next` · `@tollstile/express` · `@tollstile/fetch` | In development |
| `@tollstile/web-bot-auth` · `@tollstile/ap2` | In development |

## Contributing

Read [PHILOSOPHY.md](./PHILOSOPHY.md), [DESIGN.md](./DESIGN.md), and [CODING_RULES.md](./CODING_RULES.md). Run `pnpm check` (Node 22).

## License

MIT © 2026 Paradigm AI Inc.
