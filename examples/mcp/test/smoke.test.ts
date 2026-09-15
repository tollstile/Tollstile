import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { createServer } from '../src/mcp-server';

async function connect() {
  const client = new Client({ name: 'smoke-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([createServer().connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const forecast = async (client: Client, payment?: string) =>
  (await client.callTool({
    name: 'forecast',
    arguments: { city: 'Tokyo' },
    ...(payment === undefined ? {} : { _meta: { 'tollstile/test-payment': payment } }),
  })) as CallToolResult;

const challengeOf = (result: CallToolResult) =>
  result._meta?.['tollstile/payment-required'] as { price: string; quote: string; error: { code: string } };

describe('mcp example', () => {
  it('returns a payment-required result, then runs the tool once the quote is paid', async () => {
    const client = await connect();

    const unpaid = await forecast(client);
    expect(unpaid.isError).toBe(true);
    const { price, quote } = challengeOf(unpaid);
    expect(price).toBe('$0.01');

    const paid = await forecast(client, `test quote=${quote}`);
    expect(paid.isError).toBeUndefined();
    expect(paid.content).toEqual([{ type: 'text', text: 'Tomorrow in Tokyo: clear' }]);
    expect(paid._meta?.['tollstile/test-receipt']).toMatch(/^test_settlement_/);

    await client.close();
  });

  it('refuses a payment whose quote was not issued by this server', async () => {
    const client = await connect();

    const forged = await forecast(client, 'test quote=forged');
    expect(forged.isError).toBe(true);
    expect(challengeOf(forged)).toMatchObject({ error: { code: 'quote_invalid' } });

    await client.close();
  });
});
