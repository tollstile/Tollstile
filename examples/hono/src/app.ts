import { tollstile } from '@tollstile/hono';
import { Hono } from 'hono';
import { credits, formatMoney, money, payPerCall, type Context } from 'tollstile';
import { creditBalance, toll } from './toll';

export const app = new Hono();

app.get('/weather', tollstile(toll.price('$0.01')), (c) => c.json({ city: 'Tokyo', forecast: 'clear' }));

// A price computed from the request body. The quote commits to that exact body, so the paid retry
// must send the same bytes; a different body gets a fresh 402 with error code "quote_mismatch".
app.post('/translate', tollstile(toll.price(pricePerWord)), async (c) => {
  const text = await c.req.text();
  return c.json({ translation: `[fr] ${text}` });
});

// Stand-in for your authentication: an API key identifies a customer account.
const accountsByApiKey = new Map([['demo-key', 'acct_demo']]);

// Callers with an account draw down prepaid credits; everyone else, and anyone whose credits have
// run out, pays per call.
app.get(
  '/forecast',
  tollstile(toll.price('$0.05', { access: [credits({ balance: creditBalance }), payPerCall()] }), {
    principal: (c) => {
      const account = accountsByApiKey.get(c.req.header('x-api-key') ?? '');
      return account === undefined ? null : { id: account };
    },
  }),
  (c) => {
    const payment = c.get('payment');
    return c.json({
      city: 'Tokyo',
      week: ['clear', 'clear', 'rain', 'clear', 'cloudy', 'clear', 'clear'],
      paidWith: payment.via === 'rail' ? payment.rail : payment.policy,
    });
  },
);

/** $0.001 per word. Tollstile reads the body from a copy, so the handler can still read it. */
async function pricePerWord(context: Context): Promise<string> {
  const text = (await context.request?.text()) ?? '';
  const words = text.split(/\s+/).filter((word) => word !== '').length;
  // A price cannot be zero, so an empty body is priced as one word.
  return formatMoney(money('USD', BigInt(Math.max(words, 1)) * 1_000n));
}
