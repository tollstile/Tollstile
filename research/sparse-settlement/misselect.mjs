import { readFileSync } from 'node:fs';
const items = JSON.parse(readFileSync(process.env.SNAPSHOT ?? './snapshots/bazaar-2026-09-20.json', 'utf8'));
const USDC = new Set(['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913','0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48','0x3c499c542cef5e3811e1192ce70d8cc03d5c3359','0xaf88d065e77c8cc2239327c5edb3a432268e5831','epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v']);
const rows = items.map((i) => { const o = i.accepts?.[0] ?? {}; return { p: USDC.has(String(o.asset ?? '').toLowerCase()) ? Number(o.maxAmountRequired ?? o.amount ?? 0) / 1e6 : null, n: i.quality?.l30DaysTotalCalls ?? 0, u: i.quality?.l30DaysUniquePayers ?? 0 }; })
  .filter((r) => r.p !== null && r.p > 0 && r.p < 1000 && r.n > 0);
const GAS = 0.002, K = 25, TC = 1;
const oneshot = (r) => r.n / Math.max(1, r.u) <= 2;
const cost = {
  exact: (r) => r.n * GAS,
  channel: (r) => r.u * 2 * GAS + GAS,          // one deposit + one withdraw per payer, one sweep per resource
  sparse: (r) => { const T = Math.max(r.p, Math.min(TC, r.p * r.n / K)); return r.n * r.p / T * GAS; },
};
const cells = {};
for (const r of rows) {
  const k = `${oneshot(r) ? 'one-shot' : 'repeat'} / ${r.p < 0.01 ? 'sub-cent' : '≥ $0.01'}`;
  const c = cells[k] ??= { res: 0, calls: 0, gross: 0, exact: 0, channel: 0, sparse: 0, best: 0 };
  c.res++; c.calls += r.n; c.gross += r.n * r.p;
  const e = cost.exact(r), ch = cost.channel(r), sp = cost.sparse(r);
  c.exact += e; c.channel += ch; c.sparse += sp; c.best += Math.min(e, ch, sp);
}
console.log(`Settlement gas per regime, 30 days (transfer $${GAS}; channel = 2 tx/payer + 1 sweep/resource; sparse T=min($${TC}, p·n/${K}))\n`);
console.log('cell'.padEnd(22), 'gross'.padStart(8), 'exact'.padStart(7), 'channel'.padStart(8), 'sparse'.padStart(7), 'best'.padStart(7), '  cheapest');
let tot = { exact: 0, channel: 0, sparse: 0, best: 0, gross: 0 };
for (const [k, c] of Object.entries(cells).sort()) {
  const best = Object.entries({ exact: c.exact, channel: c.channel, sparse: c.sparse }).sort((a, b) => a[1] - b[1])[0][0];
  console.log(k.padEnd(22), ('$'+c.gross.toFixed(0)).padStart(8), ('$'+c.exact.toFixed(0)).padStart(7), ('$'+c.channel.toFixed(0)).padStart(8), ('$'+c.sparse.toFixed(0)).padStart(7), ('$'+c.best.toFixed(0)).padStart(7), '  ' + best);
  for (const kk of ['exact','channel','sparse','best','gross']) tot[kk] += c[kk];
}
console.log('\nindex total'.padEnd(23), ('$'+tot.gross.toFixed(0)).padStart(8), ('$'+tot.exact.toFixed(0)).padStart(7), ('$'+tot.channel.toFixed(0)).padStart(8), ('$'+tot.sparse.toFixed(0)).padStart(7), ('$'+tot.best.toFixed(0)).padStart(7));
console.log('\nmisselection cost vs per-resource best:');
for (const k of ['exact','channel','sparse']) console.log(`  always ${k}`.padEnd(18), `$${tot[k].toFixed(0)}`, `(${(tot[k]/tot.best).toFixed(1)}× the best policy, ${(100*tot[k]/tot.gross).toFixed(1)}% of gross)`);
console.log('  per-resource best'.padEnd(18), `$${tot.best.toFixed(0)}`, `(${(100*tot.best/tot.gross).toFixed(1)}% of gross)`);
// how many resources does each regime win?
const wins = { exact: 0, channel: 0, sparse: 0 }, winCalls = { exact: 0, channel: 0, sparse: 0 };
for (const r of rows) { const c = { exact: cost.exact(r), channel: cost.channel(r), sparse: cost.sparse(r) }; const w = Object.entries(c).sort((a,b)=>a[1]-b[1])[0][0]; wins[w]++; winCalls[w] += r.n; }
console.log('\nregime chosen per resource:', Object.entries(wins).map(([k,v])=>`${k} ${v} res / ${winCalls[k].toLocaleString()} calls`).join(' | '));
