import { readFileSync, writeFileSync } from 'node:fs';
const items = JSON.parse(readFileSync(process.env.SNAPSHOT ?? './snapshots/bazaar-2026-09-20.json', 'utf8'));
const USDC = new Set(['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913','0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48','0x3c499c542cef5e3811e1192ce70d8cc03d5c3359','0xaf88d065e77c8cc2239327c5edb3a432268e5831','epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v']);
const rows = items.map((i) => { const o = i.accepts?.[0] ?? {}; return { p: USDC.has(String(o.asset ?? '').toLowerCase()) ? Number(o.maxAmountRequired ?? o.amount ?? 0) / 1e6 : null, n: i.quality?.l30DaysTotalCalls ?? 0, u: i.quality?.l30DaysUniquePayers ?? 0 }; })
  .filter((r) => r.p !== null && r.p > 0 && r.p < 1000 && r.n > 0);

const GAS = [0.0005, 0.002, 0.01], AMORT = [1, 3, 6, 12], KS = [10, 25, 100], CAPS = [0.05, 0.10, 1, 5];
const evalGrid = (g, a, k, cap) => {
  const ex = (r) => r.n * g;
  const ch = (r) => (r.u * 2 * g) / a + g;
  const sp = (r) => { const T = Math.max(r.p, Math.min(cap, r.p * r.n / k)); return (r.n * r.p / T) * g; };
  let E = 0, C = 0, S = 0, best = 0; const wins = { exact: 0, channel: 0, sparse: 0 }, winCalls = { exact: 0, channel: 0, sparse: 0 };
  for (const r of rows) {
    const e = ex(r), c = ch(r), s = sp(r);
    E += e; C += c; S += s; best += Math.min(e, c, s);
    const w = e <= c && e <= s ? 'exact' : c <= s ? 'channel' : 'sparse';
    wins[w]++; winCalls[w] += r.n;
  }
  const singles = { exact: E, channel: C, sparse: S };
  const bestSingleName = Object.entries(singles).sort((x, y) => x[1] - y[1])[0][0];
  return { E, C, S, best, bestSingle: singles[bestSingleName], bestSingleName, margin: singles[bestSingleName] / best, worst: Math.max(E, C, S) / best, wins, winCalls };
};

const all = [];
for (const g of GAS) for (const a of AMORT) for (const k of KS) for (const cap of CAPS) all.push({ g, a, k, cap, ...evalGrid(g, a, k, cap) });

const margins = all.map(r => r.margin).sort((x, y) => x - y);
const q = (f) => margins[Math.floor((margins.length - 1) * f)];
console.log(`${all.length} parameter combinations (gas × amortisation × k × client cap)\n`);
console.log('selection vs the BEST single regime — ratio best-single / per-resource-selection');
console.log(`  min ${q(0).toFixed(2)}×  p25 ${q(.25).toFixed(2)}×  median ${q(.5).toFixed(2)}×  p75 ${q(.75).toFixed(2)}×  max ${q(1).toFixed(2)}×`);
console.log(`  combinations where selection strictly beats every single regime: ${all.filter(r => r.margin > 1.001).length} / ${all.length}`);
console.log(`  combinations where selection beats the best single by ≥ 1.2×: ${all.filter(r => r.margin >= 1.2).length}`);
const worsts = all.map(r => r.worst).sort((x, y) => x - y);
console.log(`\nselection vs the WORST single regime: min ${worsts[0].toFixed(1)}×  median ${worsts[Math.floor(worsts.length/2)].toFixed(1)}×  max ${worsts.at(-1).toFixed(1)}×`);
const names = {}; for (const r of all) names[r.bestSingleName] = (names[r.bestSingleName] || 0) + 1;
console.log('\nwhich single regime is best, over the grid:', Object.entries(names).map(([k, v]) => `${k} ${v}`).join(' | '));
console.log('  → no single regime is best across the grid' );
// always-exact penalty
const exPen = all.map(r => r.E / r.best).sort((x,y)=>x-y);
console.log(`\nalways-exact (what 97% of offers advertise) vs selection: min ${exPen[0].toFixed(1)}×  median ${exPen[Math.floor(exPen.length/2)].toFixed(1)}×  max ${exPen.at(-1).toFixed(1)}×`);
// regime mix stability
const spCalls = all.map(r => 100 * r.winCalls.sparse / rows.reduce((a, x) => a + x.n, 0)).sort((x,y)=>x-y);
const chCalls = all.map(r => 100 * r.winCalls.channel / rows.reduce((a, x) => a + x.n, 0)).sort((x,y)=>x-y);
console.log(`\nshare of calls routed to sparse:  min ${spCalls[0].toFixed(1)}%  median ${spCalls[Math.floor(spCalls.length/2)].toFixed(1)}%  max ${spCalls.at(-1).toFixed(1)}%`);
console.log(`share of calls routed to channel: min ${chCalls[0].toFixed(1)}%  median ${chCalls[Math.floor(chCalls.length/2)].toFixed(1)}%  max ${chCalls.at(-1).toFixed(1)}%`);

// One printed slice: gas fixed at 0.002, k=25 — margin by (amortisation, cap)
console.log('\nSlice: gas $0.002, k = 25 — best-single / selection (best single regime in parentheses)');
process.stdout.write('amort'.padEnd(8)); for (const cap of CAPS) process.stdout.write(`cap $${cap}`.padStart(16)); console.log();
for (const a of AMORT) {
  process.stdout.write(`${a} mo`.padEnd(8));
  for (const cap of CAPS) { const r = evalGrid(0.002, a, 25, cap); process.stdout.write(`${r.margin.toFixed(2)}× (${r.bestSingleName.slice(0,4)})`.padStart(16)); }
  console.log();
}
writeFileSync('sensitivity.json', JSON.stringify(all, null, 1));
