import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { paidTool } from '@tollstile/mcp';
import { forecast } from './handlers';
import { createToll, type Env } from './toll';

/**
 * The same demo over MCP: agents pay for a tool call by putting the test payment in `_meta`.
 * Stateless — a fresh server and transport per request, which is what Workers isolates want.
 */
export async function mcp(request: Request, env: Env): Promise<Response> {
  const toll = createToll(env);
  const server = new McpServer({ name: 'tollstile-demo', version: '1.0.0' });

  paidTool(
    server,
    'forecast',
    { description: 'Tomorrow in one word, for a city. Costs $0.01 per call.' },
    toll.price('$0.01', { resource: 'tool:forecast' }),
    (_args, { payment }) => {
      const result = forecast('Tokyo');
      return { content: [{ type: 'text' as const, text: `${result.city}: ${result.forecast} (paid via ${payment.via})` }] };
    },
  );

  server.registerTool(
    'pricing',
    { description: 'What this demo charges, and how to pay for a tool call. Free.' },
    () => ({
      content: [
        {
          type: 'text' as const,
          text: [
            'tools:',
            '  forecast — $0.01 per call',
            '',
            'To pay, call the tool with _meta:',
            '  { "tollstile/test-payment": "test" }',
            'An unpaid call answers with the payment requirement in _meta["tollstile/payment-required"].',
            'Retry safely with _meta["tollstile/idempotency-key"]: the same key is never charged twice.',
          ].join('\n'),
        },
      ],
    }),
  );

  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await server.connect(transport);
  const response = await transport.handleRequest(request);
  await server.close();
  return response;
}
