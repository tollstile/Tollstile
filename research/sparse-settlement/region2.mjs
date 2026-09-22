import { readFileSync, writeFileSync } from 'node:fs';
const items = JSON.parse(readFileSync(process.env.SNAPSHOT ?? './snapshots/bazaar-2026-09-20.json', 'utf8'));
const USDC = new Set(['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913','0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48','0x3c499c542cef5e3811e1192ce70d8cc03d5c3359','0xaf88d065e77c8cc2239327c5edb3a432268e5831','epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v']);
const rows = items.map((i) => { const o = i.accepts?.[0] ?? {}; return { p: USDC.has(String(o.asset ?? '').toLowerCase()) ? Number(o.maxAmountRequired ?? o.amount ?? 0) / 1e6 : null, n: i.quality?.l30DaysTotalCalls ?? 0, u: i.quality?.l30DaysUniquePayers ?? 0 }; })
  .filter((r) => r.p !== null && r.p > 0 && r.p < 1000 && r.n > 0);
const oneshot = (r) => r.n / Math.max(1, r.u) <= 2;
const os = rows.filter(oneshot);
const CAPS = [['$1 — x402 reference client default', 1, '#1f77b4'], ['$0.05 — Coinbase Agentic Wallet docs example', 0.05, '#d62728']];
for (const K of [10, 25, 100]) {
  console.log(`\nk = ${K} (merchant target wins/month), reduction = min(Tc, p·n/k)/p`);
  for (const [lab, Tc] of CAPS) {
    for (const R of [10, 50]) {
      const inr = os.filter(r => Math.max(r.p, Math.min(Tc, r.p * (1 + r.n / K))) / r.p >= R);
      const all = rows.filter(r => Math.max(r.p, Math.min(Tc, r.p * (1 + r.n / K))) / r.p >= R);
      console.log(`  ${lab.padEnd(46)} ≥${R}×: one-shot ${String(inr.length).padStart(4)} res / ${String(inr.reduce((a,r)=>a+r.n,0)).padStart(6)} calls | all ${String(all.length).padStart(5)} res / ${all.reduce((a,r)=>a+r.n,0)} calls`);
    }
  }
}
// n threshold for 10x at each cap, k=25
console.log('\nn needed for a 10x reduction at k=25:  n >= 10·k = 250 (independent of p), and p <= Tc/10');
for (const [lab, Tc] of CAPS) console.log(`  ${lab}: p <= $${(Tc/10).toFixed(4)} → one-shot resources meeting both: ${os.filter(r=>r.n>=225 && r.p<=Tc/10).length}`);

// Figure
const W=780,H=540,L=76,R=22,Tp=54,B=62;
const lx = (n) => L + (Math.log10(Math.max(1,n))/Math.log10(2e5))*(W-L-R);
const ly = (p) => Tp + (1 - (Math.log10(p)+4)/(Math.log10(1000)+4))*(H-Tp-B);
let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, sans-serif" font-size="11"><rect width="${W}" height="${H}" fill="#fff"/>`;
for (const [lab, Tc, col] of CAPS) {
  const x0 = lx(225), y0 = ly(Tc/10);
  svg += `<rect x="${x0}" y="${y0}" width="${W-R-x0}" height="${ly(1e-4)-y0}" fill="${col}" opacity="0.15"/><line x1="${x0}" y1="${y0}" x2="${W-R}" y2="${y0}" stroke="${col}" stroke-width="1.2"/><text x="${x0+7}" y="${y0+14}" fill="${col}" font-size="11">T_client = ${lab}</text>`;
}
svg += `<line x1="${lx(225)}" y1="${Tp}" x2="${lx(225)}" y2="${H-B}" stroke="#666" stroke-dasharray="3 3"/><text x="${lx(225)+5}" y="${Tp+12}" fill="#666" font-size="10">n = k(R−1) = 225</text>`;
svg += `<line x1="${L}" y1="${H-B}" x2="${W-R}" y2="${H-B}" stroke="#333"/><line x1="${L}" y1="${Tp}" x2="${L}" y2="${H-B}" stroke="#333"/>`;
for (const n of [1,10,100,1000,1e4,1e5]) svg += `<line x1="${lx(n)}" y1="${H-B}" x2="${lx(n)}" y2="${H-B+4}" stroke="#333"/><text x="${lx(n)}" y="${H-B+16}" text-anchor="middle">${n.toLocaleString()}</text>`;
for (const p of [1e-4,1e-3,1e-2,1e-1,1,10,100]) svg += `<line x1="${L-4}" y1="${ly(p)}" x2="${L}" y2="${ly(p)}" stroke="#333"/><text x="${L-8}" y="${ly(p)+4}" text-anchor="end">$${p>=1?p:p}</text>`;
svg += `<text x="${(L+W-R)/2}" y="${H-B+34}" text-anchor="middle" font-size="12">reported calls in 30 days (n)</text><text transform="translate(18,${(Tp+H-B)/2}) rotate(-90)" text-anchor="middle" font-size="12">advertised price (p)</text>`;
let seed=7; const rnd=()=> (seed=(seed*1103515245+12345)%2147483648)/2147483648;
const counts={}; for (const r of os) { const k=`${r.n}|${r.p}`; counts[k]=(counts[k]||0)+1; }
for (const [k,c] of Object.entries(counts)) { const [n,p]=k.split('|').map(Number); svg += `<circle cx="${lx(n)+(rnd()-0.5)*2.5}" cy="${ly(p)+(rnd()-0.5)*2.5}" r="${Math.min(6,1.4+Math.log10(c)*1.6)}" fill="#222" opacity="0.42"/>`; }
svg += `<text x="${L}" y="22" font-size="13" font-weight="bold">Where a sparse ticket cuts settlements ≥ 10× at k = 25</text>`;
svg += `<text x="${L}" y="38" font-size="11" fill="#555">${os.length.toLocaleString()} one-shot resources (≤ 2 calls per payer); dot area ∝ log count at that (n, p)</text>`;
for (const [i,[lab,Tc,col]] of CAPS.entries()) svg += `<text x="${W-R}" y="${H-B-8-i*15}" text-anchor="end" font-size="11" fill="${col}">inside ${lab.split(' —')[0]}: ${os.filter(r=>r.n>=225&&r.p<=Tc/10).length} resources</text>`;
svg += `</svg>`;
writeFileSync('fig-region.svg', svg);
