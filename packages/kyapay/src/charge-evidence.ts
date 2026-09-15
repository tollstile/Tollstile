import type { Authorization, Charge } from 'tollstile';
import type { SkyfireCharge } from './skyfire-api';

/**
 * What Skyfire's charge list proves about one Tollstile charge.
 *
 * - `charged`: the charge reached Skyfire.
 * - `absent`: it did not.
 * - `undetermined`: the list is consistent with both.
 * - `lagging`: Skyfire lists less than the ledger already recorded as settled, so the list is behind.
 * - `inconsistent`: the list is consistent with neither, so something outside this ledger charged the token.
 */
export type ChargeEvidence =
  | { readonly status: 'charged'; readonly chargedMicros: bigint; readonly recordedMicros: bigint }
  | { readonly status: 'absent' }
  | { readonly status: 'undetermined' | 'lagging' | 'inconsistent'; readonly detail: string };

/** `chargedAt` values may be truncated to whole seconds. */
const CHARGED_AT_PRECISION_MS = 1_000;

/**
 * Skyfire returns no charge id and accepts no idempotency key, so a Tollstile charge is never matched
 * to a Skyfire record by amount or time alone: two charges of the same amount on one token are
 * indistinguishable. Instead, both hypotheses are tested against the ledger's accounting for the token.
 *
 *   excess = Skyfire total − ledger `consumed` (charges recorded as settled)
 *   others = ledger `reserved` − this charge's reservation (the most every other in-flight charge could add)
 *
 * - "charged" is possible when excess − amount lies within [0, others] and some record was charged
 *   after this charge was created (less clock skew).
 * - "absent" is possible when excess lies within [0, others].
 *
 * Exactly one possible hypothesis is proven; both possible is `undetermined`; neither is `inconsistent`.
 *
 * The reasoning holds only if this ledger is the only party charging the token with the seller's API
 * key, if the list reflects every accepted charge, and if clocks agree within `clockSkewMs`.
 */
export function weighChargeEvidence(input: {
  readonly charges: readonly SkyfireCharge[];
  readonly authorization: Authorization;
  readonly charge: Charge;
  readonly clockSkewMs: number;
}): ChargeEvidence {
  const { charges, authorization, charge } = input;
  const chargedMicros = charges.reduce((sum, record) => sum + record.value.micros, 0n);
  const recordedMicros = authorization.consumed.micros;
  const excess = chargedMicros - recordedMicros;
  const others = authorization.reserved.micros - charge.reservedAmount.micros;
  const earliest = charge.createdAt.getTime() - input.clockSkewMs - CHARGED_AT_PRECISION_MS;
  const chargedSinceCreated = charges.some((record) => record.chargedAt.getTime() >= earliest);

  if (others < 0n) {
    return { status: 'inconsistent', detail: `the authorization does not hold the reservation of charge ${charge.id}` };
  }
  if (excess < 0n) {
    return { status: 'lagging', detail: 'Skyfire lists less than the ledger recorded as settled' };
  }

  const remainder = excess - charge.amount.micros;
  const couldBeCharged = chargedSinceCreated && remainder >= 0n && remainder <= others;
  const couldBeAbsent = excess <= others;

  if (couldBeCharged && couldBeAbsent) {
    return { status: 'undetermined', detail: 'other in-flight charges on the token could account for what Skyfire lists' };
  }
  if (couldBeCharged) return { status: 'charged', chargedMicros, recordedMicros };
  if (couldBeAbsent) return { status: 'absent' };
  return { status: 'inconsistent', detail: 'Skyfire lists charges the ledger cannot account for' };
}
