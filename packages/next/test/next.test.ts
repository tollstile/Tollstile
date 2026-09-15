import { createTollstile, credits, memoryBalance, memoryLedger, payPerCall, testRail, type Gate, type Rail } from 'tollstile';
import { describe, expect, it } from 'vitest';
import { paid } from '../src/index';

function setup() {
  const rail = testRail();
  const ledger = memoryLedger();
  const toll = createTollstile({ rails: [rail], ledger });
  return { rail, ledger, toll };
}

function routeContext<Params>(params: Params) {
  return { params: Promise.resolve(params) };
}

/** Counts `complete()` calls, so a second call is visible before core rejects it. */
function countCompletions<Rails extends readonly Rail[]>(gate: Gate<Rails>) {
  let completions = 0;
  const counted: Gate<Rails> = {
    resource: gate.resource,
    async enter(context) {
      const entry = await gate.enter(context);
      if (entry.kind === 'denied') return entry;
      return {
        kind: 'admitted',
        pass: {
          payment: entry.pass.payment,
          complete(outcome) {
            completions += 1;
            return entry.pass.complete(outcome);
          },
        },
      };
    },
  };
  return { gate: counted, completions: () => completions };
}

describe('@tollstile/next', () => {
  it('turns 402 into 200 with the test rail and the quote it was offered', async () => {
    const { toll, rail } = setup();
    const { gate, completions } = countCompletions(toll.price('$0.01'));
    let runs = 0;
    const GET = paid(gate, (_request, { payment }) => {
      runs += 1;
      return Response.json({ forecast: 'clear', paidWith: payment.via });
    });

    const unpaid = await GET(new Request('http://localhost/weather'), routeContext({}));
    expect(unpaid.status).toBe(402);
    const { quote } = (await unpaid.json()) as { quote: string };
    expect(runs).toBe(0);

    const response = await GET(new Request('http://localhost/weather', { headers: { payment: `test quote=${quote}` } }), routeContext({}));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ forecast: 'clear', paidWith: 'rail' });
    expect(response.headers.get('payment-receipt')).toMatch(/^test_settlement_/);
    expect(rail.effects.settlements).toBe(1);
    expect(runs).toBe(1);
    expect(completions()).toBe(1);
  });

  it('passes the route params through to the handler', async () => {
    const { toll } = setup();
    const GET = paid(toll.price('$0.01'), async (_request, { params }) => Response.json(await params));

    const response = await GET(new Request('http://localhost/reports/42', { headers: { payment: 'test' } }), routeContext({ id: '42' }));

    expect(await response.json()).toEqual({ id: '42' });
  });

  it('names the resource from the method and pathname, unless the price sets one', async () => {
    const { toll, ledger } = setup();
    const byPath = paid(toll.price('$0.01'), () => new Response('ok'));
    const named = paid(toll.price('$0.01', { resource: 'GET /reports/[id]' }), () => new Response('ok'));

    await byPath(new Request('http://localhost/weather?city=tokyo', { method: 'POST', headers: { payment: 'test' } }), routeContext({}));
    await named(new Request('http://localhost/reports/42', { headers: { payment: 'test' } }), routeContext({ id: '42' }));

    expect(ledger.charges().map((charge) => charge.resource)).toEqual(['POST /weather', 'GET /reports/[id]']);
  });

  it('releases the reservation and rethrows when the handler throws', async () => {
    const { toll, rail, ledger } = setup();
    const { gate, completions } = countCompletions(toll.price('$0.01'));
    const failure = new Error('NEXT_REDIRECT');
    const GET = paid(gate, () => {
      throw failure;
    });

    await expect(GET(new Request('http://localhost/broken', { headers: { payment: 'test' } }), routeContext({}))).rejects.toBe(failure);
    expect(rail.effects.settlements).toBe(0);
    expect(ledger.charges().map((charge) => charge.payment)).toEqual(['released']);
    expect(completions()).toBe(1);
  });

  it('releases the reservation for a response of 400 or above, without a receipt', async () => {
    const { toll, rail, ledger } = setup();
    const { gate, completions } = countCompletions(toll.price('$0.01'));
    const GET = paid(gate, () => Response.json({ error: 'missing' }, { status: 404 }));

    const response = await GET(new Request('http://localhost/missing', { headers: { payment: 'test' } }), routeContext({}));

    expect(response.status).toBe(404);
    expect(response.headers.get('payment-receipt')).toBeNull();
    expect(rail.effects.settlements).toBe(0);
    expect(ledger.charges().map((charge) => charge.payment)).toEqual(['released']);
    expect(completions()).toBe(1);
  });

  it('adds the receipt to a response with immutable headers', async () => {
    const { toll } = setup();
    const GET = paid(toll.price('$0.01'), () => Response.redirect('http://localhost/elsewhere', 307));

    const response = await GET(new Request('http://localhost/weather', { headers: { payment: 'test' } }), routeContext({}));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost/elsewhere');
    expect(response.headers.get('payment-receipt')).toMatch(/^test_settlement_/);
  });

  it('replaces the output with a fresh 402 when settlement is rejected', async () => {
    const { toll, rail } = setup();
    rail.simulate({ settle: 'reject' });
    const handler = paid(toll.price('$0.01'), () => Response.json({ forecast: 'clear' }));
    const response = await handler(new Request('http://localhost/weather', { headers: { payment: 'test proof=r1' } }), routeContext({}));

    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ reason: 'settlement_rejected' });
    expect(response.headers.get('payment-receipt')).toBeNull();
  });

  it('passes the resolved principal to access policies', async () => {
    const { toll } = setup();
    const balance = memoryBalance({ acct_1: '$1' });
    const GET = paid(toll.price('$0.25', { access: [credits({ balance }), payPerCall()] }), () => new Response('ok'), {
      principal: (request) => {
        const account = request.headers.get('x-account');
        return account === null ? null : { id: account };
      },
    });

    expect((await GET(new Request('http://localhost/credits', { headers: { 'x-account': 'acct_1' } }), routeContext({}))).status).toBe(200);
    expect(balance.available('acct_1')?.micros).toBe(750_000n);
    expect((await GET(new Request('http://localhost/credits'), routeContext({}))).status).toBe(402);
  });

  it('is assignable to the route handler type Next.js checks for static, dynamic, and catch-all routes', () => {
    const { toll } = setup();
    type NextRouteHandler<Params> = (
      request: Request & { readonly nextUrl: URL },
      context: { params: Promise<Params> },
    ) => Promise<Response | undefined> | Response | undefined;

    const dynamic: NextRouteHandler<{ id: string }> = paid(toll.price('$0.01'), () => new Response('ok'));
    const catchAll: NextRouteHandler<{ slug?: string[] }> = paid(toll.price('$0.01'), () => new Response('ok'));
    const noParams: NextRouteHandler<object> = paid(toll.price('$0.01'), () => new Response('ok'));

    expect([dynamic, catchAll, noParams]).toHaveLength(3);
  });
});
