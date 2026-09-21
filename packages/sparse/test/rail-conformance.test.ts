import { describe, it } from 'vitest';
import { fakeClock, railConformance, type RailHarness } from 'tollstile/testing';
import { memoryFacilitator, sparse, type SparseAccepts } from '../src/index';
import { encodeTicket, TICKET_HEADER } from '../src/ticket';
import { seeded } from './helpers';

/**
 * The kit prices the route at $1 by default; with a $1 ticket the threshold is 2^256 and every ticket wins, so
 * "settled once" means one transfer. The mechanism's probabilistic behaviour is tested separately in sparse.test.ts.
 */
function harness(): RailHarness {
  const facilitator = memoryFacilitator({ random: seeded(7) });
  const wallet = facilitator.wallet('agent-7', 100_000_000n);
  return {
    rail: sparse({ facilitator, payTo: '0xmerchant', ticket: '$1' }),
    clock: fakeClock(),
    pay: async ({ offer, url }) => {
      const ticket = await wallet.sign(offer.challenge.accepts as SparseAccepts);
      return new Request(url, { headers: { [TICKET_HEADER]: encodeTicket(ticket) } });
    },
    settlements: () => facilitator.transfers(),
    loseNextSettleResponse: () => {
      facilitator.loseNextSettleResponse();
    },
    failNextSettle: () => {
      facilitator.failNextSettle();
    },
    tamper: (request) => {
      const encoded = request.headers.get(TICKET_HEADER) ?? '';
      // Flip a character inside the body: the digest no longer matches, so the ticket is refused before the facilitator sees it.
      const middle = Math.floor(encoded.length / 2);
      const swapped = encoded[middle] === 'A' ? 'B' : 'A';
      return new Request(request.url, { headers: { [TICKET_HEADER]: encoded.slice(0, middle) + swapped + encoded.slice(middle + 1) } });
    },
  };
}

describe('sparse rail conformance', () => {
  for (const test of railConformance(harness)) (test.skip === undefined ? it : it.skip)(test.name, () => test.run());
});
