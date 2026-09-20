import { tollstile } from '@tollstile/hono';
import { Hono } from 'hono';
import { createTollstile, formatMoney, memoryLedger, money, testRail, upTo } from 'tollstile';
import { detect, type Detection } from './detect';
import { render, SCENE } from './scene';
import { KEEP, modelVerifier, ruleVerifier, type Verdict, type Verifier } from './verify';

/**
 * Pay for what was found, and only for what a second opinion stood behind.
 *
 * The caller authorizes a ceiling before anything runs, because nobody — including the seller —
 * knows how many panels are in an image. The detector proposes, a verifier disposes, and the
 * charge is the survivors.
 */

export const CAP = '$0.20';
/** Per verified detection. Whole cents here; the ledger holds micros, so any scale works. */
const PER_DETECTION = 10_000n;

export const toll = createTollstile({ rails: [testRail()], ledger: memoryLedger() });

export type AppOptions = { readonly verifier?: Verifier; readonly log?: (line: string) => void };

export function createApp(options: AppOptions = {}): Hono {
  const verify = options.verifier ?? modelVerifier(process.env['AI_GATEWAY_API_KEY'] ?? process.env['JEV_API_KEY']);
  const log = options.log ?? ((line: string) => { console.log(line); });
  const app = new Hono();

  app.post('/detect', tollstile(toll.price(upTo(CAP), { resource: 'POST /detect' })), async (c) => {
    const target = await targetOf(c.req.raw.clone());
    const image = render();
    const proposed = detect(image);
    const verdicts = await verify(image, target, proposed);
    const kept = verdicts.filter((verdict) => verdict.probability >= KEEP);
    const payment = c.get('payment');

    log(line(payment.via === 'rail' ? payment.chargeId : null, target, proposed, verdicts, kept));

    if (kept.length === 0) {
      // Nothing survived, so nothing is charged: a 4xx releases the hold.
      return c.json({ target, proposed: proposed.length, verified: 0, charged: '$0.00', detections: [], threshold: KEEP }, 422);
    }

    const charged = money('USD', PER_DETECTION * BigInt(kept.length));
    await payment.fulfill({ amount: formatMoney(charged) });

    return c.json({
      target,
      proposed: proposed.length,
      verified: kept.length,
      charged: formatMoney(charged),
      authorized: CAP,
      threshold: KEEP,
      verifiedBy: verdicts[0]?.verifiedBy ?? 'rules',
      detections: verdicts.map((verdict) => ({
        box: verdict.detection.box,
        detectorSaid: Number(verdict.detection.confidence.toFixed(2)),
        verifierSaid: Number(verdict.probability.toFixed(2)),
        charged: verdict.probability >= KEEP,
      })),
    });
  });

  return app;
}

/** What the scene actually holds, for a test or a person to check the count against. */
export const TRUTH = SCENE.filter((thing) => thing.kind === 'panel').length;

async function targetOf(request: Request): Promise<string> {
  const body: unknown = await request.json().catch(() => ({}));
  const target = typeof body === 'object' && body !== null && 'target' in body && typeof body.target === 'string' ? body.target : '';
  return target.trim() === '' ? 'a solar panel' : target.slice(0, 120);
}

/**
 * One line per priced request: counts and probabilities, never the image, never a crop. A billing
 * log that carries the customer's imagery is a billing log nobody can share with their accountant.
 */
function line(chargeId: string | null, target: string, proposed: readonly Detection[], verdicts: readonly Verdict[], kept: readonly Verdict[]): string {
  return [
    `charge=${chargeId ?? 'none'}`,
    `target="${target}"`,
    `proposed=${String(proposed.length)}`,
    `verified=${String(kept.length)}`,
    `threshold=${String(KEEP)}`,
    `probabilities=${verdicts.map((verdict) => verdict.probability.toFixed(2)).join(',')}`,
    `charged=$${(Number(PER_DETECTION * BigInt(kept.length)) / 1e6).toFixed(2)}`,
    `verifier=${verdicts[0]?.verifiedBy ?? 'none'}`,
  ].join(' ');
}

export { ruleVerifier };
