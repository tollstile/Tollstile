// An agent that meets 402 Payment Required, pays with the test rail, and gets through.
// Start the app first (`pnpm dev`), then run `pnpm agent`.
const url = process.argv[2] ?? 'http://localhost:3000/api/weather';

const unpaid = await fetch(url);
const challenge: unknown = await unpaid.json();
if (unpaid.status !== 402 || !isChallenge(challenge)) {
  throw new Error(`Expected a 402 with a quote, got ${unpaid.status} ${JSON.stringify(challenge)}`);
}
console.log(`GET ${url} → 402, price ${challenge.price}`);

const paid = await fetch(url, { headers: { payment: `test quote=${challenge.quote}` } });
console.log(`GET ${url}  Payment: test quote=… → ${paid.status}, receipt ${paid.headers.get('payment-receipt') ?? 'none'}`);
console.log(`  ${await paid.text()}`);

/** The fields of Tollstile's 402 body this agent reads. */
function isChallenge(body: unknown): body is { readonly price: string; readonly quote: string } {
  return typeof body === 'object' && body !== null && 'price' in body && typeof body.price === 'string' && 'quote' in body && typeof body.quote === 'string';
}
