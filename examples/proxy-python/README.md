# Proxy in front of a Python service

A FastAPI app with an MCP server (MCP Python SDK) that has **no payment code**, and Tollstile's proxy in front of it charging for two HTTP routes and one MCP tool.

| Route or tool | Price | Upstream code |
|---|---|---|
| `GET /health` | free | unchanged |
| `GET /weather` | $0.01 | reads `tollstile-payer` to see who paid |
| `POST /summarize` | up to $0.50 | sets `tollstile-fulfill-amount` to what it used |
| MCP `generate_image` | $0.04 | unchanged |
| MCP `list_styles` | free | unchanged |

## Run it

Python 3.10+ and Node 22.12+ with pnpm 9.

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000     # the service, on a private address
```

In another terminal, from the repository root:

```bash
pnpm install
pnpm --filter @tollstile-examples/proxy-python proxy                 # http://localhost:8402
```

Then call the proxy, not the service:

```bash
curl -i localhost:8402/health                                        # 200, free
curl -i 'localhost:8402/weather?city=Osaka'                          # 402 with a quote
curl -i -H "Payment: test quote=<quote>" 'localhost:8402/weather?city=Osaka'   # 200 + payment-receipt
```

An MCP tool call through the proxy:

```bash
curl -s -X POST localhost:8402/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-06-18' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"generate_image","arguments":{"prompt":"lighthouse"},"_meta":{"tollstile/test-payment":"test"}}}'
```

Without `_meta["tollstile/test-payment"]` the result is a payment-required tool result; with it, the tool runs and the receipt is in the result's `_meta`.

## Use real payments

Replace the test rail in `tollstile.proxy.ts` with a real one (the commented block shows x402 on Base Sepolia) and a database ledger. The Python service stays unchanged. Real rails have not been verified through the proxy against live providers yet.

Keep the service bound to `127.0.0.1` or a private network: anything that can reach it directly skips payment.
