import { TollstileError } from 'tollstile';
import { fakeClock, railConformance, type RailHarness } from 'tollstile/testing';
import { describe, it } from 'vitest';
import { l402, lndRest, type L402Rail } from '../src/index';
import { fakeLnd, LND_MACAROON_HEX, readChallenge } from './fake-lnd';

/**
 * The L402 rail against the fake LND.
 *
 * What `settlements` counts: the payer pays the invoice before the credential is ever presented, and
 * that payment buys the credential, not any one call; Lightning cannot undo it. The per-call economic
 * effect is `settle` consuming prepaid value for one charge, identified by its reference
 * `<payment hash>:<charge id>`. So `settlements` counts distinct (charge, reference) consumptions:
 * repeating the same consumption is not a second effect, while a settle that consumed again under a
 * new reference, or a reference shared by two charges, would count twice.
 *
 * Settlement faults: `settle` never calls the node, so the fake LND cannot drop its response. The
 * faults are injected around `settle` instead, modelling a process that dies after consuming but
 * before recording (lost response) or before consuming (failure).
 */
function harness(): RailHarness {
  const clock = fakeClock();
  const lnd = fakeLnd();
  const rail = l402({
    network: 'regtest',
    invoices: lndRest({ url: 'https://lnd.test:8080', macaroon: LND_MACAROON_HEX, fetch: lnd.fetch }),
    rate: (amount) => amount.micros * 2n,
    secret: 'l402-root-key-secret-0123456789abcdef',
    clock,
  });
  const consumed = new Set<string>();
  const paidInvoices = new Set<string>();
  let fault: 'lose-response' | 'fail' | undefined;

  const faulty: L402Rail = {
    ...rail,
    async settle(authorization, charge, operation) {
      const next = fault;
      fault = undefined;
      if (next === 'fail') throw new TollstileError('PROVIDER_UNAVAILABLE', 'simulated failure before consuming');
      const result = await rail.settle(authorization, charge, operation);
      if (result.status === 'settled') consumed.add(`${charge.id} ${result.reference}`);
      if (next === 'lose-response') throw new TollstileError('PROVIDER_TIMEOUT', 'simulated lost settle response');
      return result;
    },
  };

  return {
    rail: faulty,
    clock,
    pay: ({ offer, url }) => {
      const headers = new Headers();
      for (const [name, value] of offer.challenge.headers) headers.append(name, value);
      const { macaroon, invoice } = readChallenge(headers);
      // The proof is fixed by the challenge's invoice, so a fresh proof needs a fresh challenge.
      if (paidInvoices.has(invoice)) throw new Error('This challenge was already paid; request a new one for a new proof.');
      paidInvoices.add(invoice);
      return Promise.resolve(new Request(url, { headers: { authorization: `L402 ${macaroon}:${lnd.pay(invoice)}` } }));
    },
    settlements: () => consumed.size,
    loseNextSettleResponse: () => (fault = 'lose-response'),
    failNextSettle: () => (fault = 'fail'),
    tamper: (request) => {
      const authorization = request.headers.get('authorization') ?? '';
      const flipped = authorization.replace(/[0-9a-f]$/, (last) => (last === '0' ? '1' : '0'));
      return new Request(request.url, { headers: { authorization: flipped } });
    },
    // lookup never asks the node, so reconciliation can run as soon as a charge is older than its window.
    reconcileAfterMs: 1_000,
  };
}

describe('rail conformance: l402 against fake LND', () => {
  for (const test of railConformance(harness)) (test.skip === undefined ? it : it.skip)(test.name, () => test.run());
});
