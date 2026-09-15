import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// An agent that calls a paid MCP tool, reads the payment-required result, pays with the test rail,
// and calls again. It starts the server as a subprocess over stdio.
const client = new Client({ name: 'weather-agent', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'src/server.ts'] }));

const call = { name: 'forecast', arguments: { city: 'Tokyo' } };

const unpaid = await client.callTool(call);
const challenge = unpaid._meta?.['tollstile/payment-required'];
if (!isChallenge(challenge)) {
  throw new Error(`Expected a payment-required result, got ${JSON.stringify(unpaid)}`);
}
console.log(`tools/call forecast → payment required, price ${challenge.price}`);

const paid = await client.callTool({ ...call, _meta: { 'tollstile/test-payment': `test quote=${challenge.quote}` } });
console.log(`tools/call forecast  _meta: tollstile/test-payment → receipt ${String(paid._meta?.['tollstile/test-receipt'])}`);
console.log(`  ${JSON.stringify('content' in paid ? paid.content : paid.toolResult)}`);

await client.close();

/** The fields of Tollstile's payment-required body this agent reads. */
function isChallenge(body: unknown): body is { readonly price: string; readonly quote: string } {
  return typeof body === 'object' && body !== null && 'price' in body && typeof body.price === 'string' && 'quote' in body && typeof body.quote === 'string';
}
