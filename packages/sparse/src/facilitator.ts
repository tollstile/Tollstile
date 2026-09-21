import { commitmentOf, digestOf, digestFieldsOf, outcomeOf, sha256Hex, thresholdFor, type DigestFields, type Outcome, type Ticket } from './ticket';

/**
 * What the rail asks of a sparse-settlement facilitator. In production this is an HTTP service in front of the
 * verifier contract; here it is an interface so the reference implementation can be driven in memory.
 */
export type Facilitator = {
  /** The address bound in every witness; only this address may call `settle` on the verifier. */
  readonly address: string;
  /** Commit to a fresh secret for this challenge. The commitment goes into the 402 before the buyer signs. */
  commit(input: { readonly challengeId: string; readonly signal: AbortSignal }): Promise<{ readonly commitment: string }>;
  /** Reveal the secret and decide the ticket. MUST reveal on every valid ticket, win or lose (§7, selective abort). */
  verify(input: { readonly ticket: Ticket; readonly signal: AbortSignal }): Promise<FacilitatorVerify>;
  /** Move `ticket` to `to` for a winner, at the final price. Idempotent per `key`. */
  settle(input: { readonly ticketId: string; readonly priceMicros: bigint; readonly key: string; readonly signal: AbortSignal }): Promise<FacilitatorSettle>;
  refund(input: { readonly ticketId: string; readonly key: string; readonly signal: AbortSignal }): Promise<FacilitatorRefund>;
  lookup(input: { readonly ticketId: string; readonly signal: AbortSignal }): Promise<FacilitatorLookup>;
};

export type FacilitatorVerify =
  | { readonly ok: false; readonly reason: string }
  | { readonly ok: true; readonly ticketId: string; readonly secret: string; readonly outcome: Outcome };

export type FacilitatorSettle = { readonly ok: true; readonly reference: string } | { readonly ok: false; readonly reason: string };
export type FacilitatorRefund = { readonly ok: true; readonly reference: string } | { readonly ok: false; readonly reason: string };
export type FacilitatorLookup =
  | { readonly status: 'settled'; readonly reference: string }
  | { readonly status: 'refunded'; readonly reference: string }
  | { readonly status: 'none' };

/** A buyer's wallet in the reference: holds a balance and signs tickets. */
export type Wallet = {
  readonly payer: string;
  balance(): bigint;
  /** Sign a ticket for what a 402 offered. `nonce` defaults to a fresh one; pass it to re-sign deliberately. */
  sign(offer: SparseAccepts, options?: { readonly nonce?: string }): Promise<Ticket>;
};

/** The `accepts` block a sparse 402 carries. */
export type SparseAccepts = {
  readonly ticket: string;
  readonly price: string;
  readonly threshold: string;
  readonly commitment: string;
  readonly challengeId: string;
  readonly facilitator: string;
  readonly to: string;
  readonly validAfter: number;
  readonly quote: string;
  readonly header: string;
};

export type MemoryFacilitatorOptions = {
  readonly address?: string;
  /** Source of secrets. Defaults to `crypto.randomUUID()`; inject a seeded generator for deterministic tests. */
  readonly random?: () => string;
};

export type MemoryFacilitator = Facilitator & {
  /** Create a buyer with a balance in micro-units. */
  wallet(payer: string, balanceMicros: bigint): Wallet;
  /** On-chain transfers performed (winners settled). */
  transfers(): number;
  /** Micro-units moved to payees, in order. */
  settled(): readonly bigint[];
  /** Selective abort (§7): on the next *losing* verify, answer "verification failed" without revealing the secret. */
  abortNextLosingVerify(): void;
  /** The next settle moves the money but the response is lost. */
  loseNextSettleResponse(): void;
  /** The next settle fails before moving money. */
  failNextSettle(): void;
};

type Commitment = { readonly secret: string; readonly commitment: string; consumedDigest: string | null };
type Known = { readonly ticket: Ticket; readonly outcome: Outcome; settlement: { reference: string; amount: bigint } | null; refund: string | null };

/**
 * An in-memory facilitator: commit–reveal, signature checks (an HMAC-style stand-in for ecrecover), threshold
 * recomputation, balance checks, idempotent settlement, and the faults a rail must survive.
 */
export function memoryFacilitator(options: MemoryFacilitatorOptions = {}): MemoryFacilitator {
  const address = options.address ?? '0xfacilitator';
  const random = options.random ?? (() => crypto.randomUUID());
  const commitments = new Map<string, Commitment>();
  const known = new Map<string, Known>();
  const balances = new Map<string, bigint>();
  const keys = new Map<string, string>();
  const settledByKey = new Map<string, string>();
  const refundedByKey = new Map<string, string>();
  const moved: bigint[] = [];
  let transfers = 0;
  let sequence = 0;
  let fault: 'abort-losing-verify' | 'lose-settle-response' | 'fail-settle' | undefined;

  const signatureOf = (payer: string, digest: string) => sha256Hex('sign', keys.get(payer) ?? '', digest);

  return {
    address,

    async commit({ challengeId }) {
      const existing = commitments.get(challengeId);
      if (existing !== undefined) return { commitment: existing.commitment };
      const secret = random();
      const commitment = await commitmentOf(secret);
      commitments.set(challengeId, { secret, commitment, consumedDigest: null });
      return { commitment };
    },

    async verify({ ticket }) {
      const entry = commitments.get(ticket.challengeId);
      if (entry === undefined) return { ok: false, reason: 'challenge_unknown' };
      if (entry.commitment !== ticket.commitment) return { ok: false, reason: 'commitment_mismatch' };
      if (ticket.facilitator !== address) return { ok: false, reason: 'facilitator_mismatch' };
      if (thresholdFor(BigInt(ticket.price), BigInt(ticket.ticket)).toString() !== ticket.threshold) return { ok: false, reason: 'threshold_mismatch' };
      if ((await digestOf(digestFieldsOf(ticket))) !== ticket.digest) return { ok: false, reason: 'digest_mismatch' };
      if (!keys.has(ticket.payer) || (await signatureOf(ticket.payer, ticket.digest)) !== ticket.signature) return { ok: false, reason: 'signature_invalid' };
      // One purchase, one roll: a second *different* ticket for the same challenge is refused; the same ticket again is answered identically.
      if (entry.consumedDigest !== null && entry.consumedDigest !== ticket.digest) return { ok: false, reason: 'challenge_consumed' };
      if ((balances.get(ticket.payer) ?? 0n) < BigInt(ticket.ticket)) return { ok: false, reason: 'insufficient_balance' };

      const outcome = await outcomeOf(ticket.digest, entry.secret, BigInt(ticket.threshold));
      if (fault === 'abort-losing-verify' && outcome === 'lose') {
        fault = undefined;
        return { ok: false, reason: 'verification_failed' };
      }
      entry.consumedDigest = ticket.digest;
      if (!known.has(ticket.digest)) known.set(ticket.digest, { ticket, outcome, settlement: null, refund: null });
      return { ok: true, ticketId: ticket.digest, secret: entry.secret, outcome };
    },

    async settle({ ticketId, priceMicros, key }) {
      const done = settledByKey.get(key);
      if (done !== undefined) return { ok: true, reference: done };
      const entry = known.get(ticketId);
      if (entry === undefined) return { ok: false, reason: 'ticket_unknown' };
      const secret = commitments.get(entry.ticket.challengeId)?.secret ?? '';
      // Settle-time verification against the *final* price: odds may only go down from what was signed.
      const finalThreshold = thresholdFor(priceMicros, BigInt(entry.ticket.ticket));
      if (finalThreshold > BigInt(entry.ticket.threshold)) return { ok: false, reason: 'price_above_signed' };
      if ((await outcomeOf(ticketId, secret, finalThreshold)) !== 'win') return { ok: false, reason: 'not_a_winner' };
      const current = fault;
      if (current === 'fail-settle') {
        fault = undefined;
        return { ok: false, reason: 'unavailable' };
      }
      const amount = BigInt(entry.ticket.ticket);
      const balance = balances.get(entry.ticket.payer) ?? 0n;
      if (balance < amount) return { ok: false, reason: 'insufficient_balance' };
      balances.set(entry.ticket.payer, balance - amount);
      const reference = `tx_${String((sequence += 1))}`;
      entry.settlement = { reference, amount };
      settledByKey.set(key, reference);
      moved.push(amount);
      transfers += 1;
      if (current === 'lose-settle-response') {
        fault = undefined;
        throw new TypeError('fetch failed: socket hang up');
      }
      return { ok: true, reference };
    },

    refund({ ticketId, key }) {
      const done = refundedByKey.get(key);
      if (done !== undefined) return Promise.resolve({ ok: true, reference: done });
      const entry = known.get(ticketId);
      if (entry?.settlement === null || entry === undefined) return Promise.resolve({ ok: false, reason: 'nothing_settled' });
      balances.set(entry.ticket.payer, (balances.get(entry.ticket.payer) ?? 0n) + entry.settlement.amount);
      const reference = `refund_${String((sequence += 1))}`;
      entry.refund = reference;
      refundedByKey.set(key, reference);
      return Promise.resolve({ ok: true, reference });
    },

    lookup({ ticketId }) {
      const entry = known.get(ticketId);
      if (entry === undefined) return Promise.resolve({ status: 'none' });
      if (entry.refund !== null) return Promise.resolve({ status: 'refunded', reference: entry.refund });
      if (entry.settlement !== null) return Promise.resolve({ status: 'settled', reference: entry.settlement.reference });
      return Promise.resolve({ status: 'none' });
    },

    wallet(payer, balanceMicros) {
      keys.set(payer, `key_${payer}_${random()}`);
      balances.set(payer, balanceMicros);
      return {
        payer,
        balance: () => balances.get(payer) ?? 0n,
        async sign(offer, signOptions = {}) {
          const fields: DigestFields = {
            to: offer.to,
            facilitator: offer.facilitator,
            price: offer.price,
            ticket: offer.ticket,
            threshold: offer.threshold,
            commitment: offer.commitment,
            challengeId: offer.challengeId,
            validAfter: offer.validAfter,
            quote: offer.quote,
            payer,
            nonce: signOptions.nonce ?? random(),
          };
          const digest = await digestOf(fields);
          return { ...fields, digest, signature: await signatureOf(payer, digest) };
        },
      };
    },

    transfers: () => transfers,
    settled: () => [...moved],
    abortNextLosingVerify: () => {
      fault = 'abort-losing-verify';
    },
    loseNextSettleResponse: () => {
      fault = 'lose-settle-response';
    },
    failNextSettle: () => {
      fault = 'fail-settle';
    },
  };
}
