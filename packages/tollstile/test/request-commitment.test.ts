import { describe, expect, it } from 'vitest';
import { memoryLedger, testRail, createTollstile, type Context } from '../src/index';
import { fakeClock, mcpContext } from '../src/testing/index';
import { call, setup } from './helpers';

/** Prices a translation by its word count, like the dynamic pricing guide. */
async function perWord(context: Context): Promise<string> {
  const { text } = (await context.request?.json()) as { text: string };
  return `$${(text.split(/\s+/).length * 0.001).toFixed(3)}`;
}

const small = JSON.stringify({ text: 'hello' });
const huge = JSON.stringify({ text: 'word '.repeat(1_000_000).trim() });

describe('request commitment', () => {
  it('rejects a cheap quote replayed with a larger body, before any charge', async () => {
    const { toll, events, rail } = setup();
    const gate = toll.price(perWord, { resource: 'translate' });
    const challenge = await call(gate, { path: '/translate', body: small });
    expect(challenge.body.price).toBe('$0.001');

    const swapped = await call(gate, { path: '/translate', body: huge, payment: `test quote=${String(challenge.body.quote)}` });
    expect(swapped).toMatchObject({ status: 402, handlerRuns: 0, body: { error: { code: 'quote_mismatch' }, price: '$1000.00' } });
    expect(events.filter((event) => event.type === 'authorization.opened' || event.type === 'charge.moved')).toEqual([]);
    expect(rail.effects.settled).toEqual([]);
  });

  it('accepts the quote when the same body is sent again, and the handler can still read it', async () => {
    const { toll, rail } = setup();
    const gate = toll.price(perWord, { resource: 'translate' });
    const challenge = await call(gate, { path: '/translate', body: small });

    let read = '';
    const paid = await call(gate, {
      path: '/translate',
      body: small,
      payment: `test quote=${String(challenge.body.quote)}`,
      readBody: (body) => (read = body),
    });
    expect(paid.status).toBe(200);
    expect(read).toBe(small);
    expect(rail.effects.settled).toEqual([1_000n]);
  });

  it('binds the query string and method', async () => {
    const { toll } = setup();
    const gate = toll.price(() => '$0.01', { resource: 'search' });
    const challenge = await call(gate, { path: '/search?q=a' });
    const quote = String(challenge.body.quote);

    expect((await call(gate, { path: '/search?q=b', payment: `test quote=${quote}` })).body.error).toMatchObject({ code: 'quote_mismatch' });
    expect((await call(gate, { path: '/search?q=a', method: 'DELETE', payment: `test quote=${quote}` })).body.error).toMatchObject(
      { code: 'quote_mismatch' },
    );
    expect((await call(gate, { path: '/search?q=a', payment: `test quote=${quote}` })).status).toBe(200);
  });

  it('binds MCP tool arguments regardless of key order', async () => {
    const clock = fakeClock();
    const toll = createTollstile({ rails: [testRail()], ledger: memoryLedger({ clock }), clock });
    const gate = toll.price((context) => `$${String((context.mcp?.arguments as { pages: number }).pages)}`);
    const enter = async (args: object, meta: Record<string, string> = {}) => {
      const entry = await gate.enter(mcpContext('render', meta, { arguments: args as never }));
      return entry.kind === 'denied' ? entry.denial.body : 'admitted';
    };

    const challenge = await enter({ pages: 1, format: 'pdf' });
    if (challenge === 'admitted' || typeof challenge.quote !== 'string') throw new Error('expected a quote');
    const payment = { 'tollstile/test-payment': `test quote=${challenge.quote}` };
    expect(await enter({ pages: 500, format: 'pdf' }, payment)).toMatchObject({ error: { code: 'quote_mismatch' } });
    expect(await enter({ format: 'pdf', pages: 1 }, payment)).toBe('admitted');
  });

  it('lets a route bind only the fields that affect the price', async () => {
    const { toll } = setup();
    const gate = toll.price(perWord, {
      resource: 'translate',
      commit: async (context) => ((await context.request?.json()) as { text: string }).text,
    });
    const challenge = await call(gate, { path: '/translate', body: JSON.stringify({ text: 'hello', trace: 1 }) });
    const payment = `test quote=${String(challenge.body.quote)}`;

    const retried = await call(gate, { path: '/translate', body: JSON.stringify({ trace: 2, text: 'hello' }), payment });
    expect(retried.status).toBe(200);
    const swapped = await call(gate, { path: '/translate', body: huge, payment: `test quote=${String(challenge.body.quote)} proof=p2` });
    expect(swapped.body.error).toMatchObject({ code: 'quote_mismatch' });
  });

  it('does not bind the body on fixed-price routes', async () => {
    const { toll } = setup();
    const gate = toll.price('$0.01', { resource: 'translate' });
    const challenge = await call(gate, { path: '/translate', body: small });

    const paid = await call(gate, { path: '/translate', body: huge, payment: `test quote=${String(challenge.body.quote)}` });
    expect(paid.status).toBe(200);
  });

  it('charges reusable authorizations the current price of each request', async () => {
    const { toll, rail } = setup({ rail: { authorization: 'reusable' } });
    const gate = toll.price(perWord, { resource: 'translate' });
    const challenge = await call(gate, { path: '/translate', body: small });
    const payment = `test quote=${String(challenge.body.quote)} proof=credential limit=$0.01`;

    expect((await call(gate, { path: '/translate', body: small, payment })).status).toBe(200);
    const larger = JSON.stringify({ text: 'one two three four five' });
    expect((await call(gate, { path: '/translate', body: larger, payment })).status).toBe(200);
    expect((await call(gate, { path: '/translate', body: huge, payment })).body.error).toMatchObject({ code: 'insufficient_authorization' });
    expect(rail.effects.settled).toEqual([1_000n, 5_000n]);
  });
});
