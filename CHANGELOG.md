# Changelog

All publishable packages (`tollstile`, `@tollstile/*`, `create-tollstile`) are released together at the same version. See [RELEASING.md](./RELEASING.md).

## 0.1.2

Fixes from an adversarial review of the security boundary, the wire formats, and the docs, and READMEs that read correctly on npm.

### Upgrading

- `Ledger.pendingCharges(before, limit)` takes a second parameter. The bundled ledgers are updated; a custom ledger must return at most `limit` charges, most recently updated first.
- `@tollstile/proxy`: `unmatched` defaults to `"deny"`. Set `unmatched: "pass"` to keep passing unpriced paths through.

### Hardened

- `maxRequestBytes` is enforced while a body is read, not only from `Content-Length`: on a route that reads the body — a computed price, a request commitment, an idempotency key — core reads a bounded copy and refuses the request the moment the stream passes the limit. The handler still gets the original stream. `@tollstile/proxy` bounds MCP bodies the same way.
- `reconcile()` examines at most `limit` charges per run (500 by default), most recently updated first, and reports `truncated`; the CLI keeps going until a run comes back short. A charge nobody has touched in days — one that cannot be resolved — is visited last, so it cannot starve the ones that can. `Ledger.pendingCharges` takes the limit; custom ledgers need the extra parameter.
- **The gateway forwards nothing it did not price.** `@tollstile/proxy` now refuses (`400`) a path with an encoded separator (`%2F`, `%5C`) or a `;` parameter, which some upstreams re-split into a different route than the one matched; and `unmatched` defaults to `"deny"`, so an unpriced path is `404` unless a merchant chooses to forward it. Found by reading the source as an attacker would: `GET /reports%2F42` against a Python upstream reached a priced report for free.
- **A priced tool's answer is served only on the POST that paid for it.** The proxy withheld nothing when an MCP upstream answered `202` and delivered the result on the standalone stream: the charge was released *and* the output passed through. Such answers are now `502` with nothing charged, and `GET` on the MCP path is declined with `405`, as the protocol allows.
- `createTollstile` refuses a computed price with `commit: "route"` at definition time: one cheap quote would otherwise pay for any body for the quote's lifetime.
- A quote token whose signature is three characters long crashed verification with an uncaught `DOMException` — an unauthenticated `500` on every install. It is `402 quote_invalid` now, like every other malformed token.
- Approval and checkout questions are tied to the tool call's own signal, so a client that disconnects does not hold a reservation for the SDK's full timeout.
- The live demo keyed stored results by charge id while printing charge ids on its public ledger table, so any visitor could read what anyone else paid for. Results are keyed by a secret handed only to the payer now. The `/pay` page also put query-string text into HTML; it does not, and it carries a Content-Security-Policy.

### Fixed

- Over Streamable HTTP, the MCP adapter and the proxy ignored an `Idempotency-Key` header on the POST that carried a tool call, so a retry after a lost response was a second charge. `_meta["tollstile/idempotency-key"]` still takes precedence; the header is the fallback the docs always promised.
- Approval asked a form question of any client that declared elicitation at all. A client that declares only URL mode cannot show one; it now takes the `unsupported` path (refused by default) instead of failing the call.

### Docs

- The `tollstile` README on npm names every adapter — Next.js, Express, Hono, fetch, MCP, and the proxy — with links that work on npmjs.com; READMEs no longer link relatively.
- `@tollstile/next` is verified in a running Next.js 15.5 app: `next build` passes, and against `next start` an unpaid call returns `402` and the paid retry `200` with a receipt.

## 0.1.1

The first installable release: `@tollstile/*` 0.1.0 depended on `tollstile`, which was not on npm. 0.1.1 publishes every package together and is checked by installing it from npm after publishing.

### Added

- **`@tollstile/proxy`**: a paid gateway in front of any HTTP API or MCP server — FastAPI, the MCP Python SDK, Go, Rails — with no payment code in the service. Prices HTTP routes and MCP tool calls, tells the service who paid, charges variable amounts reported by header, and adds receipts to responses and tool results. Includes the `tollstile-proxy` CLI.
- **`npx tollstile reconcile`**: run reconciliation from cron, CI, or a terminal (`--older-than`, `--json`, `--fail-on-pending`). `reconcile()` reports now list each examined charge with its state before and after, and the errors reported during the run.
- **`createRail()`**: build a rail for any payment protocol with safe defaults and runtime contract checks, proven by `railConformance()`. See [Build a rail](https://tollstile.com/docs/rails/build-a-rail).
- **`@tollstile/mcp` — approval**: `paidTool(..., { approval })` asks the person at the client to accept the amount before the call is charged, over MCP elicitation. Only `accept` charges; declined, dismissed, unanswered, and "this client cannot be asked" all release the reservation and answer `access_denied` (`unsupported: 'charge'` opts a merchant out of the last one). See [Approval](https://tollstile.com/docs/adapters/mcp#approval).
- **`@tollstile/mcp` — checkout**: `paidTool(..., { checkout })` answers a denial the agent cannot act on — out of credit, no subscription — with a page for the person. It uses the richest channel the client has: a URL elicitation, a form the client puts on screen, or the text the model reads. See [Checkout](https://tollstile.com/docs/adapters/mcp#checkout).

### Hardened

- **A request cannot choose how much work its rejection costs.** Answering `402` reads the body on dynamic routes, signs a quote, and may have a rail contact its provider — all before anyone has paid. A body larger than `maxRequestBytes` (1 MiB by default, configurable) is now refused before any of that, and a quote token longer than 8 KiB is refused before it is hashed. [SECURITY.md](./SECURITY.md) says what Tollstile bounds here and what belongs in front of it.

### Fixed

- `reconcile()` no longer aborts when another worker moves a charge first; the charge is left to that worker and the run continues. Verified with two concurrent workers on PostgreSQL.
- `Retry-After` was the constant `5`, so every client denied in the same instant came back in the same instant. The wait is now spread around five seconds, and the denial body carries the same number as `retryAfter` — headers never reach an MCP client, which is why one could not honour a wait at all.

### Verified

- Against real providers in test environments: x402 on Base Sepolia, with a USDC transfer, and MPP's Stripe rail in Stripe test mode — each including retries, refunds, and reconciliation.
- PostgreSQL under real concurrency in CI: 100 concurrent requests with the same proof, 100 retries with the same idempotency key, 100 charges against one limit, concurrent reconcile workers, and recovery after a crash.
- Against shipping MCP clients, on the live demo: Claude Code 2.1.186 renders an approval as an Accept / Decline dialog, and accepting settled the charge; OpenAI's `codex-mcp-client` declares `elicitation.url` and opens the checkout page; a client that declares neither is told in the text its model reads. What each client declares is published at [demo.tollstile.com/api/clients](https://demo.tollstile.com/api/clients).
- Throughput of one payer's hot authorization row, measured rather than argued about: ~57 charges/second against one reusable authorization on PostgreSQL 16, ~357/second spread across payers, every charge correct in both. `packages/postgres/test/throughput.bench.test.ts`.

## 0.1.0

Early Access release of the core, rails (x402, MPP, L402, KYAPay), adapters (Hono, Express, Next.js, fetch, MCP), ledgers (Postgres, SQLite), agent requirements (Web Bot Auth, AP2), and `create-tollstile`. Not installable: `tollstile` itself was unpublished.
