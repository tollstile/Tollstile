/**
 * A buyer that asks three questions of different weights and prints what each one cost.
 *
 *   pnpm --filter @tollstile-examples/jev-pricing agent
 *
 * It authorizes the same ceiling every time and never negotiates: the whole point is that the
 * ceiling is not the price.
 */

const url = process.argv.includes('--url') ? (process.argv[process.argv.indexOf('--url') + 1] ?? '') : 'http://localhost:3000/research';

const QUESTIONS = [
  'What do anglers say about fishing the bay?',
  'When is the next ferry refund due?',
  'Should I book the Oshima ferry in September, given tides, swell and refunds?',
  'What is the capital of Mars?',
];

type Answer = {
  answered: boolean;
  answer?: string;
  pricing: { charged: string; authorized: string; tier: string; judgedBy: string; confidence: number; reason: string };
};

let spent = 0;

for (const question of QUESTIONS) {
  const body = JSON.stringify({ question });
  const unpaid = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  const challenge = (await unpaid.json()) as { quote?: string; price?: string };
  if (unpaid.status !== 402 || challenge.quote === undefined) {
    console.log(`unexpected ${String(unpaid.status)} for "${question}"`);
    continue;
  }

  const paid = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', payment: `test quote=${challenge.quote}` },
    body,
  });
  const result = (await paid.json()) as Answer;
  const charged = result.pricing.charged;
  spent += Number(charged.replace('$', ''));

  console.log(`\n"${question}"`);
  console.log(`  authorized ${String(challenge.price)} → charged ${charged} (${result.pricing.tier}, judged by ${result.pricing.judgedBy})`);
  console.log(`  ${result.pricing.reason}`);
  if (result.answered) console.log(`  ${(result.answer ?? '').slice(0, 96)}…`);
  else console.log('  nothing was answered, so nothing was charged');
}

console.log(`\nAuthorized $0.05 four times over; paid $${spent.toFixed(2)} in total.`);
