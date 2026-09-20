/**
 * Who decides what a piece of work was worth.
 *
 * The route authorizes an upper bound and settles what the work turned out to be worth, so
 * something has to put a number on "how much work was that". Counting tokens cannot: two answers
 * of the same length can be a lookup and a week of reading. A judge reads the work and picks a
 * tier.
 *
 * The seller's judge decides whether the seller gets paid, which is a conflict of interest. Three
 * things keep it honest, and they are requirements, not decoration:
 *
 *   1. Low confidence charges the lowest tier. Doubt costs the seller, never the buyer.
 *   2. A question that was not answered is not charged at all.
 *   3. The buyer is told which tier, why, and who judged it, in the response.
 */

export type Work = {
  readonly question: string;
  readonly answer: string;
  readonly sources: number;
  readonly charactersWritten: number;
  readonly millisecondsSpent: number;
};

export type Verdict = {
  /** `false` releases the charge: the caller is told, and pays nothing. */
  readonly answered: boolean;
  readonly tier: Tier['label'];
  readonly amount: string;
  /** 0–1. Below `CONFIDENCE_FLOOR` the lowest tier is charged. */
  readonly confidence: number;
  readonly reason: string;
  /** What judged it: a model version, or `rules`. Goes in the response and the log. */
  readonly judgedBy: string;
};

export type Judge = (work: Work) => Promise<Verdict>;

export type Tier = { readonly level: 0 | 1 | 2; readonly label: 'lookup' | 'synthesis' | 'investigation'; readonly amount: string };

/** The cap the caller authorizes. Nothing here can settle above it — the gate refuses that. */
export const CAP = '$0.05';

export const TIERS: readonly Tier[] = [
  { level: 0, label: 'lookup', amount: '$0.01' },
  { level: 1, label: 'synthesis', amount: '$0.02' },
  { level: 2, label: 'investigation', amount: '$0.04' },
];

export const CONFIDENCE_FLOOR = 0.6;
/** Below this, the work did not answer the question and nothing is charged. */
export const ANSWERED_FLOOR = 0.5;

const LOWEST: Tier = { level: 0, label: 'lookup', amount: '$0.01' };

export function tierOf(level: number): Tier {
  const clamped = Math.min(TIERS.length - 1, Math.max(0, Math.round(level)));
  return TIERS[clamped] ?? LOWEST;
}

/**
 * The judge that needs no key, no network, and no vendor: thresholds on what the handler measured.
 *
 * It is the floor this example is honest about. It cannot tell a thorough answer from a padded one,
 * which is the whole reason the other judge exists.
 */
export const ruleJudge: Judge = (work) => {
  const answered = work.answer.length > 0 && work.sources > 0;
  const level = work.sources >= 3 ? 2 : work.sources === 2 ? 1 : 0;
  const tier = tierOf(level);
  return Promise.resolve({
    answered,
    tier: tier.label,
    amount: tier.amount,
    confidence: 1,
    reason: answered
      ? `${String(work.sources)} source${work.sources === 1 ? '' : 's'} read, ${String(work.charactersWritten)} characters written`
      : 'nothing was found for this question',
    judgedBy: 'rules',
  });
};
