import { paid } from '@tollstile/express';
import express, { type Express } from 'express';
import { credits, formatMoney, money, payPerCall, type Context } from 'tollstile';
import { creditBalance, toll } from './toll';

export const app: Express = express();

app.get(
  '/weather',
  paid(toll.price('$0.01'), (_req, res) => {
    res.json({ city: 'Tokyo', forecast: 'clear' });
  }),
);

// A price computed from the request body that express.text() parsed. The quote commits to that body,
// so the paid retry must send the same text; different text gets a fresh 402 with reason "quote_mismatch".
app.post(
  '/translate',
  express.text(),
  paid(toll.price(pricePerWord), (req, res) => {
    res.json({ translation: `[fr] ${String(req.body)}` });
  }),
);

// Stand-in for your authentication: an API key identifies a customer account.
const accountsByApiKey = new Map([['demo-key', 'acct_demo']]);

// Callers with an account draw down prepaid credits; everyone else, and anyone whose credits have
// run out, pays per call.
app.get(
  '/forecast',
  paid(
    toll.price('$0.05', { access: [credits({ balance: creditBalance }), payPerCall()] }),
    (_req, res, { payment }) => {
      res.json({
        city: 'Tokyo',
        week: ['clear', 'clear', 'rain', 'clear', 'cloudy', 'clear', 'clear'],
        paidWith: payment.via === 'rail' ? payment.rail : payment.policy,
      });
    },
    {
      principal: (req) => {
        const account = accountsByApiKey.get(req.get('x-api-key') ?? '');
        return account === undefined ? null : { id: account };
      },
    },
  ),
);

/** $0.001 per word. Tollstile reads the body from a copy; a price cannot be zero, so an empty body is priced as one word. */
async function pricePerWord(context: Context): Promise<string> {
  const text = (await context.request?.text()) ?? '';
  const words = text.split(/\s+/).filter((word) => word !== '').length;
  return formatMoney(money('USD', BigInt(Math.max(words, 1)) * 1_000n));
}
