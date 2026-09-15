import { fakeClock, railConformance, type RailHarness } from 'tollstile/testing';
import { describe, it } from 'vitest';
import { x402 } from '../src/index';
import { FACILITATOR_URL, fakeNetwork, RPC_URL } from './fake-network';
import { FACILITATOR_ADDRESS, PAY_TO, sign, type PaymentRequired } from './helpers';

/**
 * The x402 rail under the core conformance kit, against the fake facilitator and fake chain. The
 * kit prices routes with a fixed string, so it exercises the `exact` scheme; `upto` is covered in
 * x402.test.ts.
 */
function harness(): RailHarness {
  const clock = fakeClock();
  const network = fakeNetwork(clock);
  const rail = x402({
    network: 'eip155:84532',
    payTo: PAY_TO,
    denomination: 'USD',
    rpcUrl: RPC_URL,
    facilitator: { url: FACILITATOR_URL },
    upto: { facilitatorAddress: FACILITATOR_ADDRESS },
    fetch: network.fetch,
  });
  let nonce = 0;

  return {
    rail,
    clock,
    pay({ offer, url }) {
      const header = offer.challenge.headers.find(([name]) => name === 'payment-required')?.[1];
      const paymentRequired = JSON.parse(atob(header ?? '')) as PaymentRequired;
      const [accepted] = paymentRequired.accepts;
      if (accepted === undefined) throw new Error('expected an x402 offer');
      nonce += 1;
      const payment = sign(accepted, clock.now(), { nonce });
      return Promise.resolve(new Request(url, { headers: { 'payment-signature': btoa(JSON.stringify(payment)) } }));
    },
    settlements: () => network.settlements,
    loseNextSettleResponse: () => {
      network.faultNextSettle('lose-response');
    },
    failNextSettle: () => {
      network.faultNextSettle('fail');
    },
    tamper(request) {
      const payment = JSON.parse(atob(request.headers.get('payment-signature') ?? '')) as {
        payload: { authorization: { to: string } };
      };
      payment.payload.authorization.to = '0x0000000000000000000000000000000000000001';
      return new Request(request.url, { headers: { 'payment-signature': btoa(JSON.stringify(payment)) } });
    },
    // Lookup answers "none" only once the finalized block is past the signature's validBefore
    // (maxTimeoutSeconds, 60 s by default).
    reconcileAfterMs: 5 * 60_000,
  };
}

describe('rail conformance: x402 exact', () => {
  for (const test of railConformance(harness)) (test.skip === undefined ? it : it.skip)(test.name, () => test.run());
});
