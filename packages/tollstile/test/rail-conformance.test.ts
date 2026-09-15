import { describe, expect, it } from 'vitest';
import { TollstileError, testRail, type Rail, type TestRailOptions } from '../src/index';
import { fakeClock, railConformance, type RailHarness } from '../src/testing/index';

/** The test rail under the conformance kit, with one-shot settlement faults like a real provider's. */
type Variant = TestRailOptions & {
  readonly flows?: Rail['capabilities']['flows'];
  /** Breaks the rail on purpose, to prove the kit notices. */
  readonly broken?: 'settles-every-call';
};

function harness(options: Variant = {}): () => RailHarness {
  return () => {
    const test = testRail(options);
    let fault: 'lose-response' | 'fail' | undefined;
    let brokenSettlements = 0;
    const rail: Rail = {
      ...test,
      capabilities: { ...test.capabilities, flows: options.flows ?? test.capabilities.flows },
      async settle(authorization, charge, operation) {
        const next = fault;
        fault = undefined;
        if (next === 'fail') throw new TollstileError('PROVIDER_UNAVAILABLE', 'simulated outage before settling');
        if (options.broken === 'settles-every-call') {
          brokenSettlements += 1;
          if (next === 'lose-response') throw new TollstileError('PROVIDER_TIMEOUT', 'simulated lost response');
          return { status: 'settled', reference: `broken_${String(brokenSettlements)}`, details: {} };
        }
        const result = await test.settle(authorization as never, charge, operation);
        if (next === 'lose-response') throw new TollstileError('PROVIDER_TIMEOUT', 'simulated lost response');
        return result;
      },
    };
    return {
      rail,
      clock: fakeClock(),
      pay: ({ denial, offer }) => {
        const token = typeof denial.body.quote === 'string' ? denial.body.quote : '';
        const proof = `p${String(Math.random()).slice(2)}`;
        const limit = test.capabilities.authorization === 'reusable' ? ' limit=$5' : '';
        return Promise.resolve(
          new Request(offer.offer.rail === 'test' ? 'http://localhost/conformance' : '', {
            headers: { payment: `test quote=${token} proof=${proof} signature=0xsig${limit}` },
          }),
        );
      },
      settlements: () => test.effects.settlements + brokenSettlements,
      loseNextSettleResponse: () => (fault = 'lose-response'),
      failNextSettle: () => (fault = 'fail'),
      tamper: (request) => {
        const headers = new Headers(request.headers);
        headers.set('payment', `${headers.get('payment') ?? ''} amount=$999`);
        return new Request(request.url, { headers });
      },
    };
  };
}

const variants: [string, () => RailHarness][] = [
  ['single-use, authorization flow', harness()],
  ['reusable', harness({ authorization: 'reusable' })],
  ['upfront flow', harness({ flows: ['upfront'] })],
  ['cannot refund', harness({ refund: false })],
];

for (const [variant, create] of variants) {
  describe(`rail conformance: test rail, ${variant}`, () => {
    for (const test of railConformance(create)) (test.skip === undefined ? it : it.skip)(test.name, () => test.run());
  });
}

describe('rail conformance catches broken rails', () => {
  const failures = async (create: () => RailHarness) => {
    const failed: string[] = [];
    for (const test of railConformance(create)) {
      if (test.skip !== undefined) continue;
      await test.run().catch(() => failed.push(test.name.slice('test: '.length)));
    }
    return failed;
  };

  it('a rail that settles again instead of honoring the operation key', async () => {
    expect(await failures(harness({ broken: 'settles-every-call' }))).toEqual(
      expect.arrayContaining([
        'settling again with the same key has no second effect',
        'a lost settlement response is resolved by lookup, never guessed',
      ]),
    );
  });
});
