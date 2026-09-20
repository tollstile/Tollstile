import { formatMoney, money, parseMoney } from 'tollstile';
import { CAP } from './app';
import { propose } from './propose';
import { KEEP, photoVerifier } from './verify';

/**
 * The whole thing over a real photograph, without a server in the way:
 *
 *   pnpm --filter @tollstile-examples/detection-pricing photo -- ~/Pictures/street.jpg 'a car'
 *
 * One model proposes regions, another looks at each crop, and the charge is what survived — under
 * the same ceiling the HTTP route uses. Prints what each model said, so the two can be compared.
 */
const path = process.argv[2];
const target = process.argv[3] ?? 'a car';
const key = process.env['AI_GATEWAY_API_KEY'] ?? process.env['LLAMA_API_KEY'];

if (path === undefined) {
  console.log('usage: photo <image> [target]');
  process.exit(1);
}

const detector = { apiKey: key, ...(process.env['DETECTOR_MODEL'] === undefined ? {} : { model: process.env['DETECTOR_MODEL'] }), ...(process.env['DETECTOR_URL'] === undefined ? {} : { endpoint: process.env['DETECTOR_URL'] }) };
const proposal = await propose(path, target, detector);

const started = Date.now();
const verdicts = await photoVerifier({ apiKey: key, ...(process.env['VERIFIER_MODEL'] === undefined ? {} : { model: process.env['VERIFIER_MODEL'] }) })(proposal.photo, target, proposal.detections);
const verifiedInMs = Date.now() - started;

const kept = verdicts.filter((verdict) => verdict.probability >= KEEP);
const charged = money('USD', BigInt(kept.length) * 10_000n);
const capped = charged.micros > parseMoney(CAP).micros ? parseMoney(CAP) : charged;

console.log(`\n"find ${target}" in ${path} (${String(proposal.photo.width)}×${String(proposal.photo.height)})`);
console.log(`  proposed by ${proposal.proposedBy} in ${String(proposal.tookMs)} ms · verified by ${verdicts[0]?.verifiedBy ?? 'nobody'} in ${String(verifiedInMs)} ms`);
for (const verdict of verdicts) {
  const box = verdict.detection.box;
  const at = `${String(box.x)},${String(box.y)} ${String(box.width)}×${String(box.height)}`;
  console.log(`    ${verdict.probability >= KEEP ? '✓' : '·'} ${at.padEnd(22)} detector ${verdict.detection.confidence.toFixed(2)}  verifier ${verdict.probability.toFixed(2)}`);
}
console.log(`  authorized ${CAP} · kept ${String(kept.length)} of ${String(verdicts.length)} at p ≥ ${String(KEEP)} · charged ${formatMoney(capped)}`);
