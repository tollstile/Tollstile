import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { createAccountServer } from '../src/account-server';

/** One `tools/call` as an HTTP server that has already verified a bearer token would deliver it. */
async function forecast(token: string | undefined, extra: Record<string, unknown> = {}): Promise<CallToolResult> {
  const server = createAccountServer();
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await server.connect(transport);
  const response = await transport.handleRequest(
    new Request('https://weather.example/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'forecast', arguments: { city: 'Osaka' }, ...extra } }),
    }),
    token === undefined ? {} : { authInfo: { token, clientId: 'mcp-client', scopes: [] } },
  );
  await server.close();
  return ((await response.json()) as { result: CallToolResult }).result;
}

const textOf = (result: CallToolResult) => result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');

describe('an MCP server that charges accounts, not callers', () => {
  it('runs for a subscriber, free', async () => {
    const result = await forecast('token-dee');

    expect(textOf(result)).toBe('Tomorrow in Osaka: clear');
    expect(result._meta).toBeUndefined();
  });

  it('draws on a balance for someone who has credit', async () => {
    expect(textOf(await forecast('token-amy'))).toBe('Tomorrow in Osaka: clear');
  });

  it('sends someone out of credit to the page instead of erroring at the model', async () => {
    const result = await forecast('token-ben');

    expect(result.isError).toBe(true);
    expect(result._meta?.['tollstile/checkout']).toMatchObject({ url: 'https://weather.example/account/credits' });
  });

  it('refuses a caller with no account, even one holding a valid payment', async () => {
    const anonymous = await forecast(undefined);
    expect(anonymous.isError).toBe(true);

    const paying = await forecast(undefined, { _meta: { 'tollstile/test-payment': 'test' } });
    expect(paying.isError).toBe(true);
    expect(paying._meta?.['tollstile/payment-required']).toMatchObject({ error: { code: 'access_denied' } });
  });
});
