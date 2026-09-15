# @tollstile/fetch

Tollstile for any runtime built on Web-standard `Request` and `Response`: Cloudflare Workers, Deno, Bun, and Node's `fetch`-style servers.

`paid(gate, handler)` turns a priced route into a `(request) => Promise<Response>` handler. Unpaid requests get a `402` with every rail's challenge; paid requests run your handler, and the payment is completed — settled, or released — before the response is returned, with the rail's receipt headers on it.

## Install

```bash
npm install tollstile @tollstile/fetch
```

## Example

```ts
import { createTollstile, memoryLedger, testRail } from 'tollstile';
import { paid } from '@tollstile/fetch';

const toll = createTollstile({ rails: [testRail()], ledger: memoryLedger() });

const weather = paid(toll.price('$0.01'), (request, { payment }) =>
  Response.json({ forecast: 'clear', paidWith: payment.via }),
);

export default { fetch: weather }; // Workers · Bun: Bun.serve({ fetch: weather }) · Deno: Deno.serve(weather)
```

```bash
curl -i localhost:8787/weather                      # 402 Payment Required
curl -i -H "Payment: test" localhost:8787/weather   # 200 OK, Payment-Receipt: test_settlement_…
```

## Behavior

| Handler result | Payment |
|---|---|
| Returns a response with status below 400 | completed as `succeeded`: settled (authorization flow), receipt headers added |
| Returns a response with status 400 or above | completed as `failed`: released, or refunded on the upfront flow |
| Throws or rejects | completed as `failed`, then the error is rethrown |

- Call `payment.fulfill()` inside the handler to mark the service as delivered earlier; a later failure then does not undo the charge.
- Responses with immutable headers (from `fetch()` or `Response.redirect()`) are copied so the receipt can be added. The copy keeps the status, status text, headers, and the unread body stream.
- The resource is `"<METHOD> <pathname>"`, without the query string. Paths with parameters make the set of resource names unbounded — every `/users/42` is its own resource in your ledger and limits. Name the route instead: `toll.price('$0.01', { resource: 'GET /users/:id' })`.

## Options

`paid(gate, handler, options?)`

| Option | Type | Description |
|---|---|---|
| `principal` | `(request: Request) => Principal \| null \| Promise<Principal \| null>` | Resolves the authenticated caller for access policies such as `subscriber()` and `credits()`. Defaults to no principal. |

## Verification status

Tested with Vitest against `testRail()`, `memoryLedger()`, and `memoryBalance()` using the runtime's own `Request` and `Response` (Node 22): the 402 → pay with the echoed quote → 200 round trip, receipts on mutable and immutable responses, streamed bodies, releases on thrown errors and 4xx responses, a single `complete()` per request, and principals reaching `credits()`.

Not run on Cloudflare Workers, Deno, or Bun. To verify on a runtime, deploy the example above (`wrangler dev`, `deno run --allow-net`, or `bun run`) and run the two `curl` commands: the first must return `402` with a `quote` in the body, the second `200` with a `payment-receipt` header.
