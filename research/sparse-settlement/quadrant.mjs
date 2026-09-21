import { readFileSync } from 'node:fs';
const items = JSON.parse(readFileSync(process.env.SNAPSHOT ?? './snapshots/bazaar-2026-09-20.json', 'utf8'));
const USDC = new Set(['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913','0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48','0x3c499c542cef5e3811e1192ce70d8cc03d5c3359','0xaf88d065e77c8cc2239327c5edb3a432268e5831','epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v']);
const rows = items.map((i) => { const o = i.accepts?.[0] ?? {}; return { price: USDC.has(String(o.asset ?? '').toLowerCase()) ? Number(o.maxAmountRequired ?? o.amount ?? 0) / 1e6 : null, n: i.quality?.l30DaysTotalCalls ?? 0, u: i.quality?.l30DaysUniquePayers ?? 0 }; })
  .filter((r) => r.price !== null && r.price > 0 && r.price < 1000 && r.n > 0);
const N = rows.reduce((a, r) => a + r.n, 0), E = rows.reduce((a, r) => a + r.n * r.price, 0);
console.log(`resources ${rows.length} calls ${N} gross ${E.toFixed(0)}`);
// 2x2: recurrence (calls per payer) x price
for (const cut of [2, 5, 10]) {
  const cells = {};
  for (const r of rows) {
    const cpp = r.n / Math.max(1, r.u);
    const rec = cpp > cut ? 'repeat' : 'oneshot';
    const pr = r.price < 0.01 ? 'subcent' : 'cent+';
    const k = `${rec}/${pr}`; cells[k] ??= { res: 0, calls: 0, rev: 0, payers: 0 };
    cells[k].res++; cells[k].calls += r.n; cells[k].rev += r.n * r.price; cells[k].payers += r.u;
  }
  console.log(`\ncalls/payer > ${cut} = repeat`);
  for (const [k, v] of Object.entries(cells).sort()) console.log(`${k.padEnd(16)} res ${String(v.res).padStart(6)} (${(100*v.res/rows.length).toFixed(1)}%)  calls ${String(v.calls).padStart(7)} (${(100*v.calls/N).toFixed(1)}%)  rev $${v.rev.toFixed(0).padStart(6)} (${(100*v.rev/E).toFixed(1)}%)  payers ${v.payers}`);
}
// one-shot (cpp<=2) resources by volume
const os = rows.filter(r => r.n / Math.max(1, r.u) <= 2);
const byVol = (g) => ({ res: g.length, calls: g.reduce((a, r) => a + r.n, 0), rev: g.reduce((a, r) => a + r.n * r.price, 0) });
console.log('\none-shot (cpp<=2) by volume');
for (const [lo, hi, lab] of [[0,100,'<100'],[100,1000,'100-999'],[1000,1e9,'1000+']]) { const g = os.filter(r => r.n >= lo && r.n < hi); const s = byVol(g); console.log(lab.padEnd(8), s.res, s.calls, '$' + s.rev.toFixed(0)); }
console.log('one-shot 1000+ detail', os.filter(r => r.n >= 1000).map(r => `p=${r.price} n=${r.n} u=${r.u}`).join(' | '));
// resources with many payers regardless
const manyPayers = rows.filter(r => r.u >= 100);
console.log('\nresources with >=100 unique payers:', manyPayers.length, manyPayers.map(r => `p=${r.price} n=${r.n} u=${r.u} cpp=${(r.n/r.u).toFixed(1)}`).join(' | '));
// unique payers overall distribution
const uu = rows.map(r => r.u).sort((a,b)=>a-b); console.log('\nunique payers per resource p50', uu[Math.floor(uu.length/2)], 'p90', uu[Math.floor(uu.length*.9)], 'p99', uu[Math.floor(uu.length*.99)], 'max', uu.at(-1), 'share with u==1', (100*uu.filter(x=>x===1).length/uu.length).toFixed(1));
