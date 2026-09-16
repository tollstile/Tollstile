import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CursorSchema, ElicitRequestSchema, McpError, type CallToolResult, type ClientCapabilities } from '@modelcontextprotocol/sdk/types.js';
import {
  createTollstile,
  credits,
  memoryBalance,
  memoryLedger,
  payPerCall,
  testRail,
  type AccessPolicy,
  type Context,
  type JsonObject,
  type Rail,
  type RailChallenge,
} from 'tollstile';
import { fakeClock } from 'tollstile/testing';
import { describe, expect, it } from 'vitest';
import { paidTool, type Approval, type CheckoutResolver, type PaidToolOptions } from '../src/index';

const MPP_CHALLENGE = {
  id: 'ch_abc123',
  realm: 'tools.example.com',
  method: 'tempo',
  intent: 'charge',
  request: { amount: '10000', currency: '0x20c0000000000000000000000000000000000000', recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00' },
  expires: '2026-01-01T00:05:00Z',
} as const satisfies JsonObject;

type FakeX402 = Rail<'x402'> & { settlements: number };

/**
 * An x402-shaped rail with a fake provider: it carries the quote in `accepts[].extra.quote` and reads
 * `_meta["x402/payment"] = { accepted: { extra: { quote } }, payload: { id, from } }`.
 */
function fakeX402(): FakeX402 {
  const rail: FakeX402 = {
    name: 'x402',
    livemode: false,
    settlements: 0,
    capabilities: { flows: ['authorization'], authorization: 'single', variableAmount: false, quotes: true, refund: false, partialRefund: false, lookup: true },
    offer: ({ price }) =>
      Promise.resolve({ rail: 'x402', asset: { code: 'USDC', network: 'eip155:84532', scale: 6 }, amount: price.micros.toString(), basis: 'par', details: {} }),
    challenge: (_quote, token, offer) =>
      Promise.resolve({
        headers: [],
        accepts: {},
        mcp: {
          style: 'x402',
          paymentRequired: {
            x402Version: 2,
            resource: { url: 'mcp://tool/forecast' },
            accepts: [{ scheme: 'exact', network: 'eip155:84532', amount: offer.amount, payTo: '0xmerchant', extra: { quote: token } }],
          },
        },
      }),
    async verify(context, terms) {
      const proof = context.mcp?.meta['x402/payment'];
      if (proof === undefined) return { status: 'absent' };
      const { quote: token, id, from } = readProof(proof);
      if (token === undefined || id === undefined || from === undefined) return { status: 'invalid', reason: 'malformed_payload' };
      const quote = await terms.openQuote(token);
      if (quote === undefined) return { status: 'invalid', reason: 'quote_invalid' };
      return { status: 'valid', proofId: id, payer: from, quote, limit: quote.price, expiresAt: null, data: { id } };
    },
    settle(_authorization, charge) {
      rail.settlements += 1;
      return Promise.resolve({ status: 'settled', reference: `0xtx_${charge.id}`, details: {} });
    },
    refund: () => Promise.resolve({ status: 'rejected', reason: 'unsupported' }),
    release: () => Promise.resolve(),
    lookup: () => Promise.resolve({ status: 'none' }),
    receipt: (_authorization, charge) => ({
      headers: [],
      meta: { 'x402/payment-response': { success: true, transaction: charge.settlement?.reference ?? null, network: 'eip155:84532' } },
    }),
  };
  return rail;
}

function readProof(proof: unknown): { quote: string | undefined; id: string | undefined; from: string | undefined } {
  const value = proof as { accepted?: { extra?: { quote?: unknown } }; payload?: { id?: unknown; from?: unknown } };
  const text = (item: unknown) => (typeof item === 'string' ? item : undefined);
  return { quote: text(value.accepted?.extra?.quote), id: text(value.payload?.id), from: text(value.payload?.from) };
}

/** A rail that never finds a proof and only contributes a challenge in the given MCP style. */
function challengeOnly(name: string, mcp: RailChallenge['mcp']): Rail {
  const nothing = () => Promise.resolve({ status: 'none' } as const);
  return {
    name,
    livemode: false,
    capabilities: { flows: ['authorization'], authorization: 'single', variableAmount: false, quotes: true, refund: false, partialRefund: false, lookup: true },
    offer: ({ price }) => Promise.resolve({ rail: name, asset: { code: 'USD', network: null, scale: 6 }, amount: price.micros.toString(), basis: 'par', details: {} }),
    challenge: () => Promise.resolve({ headers: [], accepts: {}, mcp }),
    verify: () => Promise.resolve({ status: 'absent' }),
    settle: () => Promise.resolve({ status: 'rejected', reason: 'unused' }),
    refund: () => Promise.resolve({ status: 'rejected', reason: 'unused' }),
    release: () => Promise.resolve(),
    lookup: nothing,
    receipt: () => ({ headers: [], meta: {} }),
  };
}

const mppRail = () => challengeOnly('mpp', { style: 'mpp', challenge: MPP_CHALLENGE });
const PAYS_WITH_MPP: ClientCapabilities = { experimental: { payment: { methods: { tempo: { intents: ['charge'] } } } } };

function setup(options: { readonly rails?: readonly Rail[]; readonly capabilities?: ClientCapabilities } = {}) {
  const test = testRail();
  const clock = fakeClock();
  const ledger = memoryLedger({ clock });
  const toll = createTollstile({ rails: [test, ...(options.rails ?? [])], ledger, clock, secret: 's'.repeat(32) });
  const server = new McpServer({ name: 'weather', version: '1.0.0' });
  const client = new Client({ name: 'agent', version: '1.0.0' }, { capabilities: options.capabilities ?? {} });
  const contexts: Context[] = [];
  let runs = 0;

  /** Records the Context core saw, and pays. */
  const observe: AccessPolicy = {
    name: 'observe',
    evaluate(context) {
      contexts.push(context);
      return Promise.resolve({ kind: 'pay' });
    },
  };

  paidTool(server, 'forecast', { description: 'Tomorrow in one word' }, toll.price('$0.01', { access: [observe] }), (_args, { payment }) => {
    runs += 1;
    return { content: [{ type: 'text', text: `clear, paid via ${payment.via}` }], _meta: { 'weather/source': 'model' } };
  });
  paidTool(server, 'broken', {}, toll.price('$0.01'), () => {
    runs += 1;
    throw new Error('upstream weather service failed');
  });
  paidTool(server, 'unknown_city', {}, toll.price('$0.01'), () => {
    runs += 1;
    return { isError: true, content: [{ type: 'text', text: 'no forecast for that city' }] };
  });

  const connect = async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  };
  const callTool = async (name: string, meta?: Record<string, unknown>) =>
    (await client.callTool({ name, ...(meta === undefined ? {} : { _meta: meta }) })) as CallToolResult;
  const charges = () => ledger.charges().map((charge) => `${charge.payment}/${charge.fulfillment}`);

  return { test, ledger, toll, server, client, connect, callTool, charges, contexts, runs: () => runs };
}

const textOf = (result: CallToolResult) => {
  const [first] = result.content;
  return first?.type === 'text' ? first.text : undefined;
};

const denialOf = (result: CallToolResult) => result._meta?.['tollstile/payment-required'] as Record<string, unknown> | undefined;

describe('@tollstile/mcp with the test rail', () => {
  it('asks for payment without running the tool, then runs it on the quote it offered and returns a receipt', async () => {
    const { connect, callTool, runs, test, ledger, charges } = setup();
    await connect();

    const unpaid = await callTool('forecast');
    expect(unpaid.isError).toBe(true);
    expect(runs()).toBe(0);
    const body = denialOf(unpaid);
    expect(body).toMatchObject({ error: { code: 'payment_required' }, resource: 'tool:forecast', price: '$0.01', accepts: [{ rail: 'test' }] });
    expect(JSON.parse(textOf(unpaid) ?? '')).toEqual(body);
    expect(unpaid.structuredContent).toBeUndefined();

    const paid = await callTool('forecast', { 'tollstile/test-payment': `test quote=${String(body?.quote)}` });
    expect(paid.isError).toBeUndefined();
    expect(textOf(paid)).toBe('clear, paid via rail');
    expect(paid._meta).toEqual({ 'weather/source': 'model', 'tollstile/test-receipt': expect.stringMatching(/^test_settlement_chg_/) as unknown });
    expect(runs()).toBe(1);
    expect(test.effects.settlements).toBe(1);
    expect(charges()).toEqual(['settled/completed']);
    expect(ledger.authorizations()[0]?.quoteId).not.toBeNull();
  });

  it('refuses a tampered quote', async () => {
    const { connect, callTool, runs } = setup();
    await connect();

    const quote = String(denialOf(await callTool('forecast'))?.quote);
    const tampered = await callTool('forecast', { 'tollstile/test-payment': `test quote=${quote.slice(0, -2)}xx` });

    expect(denialOf(tampered)).toMatchObject({ error: { code: 'quote_invalid' } });
    expect(runs()).toBe(0);
  });

  it('builds the Context from the tool call', async () => {
    const { connect, client, contexts } = setup({ capabilities: PAYS_WITH_MPP });
    await connect();

    await client.callTool({ name: 'forecast', _meta: { 'tollstile/test-payment': 'test', trace: { id: 7 } } });

    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({
      transport: 'mcp',
      request: null,
      mcp: { tool: 'forecast', arguments: null, meta: { 'tollstile/test-payment': 'test', trace: { id: 7 } }, clientCapabilities: PAYS_WITH_MPP },
      principal: null,
      resource: 'tool:forecast',
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
    });
  });

  it('rejects a replayed proof', async () => {
    const { connect, callTool, runs, test } = setup();
    await connect();

    await callTool('forecast', { 'tollstile/test-payment': 'test proof=p1' });
    const replay = await callTool('forecast', { 'tollstile/test-payment': 'test proof=p1' });

    expect(replay.isError).toBe(true);
    expect(denialOf(replay)).toMatchObject({ error: { code: 'proof_already_used' } });
    expect(runs()).toBe(1);
    expect(test.effects.settlements).toBe(1);
  });

  it('releases the reservation when the tool throws, and accepts the same proof on retry', async () => {
    const { toll, server, connect, callTool, runs, test, charges } = setup();
    let fail = true;
    paidTool(server, 'flaky', {}, toll.price('$0.01'), () => {
      if (fail) throw new Error('upstream weather service failed');
      return { content: [{ type: 'text', text: 'clear' }] };
    });
    await connect();

    const failed = await callTool('broken', { 'tollstile/test-payment': 'test proof=p1' });
    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toBe('upstream weather service failed');
    expect(runs()).toBe(1);
    expect(test.effects).toMatchObject({ settlements: 0, releases: 1 });
    expect(charges()).toEqual(['released/failed']);

    expect((await callTool('flaky', { 'tollstile/test-payment': 'test proof=p2' })).isError).toBe(true);
    fail = false;
    const retry = await callTool('flaky', { 'tollstile/test-payment': 'test proof=p2' });
    expect(textOf(retry)).toBe('clear');
    expect(test.effects.settlements).toBe(1);
  });

  it('releases the reservation when the tool returns isError', async () => {
    const { connect, callTool, test, charges } = setup();
    await connect();

    const result = await callTool('unknown_city', { 'tollstile/test-payment': 'test proof=p1' });

    expect(result).toEqual({ isError: true, content: [{ type: 'text', text: 'no forecast for that city' }] });
    expect(test.effects.settlements).toBe(0);
    expect(charges()).toEqual(['released/failed']);
  });

  it('releases the reservation when the output does not match the outputSchema, and settles when it does', async () => {
    const { toll, server, connect, callTool, test, charges } = setup();
    let summary: unknown = 42;
    paidTool(server, 'summary', { outputSchema: { summary: CursorSchema } }, toll.price('$0.01'), () => ({
      content: [],
      structuredContent: { summary },
    }));
    await connect();

    const invalid = await callTool('summary', { 'tollstile/test-payment': 'test proof=s1' });
    expect(invalid.isError).toBe(true);
    expect(textOf(invalid)).toContain('Output validation error');
    expect(charges()).toEqual(['released/failed']);

    summary = 'clear';
    const valid = await callTool('summary', { 'tollstile/test-payment': 'test proof=s2' });
    expect(valid.structuredContent).toEqual({ summary: 'clear' });
    expect(test.effects.settlements).toBe(1);
  });

  it('denies with 503 and does not run the tool when the provider is down during verification', async () => {
    const { connect, callTool, runs, test } = setup();
    await connect();
    test.simulate({ verify: 'unavailable' });

    const result = await callTool('forecast', { 'tollstile/test-payment': 'test' });

    expect(result.isError).toBe(true);
    expect(denialOf(result)).toMatchObject({ error: { code: 'payment_unavailable', action: 'retry_later' }, rail: 'test' });
    expect(runs()).toBe(0);
  });

  it('renders a 403 as a tool error with the denial body', async () => {
    const { toll, server, connect, callTool } = setup();
    paidTool(server, 'members_only', {}, toll.price('$0.01', { access: [] }), () => ({ content: [] }));
    await connect();

    const result = await callTool('members_only');

    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result) ?? '')).toMatchObject({ error: { code: 'access_denied' }, resource: 'tool:members_only' });
    expect(denialOf(result)).toMatchObject({ error: { code: 'access_denied', action: 'stop' }, resource: 'tool:members_only' });
  });

  it('uses gate.resource instead of the tool name', async () => {
    const { toll, server, connect, callTool, ledger } = setup();
    paidTool(server, 'radar', {}, toll.price('$0.01', { resource: 'weather:radar' }), () => ({ content: [] }));
    await connect();

    await callTool('radar', { 'tollstile/test-payment': 'test proof=r1' });

    expect(ledger.charges()[0]?.resource).toBe('weather:radar');
  });

  it('passes validated arguments and the payment to the handler', async () => {
    const { toll, server, connect, client } = setup();
    // zod is not a dependency of this package; CursorSchema is the SDK's own z.string().
    paidTool(server, 'city_forecast', { inputSchema: { city: CursorSchema } }, toll.price('$0.01'), (args, { payment, signal }) => ({
      content: [{ type: 'text', text: `${args.city}: clear (${payment.via === 'rail' ? payment.payer : payment.account}, ${String(signal.aborted)})` }],
    }));
    await connect();

    const result = (await client.callTool({
      name: 'city_forecast',
      arguments: { city: 'Tokyo' },
      _meta: { 'tollstile/test-payment': 'test payer=agent-7' },
    })) as CallToolResult;

    expect(textOf(result)).toBe('Tokyo: clear (agent-7, false)');
  });

  it('binds a dynamic quote to the tool arguments it priced', async () => {
    const { toll, server, connect, client, runs } = setup();
    let served = 0;
    paidTool(
      server,
      'translate',
      { inputSchema: { text: CursorSchema } },
      toll.price((context) => `$${String((context.mcp?.arguments as { text: string }).text.length / 1000)}`),
      (args) => {
        served += 1;
        return { content: [{ type: 'text', text: args.text }] };
      },
    );
    await connect();
    const translate = async (text: string, meta?: Record<string, unknown>) =>
      (await client.callTool({ name: 'translate', arguments: { text }, ...(meta === undefined ? {} : { _meta: meta }) })) as CallToolResult;

    const quoted = denialOf(await translate('hello'));
    expect(quoted?.price).toBe('$0.005');
    const payment = { 'tollstile/test-payment': `test quote=${String(quoted?.quote)}` };

    expect(denialOf(await translate('x'.repeat(100_000), payment))).toMatchObject({ error: { code: 'quote_mismatch' }, price: '$100.00' });
    expect(served).toBe(0);
    expect(textOf(await translate('hello', payment))).toBe('hello');
    expect(served + runs()).toBe(1);
  });

  it('reads the idempotency key from _meta, so a retried tool call is not paid or run twice', async () => {
    const { connect, callTool, runs, test } = setup();
    await connect();
    const meta = { 'tollstile/test-payment': 'test proof=once', 'tollstile/idempotency-key': 'call-7' };
    expect((await callTool('forecast', meta)).isError).toBeUndefined();

    const retry = await callTool('forecast', meta);
    expect(retry.isError).toBe(true);
    expect(denialOf(retry)).toMatchObject({ error: { code: 'already_paid', action: 'stop' } });
    expect(test.effects.settlements).toBe(1);
    expect(runs()).toBe(1);
  });

  it('passes the resolved principal to credits()', async () => {
    const { toll, server, connect, callTool } = setup();
    const balance = memoryBalance({ acct_1: '$1' });
    const principal: PaidToolOptions['principal'] = (extra) => {
      const account = extra._meta?.['example/account'];
      return typeof account === 'string' ? { id: account } : null;
    };
    paidTool(
      server,
      'credit_forecast',
      {},
      toll.price('$0.25', { access: [credits({ balance }), payPerCall()] }),
      (_args, { payment }) => ({ content: [{ type: 'text', text: payment.via === 'policy' ? payment.account : payment.payer }] }),
      { principal },
    );
    await connect();

    const result = await callTool('credit_forecast', { 'example/account': 'acct_1' });
    expect(textOf(result)).toBe('acct_1');
    expect(balance.available('acct_1')?.micros).toBe(750_000n);

    const anonymous = await callTool('credit_forecast');
    expect(denialOf(anonymous)).toMatchObject({ error: { code: 'payment_required' } });
  });

  it('refuses _meta that is not JSON without consulting the gate', async () => {
    const { connect, callTool, runs, contexts, ledger } = setup();
    await connect();

    const result = await callTool('forecast', { 'tollstile/test-payment': 'test', amount: 10n });

    expect(result.isError).toBe(true);
    expect(denialOf(result)).toMatchObject({ error: { code: 'invalid_request', action: 'fix_request', detail: 'meta_not_json' } });
    expect(runs()).toBe(0);
    expect(contexts).toHaveLength(0);
    expect(ledger.charges()).toHaveLength(0);
  });

  it('withholds the tool output and asks for payment again when settlement after the tool is rejected', async () => {
    const { connect, callTool, test, charges } = setup();
    await connect();
    test.simulate({ settle: 'reject' });

    const result = await callTool('forecast', { 'tollstile/test-payment': 'test proof=p1' });

    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain('clear');
    expect(denialOf(result)).toMatchObject({ error: { code: 'settlement_rejected' }, price: '$0.01' });
    expect(charges()).toEqual(['failed/completed']);
  });
});

describe('x402 style', () => {
  it('renders the challenge as a payment-required tool result, and pays with the quote it carries', async () => {
    const x402 = fakeX402();
    const { connect, callTool, runs, charges } = setup({ rails: [x402] });
    await connect();

    const unpaid = await callTool('forecast');
    expect(unpaid.isError).toBe(true);
    const paymentRequired = unpaid.structuredContent as { accepts: [{ extra: { quote: string } }] };
    expect(paymentRequired).toMatchObject({ x402Version: 2, accepts: [{ scheme: 'exact', amount: '10000' }] });
    expect(unpaid.content).toEqual([{ type: 'text', text: JSON.stringify(paymentRequired) }]);
    expect(denialOf(unpaid)).toMatchObject({ error: { code: 'payment_required' }, accepts: [{ rail: 'test' }, { rail: 'x402' }] });
    expect(runs()).toBe(0);

    const [accepted] = paymentRequired.accepts;
    const paid = await callTool('forecast', { 'x402/payment': { x402Version: 2, accepted, payload: { id: 'n1', from: '0xpayer' } } });
    expect(textOf(paid)).toBe('clear, paid via rail');
    expect(paid._meta?.['x402/payment-response']).toMatchObject({ success: true, transaction: expect.stringMatching(/^0xtx_chg_/) as unknown });
    expect(x402.settlements).toBe(1);
    expect(charges()).toEqual(['settled/completed']);
  });

  it('puts the verification failure reason in the x402 error field', async () => {
    const { connect, callTool } = setup({ rails: [fakeX402()] });
    await connect();

    const result = await callTool('forecast', { 'x402/payment': { accepted: { extra: { quote: 'forged' } }, payload: { id: 'n1', from: '0xpayer' } } });

    expect(result.structuredContent).toMatchObject({ x402Version: 2, error: 'quote_invalid' });
    expect(denialOf(result)).toMatchObject({ error: { code: 'quote_invalid' } });
  });
});

describe('mpp style', () => {
  it('renders MPP offers as JSON-RPC error -32042 when the client declared experimental.payment', async () => {
    const { connect, client, runs } = setup({ rails: [fakeX402(), mppRail()], capabilities: PAYS_WITH_MPP });
    await connect();

    const error: unknown = await client.callTool({ name: 'forecast' }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({ code: -32042, data: { httpStatus: 402, challenges: [MPP_CHALLENGE] } });
    expect(runs()).toBe(0);
  });

  it('includes the verification failure reason in the error data', async () => {
    const { connect, client } = setup({ rails: [mppRail()], capabilities: { experimental: { payment: {} } } });
    await connect();

    const error: unknown = await client
      .callTool({ name: 'forecast', _meta: { 'tollstile/test-payment': 'test amount=$5' } })
      .catch((reason: unknown) => reason);

    expect(error).toMatchObject({ code: -32042, data: { httpStatus: 402, challenges: [MPP_CHALLENGE], failure: { reason: 'amount_mismatch' } } });
  });

  it('is not used for a client without experimental.payment', async () => {
    const withX402 = setup({ rails: [fakeX402(), mppRail()], capabilities: { experimental: { other: {} } } });
    await withX402.connect();
    expect((await withX402.callTool('forecast')).structuredContent).toMatchObject({ x402Version: 2 });

    const mppOnly = setup({ rails: [mppRail()] });
    await mppOnly.connect();
    const generic = await mppOnly.callTool('forecast');
    expect(generic.isError).toBe(true);
    expect(generic.structuredContent).toBeUndefined();
    expect(denialOf(generic)).toMatchObject({ error: { code: 'payment_required' }, accepts: [{ rail: 'test' }, { rail: 'mpp' }] });
  });
});

describe('rail contract', () => {
  it('fails closed when a rail breaks the MCP challenge convention', async () => {
    const { connect, callTool, runs } = setup({ rails: [challengeOnly('broken', { style: 'x402' })] });
    await connect();

    const result = await callTool('forecast');

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Rail "broken" returned an MCP challenge');
    expect(runs()).toBe(0);
  });
});

describe('Streamable HTTP', () => {
  it('exposes the HTTP request to access policies and the principal resolver', async () => {
    const ledger = memoryLedger();
    const toll = createTollstile({ rails: [testRail()], ledger });
    const seen: (Request | null)[] = [];
    const apiKeys: AccessPolicy = {
      name: 'api-key',
      evaluate(context) {
        seen.push(context.request);
        return Promise.resolve(context.principal === null ? { kind: 'skip' } : { kind: 'grant', account: context.principal.id });
      },
    };
    const server = new McpServer({ name: 'weather', version: '1.0.0' });
    paidTool(
      server,
      'forecast',
      {},
      toll.price('$0.01', { access: [apiKeys, payPerCall()] }),
      (_args, { payment }) => ({ content: [{ type: 'text', text: payment.via === 'policy' ? payment.account : payment.payer }] }),
      { principal: (extra) => (extra.requestInfo?.headers['x-api-key'] === 'key_1' ? { id: 'acct_1' } : null) },
    );

    const post = async (headers: Record<string, string>) => {
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      await server.connect(transport);
      const response = await transport.handleRequest(
        new Request('https://tools.example.com/mcp', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'forecast' } }),
        }),
      );
      await server.close();
      return ((await response.json()) as { result: CallToolResult }).result;
    };

    const granted = await post({ 'x-api-key': 'key_1' });
    expect(granted.content).toEqual([{ type: 'text', text: 'acct_1' }]);
    expect(seen[0]?.url).toBe('https://tools.example.com/mcp');
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.headers.get('x-api-key')).toBe('key_1');

    const unpaid = await post({});
    expect(unpaid.isError).toBe(true);
    expect(ledger.charges()).toHaveLength(0);
  });
});

describe('approval by the person at the client', () => {
  type Answer = 'accept' | 'decline' | 'cancel';

  function withApproval(options: { readonly approval: Approval; readonly answer?: Answer; readonly canAsk?: boolean }) {
    const test = testRail();
    const clock = fakeClock();
    const ledger = memoryLedger({ clock });
    const toll = createTollstile({ rails: [test], ledger, clock, secret: 's'.repeat(32) });
    const server = new McpServer({ name: 'documents', version: '1.0.0' });
    const canAsk = options.canAsk ?? true;
    const client = new Client({ name: 'agent', version: '1.0.0' }, { capabilities: canAsk ? { elicitation: {} } : {} });
    const asked: string[] = [];
    if (canAsk) {
      client.setRequestHandler(ElicitRequestSchema, (request) => {
        asked.push(request.params.message);
        return { action: options.answer ?? 'accept' };
      });
    }

    let runs = 0;
    paidTool(
      server,
      'summarize',
      {},
      toll.price('$0.05'),
      () => {
        runs += 1;
        return { content: [{ type: 'text', text: 'two sentences' }] };
      },
      { approval: options.approval },
    );

    const call = async () => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      return (await client.callTool({ name: 'summarize', _meta: { 'tollstile/test-payment': 'test proof=p1' } })) as CallToolResult;
    };

    return { call, asked, test, runs: () => runs, charges: () => ledger.charges().map((charge) => `${charge.payment}/${charge.fulfillment}`) };
  }

  it('asks before charging and settles when the person accepts', async () => {
    const { call, asked, test, runs, charges } = withApproval({ approval: {} });

    const result = await call();

    expect(asked).toEqual(['Approve $0.05 for "summarize"?']);
    expect(textOf(result)).toBe('two sentences');
    expect(runs()).toBe(1);
    expect(test.effects.settlements).toBe(1);
    expect(charges()).toEqual(['settled/completed']);
  });

  it('releases the reservation and never runs the tool when the person declines', async () => {
    const { call, test, runs, charges } = withApproval({ approval: {}, answer: 'decline' });

    const result = await call();

    expect(result.isError).toBe(true);
    expect(denialOf(result)).toEqual({
      error: { code: 'access_denied', retryable: false, action: 'stop', message: expect.any(String) as unknown, detail: 'approval_declined' },
    });
    expect(runs()).toBe(0);
    expect(test.effects).toMatchObject({ settlements: 0, releases: 1 });
    expect(charges()).toEqual(['released/failed']);
  });

  it('reports a dismissed request as cancelled', async () => {
    const { call, charges } = withApproval({ approval: {}, answer: 'cancel' });

    expect(denialOf(await call())).toMatchObject({ error: { detail: 'approval_cancelled' } });
    expect(charges()).toEqual(['released/failed']);
  });

  it('charges without asking at or below `above`', async () => {
    const { call, asked, test } = withApproval({ approval: { above: '$0.05' } });

    expect(textOf(await call())).toBe('two sentences');
    expect(asked).toEqual([]);
    expect(test.effects.settlements).toBe(1);
  });

  it('asks above `above`', async () => {
    const { call, asked } = withApproval({ approval: { above: '$0.04' } });

    await call();

    expect(asked).toEqual(['Approve $0.05 for "summarize"?']);
  });

  it('asks the merchant\'s own question', async () => {
    const { call, asked } = withApproval({ approval: { message: (payment) => `Summarize this document for ${payment.via}?` } });

    await call();

    expect(asked).toEqual(['Summarize this document for rail?']);
  });

  it('refuses the charge when the client cannot ask anyone', async () => {
    const { call, test, runs, charges } = withApproval({ approval: {}, canAsk: false });

    const result = await call();

    expect(denialOf(result)).toMatchObject({ error: { code: 'access_denied', detail: 'approval_unavailable' } });
    expect(runs()).toBe(0);
    expect(test.effects).toMatchObject({ settlements: 0, releases: 1 });
    expect(charges()).toEqual(['released/failed']);
  });

  it('charges a client that cannot ask when the merchant allows it', async () => {
    const { call, asked, test } = withApproval({ approval: { unsupported: 'charge' }, canAsk: false });

    expect(textOf(await call())).toBe('two sentences');
    expect(asked).toEqual([]);
    expect(test.effects.settlements).toBe(1);
  });

  it('releases the reservation when the client fails to answer', async () => {
    const test = testRail();
    const clock = fakeClock();
    const ledger = memoryLedger({ clock });
    const toll = createTollstile({ rails: [test], ledger, clock, secret: 's'.repeat(32) });
    const server = new McpServer({ name: 'documents', version: '1.0.0' });
    const client = new Client({ name: 'agent', version: '1.0.0' }, { capabilities: { elicitation: {} } });
    client.setRequestHandler(ElicitRequestSchema, () => {
      throw new Error('no one is at the keyboard');
    });
    paidTool(server, 'summarize', {}, toll.price('$0.05'), () => ({ content: [{ type: 'text', text: 'two sentences' }] }), { approval: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = (await client.callTool({ name: 'summarize', _meta: { 'tollstile/test-payment': 'test proof=p1' } })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(test.effects).toMatchObject({ settlements: 0, releases: 1 });
    expect(ledger.charges().map((charge) => `${charge.payment}/${charge.fulfillment}`)).toEqual(['released/failed']);
  });
});

describe('sending a person to a page where they can pay', () => {
  const CREDITS = 'https://weather.example/credits';

  function withCheckout(options: { readonly checkout: CheckoutResolver; readonly capabilities?: ClientCapabilities }) {
    const test = testRail();
    const clock = fakeClock();
    const ledger = memoryLedger({ clock });
    const toll = createTollstile({ rails: [test], ledger, clock, secret: 's'.repeat(32) });
    const server = new McpServer({ name: 'weather', version: '1.0.0' });
    const client = new Client({ name: 'agent', version: '1.0.0' }, { capabilities: options.capabilities ?? { elicitation: { url: {} } } });

    let runs = 0;
    paidTool(
      server,
      'forecast',
      {},
      toll.price('$0.01'),
      () => {
        runs += 1;
        return { content: [{ type: 'text', text: 'clear' }] };
      },
      { checkout: options.checkout },
    );

    const call = async () => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      return (await client.callTool({ name: 'forecast' })) as CallToolResult;
    };

    return { call, ledger, runs: () => runs };
  }

  it('answers a client that can open a page with the page, and charges nothing', async () => {
    const { call, ledger, runs } = withCheckout({ checkout: () => ({ url: CREDITS, message: 'Add credit to keep calling.' }) });

    await expect(call()).rejects.toMatchObject({
      code: -32042,
      data: { elicitations: [{ mode: 'url', url: CREDITS, message: 'Add credit to keep calling.', elicitationId: expect.any(String) as unknown }] },
    });
    expect(runs()).toBe(0);
    expect(ledger.charges()).toHaveLength(0);
  });

  it('tells a client that cannot open a page where to go, in words its model will read', async () => {
    const { call } = withCheckout({ checkout: () => ({ url: CREDITS, message: 'Add credit to keep calling.' }), capabilities: {} });

    const result = await call();

    expect(result.isError).toBe(true);
    // First, for the person: a client that renders no `_meta` would otherwise show them nothing.
    expect(textOf(result)).toBe(`Add credit to keep calling.\n${CREDITS}`);
    // The denial body is still there, whole, in its own block and in `_meta`.
    const [, body] = result.content;
    expect(JSON.parse(body?.type === 'text' ? body.text : '')).toEqual(denialOf(result));
    expect(denialOf(result)).toMatchObject({ error: { code: 'payment_required' } });
    expect(result._meta?.['tollstile/checkout']).toEqual({ url: CREDITS, message: 'Add credit to keep calling.' });
  });

  it('puts the page on screen through form mode when the client cannot open one', async () => {
    const test = testRail();
    const ledger = memoryLedger();
    const toll = createTollstile({ rails: [test], ledger, secret: 's'.repeat(32) });
    const server = new McpServer({ name: 'weather', version: '1.0.0' });
    // What Claude Code declares: it can ask a question, but cannot be sent to a page.
    const client = new Client({ name: 'agent', version: '1.0.0' }, { capabilities: { elicitation: { form: {} } } });
    const asked: string[] = [];
    client.setRequestHandler(ElicitRequestSchema, (request) => {
      asked.push(request.params.message);
      return { action: 'decline' };
    });
    paidTool(server, 'forecast', {}, toll.price('$0.01'), () => ({ content: [{ type: 'text', text: 'clear' }] }), {
      checkout: () => ({ url: CREDITS, message: 'Add credit to keep calling.' }),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = (await client.callTool({ name: 'forecast' })) as CallToolResult;

    expect(asked).toEqual([`Add credit to keep calling.\n\n${CREDITS}`]);
    // Whatever they pressed, the call was not paid for: the denial stands and nothing is charged.
    expect(denialOf(result)).toMatchObject({ error: { code: 'payment_required' } });
    expect(ledger.charges()).toHaveLength(0);
  });

  it('still answers when the client fails to show the page', async () => {
    const toll = createTollstile({ rails: [testRail()], ledger: memoryLedger(), secret: 's'.repeat(32) });
    const server = new McpServer({ name: 'weather', version: '1.0.0' });
    const client = new Client({ name: 'agent', version: '1.0.0' }, { capabilities: { elicitation: { form: {} } } });
    client.setRequestHandler(ElicitRequestSchema, () => {
      throw new Error('no dialog here');
    });
    paidTool(server, 'forecast', {}, toll.price('$0.01'), () => ({ content: [{ type: 'text', text: 'clear' }] }), {
      checkout: () => ({ url: CREDITS }),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = (await client.callTool({ name: 'forecast' })) as CallToolResult;

    expect(textOf(result)).toBe(`Payment is required to continue.\n${CREDITS}`);
    expect(denialOf(result)).toMatchObject({ error: { code: 'payment_required' } });
  });

  it('says something sensible when the merchant supplied no message', async () => {
    const { call } = withCheckout({ checkout: () => ({ url: CREDITS }), capabilities: {} });

    expect(textOf(await call())).toBe(`Payment is required to continue.\n${CREDITS}`);
  });

  it('leaves the denial alone when there is nowhere to send anyone', async () => {
    const { call } = withCheckout({ checkout: () => null });

    const result = await call();

    expect(result._meta?.['tollstile/checkout']).toBeUndefined();
    expect(denialOf(result)).toMatchObject({ error: { code: 'payment_required' } });
  });

  it('refuses a page a browser cannot open, and charges nothing', async () => {
    const { call, ledger, runs } = withCheckout({ checkout: () => ({ url: 'javascript:alert(1)' }) });

    const result = await call();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/use an http or https URL/);
    expect(runs()).toBe(0);
    expect(ledger.charges()).toHaveLength(0);
  });

  it('lets a client that pays for itself pay, instead of sending its owner to a page', async () => {
    const test = testRail();
    const ledger = memoryLedger();
    const toll = createTollstile({ rails: [test, mppRail()], ledger, secret: 's'.repeat(32) });
    const server = new McpServer({ name: 'weather', version: '1.0.0' });
    const client = new Client({ name: 'agent', version: '1.0.0' }, { capabilities: { ...PAYS_WITH_MPP, elicitation: { url: {} } } });
    paidTool(server, 'forecast', {}, toll.price('$0.01'), () => ({ content: [{ type: 'text', text: 'clear' }] }), {
      checkout: () => ({ url: CREDITS }),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    await expect(client.callTool({ name: 'forecast' })).rejects.toMatchObject({
      code: -32042,
      data: { httpStatus: 402, challenges: [MPP_CHALLENGE] },
    });
  });
});
