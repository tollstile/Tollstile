import { defineProxyConfig } from '@tollstile/proxy';
import { createTollstile, memoryLedger, testRail, upTo } from 'tollstile';

// The test rail runs the whole payment lifecycle locally: pay with `Payment: test quote=<quote>`
// over HTTP, or `_meta["tollstile/test-payment"]` in an MCP tool call.
const toll = createTollstile({ rails: [testRail()], ledger: memoryLedger() });

export default defineProxyConfig({
  toll,
  upstream: process.env.UPSTREAM ?? 'http://127.0.0.1:8000',
  mcp: { path: '/mcp' },
  routes: [
    { method: 'GET', path: '/weather', price: '$0.01' },
    { method: 'POST', path: '/summarize', price: upTo('$0.50') },
    { tool: 'generate_image', price: '$0.04' },
  ],
  port: 8402,
});

// ─── Use real payments ────────────────────────────────────────────────────────
// Replace the test rail with x402 on Base Sepolia (see README.md → "Use real payments"):
//
// import { x402 } from '@tollstile/x402';
// import { postgresLedger } from '@tollstile/postgres';
//
// const toll = createTollstile({
//   rails: [x402({ network: 'eip155:84532', payTo: process.env.PAY_TO, denomination: 'USD', rpcUrl: 'https://sepolia.base.org' })],
//   ledger: postgresLedger({ query, transaction }),
//   secret: process.env.TOLLSTILE_SECRET,
// });
