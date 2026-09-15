import { describe, expect, it } from 'vitest';
import worker from '../src/index';

// Calls the Worker's exported fetch handler directly, as the Workers runtime would.
const challengeOf = async (response: Response) => (await response.json()) as { price: string; quote: string; reason: string | null };

describe('cloudflare workers example', () => {
  it('answers 402 with a quote, then 200 with a receipt once the quote is paid', async () => {
    const unpaid = await worker.fetch(new Request('http://localhost/weather'));
    expect(unpaid.status).toBe(402);

    const { quote } = await challengeOf(unpaid);
    const paid = await worker.fetch(new Request('http://localhost/weather', { headers: { payment: `test quote=${quote}` } }));
    expect(paid.status).toBe(200);
    expect(paid.headers.get('payment-receipt')).toMatch(/^test_settlement_/);
    expect(await paid.json()).toEqual({ city: 'Tokyo', forecast: 'clear' });
  });

  it('prices by word count and accepts the quote only for the body it priced', async () => {
    const text = 'The weather in Tokyo is clear';
    const translate = (body: string, headers: Record<string, string> = {}) =>
      worker.fetch(new Request('http://localhost/translate', { method: 'POST', body, headers }));

    const unpaid = await translate(text);
    expect(unpaid.status).toBe(402);
    const { price, quote } = await challengeOf(unpaid);
    expect(price).toBe('$0.006');

    const otherBody = await translate(`${text} all week`, { payment: `test quote=${quote}` });
    expect(otherBody.status).toBe(402);
    expect(await challengeOf(otherBody)).toMatchObject({ reason: 'quote_mismatch', price: '$0.008' });

    const paid = await translate(text, { payment: `test quote=${quote}` });
    expect(paid.status).toBe(200);
    expect(paid.headers.get('payment-receipt')).toMatch(/^test_settlement_/);
    expect(await paid.json()).toEqual({ translation: `[fr] ${text}` });
  });

  it('answers 404 for unknown routes', async () => {
    expect((await worker.fetch(new Request('http://localhost/unknown'))).status).toBe(404);
  });
});
