import { describe, it } from 'vitest';
import { fakeClock, railConformance, type RailHarness } from 'tollstile/testing';
import { acmeProvider } from '../src/acme-provider';
import { ACME_TOKEN_HEADER, acmeRail } from '../src/acme-rail';

/** Everything the conformance kit needs to drive the rail against the fake provider. */
function harness(): RailHarness {
  const provider = acmeProvider();
  return {
    rail: acmeRail({ apiKey: 'sk_test_acme', fetch: provider.fetch }),
    clock: fakeClock(),
    // A fresh payment per call, authorized against the quote and amount the 402 offered.
    pay: ({ offer, url }) => {
      const accepts = offer.challenge.accepts as { amount: string; currency: string; quote: string };
      const { token } = provider.authorize({ payer: 'agent-7', amount: accepts.amount, currency: accepts.currency, quote: accepts.quote });
      return Promise.resolve(new Request(url, { headers: { [ACME_TOKEN_HEADER]: token } }));
    },
    settlements: () => provider.captures().length,
    loseNextSettleResponse: () => { provider.loseNextCaptureResponse(); },
    failNextSettle: () => { provider.failNextCapture(); },
    tamper: (request) => new Request(request.url, { headers: { [ACME_TOKEN_HEADER]: 'tok_forged' } }),
  };
}

describe('acme rail conformance', () => {
  for (const test of railConformance(harness)) (test.skip === undefined ? it : it.skip)(test.name, () => test.run());
});
