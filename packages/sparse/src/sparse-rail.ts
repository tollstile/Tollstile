import { createRail, formatMoney, parseMoney, TollstileError, type Json, type Money } from 'tollstile';
import type { Facilitator, SparseAccepts } from './facilitator';
import {
  CHALLENGE_HEADER,
  RECEIPT_HEADER,
  RECEIPT_META,
  TICKET_HEADER,
  TICKET_META,
  decodeTicket,
  digestFieldsOf,
  digestOf,
  oddsOf,
  outcomeOf,
  thresholdFor,
  type Outcome,
} from './ticket';

export type SparseOptions = {
  readonly facilitator: Facilitator;
  /** Where winners are paid. Bound in every witness. */
  readonly payTo: string;
  /** The ticket value `T`, e.g. `"$1"`. A route priced above it gets no offer from this rail. */
  readonly ticket: string;
  /** Rail name, for registering several ticket sizes side by side. Default `"sparse"`. */
  readonly name?: string;
  readonly network?: string;
  readonly livemode?: boolean;
};

/** What the ledger keeps per authorization. `secret` is redacted from events. */
export type SparseData = {
  readonly ticketId: string;
  readonly challengeId: string;
  readonly payer: string;
  readonly ticket: string;
  readonly signedPrice: string;
  readonly signedThreshold: string;
  readonly secret: string;
  /** Outcome against the signed (maximum) price. The final outcome is decided at settle against the charged price. */
  readonly outcome: Outcome;
};

export type SparseRail = ReturnType<typeof sparse>;

const fail = (code: 'PROVIDER_TIMEOUT' | 'PROVIDER_UNAVAILABLE', what: string) => (error: unknown) => {
  throw new TollstileError(code, `The sparse facilitator did not answer ${what}.`, { cause: error });
};

/**
 * Sparse settlement as a Tollstile rail (paper §3): the buyer signs a ticket for `T`; the facilitator commits to a
 * secret before signing and reveals it at verify; the ticket settles iff `H(d ‖ s) < floor(p / T · 2^256)`. Expected
 * revenue per call is `p`; realized is `T` or 0. Both are on the receipt and in `settlement.details`.
 */
export function sparse(options: SparseOptions) {
  const name = options.name ?? 'sparse';
  const ticketMoney = parseMoney(options.ticket);
  const ticketMicros = ticketMoney.micros;
  const network = options.network ?? 'eip155:84532';
  const facilitator = options.facilitator;

  const details = (expected: Money, outcome: Outcome, threshold: bigint): Json => ({
    outcome,
    expected: formatMoney(expected),
    realized: outcome === 'win' ? formatMoney(ticketMoney) : formatMoney({ currency: expected.currency, micros: 0n }),
    ticket: formatMoney(ticketMoney),
    odds: oddsOf(threshold),
  });

  return createRail<string, SparseData>({
    name,
    livemode: options.livemode ?? false,
    capabilities: {
      // Outcome is known at verify; funds move after the handler, so a failed handler costs nobody.
      flows: ['authorization'],
      // One ticket, one roll, one purchase.
      authorization: 'single',
      // Odds may only fall between signing and settling, so `upTo()` routes settle at the charged price's odds.
      variableAmount: true,
      // The quote token travels inside the ticket.
      quotes: true,
    },

    offer: ({ price }) =>
      Promise.resolve(
        price.currency === ticketMoney.currency && price.micros <= ticketMicros
          ? { rail: name, asset: { code: 'USDC', network, scale: 6 }, amount: price.micros.toString(), basis: 'par', details: { ticket: ticketMicros.toString() } }
          : null,
      ),

    // The 402 carries everything the witness binds, plus the commitment the buyer signs over.
    async challenge(quote, quoteToken, offer, _context, operation) {
      const { commitment } = await facilitator.commit({ challengeId: quote.id, signal: operation.signal }).catch(fail('PROVIDER_UNAVAILABLE', 'a commitment'));
      const price = BigInt(offer.amount);
      const accepts: SparseAccepts = {
        ticket: ticketMicros.toString(),
        price: price.toString(),
        threshold: thresholdFor(price, ticketMicros).toString(),
        commitment,
        challengeId: quote.id,
        facilitator: facilitator.address,
        to: options.payTo,
        validAfter: Math.floor(quote.issuedAt.getTime() / 1000),
        quote: quoteToken,
        header: TICKET_HEADER,
      };
      return {
        headers: [[CHALLENGE_HEADER, JSON.stringify(accepts)]],
        accepts,
        mcp: { style: 'sparse', meta: TICKET_META, ...accepts },
      };
    },

    async verify(context, terms, operation) {
      const fromMeta = context.mcp?.meta[TICKET_META];
      const encoded = typeof fromMeta === 'string' ? fromMeta : context.request?.headers.get(TICKET_HEADER);
      if (encoded === undefined || encoded === null) return { status: 'absent' };
      const ticket = decodeTicket(encoded);
      if (ticket === undefined) return { status: 'invalid', reason: 'ticket_malformed' };

      const invalid = (reason: string) => ({ status: 'invalid' as const, reason, proofId: ticket.digest });
      // Anything the buyer could have altered after seeing the 402 is inside the digest; check it before asking anyone.
      if ((await digestOf(digestFieldsOf(ticket))) !== ticket.digest) return invalid('digest_mismatch');
      if (ticket.to !== options.payTo || ticket.facilitator !== facilitator.address || ticket.ticket !== ticketMicros.toString()) return invalid('witness_mismatch');
      const quote = await terms.openQuote(ticket.quote);
      if (quote === undefined || quote.id !== ticket.challengeId) return invalid('quote_invalid');
      if (quote.price.currency !== ticketMoney.currency || ticket.price !== quote.price.micros.toString()) return invalid('price_mismatch');
      const threshold = thresholdFor(quote.price.micros, ticketMicros);
      if (ticket.threshold !== threshold.toString()) return invalid('threshold_mismatch');

      const verdict = await facilitator.verify({ ticket, signal: operation.signal }).catch(fail('PROVIDER_UNAVAILABLE', 'a verification'));
      if (!verdict.ok) return invalid(verdict.reason);

      return {
        status: 'valid',
        proofId: ticket.digest,
        payer: ticket.payer.trim().toLowerCase(),
        quote,
        limit: quote.price,
        expiresAt: quote.expiresAt,
        data: {
          ticketId: verdict.ticketId,
          challengeId: ticket.challengeId,
          payer: ticket.payer,
          ticket: ticket.ticket,
          signedPrice: ticket.price,
          signedThreshold: ticket.threshold,
          secret: verdict.secret,
          outcome: verdict.outcome,
        },
      };
    },

    // Decide at the charged price. A loser settles with nothing moved; a winner is one on-chain transfer of `T`.
    async settle(authorization, charge, operation) {
      const { data } = authorization;
      const threshold = thresholdFor(charge.amount.micros, ticketMicros);
      const outcome = await outcomeOf(data.ticketId, data.secret, threshold);
      if (outcome === 'lose') return { status: 'settled', reference: `sparse:lose:${data.ticketId}`, details: details(charge.amount, 'lose', threshold) };
      const result = await facilitator
        .settle({ ticketId: data.ticketId, priceMicros: charge.amount.micros, key: operation.key, signal: operation.signal })
        .catch(fail('PROVIDER_TIMEOUT', 'a settlement'));
      if (!result.ok) return { status: 'rejected', reason: result.reason };
      return { status: 'settled', reference: result.reference, details: details(charge.amount, 'win', threshold) };
    },

    // Asked only when a settle's outcome is unknown. A loser never touched the facilitator, so recompute it; a winner is looked up.
    async lookup(authorization, charge, operation) {
      const { data } = authorization;
      const threshold = thresholdFor(charge.amount.micros, ticketMicros);
      if ((await outcomeOf(data.ticketId, data.secret, threshold)) === 'lose') {
        return { status: 'settled', reference: `sparse:lose:${data.ticketId}`, details: details(charge.amount, 'lose', threshold) };
      }
      const found = await facilitator.lookup({ ticketId: data.ticketId, signal: operation.signal }).catch(fail('PROVIDER_UNAVAILABLE', 'a lookup'));
      if (found.status === 'settled') return { status: 'settled', reference: found.reference, details: details(charge.amount, 'win', threshold) };
      if (found.status === 'refunded') return { status: 'refunded', reference: found.reference };
      return { status: 'none' };
    },

    async refund(authorization, charge, operation) {
      if (charge.settlement?.reference.startsWith('sparse:lose:') === true) return { status: 'refunded', reference: 'sparse:nothing-moved' };
      const result = await facilitator
        .refund({ ticketId: authorization.data.ticketId, key: operation.key, signal: operation.signal })
        .catch(fail('PROVIDER_TIMEOUT', 'a refund'));
      return result.ok ? { status: 'refunded', reference: result.reference } : { status: 'rejected', reason: result.reason };
    },

    // The receipt carries the reference and, once settled, the expected/realized pair the paper's ledger semantics require.
    receipt: (_authorization, charge, context) => {
      const reference = charge.settlement?.reference ?? charge.id;
      const settlement: Json = charge.settlement?.details ?? null;
      return context.transport === 'mcp'
        ? { headers: [], meta: { [RECEIPT_META]: { reference, settlement } } }
        : { headers: [[RECEIPT_HEADER, reference]], meta: {} };
    },

    // The secret is public once revealed, but events and logs do not need it; the ticket id is what lookup needs.
    redact: (data) => ({ ...data, secret: '' }),
  });
}
