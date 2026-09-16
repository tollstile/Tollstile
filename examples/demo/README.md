# Tollstile demo

The live demo at **[demo.tollstile.com](https://demo.tollstile.com)**: a paid API, a paid MCP tool, and the ledger filling up as people pay. It runs on Cloudflare Workers with `@tollstile/fetch`, `@tollstile/mcp`, and the SQLite ledger on D1.

The rail is the **test rail**, so anyone can pay: send `Payment: test quote=<quote>`. No wallet, no account, no money.

| Route | Price | What it shows |
|---|---|---|
| `GET /v1/forecast?city=` | $0.01 | A fixed price: `402` with a signed quote, pay it, `200` with a receipt |
| `POST /v1/translate` | $0.001 per word | A price computed from the body. The quote binds to that body, so a cheap quote cannot pay for a bigger request |
| `POST /v1/summarize` | up to $0.50 | `upTo()`: the handler reports what it used and only that is charged. `x-api-key: demo-member` draws on prepaid credits instead |
| `POST /mcp` | $0.01 per `forecast` call | The same thing over MCP: agents pay in `_meta`, and the receipt comes back in the result's `_meta` |
| `POST /mcp` | $0.25 per `forecast_week` call, from the demo's credit | Nothing to pay, and still not spent without a person's approval: the shortest way to see what approval looks like in your client |
| `POST /mcp` | up to $0.50 per `summarize` call | A charge a person has to approve: the server asks over MCP elicitation, and a call they decline is released |
| `GET /api/charges` | free | The ledger behind the live table on the page |
| `GET /v1/results/:id` | free | What a paid call produced, by the reference a retry is handed in `already_paid` |
| `GET /api/clients` | free | Which MCP clients have connected here and what each declared it can do — names and capabilities only |
| `GET /.well-known/tollstile` | free | What is on sale, what it costs, and what happens to the money — read before calling anything |

Retries are safe everywhere: send `Idempotency-Key` (or `_meta["tollstile/idempotency-key"]`) and a repeat is answered `409 already_paid` instead of being charged again — with `result`, the reference to what the first call produced, so the answer is recovered rather than bought twice. The demo keeps those under the charge's own id; Tollstile stores the reference, never the result.

## The price list

Every priced thing here is defined once, in `src/catalog.ts`. The HTTP routes and the MCP tools take their gate from it, and `/.well-known/tollstile` describes those same gates — each entry carries Tollstile's own `plan`: whether the price is fixed, computed, or a maximum; which access policies are tried; which rails can serve it and when they settle. A price cannot drift from what is charged, because there is nothing to drift from.

This is a proposal, not a standard. It exists because an agent that must contract with a provider before it can call anything is not buying software at the moment it needs it — and because the demo needed one place to keep prices.

## The agent

`scripts/agent.ts` is a client that pays, with the two consents that belong on its side of the wire: a budget it enforces itself, and a person it asks when the server wants one.

```bash
pnpm --filter @tollstile-examples/demo agent -- --budget '1 USD'          # asks you before the expensive call
pnpm --filter @tollstile-examples/demo agent -- --budget '1 USD' --yes    # answers "accept" for you
pnpm --filter @tollstile-examples/demo agent -- --budget '1 USD' --no     # answers "decline": watch the ledger release it
```

Most MCP clients give the model no way to write `_meta`, which is the right shape: the model asks for a tool, the client decides whether to pay for it. Point the agent at a local worker with `--url http://localhost:8787/mcp`.

## What a chat client sees

No chat client lets a model attach a payment, so the demo's tools also carry a `checkout`: a denial a client cannot act on is answered with a page for the person instead of an error for the model. What each client gets depends on what it declared.

```bash
pnpm --filter @tollstile-examples/demo exec tsx scripts/probe-url-elicitation.ts
```

That connects as a client that says it can open a page, and prints what comes back:

```
JSON-RPC error -32042: URL elicitation required
{ "elicitations": [{ "mode": "url", "message": "This tool is paid…", "url": "https://demo.tollstile.com/#pay" }] }
```

A client that declared no such capability is told the same thing in the text its model reads, and carries the page in `_meta["tollstile/checkout"]` as well.

Which clients can actually open a page is not something to guess at: `GET /api/clients` lists what each client that has connected here declared at `initialize` — name, version, protocol, and its capabilities object. Nothing about who was using it, and nothing it sent.

## Sessions, and why `/mcp` uses a Durable Object

Asking a person to approve a charge means the server sends the client a request and reads the answer off a **later** POST. A stateless MCP endpoint cannot do that: the answer arrives at a different isolate than the one waiting for it. So every request for one session is routed to one Durable Object, which holds the MCP server for as long as the session lives. The paid HTTP routes need none of this — they are rebuilt per request.

A session the runtime has evicted is answered `404`, which tells the client to start a new one. A one-shot call — `curl` straight at a tool, with no `initialize` — still works: it gets a server of its own, and tools that need approval refuse it, because nobody can be asked.

## Run it locally

From the repository root, with Node 22.12+ and pnpm 9:

```bash
pnpm install
pnpm --filter @tollstile-examples/demo migrate:local   # create the ledger tables in local D1
echo 'TOLLSTILE_SECRET="a-local-secret-of-32-characters-plus"' > examples/demo/.dev.vars
pnpm --filter @tollstile-examples/demo dev             # http://localhost:8787
```

```bash
curl -i 'http://localhost:8787/v1/forecast?city=Osaka'
curl -i -H "Payment: test quote=<quote>" 'http://localhost:8787/v1/forecast?city=Osaka'
```

`pnpm vitest run examples/demo` runs the same worker against D1's shape over `node:sqlite`, so the tests exercise exactly what is deployed.

## Deploy it

```bash
npx wrangler d1 create tollstile-demo          # put the id in wrangler.jsonc
pnpm --filter @tollstile-examples/demo migrate # apply the ledger schema to the remote database
npx wrangler secret put TOLLSTILE_SECRET       # 32+ random characters; quotes must verify across isolates
pnpm --filter @tollstile-examples/demo deploy
```

A scheduled trigger can run reconciliation; the worker exports `scheduled` for it.

## What this demo is not

- The credits balance is in memory, so it resets with each isolate. A real deployment keeps balances in its own database.
- MCP sessions live in memory inside their Durable Object, so an evicted session is gone and the client starts another.
- The test rail moves no money. To take real payments, swap it for `x402(...)` or `mppStripe(...)` in `src/toll.ts` — the rest of the code does not change.
