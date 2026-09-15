// Runs against installed packages, never workspace sources: a paid request through the real
// published entry points, and an import of every package. Fails loudly on anything missing.
import assert from 'node:assert/strict';

const { createTollstile, memoryLedger, testRail, createRail } = await import('tollstile');
const { fakeClock, railConformance } = await import('tollstile/testing');
const { Hono } = await import('hono');
const { tollstile } = await import('@tollstile/hono');
const { paid } = await import('@tollstile/fetch');

assert.equal(typeof createRail, 'function', 'tollstile exports createRail');
assert.equal(typeof railConformance, 'function', 'tollstile/testing exports railConformance');
assert.equal(typeof fakeClock, 'function', 'tollstile/testing exports fakeClock');

// A paid Hono route: 402 with a quote, then 200 with a receipt, then an idempotent retry.
const toll = createTollstile({ rails: [testRail()], ledger: memoryLedger() });
const app = new Hono().get('/weather', tollstile(toll.price('$0.01')), (c) => c.json({ forecast: 'clear' }));

const unpaid = await app.request('/weather');
assert.equal(unpaid.status, 402, 'an unpaid request gets 402');
const { quote, error } = await unpaid.json();
assert.equal(error.code, 'payment_required');

const headers = { payment: `test quote=${quote}`, 'idempotency-key': 'smoke-1' };
const paidResponse = await app.request('/weather', { headers });
assert.equal(paidResponse.status, 200, 'a paid request gets 200');
assert.match(paidResponse.headers.get('payment-receipt') ?? '', /^test_settlement_/, 'a paid request carries a receipt');
assert.equal((await app.request('/weather', { headers })).status, 409, 'a retry with the same key is not paid twice');

// The Web-standard adapter end to end.
const handler = paid(toll.price('$0.01'), () => Response.json({ ok: true }));
assert.equal((await handler(new Request('http://localhost/fetch'))).status, 402, 'the fetch adapter challenges');

// Every other package loads and exposes its entry point.
const entryPoints = {
  '@tollstile/express': 'paid',
  '@tollstile/next': 'paid',
  '@tollstile/mcp': 'paidTool',
  '@tollstile/x402': 'x402',
  '@tollstile/mpp': 'mppStripe',
  '@tollstile/l402': 'l402',
  '@tollstile/kyapay': 'kyapay',
  '@tollstile/postgres': 'postgresLedger',
  '@tollstile/sqlite': 'sqliteLedger',
  '@tollstile/web-bot-auth': 'verifiedAgent',
  '@tollstile/ap2': 'userMandate',
};
for (const [name, entry] of Object.entries(entryPoints)) {
  const module = await import(name);
  assert.equal(typeof module[entry], 'function', `${name} exports ${entry}`);
}

console.log('Smoke test passed: paid request, idempotent retry, and every package entry point.');
