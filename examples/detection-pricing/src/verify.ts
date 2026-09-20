import type { Detection } from './detect';
import { cropPng, type Photo } from './photo';
import { crop, png } from './scene';

/**
 * The second opinion.
 *
 * One typed question per detection — *is this the thing that was asked for?* — answered by
 * something other than the detector. The model is asked for a single token and its **logprobs**,
 * so the number that decides the money is read out of the model's distribution rather than
 * written by the model as prose. A model that says "0.95" is guessing at its own certainty; a
 * token probability is measured.
 */

export type Verdict = { readonly detection: Detection; readonly probability: number; readonly verifiedBy: string };
export type Verifier = (image: Uint8Array, target: string, detections: readonly Detection[]) => Promise<readonly Verdict[]>;
/** The same second opinion, over a photograph's crops rather than the drawn scene's. */
export type PhotoVerifier = (photo: Photo, target: string, detections: readonly Detection[]) => Promise<readonly Verdict[]>;

/** A detection is charged for at or above this. Publish it: a threshold a buyer cannot see is a threshold they cannot argue with. */
export const KEEP = 0.7;

const ENDPOINT = 'https://ai-gateway.vercel.sh/v1/chat/completions';
const MODEL = 'openai/gpt-4o-mini';
const TIMEOUT_MS = 12_000;

/**
 * Geometry and colour, no network: panels here are wide, large and very dark; skylights are small
 * and lighter. It is the honest floor — and it cannot tell a panel from anything else that happens
 * to be a big dark rectangle, which is exactly what the model is for.
 */
export const ruleVerifier: Verifier = (image, _target, detections) =>
  Promise.resolve(
    detections.map((detection) => {
      const wide = detection.box.width / Math.max(detection.box.height, 1) >= 1.4;
      const large = detection.pixels >= 1_400;
      const probability = wide && large ? 0.9 : wide || large ? 0.5 : 0.15;
      return { detection, probability, verifiedBy: 'rules' };
    }),
  );

export function photoVerifier(options: { apiKey: string | undefined; model?: string; endpoint?: string; fetch?: typeof globalThis.fetch }): PhotoVerifier {
  return async (photo, target, detections) => {
    if (options.apiKey === undefined || options.apiKey === '') throw new Error('The verifier needs a key: set AI_GATEWAY_API_KEY.');
    const fetcher = options.fetch ?? globalThis.fetch;
    return await Promise.all(
      detections.map((detection) =>
        askImage(detection, cropPng(photo, detection.box).toString('base64'), target, options.apiKey ?? '', fetcher, options.model ?? MODEL, options.endpoint ?? ENDPOINT),
      ),
    );
  };
}

export function modelVerifier(apiKey: string | undefined, fetcher: typeof globalThis.fetch = globalThis.fetch): Verifier {
  return async (image, target, detections) => {
    if (apiKey === undefined || apiKey === '') return ruleVerifier(image, target, detections);
    // Independent questions, asked at once: the crops do not depend on each other.
    return await Promise.all(detections.map((detection) => ask(detection, image, target, apiKey, fetcher)));
  };
}

async function ask(detection: Detection, image: Uint8Array, target: string, apiKey: string, fetcher: typeof globalThis.fetch): Promise<Verdict> {
  const cut = crop(image, detection.box);
  return await askImage(detection, png(cut.pixels, cut.width, cut.height).toString('base64'), target, apiKey, fetcher, MODEL, ENDPOINT);
}

/** One crop, one token, one probability read from the distribution over that token. */
async function askImage(
  detection: Detection,
  base64: string,
  target: string,
  apiKey: string,
  fetcher: typeof globalThis.fetch,
  model: string,
  endpoint: string,
): Promise<Verdict> {
  const dataUri = `data:image/png;base64,${base64}`;

  try {
    const response = await fetcher(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        temperature: 0,
        logprobs: true,
        top_logprobs: 8,
        messages: [
          {
            role: 'system',
            content: `You check one cropped region of a photograph. Answer with exactly one word, "yes" or "no": is the region ${target}? Answer no for anything else, however similar.`,
          },
          { role: 'user', content: [{ type: 'image_url', image_url: { url: dataUri } }] },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return { detection, probability: 0, verifiedBy: `unavailable (HTTP ${String(response.status)})` };

    const body = (await response.json()) as {
      model?: unknown;
      choices?: { logprobs?: { content?: { top_logprobs?: { token?: unknown; logprob?: unknown }[] }[] } }[];
    };
    const top = body.choices?.[0]?.logprobs?.content?.[0]?.top_logprobs;
    if (top === undefined) return { detection, probability: 0, verifiedBy: 'unavailable (no logprobs)' };

    // The probability of "yes" against "no", read from the distribution over the first token.
    let yes = 0;
    let no = 0;
    for (const candidate of top) {
      if (typeof candidate.token !== 'string' || typeof candidate.logprob !== 'number') continue;
      const word = candidate.token.trim().toLowerCase();
      if (word.startsWith('yes')) yes += Math.exp(candidate.logprob);
      else if (word.startsWith('no')) no += Math.exp(candidate.logprob);
    }
    const total = yes + no;
    return {
      detection,
      probability: total > 0 ? yes / total : 0,
      verifiedBy: typeof body.model === 'string' ? body.model : model,
    };
  } catch {
    return { detection, probability: 0, verifiedBy: 'unavailable (timed out)' };
  }
}
