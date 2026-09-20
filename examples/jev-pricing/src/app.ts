import { tollstile } from '@tollstile/hono';
import { Hono } from 'hono';
import { createTollstile, memoryLedger, testRail, upTo } from 'tollstile';
import { jevJudge } from './jev';
import { CAP, ruleJudge, type Judge, type Verdict, type Work } from './judge';
import { research, sourcesFor } from './research';

/**
 * One route, one price ceiling, three possible settlements.
 *
 * The caller authorizes up to $0.05 before the desk starts. The desk does the work, a judge says
 * what the work was worth, and `payment.fulfill()` settles that much — $0.01, $0.02 or $0.04. A
 * question the desk could not answer settles nothing at all.
 */

export const toll = createTollstile({ rails: [testRail()], ledger: memoryLedger() });

export type AppOptions = {
  readonly judge?: Judge;
  /** Receives one line per priced request. Defaults to `console.log`. */
  readonly log?: (line: string) => void;
};

export function createApp(options: AppOptions = {}): Hono {
  const judge = options.judge ?? jevJudge({ apiKey: process.env['JEV_API_KEY'] });
  const log = options.log ?? ((line: string) => { console.log(line); });
  const app = new Hono();

  app.post('/research', tollstile(toll.price(upTo(CAP), { resource: 'POST /research' })), async (c) => {
    const body: unknown = await c.req.json().catch(() => ({}));
    const question = typeof body === 'object' && body !== null && 'question' in body && typeof body.question === 'string' ? body.question : '';
    const work = research(question);
    const verdict = await judge(work);
    const payment = c.get('payment');

    log(line(payment.via === 'rail' ? payment.chargeId : null, work, verdict));

    // Nothing was answered, so nothing is charged: a 4xx releases the hold. The caller still gets
    // the reason, and the authorization is theirs to spend elsewhere.
    if (!verdict.answered) {
      return c.json({ answered: false, pricing: explain(verdict, '$0.00'), sources: [] }, 422);
    }

    await payment.fulfill({ amount: verdict.amount });
    return c.json({
      answered: true,
      answer: work.answer,
      sources: sourcesFor(question),
      pricing: explain(verdict, verdict.amount),
    });
  });

  return app;
}

/** What the buyer is shown about their own charge. A price nobody can question is a price nobody trusts. */
function explain(verdict: Verdict, charged: string) {
  return {
    charged,
    authorized: CAP,
    tier: verdict.tier,
    judgedBy: verdict.judgedBy,
    confidence: Number(verdict.confidence.toFixed(2)),
    reason: verdict.reason,
  };
}

/**
 * The log line. Fields are listed here by hand: counts, the tier, the judge, the charge id. The
 * question and the answer stay out of it — they are the customer's, and a pricing log is read by
 * people who have no business reading them.
 */
function line(chargeId: string | null, work: Work, verdict: Verdict): string {
  return [
    `charge=${chargeId ?? 'none'}`,
    `sources=${String(work.sources)}`,
    `chars=${String(work.charactersWritten)}`,
    `ms=${String(work.millisecondsSpent)}`,
    `tier=${verdict.answered ? verdict.tier : 'none'}`,
    `charged=${verdict.answered ? verdict.amount : '$0.00'}`,
    `confidence=${verdict.confidence.toFixed(2)}`,
    `judge=${verdict.judgedBy}`,
  ].join(' ');
}

export { ruleJudge };
