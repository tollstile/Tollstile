import { TollstileError } from '../../core/errors';
import { compare, formatMoney, parseMoney } from '../../core/money';
import type { AuthorizationKind, Context, Rail } from '../../core/types';

export type Simulation = {
  /** `paid`: the payment moves during verification, like a transfer the payer pushed on-chain. */
  readonly verify?: 'ok' | 'unavailable' | 'paid';
  readonly challenge?: 'ok' | 'unavailable';
  readonly settle?: 'ok' | 'reject' | 'timeout-before-effect' | 'timeout-after-effect';
  readonly refund?: 'ok' | 'reject' | 'timeout-after-effect';
  readonly lookup?: 'ok' | 'unavailable';
};

export type TestRailOptions = {
  /** `single` behaves like x402 or an MPP charge; `reusable` like an L402 credential or a KYAPay token. */
  readonly authorization?: AuthorizationKind;
  /** Set to `false` to behave like a rail that cannot refund, e.g. x402 `exact`. Defaults to `true`. */
  readonly refund?: boolean;
};

/** `signature` stands in for payer evidence a real rail must keep until the charge is final, then drop. */
export type TestData = { readonly proofId: string; readonly payer: string; readonly signature?: string };

export type TestRail = Rail<'test', TestData> & {
  /** Changes how the fake provider behaves for subsequent calls. */
  simulate(simulation: Simulation): void;
  /** Economic effects the fake provider performed. */
  readonly effects: {
    readonly settlements: number;
    readonly refunds: number;
    readonly releases: number;
    /** Settled amounts in micro-units, in order. */
    readonly settled: readonly bigint[];
  };
};

/** HTTP header, or MCP `_meta` key, carrying a test payment. */
export const TEST_PAYMENT_HEADER = 'payment';
export const TEST_PAYMENT_META = 'tollstile/test-payment';
export const TEST_RECEIPT_META = 'tollstile/test-receipt';

/**
 * A rail with a fake provider, for local development and tests. Send `Payment: test` to pay.
 *
 * Parameters: `Payment: test quote=<token> proof=<id> payer=<id> amount=$0.01 limit=$1.00`.
 * `quote` pins the price you were offered. Without `proof`, every request is a fresh payment.
 * `limit` sets the capacity of a reusable authorization. Over MCP, send the same string in
 * `_meta["tollstile/test-payment"]`.
 */
export function testRail(options: TestRailOptions = {}): TestRail {
  let simulation: Simulation = {};
  const settledCharges = new Map<string, { reference: string; micros: bigint }>();
  const refundedCharges = new Map<string, string>();
  const effects = { settlements: 0, refunds: 0, releases: 0, settled: [] as bigint[] };
  const kind = options.authorization ?? 'single';
  const refund = options.refund ?? true;

  return {
    name: 'test',
    livemode: false,
    capabilities: {
      flows: refund ? ['authorization', 'upfront'] : ['authorization'],
      authorization: kind,
      variableAmount: true,
      quotes: true,
      refund,
      partialRefund: refund,
      lookup: true,
    },
    effects,

    simulate(next) {
      simulation = next;
    },

    offer({ price }) {
      return Promise.resolve({
        rail: 'test',
        asset: { code: price.currency, network: null, scale: 6 },
        amount: price.micros.toString(),
        basis: 'par',
        details: {},
      });
    },

    challenge(quote, token, offer) {
      if (simulation.challenge === 'unavailable') return Promise.reject(unavailable('challenge'));
      const value = `test quote=${token}`;
      return Promise.resolve({
        headers: [],
        accepts: { header: TEST_PAYMENT_HEADER, value, price: formatMoney(quote.price), flow: offer.flow },
        mcp: { style: 'tollstile', meta: TEST_PAYMENT_META, value, price: formatMoney(quote.price) },
      });
    },

    async verify(context, terms) {
      if (simulation.verify === 'unavailable') throw unavailable('verify');

      const proof = readProof(context);
      if (proof === undefined || !(proof === 'test' || proof.startsWith('test '))) return { status: 'absent' };
      const parameters = parseParameters(proof);

      const token = parameters.get('quote');
      const quote = token === undefined ? null : await terms.openQuote(token);
      if (quote === undefined) return { status: 'invalid', reason: 'quote_invalid' };

      const price = quote?.price ?? terms.price;
      const amount = parameters.get('amount');
      if (amount !== undefined && price !== null && compare(parseMoney(amount), price) !== 0) {
        return { status: 'invalid', reason: 'amount_mismatch' };
      }

      const limit = parameters.get('limit');
      const proofId = parameters.get('proof') ?? context.requestId;
      const payer = parameters.get('payer') ?? 'test-payer';
      const signature = parameters.get('signature');
      const verified = {
        status: 'valid',
        proofId,
        payer,
        quote,
        limit: limit === undefined ? price : parseMoney(limit),
        expiresAt: null,
        data: signature === undefined ? { proofId, payer } : { proofId, payer, signature },
      } as const;
      if (simulation.verify !== 'paid' || price === null) return verified;

      effects.settlements += 1;
      effects.settled.push(price.micros);
      return { ...verified, settled: { reference: `test_push_${proofId}`, details: {} } };
    },

    settle(_authorization, charge) {
      const existing = settledCharges.get(charge.id);
      if (existing !== undefined) return Promise.resolve(settled(existing));

      const mode = simulation.settle ?? 'ok';
      if (mode === 'reject') return Promise.resolve({ status: 'rejected', reason: 'simulated_rejection' });
      if (mode === 'timeout-before-effect') return Promise.reject(timeout('settle'));

      const record = { reference: `test_settlement_${charge.id}`, micros: charge.amount.micros };
      settledCharges.set(charge.id, record);
      effects.settlements += 1;
      effects.settled.push(charge.amount.micros);
      return mode === 'timeout-after-effect' ? Promise.reject(timeout('settle')) : Promise.resolve(settled(record));
    },

    refund(_authorization, charge) {
      const existing = refundedCharges.get(charge.id);
      if (existing !== undefined) return Promise.resolve({ status: 'refunded', reference: existing });
      if (simulation.refund === 'reject') return Promise.resolve({ status: 'rejected', reason: 'simulated_rejection' });

      const reference = `test_refund_${charge.id}`;
      refundedCharges.set(charge.id, reference);
      effects.refunds += 1;
      return simulation.refund === 'timeout-after-effect'
        ? Promise.reject(timeout('refund'))
        : Promise.resolve({ status: 'refunded', reference });
    },

    release() {
      effects.releases += 1;
      return Promise.resolve();
    },

    lookup(_authorization, charge) {
      if (simulation.lookup === 'unavailable') return Promise.reject(unavailable('lookup'));
      const refund = refundedCharges.get(charge.id);
      if (refund !== undefined) return Promise.resolve({ status: 'refunded', reference: refund });
      const settlement = settledCharges.get(charge.id);
      return Promise.resolve(settlement === undefined ? { status: 'none' } : settled(settlement));
    },

    redact({ proofId, payer }) {
      return { proofId, payer };
    },

    receipt(_authorization, charge, context) {
      const reference = charge.settlement?.reference ?? charge.id;
      return context.transport === 'mcp'
        ? { headers: [], meta: { [TEST_RECEIPT_META]: reference } }
        : { headers: [['payment-receipt', reference]], meta: {} };
    },
  };
}

function readProof(context: Context): string | undefined {
  if (context.transport === 'http') return context.request?.headers.get(TEST_PAYMENT_HEADER)?.trim();
  const value = context.mcp?.meta[TEST_PAYMENT_META];
  return typeof value === 'string' ? value.trim() : undefined;
}

function parseParameters(proof: string): Map<string, string> {
  return new Map(
    proof
      .slice('test'.length)
      .trim()
      .split(/\s+/)
      .filter((part) => part.includes('='))
      .map((part) => [part.slice(0, part.indexOf('=')), part.slice(part.indexOf('=') + 1)] as const),
  );
}

function settled(record: { readonly reference: string; readonly micros: bigint }) {
  return { status: 'settled', reference: record.reference, details: { micros: record.micros.toString() } } as const;
}

function timeout(operation: string): TollstileError {
  return new TollstileError('PROVIDER_TIMEOUT', `Test rail simulated a timeout during ${operation}.`);
}

function unavailable(operation: string): TollstileError {
  return new TollstileError('PROVIDER_UNAVAILABLE', `Test rail simulated an outage during ${operation}.`);
}

