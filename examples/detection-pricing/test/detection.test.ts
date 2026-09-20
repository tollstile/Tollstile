import { describe, expect, it } from 'vitest';
import { createApp, ruleVerifier, TRUTH } from '../src/app';
import { detect } from '../src/detect';
import { render, SCENE } from '../src/scene';
import { KEEP, modelVerifier, type Verifier } from '../src/verify';

const ask = async (app: ReturnType<typeof createApp>, target = 'a solar panel') => {
  const body = JSON.stringify({ target });
  const headers = { 'content-type': 'application/json' };
  const unpaid = await app.request('/detect', { method: 'POST', headers, body });
  const challenge = (await unpaid.json()) as { quote: string; price: string };
  const paid = await app.request('/detect', { method: 'POST', headers: { ...headers, payment: `test quote=${challenge.quote}` }, body });
  return { challenge, paid, result: (await paid.json()) as Result };
};

type Result = { proposed: number; verified: number; charged: string; authorized?: string; detections: { verifierSaid: number; charged: boolean }[] };

/** A verifier that answers from a list, so the route can be tested without a model. */
const answers = (probabilities: readonly number[]): Verifier => (_image, _target, detections) =>
  Promise.resolve(detections.map((detection, index) => ({ detection, probability: probabilities[index] ?? 0, verifiedBy: 'fixture' })));

describe('the detector, before anyone is charged', () => {
  it('finds the panels and the skylights, because they look alike', () => {
    const proposed = detect(render());
    expect(proposed).toHaveLength(SCENE.filter((thing) => thing.kind !== 'pool').length);
    expect(proposed.length).toBeGreaterThan(TRUTH);
    // Its own confidence is high for things that are not panels, which is the whole problem.
    expect(Math.min(...proposed.map((one) => one.confidence))).toBeGreaterThan(0.6);
  });
});

describe('a route that charges for what survived a second opinion', () => {
  it('charges per verified detection, not per proposal', async () => {
    const app = createApp({ verifier: ruleVerifier, log: () => {} });
    const { challenge, paid, result } = await ask(app);

    expect(challenge.price).toBe('$0.20');
    expect(result.proposed).toBe(6);
    expect(result.verified).toBe(TRUTH);
    expect(result.charged).toBe('$0.04');
    expect(paid.headers.get('payment-receipt')).toMatch(/^test_settlement_/);
  });

  it('charges nothing, and releases the hold, when nothing survives', async () => {
    const app = createApp({ verifier: answers([0.2, 0.1, 0.3, 0.2, 0.1, 0.0]), log: () => {} });
    const { paid, result } = await ask(app, 'a helipad');

    expect(paid.status).toBe(422);
    expect(paid.headers.get('payment-receipt')).toBeNull();
    expect(result).toMatchObject({ verified: 0, charged: '$0.00' });
  });

  it('bills the buyer on the verifier, never on the detector', async () => {
    const app = createApp({ verifier: answers([0.95, 0.95, 0.4, 0.4, 0.4, 0.4]), log: () => {} });
    const { result } = await ask(app);

    expect(result.verified).toBe(2);
    expect(result.charged).toBe('$0.02');
    expect(result.detections.filter((one) => one.charged).every((one) => one.verifierSaid >= KEEP)).toBe(true);
  });

  it('keeps the image and its crops out of the billing log', async () => {
    const lines: string[] = [];
    const app = createApp({ verifier: ruleVerifier, log: (entry) => lines.push(entry) });
    await ask(app);

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/data:image|base64|iVBOR/);
    expect(lines[0]).toMatch(/^charge=chg_\w+ target="a solar panel" proposed=6 verified=4 threshold=0\.7 probabilities=[\d.,]+ charged=\$0\.04 verifier=rules$/);
  });
});

describe('the model verifier', () => {
  it('reads the probability out of the token distribution, not out of the prose', async () => {
    const verifier = modelVerifier('vck_test', (_url, init) => {
      expect(typeof init?.body === 'string' ? init.body : '').toContain('data:image/png;base64,');
      return Promise.resolve(
        Response.json({
          model: 'openai/gpt-4o-mini',
          choices: [{ logprobs: { content: [{ top_logprobs: [{ token: 'yes', logprob: Math.log(0.8) }, { token: 'no', logprob: Math.log(0.2) }] }] } }],
        }),
      );
    });

    const verdicts = await verifier(render(), 'a solar panel', detect(render()).slice(0, 1));
    expect(verdicts[0]?.probability).toBeCloseTo(0.8, 5);
    expect(verdicts[0]?.verifiedBy).toBe('openai/gpt-4o-mini');
  });

  it('charges nothing for a detection it could not check', async () => {
    const verifier = modelVerifier('vck_test', () => Promise.resolve(new Response('nope', { status: 503 })));
    const verdicts = await verifier(render(), 'a solar panel', detect(render()).slice(0, 2));

    expect(verdicts.map((verdict) => verdict.probability)).toEqual([0, 0]);
    expect(verdicts[0]?.verifiedBy).toContain('503');
  });

  it('falls back to the rules without a key', async () => {
    const verdicts = await modelVerifier(undefined)(render(), 'a solar panel', detect(render()));
    expect(verdicts.every((verdict) => verdict.verifiedBy === 'rules')).toBe(true);
  });
});
