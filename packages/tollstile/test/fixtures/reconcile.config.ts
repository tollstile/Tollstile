// A process that lost two settlement responses, as `tollstile reconcile` would find it.
import { createTollstile, memoryLedger, testRail } from '../../src/index';
import { httpContext } from '../../src/testing/index';

const rail = testRail();
// The charges were written an hour ago; reconciliation runs now.
let offsetMs = -60 * 60_000;
const clock = { now: () => new Date(Date.now() + offsetMs) };
const toll = createTollstile({ rails: [rail], ledger: memoryLedger({ clock }), clock });

rail.simulate({ settle: 'timeout-after-effect' });
for (const proof of ['a', 'b']) {
  const entry = await toll.price('$0.05', { resource: 'GET /report' }).enter(httpContext(new Request('https://api.example.com/report', { headers: { payment: `test proof=${proof}` } })));
  if (entry.kind === 'admitted') await entry.pass.complete('succeeded');
}
rail.simulate(process.env.LOOKUP_DOWN === '1' ? { lookup: 'unavailable' } : {});
offsetMs = 0;

export default { toll };
