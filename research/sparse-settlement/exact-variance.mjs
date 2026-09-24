/**
 * Everything §4–§6 depends on, with the EXACT binomial coefficient of variation.
 *
 *   CV = sqrt(n q (1-q)) / (n q) = sqrt((1-q)/(n q)),  q = p/T
 *      = sqrt((T/p - 1) / n)
 *   CV <= c   <=>   T <= p (1 + c^-2 / n^-1) = p (1 + n/k),  k = 1/c^2
 *
 * The earlier drafts used T <= p n / k, dropping the +1. The correction is one term, but it
 * changes the region boundary (n >= k(R-1), not kR) and makes "variance forces T = p" false.
 */
import { readFileSync } from 'node:fs';
const items = JSON.parse(readFileSync(process.env.SNAPSHOT ?? './snapshots/bazaar-2026-09-20.json', 'utf8'));
const USDC = new Set(['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913','0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48','0x3c499c542cef5e3811e1192ce70d8cc03d5c3359','0xaf88d065e77c8cc2239327c5edb3a432268e5831','epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v']);
const rows = items.map((i) => { const o = i.accepts?.[0] ?? {}; return { p: USDC.has(String(o.asset ?? '').toLowerCase()) ? Number(o.maxAmountRequired ?? o.amount ?? 0) / 1e6 : null, n: i.quality?.l30DaysTotalCalls ?? 0, u: i.quality?.l30DaysUniquePayers ?? 0 }; })
  .filter((r) => r.p !== null && r.p > 0 && r.p < 1000 && r.n > 0);

const K = 25;                       // tolerance: CV <= 20%
const GAS = 0.002;                  // $ per transaction unit
const E3009 = 86242, S_ONE = 95859 / E3009, S_REP = 78771 / E3009, A = 46403 / E3009;  // measured ratios
const lowRec = (r) => r.n / Math.max(1, r.u) <= 2;
const sOf = (r) => (lowRec(r) ? S_ONE : S_REP);

/** Exact variance bound, then the client cap. T_policy is the merchant's and is not modelled here. */
const ticketFor = (r, cap, k = K) => Math.max(r.p, Math.min(cap, r.p * (1 + r.n / k)));
const reduction = (r, cap, k = K) => ticketFor(r, cap, k) / r.p;

console.log('=== (1) exact vs approximate bound');
for (const n of [1, 10, 100, 225, 250, 1000, 10000]) console.log(`  n=${String(n).padStart(5)}: exact T/p <= ${(1 + n / K).toFixed(2)}   approx (old) ${(n / K).toFixed(2)}`);
console.log(`  10x reduction needs n >= k(R-1) = ${K * 9} (the drafts said ${K * 10})`);

console.log('\n=== (2) the region: low-recurrence resources with reduction >= 10x');
const lr = rows.filter(lowRec);
for (const [label, cap] of [['$1 (x402 reference default)', 1], ['$0.05 (agent-wallet docs)', 0.05]]) {
  const inR = lr.filter((r) => reduction(r, cap) >= 10);
  const old = lr.filter((r) => Math.max(r.p, Math.min(cap, r.p * r.n / K)) / r.p >= 10);
  console.log(`  cap ${label}: n >= 225 and p <= ${(cap / 10).toFixed(4)} -> ${inR.length} of ${lr.length} (old approximation: ${old.length}); their calls ${inR.reduce((a, r) => a + r.n, 0).toLocaleString()} = ${(100 * inR.reduce((a, r) => a + r.n, 0) / rows.reduce((a, r) => a + r.n, 0)).toFixed(1)}% of index calls`);
}
for (const k of [10, 100]) console.log(`  at k=${k} (CV ${(100 / Math.sqrt(k)).toFixed(0)}%), cap $1: ${lr.filter((r) => reduction(r, 1, k) >= 10).length} resources`);
console.log(`  demanding 50x at k=25, cap $1: ${lr.filter((r) => reduction(r, 1) >= 50).length} resources`);
// f-robustness
for (const f of [0.5, 0.25, 0.1]) {
  const stressed = rows.map((r) => ({ ...r, n: Math.max(r.u, Math.round(r.n * f)) })).filter(lowRec);
  console.log(`  f=${f}: ${stressed.filter((r) => reduction(r, 1) >= 10).length} in region (cap $1)`);
}

console.log('\n=== (3) the cell: 4,716 low-recurrence sub-cent resources — what the ticket actually achieves');
const cell = rows.filter((r) => lowRec(r) && r.p < 0.01);
const red = cell.map((r) => reduction(r, 1)).sort((a, b) => a - b);
console.log(`  reduction T/p: min ${red[0].toFixed(2)} median ${red[Math.floor(red.length / 2)].toFixed(2)} p90 ${red[Math.floor(red.length * 0.9)].toFixed(2)} max ${red.at(-1).toFixed(2)}`);
for (const t of [1.1, 1.5, 2, 10]) console.log(`  resources reaching ${t}x: ${cell.filter((r) => reduction(r, 1) >= t).length} of ${cell.length}`);
// break-even first-time share with the measured ratios
const phi = (r, cap = 1) => (r.n / Math.max(1, r.u)) * (1 - sOf(r) * r.p / ticketFor(r, cap)) / A;
const ph = cell.map((r) => phi(r)).sort((a, b) => a - b);
console.log(`  phi* (s=${S_ONE.toFixed(2)}, a=${A.toFixed(2)}): median ${ph[Math.floor(ph.length / 2)].toFixed(2)}; phi*<=0 (never beats exact): ${ph.filter((x) => x <= 0).length}; phi*>=1 (beats exact with all-new buyers): ${ph.filter((x) => x >= 1).length}`);
const reg = lr.filter((r) => reduction(r, 1) >= 10);
const pr = reg.map((r) => phi(r)).sort((a, b) => a - b);
console.log(`  region resources: phi* median ${pr[Math.floor(pr.length / 2)].toFixed(2)}, >=1: ${pr.filter((x) => x >= 1).length}/${pr.length}`);

console.log('\n=== (4) cost table (measured gas ratios, exact variance bound)');
const cells = {};
let tot = { gross: 0, exact: 0, channel: 0, sparse: 0, best: 0 };
for (const r of rows) {
  const key = `${lowRec(r) ? 'low-recurrence' : 'repeat'} / ${r.p < 0.01 ? 'sub-cent' : '>= $0.01'}`;
  const c = (cells[key] ??= { gross: 0, exact: 0, channel: 0, sparse: 0, best: 0 });
  const e = r.n * GAS, ch = r.u * 2 * GAS + GAS, sp = (r.n * r.p / ticketFor(r, 1)) * GAS * sOf(r);
  c.gross += r.n * r.p; c.exact += e; c.channel += ch; c.sparse += sp; c.best += Math.min(e, ch, sp);
  tot.gross += r.n * r.p; tot.exact += e; tot.channel += ch; tot.sparse += sp; tot.best += Math.min(e, ch, sp);
}
for (const [k, c] of Object.entries(cells).sort()) console.log(`  ${k.padEnd(26)} gross $${c.gross.toFixed(0).padStart(5)} | exact $${c.exact.toFixed(0).padStart(3)} channel $${c.channel.toFixed(0).padStart(3)} sparse $${c.sparse.toFixed(0).padStart(3)} | best $${c.best.toFixed(0)}`);
console.log(`  ${'index'.padEnd(26)} gross $${tot.gross.toFixed(0)} | exact $${tot.exact.toFixed(0)} channel $${tot.channel.toFixed(0)} sparse $${tot.sparse.toFixed(0)} | oracle $${tot.best.toFixed(0)}`);
// with one-shot approvals charged
for (const p of [0.5, 1]) { let s = 0, b = 0; for (const r of rows) { const e = r.n * GAS, ch = r.u * 2 * GAS + GAS, sp = (r.n * r.p / ticketFor(r, 1)) * GAS * sOf(r) + (lowRec(r) ? p * r.u * A * GAS : 0); s += sp; b += Math.min(e, ch, sp); } console.log(`  approvals at phi=${p}: always-sparse $${s.toFixed(0)}, oracle $${b.toFixed(0)}`); }

console.log('\n=== (5) the deployable rule, exact bound, 288 scenarios x 3 call fractions');
const RULE = (r) => (r.n / Math.max(1, r.u) > 2 ? 'channel' : r.u >= 100 && r.p <= 0.10 ? 'sparse' : 'exact');
for (const f of [1, 0.25, 0.1]) {
  const base = rows.map((r) => ({ ...r, n: Math.max(r.u, Math.round(r.n * f)) }));
  const out = [];
  for (const g of [0.0005, 0.002, 0.01]) for (const am of [1, 3, 6, 12]) for (const k of [10, 25, 100]) for (const cap of [0.05, 0.10, 1, 5]) for (const m of [1, 2]) {
    let E = 0, C = 0, S = 0, oracle = 0, rule = 0;
    for (const r of base) {
      const cost = { exact: r.n * g, channel: (r.u * 2 * g * m) / am + g * m, sparse: (r.n * r.p / ticketFor(r, cap, k)) * g * m };
      E += cost.exact; C += cost.channel; S += cost.sparse; oracle += Math.min(cost.exact, cost.channel, cost.sparse); rule += cost[RULE(r)];
    }
    const singles = { exact: E, channel: C, sparse: S }; const bs = Object.entries(singles).sort((a, b) => a[1] - b[1])[0];
    out.push({ rule, oracle, bestSingle: bs[1], bsName: bs[0], exact: E, am });
  }
  const wins = out.filter((o) => o.rule < o.bestSingle);
  const marg = out.map((o) => o.bestSingle / o.rule).sort((a, b) => a - b);
  const gap = out.map((o) => o.rule / o.oracle).sort((a, b) => a - b);
  const names = {}; for (const o of out) names[o.bsName] = (names[o.bsName] ?? 0) + 1;
  const losses = out.filter((o) => o.rule >= o.bestSingle);
  const byAm = {}; for (const l of losses) byAm[`${l.am}mo`] = (byAm[`${l.am}mo`] ?? 0) + 1;
  console.log(`  f=${f}: rule beats best single in ${wins.length}/${out.length}; margin min ${marg[0].toFixed(2)} median ${marg[Math.floor(marg.length / 2)].toFixed(2)} max ${marg.at(-1).toFixed(2)}; rule/oracle ${gap[0].toFixed(2)}-${gap.at(-1).toFixed(2)}; best single: ${Object.entries(names).map(([k2, v]) => `${k2} ${v}`).join(', ')}; losses by amortisation: ${JSON.stringify(byAm)}`);
}
const central = (() => { let E = 0, C = 0, S = 0, o = 0, ru = 0; for (const r of rows) { const c = { exact: r.n * GAS, channel: r.u * 2 * GAS + GAS, sparse: (r.n * r.p / ticketFor(r, 1)) * GAS }; E += c.exact; C += c.channel; S += c.sparse; o += Math.min(c.exact, c.channel, c.sparse); ru += c[RULE(r)]; } return { E, C, S, o, ru }; })();
console.log(`  central (gas $0.002, 1mo, k=25, cap $1, gas ratio 1): exact $${central.E.toFixed(0)} channel $${central.C.toFixed(0)} sparse $${central.S.toFixed(0)} oracle $${central.o.toFixed(0)} rule $${central.ru.toFixed(0)}`);
