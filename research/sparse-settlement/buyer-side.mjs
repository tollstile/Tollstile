import { readFileSync } from 'node:fs';
const items = JSON.parse(readFileSync(process.env.SNAPSHOT ?? './snapshots/bazaar-2026-09-20.json', 'utf8'));
const USDC = new Set(['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913','0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48','0x3c499c542cef5e3811e1192ce70d8cc03d5c3359','0xaf88d065e77c8cc2239327c5edb3a432268e5831','epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v']);
const rows = items.map((i) => { const o = i.accepts?.[0] ?? {}; return { price: USDC.has(String(o.asset ?? '').toLowerCase()) ? Number(o.maxAmountRequired ?? o.amount ?? 0) / 1e6 : null, n: i.quality?.l30DaysTotalCalls ?? 0, u: i.quality?.l30DaysUniquePayers ?? 0 }; })
  .filter((r) => r.price !== null && r.price > 0 && r.price < 1000 && r.n > 0);
const oneshot = rows.filter(r => r.n / Math.max(1, r.u) <= 2);
const sub = oneshot.filter(r => r.price < 0.01);
function erf(x){const s=Math.sign(x);x=Math.abs(x);const t=1/(1+0.3275911*x);return s*(1-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-0.284496736)*t+0.254829592)*t*Math.exp(-x*x));}
const cdf=(x)=>0.5*(1+erf(x/Math.SQRT2));
function pWithin(n,q,tol=0.1){ if(q>=1) return 1; const mu=n*q, sd=Math.sqrt(n*q*(1-q)); if(mu<=2000){ // exact binomial
  let lo=Math.ceil(mu*(1-tol)-1e-9), hi=Math.floor(mu*(1+tol)+1e-9); let p=0; let logC=0; // iterate
  let pk=Math.pow(1-q,n); let acc=0; for(let k=0;k<=n;k++){ if(k>=lo&&k<=hi) acc+=pk; pk*= (n-k)/(k+1)*q/(1-q); if(k>hi) break; } return acc; }
  return cdf((mu*(1+tol)-mu)/sd)-cdf((mu*(1-tol)-mu)/sd); }
console.log(`one-shot cell (calls/payer<=2): ${oneshot.length} resources, calls ${oneshot.reduce((a,r)=>a+r.n,0)}, gross $${oneshot.reduce((a,r)=>a+r.n*r.price,0).toFixed(0)}, payer-resource pairs ${oneshot.reduce((a,r)=>a+r.u,0)}`);
console.log(`  sub-cent subset: ${sub.length} resources, calls ${sub.reduce((a,r)=>a+r.n,0)}, gross $${sub.reduce((a,r)=>a+r.n*r.price,0).toFixed(2)}, pairs ${sub.reduce((a,r)=>a+r.u,0)}`);
console.log('\nSub-cent one-shot cell under a client-side cap T_c (ticket = min(T_c, p·n/k), k=25); buyer m=1');
console.log('T_c      settle   x-fewer  merchant meanP(±10%)  buyer: max loss   P(pay>0) at p=$0.001  P(pay>0) at p=$0.005');
for (const Tc of [0.01, 0.05, 0.10, 1.00]) {
  let settle=0, ps=[]; for (const r of sub) { const T=Math.max(r.price, Math.min(Tc, r.price*r.n/25)); const q=r.price/T; settle+=r.n*q; ps.push(pWithin(r.n,q)); }
  const calls=sub.reduce((a,r)=>a+r.n,0);
  console.log(`$${Tc.toFixed(2).padEnd(6)} ${settle.toFixed(0).padStart(7)} ${(calls/settle).toFixed(1).padStart(8)}x  ${(100*ps.reduce((a,b)=>a+b,0)/ps.length).toFixed(0).padStart(6)}%              $${Tc.toFixed(2)}          ${(100*Math.min(1,0.001/Tc)).toFixed(0)}%                    ${(100*Math.min(1,0.005/Tc)).toFixed(0)}%`);
}
console.log('\nWhole population, ticket = min(T_c, p·n/k) k=25 — settlements vs uncapped');
for (const Tc of [0.10, 1, 10, Infinity]) { let s=0; for (const r of rows) { const T=Math.max(r.price, Math.min(Tc, r.price*r.n/25)); s+=r.n*r.price/T; } console.log(`T_c=${Tc}`.padEnd(14), s.toFixed(0)); }
// buyer-side variance for a repeat buyer m calls
console.log('\nBuyer relative sd 1/sqrt(m q): p=$0.01, T=$1 (q=0.01)');
for (const m of [1,10,100,1000,10000]) console.log(`m=${String(m).padEnd(6)} sd_rel ${(1/Math.sqrt(m*0.01)).toFixed(2)}  P(pay 0)=${Math.pow(0.99,m).toExponential(2)}`);
