import { createTollstile, memoryLedger } from 'tollstile';
import { httpContext } from 'tollstile/testing';
import { describe, expect, it } from 'vitest';
import { acmeProvider } from '../src/acme-provider';
import { ACME_TOKEN_HEADER, acmeRail } from '../src/acme-rail';

function setup() {
  const provider = acmeProvider();
  const toll = createTollstile({ rails: [acmeRail({ apiKey: 'sk_test_acme', fetch: provider.fetch })], ledger: memoryLedger() });
  const gate = toll.price('$0.25', { resource: 'GET /report' });
  const enter = (headers: Record<string, string> = {}) => gate.enter(httpContext(new Request('https://api.example.com/report', { headers })));
  return { provider, toll, gate, enter };
}

describe('acme rail', () => {
  it('challenges, verifies the authorized payment, and captures after the handler', async () => {
    const { provider, enter } = setup();
    const challenge = await enter();
    if (challenge.kind !== 'denied') throw new Error('expected a 402');
    const accepts = challenge.denial.offers[0]?.challenge.accepts as { amount: string; quote: string };
    expect(accepts.amount).toBe('250000');

    const { token } = provider.authorize({ payer: 'Agent-7', amount: accepts.amount, currency: 'USD', quote: accepts.quote });
    const paid = await enter({ [ACME_TOKEN_HEADER]: token });
    if (paid.kind !== 'admitted') throw new Error('expected admission');
    expect(paid.pass.payment).toMatchObject({ via: 'rail', rail: 'acme', payer: 'agent-7' });

    const completion = await paid.pass.complete('succeeded');
    expect(completion).toMatchObject({ settlement: 'settled', receipt: { headers: [['acme-receipt', 'cap_2']] } });
    expect(provider.captures()).toHaveLength(1);
  });

  it('refuses a payment authorized for less than the quoted price', async () => {
    const { provider, enter } = setup();
    const challenge = await enter();
    if (challenge.kind !== 'denied') throw new Error('expected a 402');
    const { quote } = challenge.denial.offers[0]?.challenge.accepts as { quote: string };

    const { token } = provider.authorize({ payer: 'agent-7', amount: '1', currency: 'USD', quote });
    expect(await enter({ [ACME_TOKEN_HEADER]: token })).toMatchObject({
      kind: 'denied',
      denial: { status: 402, error: { code: 'proof_invalid', detail: 'amount_mismatch' } },
    });
  });

  it('explains how it serves a route', () => {
    const { toll, gate } = setup();
    expect(toll.explain(gate)).toContain('acme: authorization flow, settles after handler, single authorization, fixed amounts, release on handler failure');
  });
});
