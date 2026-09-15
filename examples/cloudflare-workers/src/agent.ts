// An agent that meets 402 Payment Required, pays with the test rail, and gets through.
// Start the Worker first (`pnpm dev`), then run `pnpm agent`.
const baseUrl = process.argv[2] ?? 'http://localhost:8787';

/** The fields of Tollstile's 402 body this agent reads. */
type Challenge = { readonly price: string; readonly quote: string; readonly reason: string | null };

// 1. A fixed price: 402 with a signed quote, then 200 and a receipt for paying it.
const weather = await challengeOf('GET /weather', await fetch(`${baseUrl}/weather`));
await show(
  'GET /weather  Payment: test quote=…',
  await fetch(`${baseUrl}/weather`, { headers: { payment: `test quote=${weather.quote}` } }),
);

// 2. A price computed from the body. The quote pays only for the body it priced.
const text = 'The weather in Tokyo is clear all week';
const translation = await challengeOf('POST /translate', await fetch(`${baseUrl}/translate`, { method: 'POST', body: text }));
await challengeOf(
  'POST /translate  Payment: test quote=…  (a longer body)',
  await fetch(`${baseUrl}/translate`, {
    method: 'POST',
    body: `${text}, and here is a much longer text to translate`,
    headers: { payment: `test quote=${translation.quote}` },
  }),
);
await show(
  'POST /translate  Payment: test quote=…  (the same body)',
  await fetch(`${baseUrl}/translate`, { method: 'POST', body: text, headers: { payment: `test quote=${translation.quote}` } }),
);

/** Prints a 402 and returns the challenge it carries. */
async function challengeOf(label: string, response: Response): Promise<Challenge> {
  const body: unknown = await response.json();
  if (response.status !== 402 || !isChallenge(body)) {
    throw new Error(`${label}: expected a 402 with a quote, got ${response.status} ${JSON.stringify(body)}`);
  }
  console.log(`${label} → 402 ${body.reason ?? 'payment_required'}, price ${body.price}`);
  return body;
}

async function show(label: string, response: Response): Promise<void> {
  console.log(`${label} → ${response.status}, receipt ${response.headers.get('payment-receipt') ?? 'none'}`);
  console.log(`  ${await response.text()}`);
}

function isChallenge(body: unknown): body is Challenge {
  return (
    typeof body === 'object' &&
    body !== null &&
    'price' in body &&
    typeof body.price === 'string' &&
    'quote' in body &&
    typeof body.quote === 'string' &&
    'reason' in body &&
    (body.reason === null || typeof body.reason === 'string')
  );
}
