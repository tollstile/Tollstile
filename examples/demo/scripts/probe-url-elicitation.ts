import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

/** What a client that can open a page is told when a paid tool is called without payment. */
const url = process.argv[2] ?? 'https://demo.tollstile.com/mcp';
const client = new Client({ name: 'probe', version: '1.0.0' }, { capabilities: { elicitation: { url: {} } } });
await client.connect(new StreamableHTTPClientTransport(new URL(url)) as Transport);

const result = await client.callTool({ name: 'forecast' }).then(
  (value) => ({ kind: 'result' as const, value }),
  (error: unknown) => ({ kind: 'error' as const, value: error }),
);

if (result.kind === 'error') {
  const error = result.value as { code?: number; message?: string; data?: unknown };
  console.log(`JSON-RPC error ${String(error.code)}: ${String(error.message)}`);
  console.log(JSON.stringify(error.data, null, 2));
} else {
  console.log('tool result (no error):');
  console.log(JSON.stringify(result.value, null, 2));
}

await client.close();
