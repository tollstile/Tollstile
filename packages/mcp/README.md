# @tollstile/mcp

Charge for MCP tool calls on servers built with [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk).

`paidTool()` registers a tool with `McpServer.registerTool`, puts a Tollstile gate in front of its handler, renders payment challenges the way each protocol's MCP transport expects, and attaches receipts to the tool result.

## Install

```bash
npm install tollstile @tollstile/mcp @modelcontextprotocol/sdk
```

`@modelcontextprotocol/sdk` 1.23 or later is required: earlier versions turn every error thrown from a tool callback into a tool result, so MPP's JSON-RPC error could not reach the client.

## Example

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { paidTool } from '@tollstile/mcp';
import { createTollstile, memoryLedger, testRail } from 'tollstile';

const toll = createTollstile({ rails: [testRail()], ledger: memoryLedger() });
const server = new McpServer({ name: 'weather', version: '1.0.0' });

paidTool(server, 'forecast', { description: 'Tomorrow in one word' }, toll.price('$0.01'), (_args, { payment }) => ({
  content: [{ type: 'text', text: `clear (paid via ${payment.via})` }],
}));

await server.connect(new StdioServerTransport());
```

A call without payment returns `isError: true` with the challenge in `_meta["tollstile/payment-required"]`. Pay with the test rail by sending the quote it offered:

```json
{ "method": "tools/call", "params": { "name": "forecast", "_meta": { "tollstile/test-payment": "test quote=<quote>" } } }
```

The result carries `_meta["tollstile/test-receipt"]`.

## API

```ts
paidTool(server, name, config, gate, handler, options?): RegisteredTool
```

| Parameter | |
|---|---|
| `server` | An `McpServer`. |
| `name`, `config` | As for `server.registerTool`: `title`, `description`, `inputSchema`, `outputSchema`, `annotations`, `_meta`. |
| `gate` | `toll.price(...)`. |
| `handler` | `(args, extra) => CallToolResult`. `args` is validated against `inputSchema` (`undefined` without one). `extra` is the SDK's request context plus `payment`. |
| `options.principal` | `(extra) => Principal \| null \| Promise<…>`. Resolves the caller for access policies such as `subscriber()` and `credits()`, e.g. from `extra.authInfo` or `extra.requestInfo.headers`. |

### Context passed to the gate

| Field | Value |
|---|---|
| `transport` | `"mcp"` |
| `request` | Under Streamable HTTP and SSE, a `Request` rebuilt from the URL and headers of the HTTP POST that delivered the call. The SDK exposes only those, so it has no body. `null` for stdio and in-memory transports. |
| `mcp` | `{ tool, meta, clientCapabilities }`: `params._meta` and the client's declared capabilities, both checked to be plain JSON. A call whose `_meta` is not JSON is refused with `invalid_request` before the gate runs. |
| `principal` | From `options.principal`, or `null`. |
| `resource` | `gate.resource`, or `tool:<name>`. |
| `requestId` | `crypto.randomUUID()` per call. |
| `extras` | The SDK's `extra`. |

### Denials

| Denial | Rendered as |
|---|---|
| 402, a rail offers `style: "mpp"`, and the client declared `capabilities.experimental.payment` | JSON-RPC error `-32042`, `data: { httpStatus: 402, challenges: [...], failure?: { reason } }` |
| 402, a rail offers `style: "x402"` | Tool result `isError: true`, `structuredContent` = the x402 `PaymentRequired` (with `error` set to the failure reason, if any), `content[0].text` = its JSON |
| any other 402, and 400 / 403 / 429 / 503 | Tool result `isError: true`, `content[0].text` = Tollstile's denial body |

Every denial rendered as a tool result also carries Tollstile's full denial body — every rail's offer and the signed quote — in `_meta["tollstile/payment-required"]`. The generic form has no `structuredContent`, because clients validate it against the tool's `outputSchema`.

Proofs are read by the rails from `_meta`: x402 `"x402/payment"`, MPP `"org.paymentauth/credential"`, test rail `"tollstile/test-payment"`. Receipts land in the result's `_meta`: x402 `"x402/payment-response"`, MPP `"org.paymentauth/receipt"`, test rail `"tollstile/test-receipt"`.

### Outcome

The call **succeeded** — and settles, on the `authorization` flow — when the handler returns a result without `isError: true` whose `structuredContent` matches `outputSchema` (if the tool has one; McpServer checks it only after the callback returns, so `paidTool` checks it first). Otherwise the call **failed**: a handler that throws, returns `isError: true`, or returns output the SDK will reject releases the reservation (or refunds, on `upfront`). A thrown error is rethrown for the SDK to render as usual.

For work that exists before the handler returns, call `extra.payment.fulfill()`; a later failure then does not undo the charge.

## Known limitations

- **Settlement rejected after the tool ran.** The tool output is withheld and the client gets a payment-required result again (reason `settlement_rejected`), as x402's MCP transport asks. An `unknown` settlement still returns the output without a receipt: withholding it would charge for a service never delivered if reconciliation later finds it settled.
- **MPP verification failures use `-32042`, not `-32043`.** McpServer passes only `-32042` through from a tool callback. The failure reason is in `data.failure.reason`, next to a fresh challenge.
- **x402 denials on tools with an `outputSchema`.** The x402 transport requires `structuredContent` on the payment-required result; a client that validates it against the tool's `outputSchema` will reject it. That is the protocol's shape, not something this adapter can change.
- Do not call `RegisteredTool.update()` with a new `callback` (it bypasses the gate), or to add or remove `inputSchema` (the SDK then calls the registered callback with different arguments).

## Verification status

- Tested with the real SDK `McpServer` and `Client` over `InMemoryTransport`, and `WebStandardStreamableHTTPServerTransport` for the HTTP request and principal: test-rail quote round-trip, tampered quote, replay, retry after a released charge, handler throw, `isError`, `outputSchema` mismatch, provider outage during verification (503), 403, non-JSON `_meta`, `credits()` with a resolved principal, and rejected settlement.
- The x402 and MPP renderings are tested against fake rails that return challenges shaped like the x402 MCP transport (`specs/transports-v2/mcp.md`) and `draft-payment-transport-mcp-00`. They are **not** tested against `@x402/mcp`, `mppx`, or a real client.
- To verify live: run a server with `@tollstile/x402` on Base Sepolia, call it from an x402 MCP client, and confirm the client pays from `structuredContent` and reads `_meta["x402/payment-response"]`; run it with `@tollstile/mpp` and a client that declares `capabilities.experimental.payment`, and confirm it receives `-32042` and retries with `_meta["org.paymentauth/credential"]`. Repeat both over Streamable HTTP.
