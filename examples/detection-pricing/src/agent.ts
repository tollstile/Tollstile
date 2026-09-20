/**
 * A buyer that asks for one thing, authorizes a ceiling, and prints what it was charged.
 *
 *   pnpm --filter @tollstile-examples/detection-pricing agent
 *   pnpm --filter @tollstile-examples/detection-pricing agent -- --target 'a swimming pool'
 */
const url = process.argv.includes('--url') ? (process.argv[process.argv.indexOf('--url') + 1] ?? '') : 'http://localhost:3100/detect';
const target = process.argv.includes('--target') ? (process.argv[process.argv.indexOf('--target') + 1] ?? '') : 'a solar panel';

type Answer = {
  target: string;
  proposed: number;
  verified: number;
  charged: string;
  authorized?: string;
  threshold: number;
  verifiedBy?: string;
  detections: { box: { x: number; y: number; width: number; height: number }; detectorSaid: number; verifierSaid: number; charged: boolean }[];
};

const body = JSON.stringify({ target });
const headers = { 'content-type': 'application/json' };

const unpaid = await fetch(url, { method: 'POST', headers, body });
const challenge = (await unpaid.json()) as { quote?: string; price?: string };
if (unpaid.status !== 402 || challenge.quote === undefined) {
  console.log(`unexpected ${String(unpaid.status)}`);
  process.exit(1);
}

const started = Date.now();
const paid = await fetch(url, { method: 'POST', headers: { ...headers, payment: `test quote=${challenge.quote}` }, body });
const result = (await paid.json()) as Answer;
const took = Date.now() - started;

console.log(`\n"find ${target}" — authorized ${String(challenge.price)}`);
console.log(`  detector proposed ${String(result.proposed)}, verifier kept ${String(result.verified)} at p ≥ ${String(result.threshold)}`);
for (const detection of result.detections) {
  const at = `${String(detection.box.x)},${String(detection.box.y)} ${String(detection.box.width)}×${String(detection.box.height)}`;
  console.log(`    ${detection.charged ? '✓' : '·'} ${at.padEnd(20)} detector ${detection.detectorSaid.toFixed(2)}  verifier ${detection.verifierSaid.toFixed(2)}`);
}
console.log(`  charged ${result.charged}${result.verifiedBy === undefined ? '' : ` · verified by ${result.verifiedBy}`} · ${String(took)} ms`);
