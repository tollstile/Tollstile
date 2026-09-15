import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { paidTool } from '@tollstile/mcp';
import { z } from 'zod';
import { toll } from './toll';

export function createServer(): McpServer {
  const server = new McpServer({ name: 'weather', version: '1.0.0' });

  // Called without payment, the tool does not run: the result is `isError: true` with the price and
  // a signed quote in `_meta["tollstile/payment-required"]`. Paid, it runs and the result carries
  // a receipt in `_meta["tollstile/test-receipt"]`.
  paidTool(
    server,
    'forecast',
    { description: "Tomorrow's weather for a city. Costs $0.01 per call.", inputSchema: { city: z.string() } },
    toll.price('$0.01'),
    ({ city }) => ({ content: [{ type: 'text', text: `Tomorrow in ${city}: clear` }] }),
  );

  return server;
}
