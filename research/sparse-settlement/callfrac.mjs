import { readFileSync } from 'node:fs';
const items = JSON.parse(readFileSync(process.env.SNAPSHOT ?? './snapshots/bazaar-2026-09-20.json', 'utf8'));
const USDC = new Set(['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913','0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48','0x3c499c542cef5e3811e1192ce70d8cc03d5c3359','0xaf88d065e77c8cc2239327c5edb3a432268e5831','epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v']);
const base = items.map((i) => { const o = i.accepts?.[0] ?? {}; return { p: USDC.has(String(o.asset ?? '').toLowerCase()) ? Number(o.maxAmountRequired ?? o.amount ?? 0) / 1e6 : null, n: i.quality?.l30DaysTotalCalls ?? 0, u: i.quality?.l30DaysUniquePayers ?? 0 }; })
  .filter((r) => r.p !== null && r.p > 0 && r.p < 1000 && r.n > 0);
// f = fraction of REPORTED calls that are actually settled payments. u is unaffected (a unique payer paid at least once).
const run = (f, g = 0.002, a = 1, k = 25, cap = 1) => {
  let E=0,C=0,S=0,best=0; const wc={exact:0,channel:0,sparse:0};
  for (const r0 of base) {
    const r = { p: r0.p, n: Math.max(1, Math.round(r0.n * f)), u: Math.min(r0.u, Math.max(1, Math.round(r0.n * f))) };
    const e = r.n*g, c = r.u*2*g/a + g, T = Math.max(r.p, Math.min(cap, r.p*r.n/k)), s = r.n*r.p/T*g;
    E+=e; C+=c; S+=s; best += Math.min(e,c,s);
    const w = e<=c&&e<=s?'exact':c<=s?'channel':'sparse'; wc[w]+=r.n;
  }
  const bs = Math.min(E,C,S), bsn = E===bs?'exact':C===bs?'channel':'sparse';
  return { f, E, C, S, best, margin: bs/best, bsn, exactPen: E/best, sparseCalls: 100*wc.sparse/Object.values(wc).reduce((a,b)=>a+b,0) };
};
console.log('\nIf only a fraction f of REPORTED calls are settled payments (gas $0.002, a=1mo, k=25, cap $1):\n');
console.log('f'.padEnd(7),'exact'.padStart(8),'channel'.padStart(8),'sparse'.padStart(8),'select'.padStart(8),'best-single/select'.padStart(20),'always-exact/select'.padStart(21));
for (const f of [1, 0.5, 0.25, 0.1, 0.05]) { const r = run(f);
  console.log(String(f).padEnd(7), ('$'+r.E.toFixed(0)).padStart(8), ('$'+r.C.toFixed(0)).padStart(8), ('$'+r.S.toFixed(0)).padStart(8), ('$'+r.best.toFixed(0)).padStart(8), `${r.margin.toFixed(2)}× (${r.bsn})`.padStart(20), `${r.exactPen.toFixed(1)}×`.padStart(21)); }
// full grid re-run at f=0.1
const GAS=[0.0005,0.002,0.01],AM=[1,3,6,12],KS=[10,25,100],CP=[0.05,0.10,1,5];
for (const f of [1, 0.25, 0.1]) {
  const ms=[]; let allWin=0, n=0, names={};
  for (const g of GAS) for (const a of AM) for (const k of KS) for (const cap of CP) { const r=run(f,g,a,k,cap); ms.push(r.margin); n++; if(r.margin>1.001) allWin++; names[r.bsn]=(names[r.bsn]||0)+1; }
  ms.sort((x,y)=>x-y);
  console.log(`\nf=${f}: selection beats every single regime in ${allWin}/${n} combos; margin min ${ms[0].toFixed(2)}× median ${ms[Math.floor(ms.length/2)].toFixed(2)}× max ${ms.at(-1).toFixed(2)}×; best-single identity: ${Object.entries(names).map(([k,v])=>k+' '+v).join(', ')}`);
}
