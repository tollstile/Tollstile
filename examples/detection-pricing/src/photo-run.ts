import { formatMoney, money, parseMoney } from 'tollstile';
import { CAP } from './app';
import { propose } from './propose';
import { segment } from './sam';
import { secondOpinion } from './second-opinion';
import { KEEP } from './verify';

/**
 * The whole thing over a real photograph:
 *
 *   FAL_KEY=… AI_GATEWAY_API_KEY=… pnpm --filter @tollstile-examples/detection-pricing photo -- photo.jpg car
 *
 * SAM 3 proposes every instance of the concept, with its own score. A vision model says what each
 * crop shows. A System One model says whether that is the thing asked for, with a probability. The
 * charge is the survivors, under a ceiling the caller approved before any of it ran.
 */
// pnpm forwards its own `--`; drop it so the first real argument is the image.
const args = process.argv.slice(2).filter((argument) => argument !== '--');
const path = args[0];
const concept = args[1] ?? 'car';
const gatewayKey = process.env['AI_GATEWAY_API_KEY'];
const falKey = process.env['FAL_KEY'];

if (path === undefined || gatewayKey === undefined) {
  console.log('usage: AI_GATEWAY_API_KEY=… [FAL_KEY=…] photo <image> [concept]');
  process.exit(1);
}

const proposal =
  falKey === undefined
    ? await propose(path, concept, { apiKey: gatewayKey })
    : await segment(path, concept, { apiKey: falKey });

const started = Date.now();
const verdicts = await secondOpinion({ apiKey: gatewayKey })(proposal.photo, concept, proposal.detections);
const checkedInMs = Date.now() - started;

const kept = verdicts.filter((verdict) => verdict.probability >= KEEP);
const asked = money('USD', BigInt(kept.length) * 10_000n);
const charged = asked.micros > parseMoney(CAP).micros ? parseMoney(CAP) : asked;

console.log(`\n"find every ${concept}" in ${path} (${String(proposal.photo.width)}×${String(proposal.photo.height)})`);
console.log(`  ${proposal.proposedBy} proposed ${String(proposal.detections.length)} in ${String(proposal.tookMs)} ms`);
for (const verdict of verdicts) {
  const box = verdict.detection.box;
  const at = `${String(box.x)},${String(box.y)} ${String(box.width)}×${String(box.height)}`;
  console.log(
    `    ${verdict.probability >= KEEP ? '✓' : '·'} ${at.padEnd(22)} proposer ${verdict.detection.confidence.toFixed(2)}  judge ${verdict.probability.toFixed(2)}  "${verdict.description}"`,
  );
}
console.log(
  `  checked in ${String(checkedInMs)} ms by ${verdicts[0]?.verifiedBy ?? 'nobody'} · kept ${String(kept.length)} of ${String(verdicts.length)} at p ≥ ${String(KEEP)}`,
);
console.log(`  authorized ${CAP} · charged ${formatMoney(charged)}`);
