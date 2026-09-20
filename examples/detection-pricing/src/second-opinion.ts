import type { Detection } from './detect';
import { cropPng, type Photo } from './photo';
import type { Verdict } from './verify';

/**
 * The second opinion, in two stages, because neither model can do it alone.
 *
 * A vision model can look at a crop but will not give you a number. Asking it to state a
 * confidence gets you a guess at its own certainty; asking for `logprobs` through this gateway
 * returns an empty list, for text and images alike. A System One model answers with a calibrated
 * probability but cannot see. Measured: the vision model and a general LLM both answer a crop of a
 * car's wheel with a confident yes, and only the judge says 0.85 — a number a threshold can act on.
 *
 * So: the vision model says what the crop **shows**, in one sentence, and the judge says whether
 * that sentence is the thing that was asked for. The number that decides the money comes from the
 * judge, and neither of the two produced the detection they are checking.
 */

export type SecondOpinion = (photo: Photo, concept: string, detections: readonly Detection[]) => Promise<readonly Verdict[]>;

const GATEWAY = 'https://ai-gateway.vercel.sh';
const EYES = 'openai/gpt-4o-mini';
const JUDGE = 'typesafe-ai/jev';
/** Vision calls are the scarce resource — five a minute on a starter gateway team — so they queue. */
const SPACING_MS = 13_000;

export type SecondOpinionOptions = {
  readonly apiKey: string;
  readonly eyes?: string;
  readonly judge?: string;
  readonly gateway?: string;
  readonly spacingMs?: number;
  readonly fetch?: typeof globalThis.fetch;
};

export type Described = Verdict & { readonly description: string };

export function secondOpinion(options: SecondOpinionOptions): (photo: Photo, concept: string, detections: readonly Detection[]) => Promise<readonly Described[]> {
  const call = options.fetch ?? globalThis.fetch;
  const gateway = options.gateway ?? GATEWAY;
  const eyes = options.eyes ?? EYES;
  const judge = options.judge ?? JUDGE;
  const spacing = options.spacingMs ?? SPACING_MS;

  return async (photo, concept, detections) => {
    const verdicts: Described[] = [];
    for (const [index, detection] of detections.entries()) {
      if (index > 0 && spacing > 0) await wait(spacing);
      const description = await describe(call, gateway, eyes, options.apiKey, cropPng(photo, detection.box).toString('base64'));
      if (description === null) {
        // Unchecked is not verified: the seller carries the cost of a verifier that did not answer.
        verdicts.push({ detection, probability: 0, verifiedBy: 'unavailable', description: '' });
        continue;
      }
      const decided = await decide(call, gateway, judge, options.apiKey, concept, description);
      verdicts.push({ detection, probability: decided.probability, verifiedBy: decided.by, description });
    }
    return verdicts;
  };
}

/** What is actually in the crop, said by something that did not choose the crop. */
async function describe(call: typeof globalThis.fetch, gateway: string, model: string, apiKey: string, base64: string): Promise<string | null> {
  const response = await call(`${gateway}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: 40,
      temperature: 0,
      messages: [
        { role: 'system', content: 'Describe what fills this cropped region, in at most 12 words. No hedging, no preamble.' },
        { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } }] },
      ],
    }),
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null);

  if (response === null || !response.ok) return null;
  const body = (await response.json()) as { choices?: { message?: { content?: unknown } }[] };
  const content = body.choices?.[0]?.message?.content;
  return typeof content === 'string' && content.trim() !== '' ? content.trim() : null;
}

/** Whether that sentence is the thing the buyer asked for, as a calibrated probability. */
async function decide(
  call: typeof globalThis.fetch,
  gateway: string,
  model: string,
  apiKey: string,
  concept: string,
  description: string,
): Promise<{ probability: number; by: string }> {
  const response = await call(`${gateway}/typesafe/v1/systemone`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      state: { concept, description },
      questions: {
        matches: {
          type: 'noul',
          instructions: `Does the description describe ${concept}?`,
          criteria: { true: `It is ${concept}`, false: 'It is something else, or too vague to tell' },
        },
      },
    }),
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);

  if (response === null || !response.ok) return { probability: 0, by: `unavailable (HTTP ${String(response?.status ?? 0)})` };
  const body = (await response.json()) as { model?: unknown; answers?: { matches?: { noul?: unknown } } };
  const noul = body.answers?.matches?.noul;
  return { probability: typeof noul === 'number' ? noul : 0, by: typeof body.model === 'string' ? body.model : model };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
