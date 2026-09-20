import { ANSWERED_FLOOR, CONFIDENCE_FLOOR, ruleJudge, tierOf, TIERS, type Judge, type Work } from './judge';

/**
 * The judge, as a call to Jev (TypeSafe AI's System One model): two typed questions, no prose,
 * answers with probabilities and a confidence.
 *
 * Everything here degrades to `ruleJudge`: no key, a timeout, an error, a shape this code does not
 * recognise. A pricing path that stops working when a vendor does is not one to put in front of a
 * paid route, and a free trial that ends should change the numbers, not break the server.
 */

const TYPESAFE = { endpoint: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest' };
/**
 * A key beginning `vck_` is a Vercel AI Gateway key, not a TypeSafe one. The gateway serves the
 * same request shape at its own address under another model id, and answering `401` is how a key
 * sent to the wrong one fails — so the key decides the door.
 */
const GATEWAY = { endpoint: 'https://ai-gateway.vercel.sh/typesafe/v1/systemone', model: 'typesafe-ai/jev' };
const TIMEOUT_MS = 2_000;

function provider(apiKey: string): { endpoint: string; model: string } {
  return apiKey.startsWith('vck_') ? GATEWAY : TYPESAFE;
}

export type JevOptions = {
  /** Read from the environment by the caller. This file never reads `process.env`. */
  readonly apiKey: string | undefined;
  /**
   * A server that speaks `POST /v1/systemone` itself, instead of the address the key implies —
   * [LocalJev](https://github.com/githubnext/localjev) on `http://127.0.0.1:8080`, say. With one
   * set, no key is needed: the judgement never leaves the machine.
   */
  readonly endpoint?: string;
  readonly model?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
};

export function jevJudge(options: JevOptions): Judge {
  const call = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;

  return async (work) => {
    const apiKey = options.apiKey;
    const local = options.endpoint;
    if (local === undefined && (apiKey === undefined || apiKey === '')) return await fallback(work, 'no JEV_API_KEY is set');

    const via = local === undefined ? provider(apiKey ?? '') : { endpoint: local, model: options.model ?? TYPESAFE.model };
    let payload: unknown;
    try {
      const response = await call(via.endpoint, {
        method: 'POST',
        // A local server needs no key, and is not sent one.
        headers: apiKey === undefined || apiKey === '' ? { 'content-type': 'application/json' } : { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(request(work, via.model)),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return await fallback(work, `Jev answered HTTP ${String(response.status)}`);
      payload = await response.json();
    } catch (error) {
      return await fallback(work, `${local === undefined ? 'Jev' : local} was unreachable (${error instanceof Error ? error.name : 'error'})`);
    }

    const answers = read(payload);
    if (answers === undefined) return await fallback(work, 'Jev answered in a shape this example does not know');

    // The score is a position on the legend, so a confident answer takes the nearest level. Doubt
    // rounds down instead, which is the one direction that costs the seller and not the buyer:
    // 1.44 confident is an investigation, 1.44 unsure is a synthesis.
    const uncertain = answers.confidence < CONFIDENCE_FLOOR;
    const tier = tierOf(uncertain ? Math.floor(answers.effort) : Math.round(answers.effort));
    return {
      answered: answers.answered >= ANSWERED_FLOOR,
      tier: tier.label,
      amount: tier.amount,
      confidence: answers.confidence,
      reason: uncertain
        ? `judged ${answers.effort.toFixed(2)} on the effort scale with confidence ${answers.confidence.toFixed(2)}, below the ${String(CONFIDENCE_FLOOR)} floor, so it rounded down`
        : `judged ${answers.effort.toFixed(2)} on the effort scale (${TIERS.map((one) => one.label).join(' · ')}) with confidence ${answers.confidence.toFixed(2)}`,
      judgedBy: answers.model,
    };
  };
}

/**
 * What leaves the server: the question, the answer this server wrote, and three counts. No headers,
 * no caller identity, no payment evidence. Listed here by hand so nothing joins it by accident.
 */
function request(work: Work, model: string) {
  return {
    model,
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
  return { answered, effort, confidence, model: typeof body.model === 'string' ? body.model : 'jev' };
}

async function fallback(work: Work, why: string): Promise<ReturnType<Judge>> {
  const verdict = await ruleJudge(work);
  return { ...verdict, reason: `${verdict.reason} (${why}, so the rules priced it)` };
}
