# MCP example

A paid MCP tool with `@tollstile/mcp` and the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), served over stdio. It runs on the test rail and an in-memory ledger: no wallet, account, or network.

The server has one tool, `forecast`, at $0.01 per call:

1. Called without payment, the tool does not run. The result is `isError: true`, with the price and a signed quote in `_meta["tollstile/payment-required"]`.
2. Called again with `_meta: { "tollstile/test-payment": "test quote=<quote>" }`, the tool runs, the payment settles, and the result carries `_meta["tollstile/test-receipt"]`.

## Run it

From the repository root, with Node 22.12+ and pnpm 9:

```bash
pnpm install
pnpm --filter @tollstile-examples/mcp agent
```

The agent starts the server as a subprocess over stdio, so one terminal is enough. Expected output (the charge id differs):

```
tools/call forecast → payment required, price $0.01
tools/call forecast  _meta: tollstile/test-payment → receipt test_settlement_chg_51a669b345269b83dbda60f4
  [{"type":"text","text":"Tomorrow in Tokyo: clear"}]
```

To use the server from an MCP host, register the command `pnpm --silent --dir <path to this directory> start` (`--silent` keeps pnpm's banner off stdout, which carries MCP messages). A host that does not send `_meta["tollstile/test-payment"]` sees the payment-required result.

The smoke test connects a client to the server in process over `InMemoryTransport`: `pnpm vitest run examples/mcp` from the repository root.

## Files

| File | |
|---|---|
| `src/toll.ts` | The Tollstile instance: rail and ledger. |
| `src/account-server.ts` | The other way to charge for a tool: identify the caller, draw on the balance they already bought, and send them to top up when it runs out. No rail, no `_meta`, no wallet — see [Sell an MCP server to people](https://tollstile.com/docs/guides/sell-an-mcp-server-to-people). |
| `src/mcp-server.ts` | `createServer()`: an `McpServer` with the paid `forecast` tool. |
| `src/server.ts` | Serves it over stdio. |
| `src/agent.ts` | A client that calls the tool, reads the quote, pays with the test rail, and prints the result and receipt. |
| `test/smoke.test.ts` | The payment-required → pay → result flow, and a forged quote. |
| `test/account-server.test.ts` | A subscriber, someone with credit, someone out of it, and a caller with no account holding a valid payment. |

## Notes

- The tool has a fixed price, so its quote commits to the tool, not its arguments. A `toll.price()` computed from the arguments commits to them by default, and a paid call must repeat the same arguments.
- The ledger lives in memory, and each stdio server process has its own.
- Inside this repository, `tsconfig.json` maps `tollstile` and `@tollstile/*` to their sources, and `tsx` follows the mapping when run from this directory, so nothing needs building. In your own project, install the packages and delete `paths`.

## Use real payments

> **What has and has not been verified.** `@tollstile/x402`'s `exact` flow has been run on Base Sepolia against the x402.org facilitator, including a real USDC transfer, replay rejection, and recovery across a process restart — see [Verification status](../../packages/x402/README.md#verification-status). What has **not** been tried is this adapter's x402 rendering against a real x402 MCP client, and nothing in these examples has settled a payment on a mainnet. Run the checks below on a testnet before trusting it with money.

To accept USDC on Base Sepolia through x402:

1. In `src/toll.ts`, replace `toll` with the commented x402 block below it. The tool and its handler stay the same.
2. Set `PAY_TO` to the address that receives USDC, and `TOLLSTILE_SECRET` to 32 or more random characters (for example `openssl rand -base64 32`). `RPC_URL` is optional and defaults to `https://sepolia.base.org`. A missing or invalid value fails at startup with a message naming it.
3. Call the tool from an x402 MCP client. Unpaid calls now return x402's payment-required result in `structuredContent`; the client pays with `_meta["x402/payment"]` and reads the receipt from `_meta["x402/payment-response"]`. `src/agent.ts` speaks only the test rail. See [Verification status](../../packages/mcp/README.md#verification-status) in `@tollstile/mcp` and [Verify live on Base Sepolia](../../packages/x402/README.md#verify-live-on-base-sepolia-with-the-x402org-facilitator) in `@tollstile/x402`.
4. Before production, replace `memoryLedger()` with a database ledger and run `toll.reconcile()` on a schedule.
