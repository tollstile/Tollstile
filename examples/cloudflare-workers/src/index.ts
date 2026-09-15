import { paid } from '@tollstile/fetch';
import { formatMoney, money, type Context } from 'tollstile';
import { createToll } from './toll';

type Route = (request: Request) => Promise<Response>;

let routes: ReadonlyMap<string, Route> | undefined;

export default {
  fetch(request: Request): Promise<Response> | Response {
    // Built on the first request and reused for the life of the isolate: with real payments, the
    // secret and receiving address are Worker bindings, which arrive with the request.
    routes ??= createRoutes();
    const route = routes.get(`${request.method} ${new URL(request.url).pathname}`);
    return route === undefined ? new Response('Not found', { status: 404 }) : route(request);
  },
};

function createRoutes(): ReadonlyMap<string, Route> {
  const toll = createToll();
  return new Map([
    ['GET /weather', paid(toll.price('$0.01'), () => Response.json({ city: 'Tokyo', forecast: 'clear' }))],
    // A price computed from the request body. The quote commits to that exact body, so the paid
    // retry must send the same bytes; a different body gets a fresh 402 with error code "quote_mismatch".
    [
      'POST /translate',
      paid(toll.price(pricePerWord), async (request) => Response.json({ translation: `[fr] ${await request.text()}` })),
    ],
  ]);
}

/** $0.001 per word. Tollstile reads the body from a copy, so the handler can still read it. */
async function pricePerWord(context: Context): Promise<string> {
  const text = (await context.request?.text()) ?? '';
  const words = text.split(/\s+/).filter((word) => word !== '').length;
  // A price cannot be zero, so an empty body is priced as one word.
  return formatMoney(money('USD', BigInt(Math.max(words, 1)) * 1_000n));
}
