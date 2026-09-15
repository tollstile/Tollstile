# Changelog

All publishable packages (`tollstile`, `@tollstile/*`, `create-tollstile`) are released together at the same version. See [RELEASING.md](./RELEASING.md).

## 0.1.1

The first installable release: `@tollstile/*` 0.1.0 depended on `tollstile`, which was not on npm. 0.1.1 publishes every package together and is checked by installing it from npm after publishing.

### Added

- **`@tollstile/proxy`**: a paid gateway in front of any HTTP API or MCP server — FastAPI, the MCP Python SDK, Go, Rails — with no payment code in the service. Prices HTTP routes and MCP tool calls, tells the service who paid, charges variable amounts reported by header, and adds receipts to responses and tool results. Includes the `tollstile-proxy` CLI.
- **`npx tollstile reconcile`**: run reconciliation from cron, CI, or a terminal (`--older-than`, `--json`, `--fail-on-pending`). `reconcile()` reports now list each examined charge with its state before and after, and the errors reported during the run.
- **`createRail()`**: build a rail for any payment protocol with safe defaults and runtime contract checks, proven by `railConformance()`. See [Build a rail](https://tollstile.com/docs/rails/build-a-rail).

### Fixed

- `reconcile()` no longer aborts when another worker moves a charge first; the charge is left to that worker and the run continues. Verified with two concurrent workers on PostgreSQL.

### Verified

- PostgreSQL under real concurrency in CI: 100 concurrent requests with the same proof, 100 retries with the same idempotency key, 100 charges against one limit, concurrent reconcile workers, and recovery after a crash.

## 0.1.0

Early Access release of the core, rails (x402, MPP, L402, KYAPay), adapters (Hono, Express, Next.js, fetch, MCP), ledgers (Postgres, SQLite), agent requirements (Web Bot Auth, AP2), and `create-tollstile`. Not installable: `tollstile` itself was unpublished.
