import { readFileSync, writeFileSync } from 'node:fs';
const items = JSON.parse(readFileSync(process.env.SNAPSHOT ?? './snapshots/bazaar-2026-09-20.json', 'utf8'));
const USDC = new Set(['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913','0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48','0x3c499c542cef5e3811e1192ce70d8cc03d5c3359','0xaf88d065e77c8cc2239327c5edb3a432268e5831','epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v']);
const base = items.map((i) => { const o = i.accepts?.[0] ?? {}; return { p: USDC.has(String(o.asset ?? '').toLowerCase()) ? Number(o.maxAmountRequired ?? o.amount ?? 0) / 1e6 : null, n: i.quality?.l30DaysTotalCalls ?? 0, u: i.quality?.l30DaysUniquePayers ?? 0 }; })
  .filter((r) => r.p !== null && r.p > 0 && r.p < 1000 && r.n > 0);

// Feasible stress transform: paid calls can't be fewer than unique payers.
const stress = (f) => base.map(r => ({ p: r.p, u: r.u, n: Math.max(r.u, Math.round(r.n * f)) }));

// Fixed two-threshold rule — thresholds frozen at the paper's central assumptions, NOT re-tuned per scenario.
const RULE = (r) => (r.n / r.u > 2) ? 'channel' : (r.u >= 100 && r.p <= 0.10) ? 'sparse' : 'exact';

const GAS = [0.0005, 0.002, 0.01], AMORT = [1, 3, 6, 12], KS = [10, 25, 100], CAPS = [0.05, 0.10, 1, 5], MULT = [1, 2];
function run(rows, g, a, k, cap, m) {
  const c = { exact: (r) => r.n * g, channel: (r) => (r.u * 2 * g * m) / a + g * m, sparse: (r) => { const T = Math.max(r.p, Math.min(cap, r.p * r.n / k)); return (r.n * r.p / T) * g * m; } };
  let E = 0, C = 0, S = 0, oracle = 0, rule = 0;
  for (const r of rows) { const e = c.exact(r), ch = c.channel(r), sp = c.sparse(r); E += e; C += ch; S += sp; oracle += Math.min(e, ch, sp); rule += c[RULE(r)](r); }
  const singles = { exact: E, channel: C, sparse: S }; const bsName = Object.entries(singles).sort((x, y) => x[1] - y[1])[0][0];
  return { E, C, S, oracle, rule, bestSingle: singles[bsName], bsName };
}
for (const f of [1, 0.25, 0.1]) {
  const rows = stress(f); const out = [];
  for (const g of GAS) for (const a of AMORT) for (const k of KS) for (const cap of CAPS) for (const m of MULT) out.push({ g, a, k, cap, m, ...run(rows, g, a, k, cap, m) });
  const wins = out.filter(o => o.rule < o.bestSingle).length;
  const margins = out.map(o => o.bestSingle / o.rule).sort((x, y) => x - y);
  const gap = out.map(o => o.rule / o.oracle).sort((x, y) => x - y);
  const losses = out.filter(o => o.rule >= o.bestSingle);
  console.log(`\nf = ${f} (n_paid = max(u, f·n)) — ${out.length} scenarios (gas × amort × k × cap × contract-gas ×1/×2)`);
  console.log(`  FIXED RULE beats the best single regime in ${wins} / ${out.length}`);
  console.log(`  best-single / rule: min ${margins[0].toFixed(2)}× median ${margins[Math.floor(margins.length / 2)].toFixed(2)}× max ${margins.at(-1).toFixed(2)}×`);
  console.log(`  rule / oracle (how far the deployable rule is from the bound): min ${gap[0].toFixed(2)}× median ${gap[Math.floor(gap.length / 2)].toFixed(2)}× max ${gap.at(-1).toFixed(2)}×`);
  console.log(`  rule vs always-exact: min ${Math.min(...out.map(o => o.E / o.rule)).toFixed(1)}× median ${out.map(o => o.E / o.rule).sort((x, y) => x - y)[Math.floor(out.length / 2)].toFixed(1)}×`);
  if (losses.length) { const by = {}; for (const l of losses) { const key = `amort=${l.a}mo`; by[key] = (by[key] || 0) + 1; } console.log(`  where the rule loses (${losses.length}): ${Object.entries(by).map(([k, v]) => `${k}: ${v}`).join(', ')}; loses to: ${[...new Set(losses.map(l => l.bsName))].join(', ')}; worst shortfall ${Math.max(...losses.map(l => l.rule / l.bestSingle)).toFixed(2)}×`); }
  if (f === 1) writeFileSync('fixed-selector.json', JSON.stringify(out, null, 1));
}
// central case
const c = run(stress(1), 0.002, 1, 25, 1, 1);
console.log(`\ncentral (gas $0.002, 1mo, k=25, cap $1, ×1): exact $${c.E.toFixed(0)} channel $${c.C.toFixed(0)} sparse $${c.S.toFixed(0)} | rule $${c.rule.toFixed(0)} | oracle $${c.oracle.toFixed(0)}`);
// the f-stress recurrence table, feasible version, for §1.2
console.log('\n§1.2 table, feasible transform:');
for (const f of [1, 0.5, 0.25, 0.1]) { const rows = stress(f); const tot = rows.reduce((a, r) => a + r.n, 0); const rep = rows.filter(r => r.n / r.u > 2).reduce((a, r) => a + r.n, 0); const lb = rows.reduce((a, r) => a + Math.max(0, 2 * r.u - r.n), 0); const pairs = rows.reduce((a, r) => a + r.u, 0); console.log(`  f=${f}: repeat share of calls ${(100 * rep / tot).toFixed(1)}%, provable single-call floor ${(100 * lb / pairs).toFixed(1)}%`); }
