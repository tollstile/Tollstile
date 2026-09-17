import { createTollstile, memoryLedger, testRail } from 'tollstile';
import { describe, expect, it } from 'vitest';
import { createProxy } from '../src/index';

const toolCall = (name: string, meta: Record<string, string> = {}, id: number | string = 1) =>
  JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { prompt: 'a lighthouse' }, _meta: meta } });

function setup(respond: (body: string) => Response = (body) => {
  const { id } = JSON.parse(body) as { id: number };
  return Response.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'done' }] } });
}) {
  const rail = testRail();
  const ledger = memoryLedger();
  const toll = createTollstile({ rails: [rail], ledger });
  const bodies: string[] = [];
  const proxy = createProxy({
    toll,
    upstream: 'http://127.0.0.1:8000',
    mcp: { path: '/mcp' },
    routes: [{ tool: 'generate_image', price: '$0.04' }],
    maxMcpBodyBytes: 4096,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = await new Request(input, init).text();
      bodies.push(body);
      return respond(body);
    }),
  });
  const post = (body: string) => proxy(new Request('https://api.example.com/mcp', { method: 'POST', body, headers: { 'content-type': 'application/json' } }));
  const charges = () => ledger.charges().map((charge) => `${charge.payment}/${charge.fulfillment}`);
  return { proxy, post, rail, bodies, charges };
}

type RpcResult = { id: number; result: { isError?: boolean; content: { text: string }[]; _meta?: Record<string, unknown> } };

describe('@tollstile/proxy for MCP tools', () => {
  it('answers an unpaid priced tool call with a payment-required tool result, without reaching the upstream', async () => {
    const { post, bodies } = setup();
    const response = await post(toolCall('generate_image'));
    const message = (await response.json()) as RpcResult;

    expect(response.status).toBe(200);
    expect(message.id).toBe(1);
    expect(message.result.isError).toBe(true);
    expect(message.result._meta?.['tollstile/payment-required']).toMatchObject({ error: { code: 'payment_required' }, price: '$0.04' });
    expect(bodies).toHaveLength(0);
  });

  it('forwards a paid tool call and adds the receipt to the result', async () => {
    const { post, rail } = setup();
    const message = (await (await post(toolCall('generate_image', { 'tollstile/test-payment': 'test' }))).json()) as RpcResult;

    expect(message.result.content[0]?.text).toBe('done');
    expect(message.result._meta).toEqual({ 'tollstile/test-receipt': expect.stringMatching(/^test_settlement_/) as unknown });
    expect(rail.effects.settlements).toBe(1);
  });

  it('honours an Idempotency-Key header on the POST that carried the tool call', async () => {
    const { proxy, rail, bodies } = setup();
    const post = () =>
      proxy(
        new Request('https://api.example.com/mcp', {
          method: 'POST',
          body: toolCall('generate_image', { 'tollstile/test-payment': 'test proof=once' }),
          headers: { 'content-type': 'application/json', 'idempotency-key': 'job-9' },
        }),
      );

    expect(((await (await post()).json()) as RpcResult).result.content[0]?.text).toBe('done');

    // The client lost the answer and repeats the POST exactly: same payment, same key.
    const retry = (await (await post()).json()) as RpcResult;
    expect(retry.result._meta?.['tollstile/payment-required']).toMatchObject({ error: { code: 'already_paid' } });
    expect(bodies).toHaveLength(1);
    expect(rail.effects.settlements).toBe(1);
  });

  it('withholds a paid call whose answer the upstream promised somewhere else, and charges nothing', async () => {
    // Streamable HTTP lets a server answer a POST with 202 and deliver the result on the GET stream.
    const { post, rail, charges } = setup(() => new Response(null, { status: 202 }));

    const response = await post(toolCall('generate_image', { 'tollstile/test-payment': 'test' }));

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: 'mcp_response_unreadable' } });
    expect(rail.effects.settlements).toBe(0);
    expect(charges()).toEqual(['released/failed']);
  });

  it('declines the standalone stream, where a priced answer could bypass the gate', async () => {
    const { proxy, bodies } = setup();

    const response = await proxy(new Request('https://api.example.com/mcp', { method: 'GET', headers: { accept: 'text/event-stream' } }));

    expect(response.status).toBe(405);
    expect(bodies).toHaveLength(0);
  });

  it('reads and rewrites a streamed (SSE) tool response', async () => {
    const { post } = setup((body) => {
      const { id } = JSON.parse(body) as { id: number };
      const progress = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })}`;
      const result = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'streamed' }] } })}`;
      return new Response(`${progress}\n\n${result}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    });
    const text = await (await post(toolCall('generate_image', { 'tollstile/test-payment': 'test' }))).text();

    expect(text).toContain('notifications/progress');
    const data = text.split('\n').filter((line) => line.startsWith('data:') && line.includes('streamed'))[0]?.slice(5) ?? '{}';
    expect((JSON.parse(data) as RpcResult).result._meta).toHaveProperty('tollstile/test-receipt');
  });

  it('releases the charge when the tool reports an error', async () => {
    const { post, charges } = setup((body) => {
      const { id } = JSON.parse(body) as { id: number };
      return Response.json({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: 'failed' }] } });
    });
    await post(toolCall('generate_image', { 'tollstile/test-payment': 'test' }));

    expect(charges()).toEqual(['released/failed']);
  });

  it('forwards unpriced tools and other MCP messages for free', async () => {
    const { post, bodies } = setup();
    await post(toolCall('list_styles'));
    await post(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));

    expect(bodies).toHaveLength(2);
  });

  it('refuses priced tools inside a batch and oversized bodies, so pricing cannot be bypassed', async () => {
    const { post, bodies } = setup();
    const batch = await post(`[${toolCall('generate_image')},${toolCall('list_styles', {}, 2)}]`);
    expect(batch.status).toBe(400);

    const padded = await post(`${toolCall('generate_image')}${' '.repeat(5000)}`);
    expect(padded.status).toBe(413);
    expect(bodies).toHaveLength(0);
  });

  it('prices tool calls sent to aliases of the MCP endpoint', async () => {
    const { proxy, bodies } = setup();
    for (const alias of ['/mcp/', '/%6Dcp', '//mcp']) {
      const response = await proxy(new Request(`https://api.example.com${alias}`, { method: 'POST', body: toolCall('generate_image') }));
      expect(((await response.json()) as RpcResult).result.isError, alias).toBe(true);
    }
    expect(bodies).toHaveLength(0);
  });

  it('refuses tool routes without an MCP endpoint', () => {
    const toll = createTollstile({ rails: [testRail()], ledger: memoryLedger() });
    expect(() => createProxy({ toll, upstream: 'http://127.0.0.1:8000', routes: [{ tool: 'x', price: '$0.01' }] })).toThrow(/mcp: \{ path \}/);
  });
});
