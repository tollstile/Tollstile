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

describe('SAM as the proposer', () => {
  it('turns centre-based fractions into pixel boxes, and keeps its score for the record only', async () => {
    const { segment } = await import('../src/sam');
    const photo = '/Users/yoshida/.claude/uploads/b4507ce0-1457-4767-a9d5-0820d398a1a6/9f5ae28c-image.jpg';
    let sent: Record<string, unknown> = {};

    const result = await segment(photo, 'a car', {
      apiKey: 'key-from-the-environment',
      fetch: (_url, init) => {
        sent = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
        return Promise.resolve(Response.json({ boxes: [[0.5, 0.5, 0.25, 0.2]], scores: [0.96] }));
      },
    });

    expect(sent['prompt']).toBe('a car');
    expect(String(sent['image_url'])).toMatch(/^data:image\/jpeg;base64,/);
    expect(result.detections).toHaveLength(1);
    const box = result.detections[0]?.box;
    expect(box?.width).toBe(Math.round(result.photo.width * 0.25));
    expect(box?.x).toBe(Math.round(result.photo.width * 0.5 - (result.photo.width * 0.25) / 2));
    expect(result.detections[0]?.confidence).toBe(0.96);
  });
});

describe('the two-stage second opinion', () => {
  it('asks what the crop shows, then whether that is the concept, and bills on the second answer', async () => {
    const { secondOpinion } = await import('../src/second-opinion');
    const { load } = await import('../src/photo');
    const photo = load('/Users/yoshida/.claude/uploads/b4507ce0-1457-4767-a9d5-0820d398a1a6/9f5ae28c-image.jpg');
    const seen: string[] = [];

    const verdicts = await secondOpinion({
      apiKey: 'key',
      spacingMs: 0,
      fetch: (url) => {
        const address = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
        seen.push(address);
        return Promise.resolve(
          address.endsWith('/v1/chat/completions')
            ? Response.json({ choices: [{ message: { content: 'A dark gray SUV parked beside a silver car.' } }] })
            : Response.json({ model: 'typesafe-ai/jev', answers: { matches: { noul: 0.97 } } }),
        );
      },
    })(photo, 'a car', [{ box: { x: 430, y: 550, width: 230, height: 90 }, confidence: 0.96, pixels: 20_700 }]);

    expect(seen).toEqual(['https://ai-gateway.vercel.sh/v1/chat/completions', 'https://ai-gateway.vercel.sh/typesafe/v1/systemone']);
    expect(verdicts[0]).toMatchObject({ probability: 0.97, verifiedBy: 'typesafe-ai/jev', description: 'A dark gray SUV parked beside a silver car.' });
  });

  it('scores a crop it could not describe as zero', async () => {
    const { secondOpinion } = await import('../src/second-opinion');
    const { load } = await import('../src/photo');
    const photo = load('/Users/yoshida/.claude/uploads/b4507ce0-1457-4767-a9d5-0820d398a1a6/9f5ae28c-image.jpg');

    const verdicts = await secondOpinion({ apiKey: 'key', spacingMs: 0, fetch: () => Promise.resolve(new Response('no', { status: 500 })) })(photo, 'a car', [
      { box: { x: 430, y: 550, width: 230, height: 90 }, confidence: 0.96, pixels: 20_700 },
    ]);

    expect(verdicts[0]).toMatchObject({ probability: 0, verifiedBy: 'unavailable' });
  });
});
