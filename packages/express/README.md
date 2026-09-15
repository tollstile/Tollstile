# @tollstile/express

Tollstile for Express 5.

`paid(gate, handler)` wraps a route handler. Unpaid requests get a `402` with every rail's challenge; paid requests run your handler, and the response is held at the moment it would send its headers until the payment is completed — settled, or released. Receipt headers are on the response, and settlement has finished, before anything reaches the client.

## Install

```bash
npm install tollstile @tollstile/express express
```

## Example

```ts
import express from 'express';
import { createTollstile, memoryLedger, testRail } from 'tollstile';
import { paid } from '@tollstile/express';

const toll = createTollstile({ rails: [testRail()], ledger: memoryLedger() });
const app = express();

app.get('/weather', paid(toll.price('$0.01'), (req, res, { payment }) => {
  res.json({ forecast: 'clear', paidWith: payment.via });
}));

app.listen(3000);
```

```bash
curl -i localhost:3000/weather                      # 402 Payment Required
curl -i -H "Payment: test" localhost:3000/weather   # 200 OK, Payment-Receipt: test_settlement_…
```

## Behavior

The handler is called as `handler(req, res, { payment, next })`.

| What happens | Payment |
|---|---|
| The response sends its headers with status below 400 | completed as `succeeded`: settled (authorization flow), receipt headers added |
| The response sends its headers with status 400 or above | completed as `failed`: released, or refunded on the upfront flow |
| The handler throws or rejects | completed as `failed`, then Express receives the error |
| The handler calls `next(error)` | completed as `failed` when the error response is sent |
| The handler calls `next()` | decided by whichever handler sends the response |

- **When the outcome is decided.** Express responses are written synchronously, but settlement is not. The first call that would send headers — `res.send`, `res.json`, `res.end`, `res.writeHead`, `res.write`, `res.flushHeaders`, or a piped stream — decides the outcome from the status code, and that call and everything after it are held until the payment is completed. A streaming handler therefore gets its first bytes out only after settlement, and an error thrown halfway through a stream does not undo the charge: the headers, and the receipt, are already on their way.
- **When completion fails** (for example, the ledger is unreachable), the held response is discarded and the error goes to your Express error handlers, which render it instead. If control had already left the handler through `next()` or a thrown error, the connection is closed instead of passing the error on a second time.
- Writes made while the response is held return `false`; `'drain'` is emitted once they are let through, so piped streams and writers that respect back-pressure resume.
- Call `payment.fulfill()` inside the handler to mark the service as delivered earlier; a later failure then does not undo the charge.
- The resource is `"<METHOD> <route path>"` — e.g. `GET /api/users/:id` — when the handler is on a string route path, and `"<METHOD> <pathname>"` otherwise (for example under `app.use`). Router mount paths are taken from `req.baseUrl`, so a mount path with parameters is recorded with its values; set `toll.price(amount, { resource })` there.
- Rails read proofs from a Web `Request` built from `req`: method, the absolute URL from `req.protocol`, `req.host`, and `req.originalUrl` (both honor Express's `trust proxy` setting), and every header. The body is not included: rails read proofs from headers.

## Options

`paid(gate, handler, options?)`

| Option | Type | Description |
|---|---|---|
| `principal` | `(req: express.Request) => Principal \| null \| Promise<Principal \| null>` | Resolves the authenticated caller for access policies such as `subscriber()` and `credits()`. Defaults to no principal. |

## Verification status

Tested with Vitest against a real Express 5.2 app on Node's HTTP server, an ephemeral port, and `fetch`, using `testRail()`, `memoryLedger()`, and `memoryBalance()`: the 402 → pay with the echoed quote → 200 round trip; `res.json`, `res.send`, explicit `res.writeHead`, a piped stream larger than the socket buffer, and writers waiting for `'drain'`; completion finishing before the client sees the response (with a deliberately slow `complete`); releases on thrown errors, rejected promises, `next(error)`, and 4xx responses; `next()` to a later handler; a failing completion replacing the response; route-path resource names; a single `complete()` per request; and principals reaching `credits()`.

Not tested with other middleware that patches the response, such as `compression`, or behind a reverse proxy. To verify such a setup, run the example with your middleware stack and run the two `curl` commands: the second must return `200` with a `payment-receipt` header and the full body, and your ledger must show the charge `settled` before the response was received.
