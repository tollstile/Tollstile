import { describe, expect, it } from 'vitest';
import { app } from '../src/app';

const challengeOf = async (response: Response) => (await response.json()) as { price: string; quote: string; reason: string | null };

describe('hono example', () => {
  it('answers 402 with a quote, then 200 with a receipt once the quote is paid', async () => {
    const unpaid = await app.request('/weather');
    expect(unpaid.status).toBe(402);

    const paid = await app.request('/weather', { headers: { payment: `test quote=${(await challengeOf(unpaid)).quote}` } });
    expect(paid.status).toBe(200);
    expect(paid.headers.get('payment-receipt')).toMatch(/^test_settlement_/);
    expect(await paid.json()).toEqual({ city: 'Tokyo', forecast: 'clear' });
  });

  it('prices by word count and accepts the quote only for the body it priced', async () => {
    const text = 'The weather in Tokyo is clear';
    const unpaid = await app.request('/translate', { method: 'POST', body: text });
    expect(unpaid.status).toBe(402);
    const { price, quote } = await challengeOf(unpaid);
    expect(price).toBe('$0.006');

    const otherBody = await app.request('/translate', { method: 'POST', body: `${text} all week`, headers: { payment: `test quote=${quote}` } });
    expect(otherBody.status).toBe(402);
    expect(await challengeOf(otherBody)).toMatchObject({ reason: 'quote_mismatch', price: '$0.008' });

    const paid = await app.request('/translate', { method: 'POST', body: text, headers: { payment: `test quote=${quote}` } });
    expect(paid.status).toBe(200);
    expect(paid.headers.get('payment-receipt')).toMatch(/^test_settlement_/);
    expect(await paid.json()).toEqual({ translation: `[fr] ${text}` });
  });

  it('draws down credits for an API key, then asks for payment once they run out', async () => {
    const withKey = { headers: { 'x-api-key': 'demo-key' } };
    for (let call = 1; call <= 2; call += 1) {
      const response = await app.request('/forecast', withKey);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ paidWith: 'credits' });
    }

    const exhausted = await app.request('/forecast', withKey);
    expect(exhausted.status).toBe(402);

    const paid = await app.request('/forecast', { headers: { 'x-api-key': 'demo-key', payment: `test quote=${(await challengeOf(exhausted)).quote}` } });
    expect(paid.status).toBe(200);
    expect(await paid.json()).toMatchObject({ paidWith: 'test' });
  });
});
