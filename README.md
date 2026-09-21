<p align="center">
  <img src="https://tollstile.com/icon.svg" alt="Tollstile" width="96" /><br />
  <strong>Tollstile</strong><br />
  Open-source payment middleware for APIs, MCP tools, and AI agents.
</p>

<p align="center">
  <a href="https://tollstile.com/docs/roadmap"><img src="https://img.shields.io/badge/status-Early%20Access-orange" alt="Early Access" /></a>
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
// lib/toll.ts
import { createTollstile, memoryLedger, testRail } from "tollstile";

export const toll = createTollstile({ rails: [testRail()], ledger: memoryLedger() });
```

```ts
// app/weather/route.ts
import { paid } from "@tollstile/next";
import { toll } from "@/lib/toll";

export const GET = paid(toll.price("$0.05"), () => Response.json({ forecast: "clear" }));
```

```bash
curl -i localhost:3000/weather                      # 402 Payment Required + signed quote
curl -i -H "Payment: test" localhost:3000/weather   # 200 OK + receipt
```

The handler you already had, with a price in front of it. Same two lines on [Express](./packages/express), [Hono](./packages/hono), [any `fetch` handler](./packages/fetch), and [MCP tools](./packages/mcp).

> **Early Access.** Tollstile is available for public evaluation. x402 and MPP's Stripe rail have been verified against real providers in test environments, on Base Sepolia and in Stripe test mode, including retries, refunds, and reconciliation. KYAPay, AP2, x402's `upto` scheme, and MPP's Tempo rails are tested against fakes and published vectors, and remain experimental or need provider access.

## Prompt your coding agent

```txt
Add $0.05 pay-per-call pricing to this Next.js route handler using Tollstile.
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
- **Nothing charged silently** — an MCP tool can ask the person at the client to approve the amount, and send them somewhere to pay when they cannot.
- **Or no rail at all** — identify the caller and draw on credits they already bought. Selling to people through Claude or ChatGPT needs no payment protocol.
- **No duplicate economic effects** — charges are state machines; unknown outcomes are reconciled, never guessed.
- **Your ledger** — no account, no dashboard, no telemetry.
- **Test rail** — the full lifecycle locally, with failure simulation.

## Packages

| Package | What it is | Status |
|---|---|---|
| [`tollstile`](./packages/tollstile) | Core, policies, requirements, test rail, memory ledger | Tested |
| [`@tollstile/hono`](./packages/hono) · [`express`](./packages/express) · [`next`](./packages/next) · [`fetch`](./packages/fetch) | HTTP adapters | Tested |
| [`@tollstile/mcp`](./packages/mcp) | Paid MCP tools | Tested with the MCP SDK |
| [`@tollstile/proxy`](./packages/proxy) | A paid gateway in front of any HTTP API or MCP server — Python (FastAPI, MCP SDK), Go, Rails | Tested end to end in front of FastAPI and the MCP Python SDK |
| [`@tollstile/x402`](./packages/x402) · [`mpp`](./packages/mpp) · [`l402`](./packages/l402) · [`kyapay`](./packages/kyapay) | Payment rails | x402 (Base Sepolia) and MPP's Stripe rail (test mode) verified against real providers; the rest against fakes and vectors |
| [`@tollstile/postgres`](./packages/postgres) · [`sqlite`](./packages/sqlite) | Ledgers | Shared conformance suite |
| [`@tollstile/web-bot-auth`](./packages/web-bot-auth) · [`ap2`](./packages/ap2) | Agent identity and user mandates | Spec vectors; AP2 experimental |
| [`create-tollstile`](./packages/create-tollstile) | Project generator | Tested |

## Live demo

[demo.tollstile.com](https://demo.tollstile.com) is a paid API you can pay for right now: `402` with a signed quote, pay with the test rail, `200` with a receipt, and the ledger filling up on the page. Same thing over MCP at `https://demo.tollstile.com/mcp`, where one tool is charged only after a person approves the amount.

[`examples/demo/scripts/agent.ts`](./examples/demo/scripts/agent.ts) is the other side of the wire: a client with a budget it will not spend past, which answers the approval the server asks for and backs off when told to wait.

```bash
pnpm --filter @tollstile-examples/demo agent -- --budget '1 USD'
```

## Build a rail

Any payment protocol or provider can be added without touching core: write it with `createRail()`, test it against a fake provider, and prove it with `railConformance()`. Start from [`examples/custom-rail`](./examples/custom-rail) and the [Build a rail](https://tollstile.com/docs/rails/build-a-rail) guide. Published rails can be listed on [Community rails](https://tollstile.com/docs/rails/community).

## Research

[`research/`](./research) holds measurement scripts and paper drafts — currently one study of the x402 index and where probabilistic settlement would and would not pay — with a reference implementation in [`packages/sparse`](./packages/sparse). It is research, not product: private, unpublished and unsupported, kept in the repository so its numbers can be re-run.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md): development setup, what reviews expect, and how rails are shipped — in your own app, as a community rail, or as an official `@tollstile/*` rail. Report vulnerabilities privately per [SECURITY.md](./SECURITY.md).

## License

MIT © 2026 Paradigm AI Inc.
