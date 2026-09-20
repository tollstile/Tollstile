import { ANSWERED_FLOOR, CONFIDENCE_FLOOR, ruleJudge, tierOf, TIERS, type Judge, type Work } from './judge';

/**
 * The judge, as a call to Jev (TypeSafe AI's System One model): two typed questions, no prose,
 * answers with probabilities and a confidence.
 *
 * Everything here degrades to `ruleJudge`: no key, a timeout, an error, a shape this code does not
 * recognise. A pricing path that stops working when a vendor does is not one to put in front of a
 * paid route, and a free trial that ends should change the numbers, not break the server.
 */

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-latest';
const TIMEOUT_MS = 2_000;

export type JevOptions = {
  /** Read from the environment by the caller. This file never reads `process.env`. */
  readonly apiKey: string | undefined;
  readonly fetch?: typeof globalThis.fetch;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
};

export function jevJudge(options: JevOptions): Judge {
  const call = options.fetch ?? globalThis.fetch;
  const endpoint = options.endpoint ?? ENDPOINT;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;

  return async (work) => {
    const apiKey = options.apiKey;
    if (apiKey === undefined || apiKey === '') return await fallback(work, 'no JEV_API_KEY is set');

    let payload: unknown;
    try {
      const response = await call(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(request(work)),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return await fallback(work, `Jev answered HTTP ${String(response.status)}`);
      payload = await response.json();
    } catch (error) {
      return await fallback(work, `Jev was unreachable (${error instanceof Error ? error.name : 'error'})`);
    }

    const answers = read(payload);
    if (answers === undefined) return await fallback(work, 'Jev answered in a shape this example does not know');

    // Doubt costs the seller: an uncertain judgement charges the lowest tier, never a guess upward.
    const uncertain = answers.confidence < CONFIDENCE_FLOOR;
    const tier = uncertain ? tierOf(0) : tierOf(answers.effort);
    return {
      answered: answers.answered >= ANSWERED_FLOOR,
      tier: tier.label,
      amount: tier.amount,
      confidence: answers.confidence,
      reason: uncertain
        ? `judged ${answers.effort.toFixed(2)} on the effort scale with confidence ${answers.confidence.toFixed(2)}, below the ${String(CONFIDENCE_FLOOR)} floor, so the lowest tier was charged`
        : `judged ${answers.effort.toFixed(2)} on the effort scale (${TIERS.map((one) => one.label).join(' · ')}) with confidence ${answers.confidence.toFixed(2)}`,
      judgedBy: answers.model,
    };
  };
}

/**
 * What leaves the server: the question, the answer this server wrote, and three counts. No headers,
 * no caller identity, no payment evidence. Listed here by hand so nothing joins it by accident.
 */
function request(work: Work) {
  return {
    model: MODEL,
    state: {
      question: work.question,
      answer: work.answer,
      sources_read: work.sources,
      characters_written: work.charactersWritten,
      milliseconds_spent: work.millisecondsSpent,
    },
    questions: {
      answered: {
        type: 'noul',
        instructions: 'Does the answer actually answer the question asked?',
        criteria: { true: 'The question is answered', false: 'It evades, refuses, or answers something else' },
      },
      effort: {
        type: 'score',
        instructions: 'How much work did producing this answer take?',
        criteria: [
          'A lookup: one fact, restated',
          'A synthesis: a few sources combined into something new',
          'An investigation: several sources weighed, with a judgement the sources do not state',
        ],
      },
    },
  };
}

type Answers = { readonly answered: number; readonly effort: number; readonly confidence: number; readonly model: string };

function read(payload: unknown): Answers | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const body = payload as { model?: unknown; answers?: { answered?: { noul?: unknown }; effort?: { score?: unknown; confidence?: unknown } } };
  const answered = body.answers?.answered?.noul;
  const effort = body.answers?.effort?.score;
  const confidence = body.answers?.effort?.confidence;
  if (typeof answered !== 'number' || typeof effort !== 'number' || typeof confidence !== 'number') return undefined;
  return { answered, effort, confidence, model: typeof body.model === 'string' ? body.model : MODEL };
}

async function fallback(work: Work, why: string): Promise<ReturnType<Judge>> {
  const verdict = await ruleJudge(work);
  return { ...verdict, reason: `${verdict.reason} (${why}, so the rules priced it)` };
}
