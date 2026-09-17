# @tollstile/next

Tollstile for Next.js App Router route handlers.

`paid(gate, handler)` returns a route handler. Unpaid requests get a `402` with every rail's challenge; paid requests run your handler with the route `params` and `payment`, and the payment is completed — settled, or released — before the response is returned, with the rail's receipt headers on it. It imports nothing from `next`, so it works with any Next.js version whose route handlers take a Web `Request`.

## Install

```bash
npm install tollstile @tollstile/next
```

## Example

```ts
// lib/toll.ts
import { createTollstile, memoryLedger, testRail } from 'tollstile';

export const toll = createTollstile({ rails: [testRail()], ledger: memoryLedger() });
```

```ts
// app/reports/[id]/route.ts
import { paid } from '@tollstile/next';
import { toll } from '@/lib/toll';

export const GET = paid(
  toll.price('$0.01', { resource: 'GET /reports/[id]' }),
  async (request, { params, payment }) => {
    const { id } = await params;
    return Response.json({ id, paidWith: payment.via });
  },
);
```

```bash
curl -i localhost:3000/reports/42                      # 402 Payment Required
curl -i -H "Payment: test" localhost:3000/reports/42   # 200 OK, Payment-Receipt: test_settlement_…
```

`memoryLedger()` lives in one process. Use a database ledger in production and on serverless deployments, where each invocation may run in a different instance.

## Behavior

| Handler result | Payment |
|---|---|
| Returns a response with status below 400 | completed as `succeeded`: settled (authorization flow), receipt headers added |
| Returns a response with status 400 or above | completed as `failed`: released, or refunded on the upfront flow |
| Throws or rejects | completed as `failed`, then the error is rethrown |

- `redirect()` and `notFound()` from `next/navigation` work by throwing, so they count as failures. Return `NextResponse.redirect()` when a redirect is the paid result.
- Call `payment.fulfill()` inside the handler to mark the service as delivered earlier; a later failure then does not undo the charge.
- The resource is `"<METHOD> <pathname>"`, without the query string. Dynamic segments make the set of resource names unbounded — every `/reports/42` is its own resource in your ledger and limits. Name the route instead with `toll.price(amount, { resource })`, as in the example.
- The handler receives the request typed as `Request`. Next.js passes a `NextRequest`; use `new URL(request.url)` for the URL.

## Options

`paid(gate, handler, options?)`

| Option | Type | Description |
|---|---|---|
| `principal` | `(request: Request) => Principal \| null \| Promise<Principal \| null>` | Resolves the authenticated caller for access policies such as `subscriber()` and `credits()`. Defaults to no principal. |

## Verification status

Tested with Vitest by calling the exported handler the way Next.js does — `(request, { params: Promise })` — against `testRail()`, `memoryLedger()`, and `memoryBalance()`: the 402 → pay with the echoed quote → 200 round trip, params passthrough, receipts on immutable responses, releases on thrown errors and 4xx responses, a single `complete()` per request, principals reaching `credits()`, and assignability to the handler type Next.js checks for static, dynamic, and catch-all routes.

Run in a Next.js 15.5 application (`examples/nextjs`): `next build` type-checks and compiles the paid route, and against `next start` an unpaid `GET /api/weather` returns `402` with a `quote`, and the retry with `Payment: test quote=…` returns `200` with a `payment-receipt` header.
