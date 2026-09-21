import { parseMoney, type Money } from 'tollstile';

export type Regime = 'channel' | 'sparse' | 'deterministic';

export type RegimeInput = {
  /** Calls to the resource in the accounting period. */
  readonly calls: number;
  /** Distinct payers in the same period. */
  readonly payers: number;
  readonly price: Money | string;
  /** The largest single authorization the buyer's client will sign. Default `"$1"` (x402 reference client default). */
  readonly clientCap?: Money | string;
  /** Expected wins per period the merchant will tolerate; σ ≈ 1/√k. Default 25 (σ ≈ 20%). */
  readonly k?: number;
  /** Mean calls per payer above which a buyer is worth a channel or gateway balance. Default 2. */
  readonly repeatAbove?: number;
  /** Fewest distinct payers before a sparse offer is worth making. Default 100. */
  readonly minPayers?: number;
};

export type RegimeChoice = {
  readonly regime: Regime;
  readonly reason: string;
  /** For `sparse`: the largest ticket that satisfies merchant variance and the client cap. */
  readonly ticket?: Money;
  /** For `sparse`: settlements per call, i.e. `price / ticket`. */
  readonly odds?: number;
};

const money = (value: Money | string): Money => (typeof value === 'string' ? parseMoney(value) : value);

/** Round a ticket down to a denomination a wallet presents sensibly: $0.01, $0.10, $1, $10, … */
function denominate(micros: bigint): bigint {
  let step = 10_000n; // $0.01
  while (step * 10n <= micros) step *= 10n;
  return micros < 10_000n ? 0n : step;
}

/**
 * The deployable two-threshold rule of the paper (§6): recurring payers → a pre-funded scheme; many one-shot payers at
 * volume → a sparse ticket bounded by merchant variance and the client cap; otherwise deterministic settlement. The
 * merchant runtime feeds it what its own ledger knows; nothing here needs the protocol.
 */
export function selectRegime(input: RegimeInput): RegimeChoice {
  const price = money(input.price);
  const cap = money(input.clientCap ?? '$1');
  const k = input.k ?? 25;
  const repeatAbove = input.repeatAbove ?? 2;
  const minPayers = input.minPayers ?? 100;
  const payers = Math.max(1, input.payers);

  if (input.calls / payers > repeatAbove) return { regime: 'channel', reason: `mean recurrence ${(input.calls / payers).toFixed(1)} calls per payer exceeds ${String(repeatAbove)}` };
  if (payers < minPayers) return { regime: 'deterministic', reason: `${String(payers)} distinct payers is below ${String(minPayers)}` };

  // T = min(p·n/k, T_client); a ticket must clear the price by 10× to be worth the variance.
  const byVariance = (price.micros * BigInt(input.calls)) / BigInt(k);
  const bound = byVariance < cap.micros ? byVariance : cap.micros;
  const ticket = denominate(bound);
  if (ticket < price.micros * 10n) return { regime: 'deterministic', reason: `no ticket reaches 10× the price within k = ${String(k)} and cap ${cap.micros.toString()}µ` };

  return {
    regime: 'sparse',
    reason: `${String(payers)} payers, ${String(input.calls)} calls: T = min(p·n/k, cap) = ${ticket.toString()}µ`,
    ticket: { currency: price.currency, micros: ticket },
    odds: Number((price.micros * 1_000_000n) / ticket) / 1_000_000,
  };
}
