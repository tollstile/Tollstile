# @tollstile/proxy

A paid gateway in front of any HTTP API or MCP server. Charge per route or per tool with x402, MPP, credits, and subscriptions, without adding code to the service behind it — FastAPI, FastMCP and the MCP Python SDK, Rails, Django, Go, anything that speaks HTTP.

```txt
agent ──► tollstile-proxy ──► your service (private address)
          402 · verify · settle · receipt
```

## Install

```bash
npm install tollstile @tollstile/proxy
```

## Configure

```ts title="tollstile.proxy.ts"
import { defineProxyConfig } from "@tollstile/proxy";
import { createTollstile, memoryLedger, testRail, upTo } from "tollstile";

const toll = createTollstile({ rails: [testRail()], ledger: memoryLedger() });

export default defineProxyConfig({
  toll,
  upstream: "http://127.0.0.1:8000",
  mcp: { path: "/mcp" },
  routes: [
    { method: "GET", path: "/weather", price: "$0.01" },
    { method: "POST", path: "/summarize", price: upTo("$0.50") },
    { path: "/reports/:id/*", price: "$0.02" },
    { tool: "generate_image", price: "$0.04" },
  ],
});
```

```bash
npx tollstile-proxy --config tollstile.proxy.mjs --port 8402
```

TypeScript configs need a TypeScript-aware runner: `npx tsx node_modules/@tollstile/proxy/dist/cli.js --config tollstile.proxy.ts`, or write the config as `.mjs`.

Route options are the same as `toll.price()`: `access`, `require`, `flow`, `commit`, `resource`.

| Option | Default | Purpose |
|---|---|---|
| `upstream` | required | Base URL of the service behind the proxy |
| `routes` | required | HTTP routes (`method?`, `path`) and MCP tools (`tool`), each with a price |
| `mcp.path` | — | The upstream MCP endpoint. Required when a route prices a tool |
| `unmatched` | `"pass"` | Requests no route prices are forwarded free (`pass`) or refused with 404 (`deny`) |
| `principal` | none | Resolves the caller from the request, for `subscriber()` and `credits()` |
| `maxMcpBodyBytes` | 10 MiB | Larger bodies to the MCP endpoint are refused (they could hide a tool call) |
| `upstreamTimeoutMs` | 60 s | The upstream is given up on after this long; the charge is released and the client gets 502 |
| `port`, `hostname` | 8402, 0.0.0.0 | CLI only |

## How it charges

**HTTP routes.** The request is priced and verified before it reaches the upstream. The upstream's answer decides the outcome: below 400 succeeds and settles before the response is sent to the client, with the rail's receipt headers added; 400 or above, or no answer, releases the charge. If settlement is rejected, the upstream's response is discarded and the client gets a fresh 402.

**MCP tools.** `POST` requests to `mcp.path` are read as JSON-RPC. A `tools/call` for a priced tool is priced from its name and arguments; the payment is read from `params._meta` like `@tollstile/mcp`. An unpaid call gets a payment-required tool result (x402's `PaymentRequired` when an x402 rail is configured, otherwise Tollstile's body in `_meta["tollstile/payment-required"]`). A paid call is forwarded; a result without `isError` settles and the receipt is added to the result's `_meta`, in JSON or SSE responses. Everything else — `initialize`, `tools/list`, free tools, notifications, `GET` streams — passes through untouched. Priced tools inside JSON-RPC batches are refused.

**Variable prices.** On an `upTo()` route, the upstream reports what it used with a response header, and the proxy strips it before the client sees the response:

| Response header from the upstream | Meaning |
|---|---|
| `Tollstile-Fulfill-Amount: $0.137` | The amount to charge, at most the route's maximum. An invalid or larger amount is not charged; the request completes as failed |
| `Tollstile-Result-Ref: jobs/42` | Where the result was stored, returned to idempotent retries in `already_paid` |

**What the upstream receives.** The request as sent, with its canonical path, plus who paid:

| Request header to the upstream | Value |
|---|---|
| `Tollstile-Payment-Via` | `rail` or `policy` |
| `Tollstile-Payer` | The rail's payer id, or the policy account |
| `Tollstile-Charge-Id` | The charge, stable across idempotent retries |
| `Tollstile-Amount` | Currency and micro-units, e.g. `USD 40000` |

Clients cannot set these: every incoming `tollstile-*` header is removed.

**Paths.** Percent-encoding, repeated slashes, dot segments, and trailing slashes cannot route around a price: the proxy matches and forwards the same canonical path, so what it priced is exactly what the upstream receives.

## Security

- **The upstream must only be reachable through the proxy.** Bind it to `127.0.0.1` or a private network. Anyone who can reach it directly skips payment, and can forge the `Tollstile-*` headers.
- Idempotency keys (`Idempotency-Key`, or `_meta["tollstile/idempotency-key"]`) work as in every adapter: a retried paid request is never paid or forwarded twice.
- Streaming responses: on HTTP routes the body streams after settlement; MCP tool responses are buffered to add the receipt, so progress notifications arrive together with the result.

## Embedding

`createProxy(options)` returns a Web-standard `(request: Request) => Promise<Response>` handler, so the gateway runs on Cloudflare Workers, Deno, and Bun too. `@tollstile/proxy/node` exports `serve(handler, { port })` for Node.

```ts
import { createProxy } from "@tollstile/proxy";
export default { fetch: createProxy({ toll, upstream: "https://internal.example", routes }) };
```

## Verification status

Tested with unit tests against a recorded upstream, and end to end in front of a real FastAPI app with the MCP Python SDK 2.2 (JSON and SSE responses, free and priced tools, `upTo` with the amount header). Not yet run in production or on Workers.

Example: [`examples/proxy-python`](../../examples/proxy-python).
