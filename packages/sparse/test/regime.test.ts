import { describe, expect, it } from 'vitest';
import { selectRegime } from '../src/index';

describe('selectRegime — the deployable two-threshold rule (paper §6)', () => {
  it('routes recurring payers to a pre-funded scheme', () => {
    // 132,437 calls from 2,479 payers: 53 calls per payer.
    expect(selectRegime({ calls: 132_437, payers: 2_479, price: '$0.02' })).toMatchObject({ regime: 'channel' });
    expect(selectRegime({ calls: 20, payers: 2, price: '$0.001' })).toMatchObject({ regime: 'channel' });
  });

  it('offers a sparse ticket to many one-shot payers at volume, bounded by variance and the client cap', () => {
    // 1,202 calls from 952 payers at $0.001: p·n/k = $0.048 → $0.01 denomination → 10× the price.
    const choice = selectRegime({ calls: 1_202, payers: 952, price: '$0.001' });
    expect(choice).toMatchObject({ regime: 'sparse', ticket: { micros: 10_000n }, odds: 0.1 });

    // A big enough resource is capped by the client, not by variance: p·n/k = $4 but the cap is $1.
    const capped = selectRegime({ calls: 10_000, payers: 5_000, price: '$0.01' });
    expect(capped).toMatchObject({ regime: 'sparse', ticket: { micros: 1_000_000n }, odds: 0.01 });

    // The agent-wallet documentation's $0.05 cap shrinks the ticket.
    expect(selectRegime({ calls: 10_000, payers: 5_000, price: '$0.001', clientCap: '$0.05' })).toMatchObject({ regime: 'sparse', ticket: { micros: 10_000n } });
  });

  it('falls back to deterministic settlement below the volume or payer floor, or when no ticket clears 10× the price', () => {
    // The median resource: 2 calls, 1 payer.
    expect(selectRegime({ calls: 2, payers: 1, price: '$0.01' })).toMatchObject({ regime: 'deterministic' });
    // Many payers, but p·n/k = $0.004 at $0.001 × 100 / 25: no denomination reaches 10× the price.
    expect(selectRegime({ calls: 100, payers: 100, price: '$0.001' })).toMatchObject({ regime: 'deterministic' });
    // A cent-priced route at the $0.05 cap: the cap is only 5× the price.
    expect(selectRegime({ calls: 10_000, payers: 5_000, price: '$0.01', clientCap: '$0.05' })).toMatchObject({ regime: 'deterministic' });
  });

  it('tighter merchant tolerance shrinks the ticket, and past a point removes it', () => {
    // p·n/k at $0.005 × 2,000: k = 10 → $1; k = 100 → $0.10; k = 400 → $0.025 → $0.01, only 2× the price.
    expect(selectRegime({ calls: 2_000, payers: 1_500, price: '$0.005', k: 10 })).toMatchObject({ regime: 'sparse', ticket: { micros: 1_000_000n } });
    expect(selectRegime({ calls: 2_000, payers: 1_500, price: '$0.005', k: 100 })).toMatchObject({ regime: 'sparse', ticket: { micros: 100_000n } });
    expect(selectRegime({ calls: 2_000, payers: 1_500, price: '$0.005', k: 400 })).toMatchObject({ regime: 'deterministic' });
  });
});
