import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { jevJudge } from '../src/jev';
import { ruleJudge, type Judge } from '../src/judge';

const ask = async (app: ReturnType<typeof createApp>, question: string) => {
  const body = JSON.stringify({ question });
  const headers = { 'content-type': 'application/json' };
  const unpaid = await app.request('/research', { method: 'POST', headers, body });
  const challenge = (await unpaid.json()) as { quote: string; price: string };
  const paid = await app.request('/research', { method: 'POST', headers: { ...headers, payment: `test quote=${challenge.quote}` }, body });
  return { challenge, paid, result: (await paid.json()) as Result };
};

type Result = {
  answered: boolean;
  pricing: { charged: string; authorized: string; tier: string; judgedBy: string; confidence: number; reason: string };
};

/** A judge that says whatever the test needs, so the route can be tested without a vendor. */
const fixed = (verdict: Partial<Awaited<ReturnType<Judge>>>): Judge => async (work) => ({ ...(await ruleJudge(work)), ...verdict });

describe('a route that authorizes a ceiling and settles what the work was worth', () => {
  it('charges the lowest tier for a lookup and the highest for an investigation', async () => {
    const app = createApp({ judge: ruleJudge, log: () => {} });

    const lookup = await ask(app, 'What do anglers say about fishing the bay?');
    expect(lookup.challenge.price).toBe('$0.05');
    expect(lookup.result.pricing).toMatchObject({ charged: '$0.01', tier: 'lookup', authorized: '$0.05' });

    const investigation = await ask(app, 'Should I book the Oshima ferry in September, given tides, swell and refunds?');
    expect(investigation.challenge.price).toBe('$0.05');
    expect(investigation.result.pricing).toMatchObject({ charged: '$0.04', tier: 'investigation' });
    expect(investigation.paid.headers.get('payment-receipt')).toMatch(/^test_settlement_/);
  });

  it('charges nothing when the desk answered nothing, and says so', async () => {
    const lines: string[] = [];
    const app = createApp({ judge: ruleJudge, log: (line) => lines.push(line) });
    const { paid, result } = await ask(app, 'What is the capital of Mars?');

    expect(paid.status).toBe(422);
    expect(paid.headers.get('payment-receipt')).toBeNull();
    expect(result).toMatchObject({ answered: false, pricing: { charged: '$0.00' } });
    expect(lines.at(-1)).toContain('tier=none charged=$0.00');
  });

  it('tells the buyer which tier, who judged it, and why', async () => {
    const app = createApp({ judge: fixed({ judgedBy: 'jev-1.13.0', confidence: 0.81 }), log: () => {} });
    const { result } = await ask(app, 'When is the next ferry refund due?');

    expect(result.pricing.judgedBy).toBe('jev-1.13.0');
    expect(result.pricing.confidence).toBe(0.81);
    expect(result.pricing.reason).not.toBe('');
  });

  it('keeps the question and the answer out of the pricing log', async () => {
    const lines: string[] = [];
    const app = createApp({ judge: ruleJudge, log: (line) => lines.push(line) });
    await ask(app, 'When is the next ferry refund due?');

    // The unpaid attempt never reaches the handler, so one request is judged and logged once.
    expect(lines).toHaveLength(1);
    expect(lines.join('\n')).not.toMatch(/ferry|refund|jetfoil|swell|sailing/i);
    expect(lines.at(-1)).toMatch(/^charge=chg_\w+ sources=2 chars=\d+ ms=\d+ tier=synthesis charged=\$0\.02 confidence=1\.00 judge=rules$/);
  });
});

describe('the Jev judge', () => {
  const work = { question: 'q', answer: 'a', sources: 2, charactersWritten: 10, millisecondsSpent: 3 };

  it('sends the question, the answer and three counts, and nothing else', async () => {
    let sent: Record<string, unknown> = {};
    const judge = jevJudge({
      apiKey: 'key-from-the-environment',
      fetch: (_url, init) => {
        sent = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
        return Promise.resolve(Response.json({ model: 'jev-1.13.0', answers: { answered: { noul: 0.97 }, effort: { score: 2.1, confidence: 0.9 } } }));
      },
    });

    const verdict = await judge(work);
    expect(Object.keys(sent['state'] as object).sort()).toEqual(['answer', 'characters_written', 'milliseconds_spent', 'question', 'sources_read']);
    expect(verdict).toMatchObject({ answered: true, tier: 'investigation', amount: '$0.04', judgedBy: 'jev-1.13.0' });
    expect(sent['model']).toBe('jev-latest');
  });

  it('takes the nearest level when confident, and rounds down when it is not', async () => {
    const answer = (score: number, confidence: number) =>
      jevJudge({
        apiKey: 'key-from-the-environment',
        fetch: () => Promise.resolve(Response.json({ model: 'jev-1.13.0', answers: { answered: { noul: 0.9 }, effort: { score, confidence } } })),
      })(work);

    await expect(answer(0.99, 0.9)).resolves.toMatchObject({ tier: 'synthesis', amount: '$0.02' });
    await expect(answer(1.6, 0.9)).resolves.toMatchObject({ tier: 'investigation', amount: '$0.04' });
    // The same readings, unsure, round down rather than to the nearest: doubt costs the seller.
    await expect(answer(1.6, 0.35)).resolves.toMatchObject({ tier: 'synthesis', amount: '$0.02' });
    await expect(answer(0.99, 0.35)).resolves.toMatchObject({ tier: 'lookup', amount: '$0.01' });
  });

  it('sends a Vercel gateway key to the gateway, under its model id', async () => {
    let address = '';
    let model: unknown = null;
    const judge = jevJudge({
      apiKey: 'vck_not-a-real-key',
      fetch: (url, init) => {
        address = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
        model = (JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { model?: unknown }).model;
        return Promise.resolve(Response.json({ model: 'typesafe-ai/jev', answers: { answered: { noul: 0.9 }, effort: { score: 2, confidence: 0.9 } } }));
      },
    });

    await expect(judge(work)).resolves.toMatchObject({ judgedBy: 'typesafe-ai/jev' });
    expect(address).toBe('https://ai-gateway.vercel.sh/typesafe/v1/systemone');
    expect(model).toBe('typesafe-ai/jev');
  });

  it('prices by the rules when there is no key, and says which', async () => {
    const verdict = await jevJudge({ apiKey: undefined })(work);
    expect(verdict.judgedBy).toBe('rules');
    expect(verdict.reason).toContain('no JEV_API_KEY');
  });

  it('prices by the rules when Jev is unreachable or answers something unexpected', async () => {
    const down = jevJudge({ apiKey: 'k', fetch: () => Promise.reject(new Error('socket hang up')) });
    await expect(down(work)).resolves.toMatchObject({ judgedBy: 'rules', tier: 'synthesis' });

    const odd = await jevJudge({ apiKey: 'k', fetch: () => Promise.resolve(Response.json({ hello: 'world' })) })(work);
    expect(odd).toMatchObject({ judgedBy: 'rules' });
    expect(odd.reason).toContain('shape');

    const refused = await jevJudge({ apiKey: 'k', fetch: () => Promise.resolve(new Response('no', { status: 429 })) })(work);
    expect(refused).toMatchObject({ judgedBy: 'rules' });
    expect(refused.reason).toContain('429');
  });
});
