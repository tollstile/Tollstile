import { describe, expect, it } from 'vitest';
import { GET } from '../app/api/weather/route';

// Calls the route handler the way Next.js does: the request, and a context whose params are a promise.
const get = (headers: Record<string, string> = {}) =>
  GET(new Request('http://localhost/api/weather', { headers }), { params: Promise.resolve({}) });

describe('next.js example', () => {
  it('answers 402 with a quote, then 200 with a receipt once the quote is paid', async () => {
    const unpaid = await get();
    expect(unpaid.status).toBe(402);
    const { price, quote } = (await unpaid.json()) as { price: string; quote: string };
    expect(price).toBe('$0.01');

    const paid = await get({ payment: `test quote=${quote}` });
    expect(paid.status).toBe(200);
    expect(paid.headers.get('payment-receipt')).toMatch(/^test_settlement_/);
    expect(await paid.json()).toEqual({ city: 'Tokyo', forecast: 'clear' });
  });
});
