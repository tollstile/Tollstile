import { createTollstile, memoryLedger, testRail, upTo, type Rail } from 'tollstile';
import { describe, expect, it } from 'vitest';
import { createProxy, type ProxyOptions } from '../src/index';

type Seen = { readonly method: string; readonly url: string; readonly headers: Headers; readonly body: string };

/** A stand-in for the service behind the proxy, e.g. a FastAPI app. Records what reached it. */
function upstream(respond: (request: Request, body: string) => Response | Promise<Response> = () => Response.json({ ok: true })) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
    seen.push({ method: request.method, url: request.url, headers: request.headers, body });
    return respond(request, body);
  }) as typeof fetch;
  return { fetch: fetchImpl, seen };
}

function setup(options: Partial<ProxyOptions<readonly Rail[]>> & { readonly respond?: Parameters<typeof upstream>[0] } = {}) {
  const rail = testRail();
  const ledger = memoryLedger();
  const toll = createTollstile({ rails: [rail], ledger });
  const service = upstream(options.respond);
  const proxy = createProxy({
    toll,
    upstream: 'http://127.0.0.1:8000',
    routes: [
      { method: 'GET', path: '/weather', price: '$0.01' },
      { method: 'POST', path: '/summarize', price: upTo('$0.50') },
      { path: '/reports/:id/*', price: '$0.02' },
    ],
    fetch: service.fetch,
    ...options,
  });
  const charges = () => ledger.charges().map((charge) => `${charge.payment}/${charge.fulfillment}`);
  return { proxy, rail, ledger, service, charges };
}

const at = (path: string, init?: RequestInit) => new Request(`https://api.example.com${path}`, init);

describe('@tollstile/proxy over HTTP', () => {
  it('asks for payment without reaching the upstream, then forwards the paid request with who paid', async () => {
    const { proxy, service, rail } = setup();

    const unpaid = await proxy(at('/weather?city=tokyo'));
    expect(unpaid.status).toBe(402);
    const { quote, error } = (await unpaid.json()) as { quote: string; error: { code: string } };
    expect(error.code).toBe('payment_required');
    expect(service.seen).toHaveLength(0);

    const paid = await proxy(at('/weather?city=tokyo', { headers: { payment: `test quote=${quote}`, 'tollstile-payer': 'spoofed' } }));
    expect(paid.status).toBe(200);
    expect(await paid.json()).toEqual({ ok: true });
    expect(paid.headers.get('payment-receipt')).toMatch(/^test_settlement_/);
    expect(rail.effects.settlements).toBe(1);

    const [forwarded] = service.seen;
    expect(forwarded?.url).toBe('http://127.0.0.1:8000/weather?city=tokyo');
    expect(forwarded?.headers.get('tollstile-payment-via')).toBe('rail');
    expect(forwarded?.headers.get('tollstile-payer')).toBe('test-payer');
    expect(forwarded?.headers.get('tollstile-charge-id')).toMatch(/^chg_/);
    expect(forwarded?.headers.get('x-forwarded-host')).toBe('api.example.com');
  });

  it('refuses a path with an encoded separator or a parameter instead of forwarding it unpriced', async () => {
    const { proxy, service } = setup({ unmatched: 'pass' });

    for (const path of ['/weathe%2F', '/weather%2Fx', '/weather%5C', '/weather;x=1']) {
      const response = await proxy(at(path));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'invalid_path' } });
    }
    expect(service.seen).toHaveLength(0);
  });

  it('refuses unpriced routes by default, and forwards them free only when told to', async () => {
    const strict = setup();
    expect((await strict.proxy(at('/health'))).status).toBe(404);
    expect(strict.service.seen).toHaveLength(0);

    const free = setup({ unmatched: 'pass' });
    expect((await free.proxy(at('/health'))).status).toBe(200);
    expect(free.service.seen).toHaveLength(1);
  });

  it('matches path parameters and trailing wildcards', async () => {
    const { proxy } = setup();
    expect((await proxy(at('/reports/42/pdf/full'))).status).toBe(402);
    expect((await proxy(at('/reports/42'))).status).toBe(402);
    // `/reports/:id` does not cover `/reports`, and an unpriced path is refused by default.
    expect((await proxy(at('/reports'))).status).toBe(404);
  });

  it('prices path aliases the upstream would treat as the same route, and forwards the canonical path', async () => {
    const { proxy, service } = setup();
    for (const alias of ['/weathe%72', '//weather', '/weather/', '/./weather']) {
      expect((await proxy(at(alias))).status, alias).toBe(402);
    }
    expect(service.seen).toHaveLength(0);

    await proxy(at('/weathe%72', { headers: { payment: 'test' } }));
    expect(service.seen[0]?.url).toBe('http://127.0.0.1:8000/weather');
    expect((await proxy(at('/weather%zz'))).status).toBe(400);
  });

  it('releases the charge when the upstream fails, and passes its answer through', async () => {
    const { proxy, charges, rail } = setup({ respond: () => Response.json({ detail: 'boom' }, { status: 500 }) });
    const response = await proxy(at('/weather', { headers: { payment: 'test' } }));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ detail: 'boom' });
    expect(response.headers.get('payment-receipt')).toBeNull();
    expect(charges()).toEqual(['released/failed']);
    expect(rail.effects.settlements).toBe(0);
  });

  it('answers 502 and releases the charge when the upstream is unreachable', async () => {
    const { proxy, charges } = setup({ fetch: (() => Promise.reject(new TypeError('connect ECONNREFUSED'))) });
    const response = await proxy(at('/weather', { headers: { payment: 'test' } }));

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: 'upstream_unavailable', action: 'retry_later' } });
    expect(charges()).toEqual(['released/failed']);
  });

  it('withholds the upstream answer and asks again when settlement is rejected', async () => {
    const { proxy, rail } = setup();
    rail.simulate({ settle: 'reject' });
    const response = await proxy(at('/weather', { headers: { payment: 'test' } }));

    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ error: { code: 'settlement_rejected' } });
  });

  it('charges the amount the upstream reports on an upTo route, and never shows the header to clients', async () => {
    const { proxy, ledger } = setup({
      respond: () => Response.json({ summary: '…' }, { headers: { 'tollstile-fulfill-amount': '$0.137', 'tollstile-result-ref': 'jobs/7' } }),
    });
    const challenge = (await (await proxy(at('/summarize', { method: 'POST', body: 'text' }))).json()) as { quote: string };
    const response = await proxy(at('/summarize', { method: 'POST', body: 'text', headers: { payment: `test quote=${challenge.quote}` } }));

    expect(response.status).toBe(200);
    expect(response.headers.get('tollstile-fulfill-amount')).toBeNull();
    expect(ledger.charges()[0]).toMatchObject({ payment: 'settled', amount: { micros: 137_000n }, resultRef: 'jobs/7' });
  });

  it('does not charge an amount above the authorized maximum', async () => {
    const { proxy, charges } = setup({ respond: () => Response.json({}, { headers: { 'tollstile-fulfill-amount': '$9.00' } }) });
    const challenge = (await (await proxy(at('/summarize', { method: 'POST', body: 'x' }))).json()) as { quote: string };
    await proxy(at('/summarize', { method: 'POST', body: 'x', headers: { payment: `test quote=${challenge.quote}` } }));

    expect(charges()).toEqual(['released/failed']);
  });

  it('binds dynamic prices to the forwarded body, and still forwards the body intact', async () => {
    const { proxy, service } = setup({
      routes: [{ method: 'POST', path: '/translate', price: async (context) => `$${String((await context.request?.text() ?? '').length / 1000)}` }],
    });
    const challenge = (await (await proxy(at('/translate', { method: 'POST', body: 'hello' }))).json()) as { quote: string };

    const swapped = await proxy(at('/translate', { method: 'POST', body: 'x'.repeat(5000), headers: { payment: `test quote=${challenge.quote}` } }));
    expect(await swapped.json()).toMatchObject({ error: { code: 'quote_mismatch' } });

    const paid = await proxy(at('/translate', { method: 'POST', body: 'hello', headers: { payment: `test quote=${challenge.quote}` } }));
    expect(paid.status).toBe(200);
    expect(service.seen.at(-1)?.body).toBe('hello');
  });

  it('answers a retried request with the same Idempotency-Key without paying or forwarding again', async () => {
    const { proxy, service, rail } = setup();
    const headers = { payment: 'test proof=once', 'idempotency-key': 'order-1' };
    expect((await proxy(at('/weather', { headers }))).status).toBe(200);

    const retry = await proxy(at('/weather', { headers }));
    expect(retry.status).toBe(409);
    expect(service.seen).toHaveLength(1);
    expect(rail.effects.settlements).toBe(1);
  });
});
