# Changelog

All publishable packages (`tollstile`, `@tollstile/*`, `create-tollstile`) are released together at the same version. See [RELEASING.md](./RELEASING.md).

## 0.1.1

The first installable release: `@tollstile/*` 0.1.0 depended on `tollstile`, which was not on npm. 0.1.1 publishes every package together and is checked by installing it from npm after publishing.

### Added

- **`@tollstile/proxy`**: a paid gateway in front of any HTTP API or MCP server — FastAPI, the MCP Python SDK, Go, Rails — with no payment code in the service. Prices HTTP routes and MCP tool calls, tells the service who paid, charges variable amounts reported by header, and adds receipts to responses and tool results. Includes the `tollstile-proxy` CLI.
- **`npx tollstile reconcile`**: run reconciliation from cron, CI, or a terminal (`--older-than`, `--json`, `--fail-on-pending`). `reconcile()` reports now list each examined charge with its state before and after, and the errors reported during the run.
- **`createRail()`**: build a rail for any payment protocol with safe defaults and runtime contract checks, proven by `railConformance()`. See [Build a rail](https://tollstile.com/docs/rails/build-a-rail).
- **`@tollstile/mcp` — approval**: `paidTool(..., { approval })` asks the person at the client to accept the amount before the call is charged, over MCP elicitation. Only `accept` charges; declined, dismissed, unanswered, and "this client cannot be asked" all release the reservation and answer `access_denied`. See [Approval](https://tollstile.com/docs/adapters/mcp#approval).
- **`@tollstile/mcp` — checkout**: `paidTool(..., { checkout })` answers a denial the agent cannot act on — out of credit, no subscription — with a page for the person. It uses the richest channel the client has: a URL elicitation, a form the client puts on screen, or the text the model reads. See [Checkout](https://tollstile.com/docs/adapters/mcp#checkout).

### Hardened

- **A request cannot choose how much work its rejection costs.** Answering `402` reads the body on dynamic routes, signs a quote, and may have a rail contact its provider — all before anyone has paid. A body larger than `maxRequestBytes` (1 MiB by default, configurable) is now refused before any of that, and a quote token longer than 8 KiB is refused before it is hashed. [SECURITY.md](./SECURITY.md) says what Tollstile bounds here and what belongs in front of it.

### Fixed

- `reconcile()` no longer aborts when another worker moves a charge first; the charge is left to that worker and the run continues. Verified with two concurrent workers on PostgreSQL.
- `Retry-After` was the constant `5`, so every client denied in the same instant came back in the same instant. The wait is now spread around five seconds, and the denial body carries the same number as `retryAfter` — headers never reach an MCP client, which is why one could not honour a wait at all.

### Verified

- Against real providers in test environments: x402 `exact` on Base Sepolia with a USDC transfer, and MPP Stripe in Stripe test mode — each including retries, refunds, and reconciliation.
- PostgreSQL under real concurrency in CI: 100 concurrent requests with the same proof, 100 retries with the same idempotency key, 100 charges against one limit, concurrent reconcile workers, and recovery after a crash.
- Against shipping MCP clients, on the live demo: Claude Code 2.1.186 renders an approval as an Accept / Decline dialog, and accepting settled the charge; OpenAI's `codex-mcp-client` declares `elicitation.url` and opens the checkout page; a client that declares neither is told in the text its model reads. What each client declares is published at [demo.tollstile.com/api/clients](https://demo.tollstile.com/api/clients).
- Throughput of one payer's hot authorization row, measured rather than argued about: ~57 charges/second against one reusable authorization on PostgreSQL 16, ~357/second spread across payers, every charge correct in both. `packages/postgres/test/throughput.bench.test.ts`.

## 0.1.0

Early Access release of the core, rails (x402, MPP, L402, KYAPay), adapters (Hono, Express, Next.js, fetch, MCP), ledgers (Postgres, SQLite), agent requirements (Web Bot Auth, AP2), and `create-tollstile`. Not installable: `tollstile` itself was unpublished.
