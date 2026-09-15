import { createTollstile, credits, memoryBalance, memoryLedger, payPerCall, testRail, type Gate, type Rail } from 'tollstile';
import { describe, expect, it } from 'vitest';
import { paid } from '../src/index';

function setup() {
  const rail = testRail();
  const ledger = memoryLedger();
  const toll = createTollstile({ rails: [rail], ledger });
  return { rail, ledger, toll };
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

describe('@tollstile/fetch', () => {
  it('turns 402 into 200 with the test rail and the quote it was offered', async () => {
    const { toll, rail } = setup();
    const { gate, completions } = countCompletions(toll.price('$0.01'));
    let runs = 0;
    const handler = paid(gate, (_request, { payment }) => {
      runs += 1;
      return Response.json({ forecast: 'clear', paidWith: payment.via });
    });

    const unpaid = await handler(new Request('http://localhost/weather'));
    expect(unpaid.status).toBe(402);
    const { quote, resource } = (await unpaid.json()) as { quote: string; resource: string };
    expect(resource).toBe('GET /weather');
    expect(runs).toBe(0);

    const response = await handler(new Request('http://localhost/weather', { headers: { payment: `test quote=${quote}` } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ forecast: 'clear', paidWith: 'rail' });
    expect(response.headers.get('payment-receipt')).toMatch(/^test_settlement_/);
    expect(rail.effects.settlements).toBe(1);
    expect(runs).toBe(1);
    expect(completions()).toBe(1);
  });

  it('refuses a quote issued for another path', async () => {
    const { toll } = setup();
    const handler = paid(toll.price('$0.01'), () => new Response('ok'));

    const unpaid = await handler(new Request('http://localhost/weather'));
    const { quote } = (await unpaid.json()) as { quote: string };
    const response = await handler(new Request('http://localhost/other', { headers: { payment: `test quote=${quote}` } }));

    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ error: { code: 'quote_invalid' } });
  });

  it('names the resource from the method and pathname, unless the price sets one', async () => {
    const { toll, ledger } = setup();
    const byPath = paid(toll.price('$0.01'), () => new Response('ok'));
    const named = paid(toll.price('$0.01', { resource: 'GET /users/:id' }), () => new Response('ok'));

    await byPath(new Request('http://localhost/weather?city=tokyo', { method: 'POST', headers: { payment: 'test' } }));
    await named(new Request('http://localhost/users/42', { headers: { payment: 'test' } }));

    expect(ledger.charges().map((charge) => charge.resource)).toEqual(['POST /weather', 'GET /users/:id']);
  });

  it('releases the reservation and rethrows when the handler throws', async () => {
    const { toll, rail, ledger } = setup();
    const { gate, completions } = countCompletions(toll.price('$0.01'));
    const failure = new Error('handler failed');
    const handler = paid(gate, () => {
      throw failure;
    });

    await expect(handler(new Request('http://localhost/broken', { headers: { payment: 'test' } }))).rejects.toBe(failure);
    expect(rail.effects.settlements).toBe(0);
    expect(ledger.charges().map((charge) => charge.payment)).toEqual(['released']);
    expect(completions()).toBe(1);
  });

  it('releases the reservation when an async handler rejects', async () => {
    const { toll, rail, ledger } = setup();
    const handler = paid(toll.price('$0.01'), () => Promise.reject(new Error('handler failed')));

    await expect(handler(new Request('http://localhost/broken', { headers: { payment: 'test' } }))).rejects.toThrow('handler failed');
    expect(rail.effects.settlements).toBe(0);
    expect(ledger.charges().map((charge) => charge.payment)).toEqual(['released']);
  });

  it('releases the reservation for a response of 400 or above, without a receipt', async () => {
    const { toll, rail, ledger } = setup();
    const { gate, completions } = countCompletions(toll.price('$0.01'));
    const handler = paid(gate, () => Response.json({ error: 'missing' }, { status: 404 }));

    const response = await handler(new Request('http://localhost/missing', { headers: { payment: 'test' } }));

    expect(response.status).toBe(404);
    expect(response.headers.get('payment-receipt')).toBeNull();
    expect(rail.effects.settlements).toBe(0);
    expect(ledger.charges().map((charge) => charge.payment)).toEqual(['released']);
    expect(completions()).toBe(1);
  });

  it('adds the receipt to a response with immutable headers', async () => {
    const { toll } = setup();
    const handler = paid(toll.price('$0.01'), () => Response.redirect('http://localhost/elsewhere', 302));

    const response = await handler(new Request('http://localhost/weather', { headers: { payment: 'test' } }));

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('http://localhost/elsewhere');
    expect(response.headers.get('payment-receipt')).toMatch(/^test_settlement_/);
  });

  it('keeps the status text, every set-cookie header, and a streamed body', async () => {
    const { toll } = setup();
    const handler = paid(toll.price('$0.01'), () => {
      const headers = new Headers();
      headers.append('set-cookie', 'a=1');
      headers.append('set-cookie', 'b=2');
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('chunk-1 '));
          controller.enqueue(new TextEncoder().encode('chunk-2'));
          controller.close();
        },
      });
      return new Response(body, { status: 201, statusText: 'Created', headers });
    });

    const response = await handler(new Request('http://localhost/weather', { headers: { payment: 'test' } }));

    expect(response.status).toBe(201);
    expect(response.statusText).toBe('Created');
    expect(response.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
    expect(await response.text()).toBe('chunk-1 chunk-2');
  });

  it('replaces the output with a fresh 402 when settlement is rejected', async () => {
    const { toll, rail } = setup();
    rail.simulate({ settle: 'reject' });
    const handler = paid(toll.price('$0.01'), () => Response.json({ forecast: 'clear' }));
    const response = await handler(new Request('http://localhost/weather', { headers: { payment: 'test proof=r1' } }));

    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ error: { code: 'settlement_rejected' } });
    expect(response.headers.get('payment-receipt')).toBeNull();
  });

  it('forwards Idempotency-Key, so a retried request is not paid twice', async () => {
    const { toll, rail } = setup();
    const handler = paid(toll.price('$0.01'), () => Response.json({ forecast: 'clear' }));
    const headers = { payment: 'test proof=once', 'idempotency-key': 'order-7' };
    expect((await handler(new Request('http://localhost/weather', { headers }))).status).toBe(200);

    const retry = await handler(new Request('http://localhost/weather', { headers }));
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({ error: { code: 'already_paid' } });
    expect(rail.effects.settlements).toBe(1);
  });

  it('passes the resolved principal to access policies', async () => {
    const { toll } = setup();
    const balance = memoryBalance({ acct_1: '$1' });
    const handler = paid(toll.price('$0.25', { access: [credits({ balance }), payPerCall()] }), (_request, { payment }) => Response.json({ via: payment.via }), {
      principal: (request) => {
        const account = request.headers.get('x-account');
        return account === null ? null : { id: account };
      },
    });

    const withAccount = await handler(new Request('http://localhost/credits', { headers: { 'x-account': 'acct_1' } }));
    expect(withAccount.status).toBe(200);
    expect(await withAccount.json()).toEqual({ via: 'policy' });
    expect(balance.available('acct_1')?.micros).toBe(750_000n);
    expect((await handler(new Request('http://localhost/credits'))).status).toBe(402);
  });
});
