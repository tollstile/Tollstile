// Runs the Acme rail end to end in one process: a 402, a wallet authorizing the payment, a paid
// request, and the capture. `pnpm --filter @tollstile-examples/custom-rail demo`
import { createTollstile, memoryLedger } from 'tollstile';
import { httpContext } from 'tollstile/testing';
import { acmeProvider } from './acme-provider';
import { ACME_TOKEN_HEADER, acmeRail } from './acme-rail';

const provider = acmeProvider();
const toll = createTollstile({ rails: [acmeRail({ apiKey: 'sk_test_acme', fetch: provider.fetch })], ledger: memoryLedger() });
const gate = toll.price('$0.25', { resource: 'GET /report' });
const request = (headers: Record<string, string> = {}) => httpContext(new Request('https://api.example.com/report', { headers }));

console.log(toll.explain(gate), '\n');

const challenge = await gate.enter(request());
if (challenge.kind !== 'denied') throw new Error('expected a 402');
const accepts = challenge.denial.offers[0]?.challenge.accepts as { amount: string; currency: string; quote: string };
console.log(`402 ${challenge.denial.error.code}: ${accepts.amount} micro-USD`);

const { token } = provider.authorize({ payer: 'agent-7', amount: accepts.amount, currency: accepts.currency, quote: accepts.quote });
const paid = await gate.enter(request({ [ACME_TOKEN_HEADER]: token }));
if (paid.kind !== 'admitted') throw new Error(`expected admission, got ${paid.denial.error.code}`);
console.log(`admitted: payer ${paid.pass.payment.via === 'rail' ? paid.pass.payment.payer : ''}`);

const completion = await paid.pass.complete('succeeded');
console.log(`completed: ${completion.settlement}, receipt ${JSON.stringify(completion.receipt.headers)}, captures ${String(provider.captures().length)}`);
