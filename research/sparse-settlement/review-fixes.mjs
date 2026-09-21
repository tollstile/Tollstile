import { readFileSync } from 'node:fs';
const items = JSON.parse(readFileSync(process.env.SNAPSHOT ?? './snapshots/bazaar-2026-09-20.json', 'utf8'));
const USDC = new Set(['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913','0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48','0x3c499c542cef5e3811e1192ce70d8cc03d5c3359','0xaf88d065e77c8cc2239327c5edb3a432268e5831','epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v']);
const rows = items.map((i) => { const o = i.accepts?.[0] ?? {}; const schemes = (i.accepts ?? []).map(a => a.scheme === 'batch-settlement' ? 'batch' : a.extra?.name === 'GatewayWalletBatched' ? 'gateway' : a.scheme); return { p: USDC.has(String(o.asset ?? '').toLowerCase()) ? Number(o.maxAmountRequired ?? o.amount ?? 0) / 1e6 : null, n: i.quality?.l30DaysTotalCalls ?? 0, u: i.quality?.l30DaysUniquePayers ?? 0, schemes }; })
  .filter((r) => r.p !== null && r.p > 0 && r.p < 1000 && r.n > 0);
const N = rows.reduce((a, r) => a + r.n, 0), PAIRS = rows.reduce((a, r) => a + r.u, 0);

// ---- MC1: rigorous lower bound on single-call payers. With n calls over u payers (each >=1), at most n-u payers have >=2 calls, so >= 2u-n have exactly 1.
let lb = 0, lbSub = 0, lbAll = 0;
for (const r of rows) { const one = Math.max(0, 2 * r.u - r.n); lbAll += one; if (r.n / r.u <= 2) { lb += one; if (r.p < 0.01) lbSub += one; } }
console.log('MC1 — provable lower bound on payers who made EXACTLY one call (2u − n per resource):');
console.log(`  all resources: ≥ ${lbAll.toLocaleString()} of ${PAIRS.toLocaleString()} pairs (${(100*lbAll/PAIRS).toFixed(1)}%)`);
console.log(`  low-recurrence resources (mean ≤ 2): ≥ ${lb.toLocaleString()} (${(100*lb/PAIRS).toFixed(1)}% of all pairs) vs the ${rows.filter(r=>r.n/r.u<=2).reduce((a,r)=>a+r.u,0).toLocaleString()} pairs previously called "one-shot"`);
console.log(`  low-recurrence AND sub-cent: ≥ ${lbSub.toLocaleString()} (${(100*lbSub/PAIRS).toFixed(1)}%) vs 23,991 previously claimed`);
const exact1 = rows.filter(r => r.n === r.u); console.log(`  resources where n == u (every payer made exactly one call, no inference needed): ${exact1.length}, pairs ${exact1.reduce((a,r)=>a+r.u,0).toLocaleString()}`);

// ---- MC2: advertised vs used. Calls at resources advertising batch or gateway = UPPER bound on calls that could have used them.
const adv = rows.filter(r => r.schemes.includes('batch') || r.schemes.includes('gateway'));
console.log(`\nMC2 — resources advertising batch-settlement or Gateway: ${adv.length}; their calls ${adv.reduce((a,r)=>a+r.n,0).toLocaleString()} = ${(100*adv.reduce((a,r)=>a+r.n,0)/N).toFixed(2)}% of index calls → an UPPER bound on the share of calls that could have settled on those schemes`);
const advOnly = adv.filter(r => !r.schemes.includes('exact') || r.schemes.every(s => s === 'batch' || s === 'gateway'));
console.log(`  of those, advertising ONLY batch/gateway (no plain exact alongside): ${advOnly.length} resources, ${advOnly.reduce((a,r)=>a+r.n,0).toLocaleString()} calls`);

// ---- MC3: oracle vs implementable selectors
const G = 0.002, K = 25, CAP = 1;
const cost = { exact: (r) => r.n * G, channel: (r) => r.u * 2 * G + G, sparse: (r) => { const T = Math.max(r.p, Math.min(CAP, r.p * r.n / K)); return r.n * r.p / T * G; } };
const total = (pick) => rows.reduce((a, r) => a + cost[pick(r)](r), 0);
const oracle = rows.reduce((a, r) => a + Math.min(cost.exact(r), cost.channel(r), cost.sparse(r)), 0);
// fixed two-threshold rule using only coarse, advance-knowable features
const rule = (r) => (r.n / r.u > 2) ? 'channel' : (r.u >= 100 && r.p <= 0.1) ? 'sparse' : 'exact';
const ruleCost = total(rule);
// noisy forecast: selector sees n,u perturbed by lognormal noise; evaluated on true n,u
let seed = 11; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const gauss = () => { const a = rnd() || 1e-9, b = rnd(); return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * b); };
console.log('\nMC3 — oracle vs implementable selectors (gas $0.002, k=25, cap $1):');
console.log(`  always-exact $975 | oracle per-resource best $${oracle.toFixed(0)} | fixed 2-threshold rule (recurrence>2→channel; u≥100 & p≤$0.1→sparse; else exact) $${ruleCost.toFixed(0)}`);
for (const sigma of [0.5, 1.0, 1.5]) {
  let acc = 0; const R = 20;
  for (let t = 0; t < R; t++) {
    acc += rows.reduce((a, r) => { const f = { p: r.p, n: Math.max(1, r.n * Math.exp(sigma * gauss())), u: Math.max(1, r.u * Math.exp(sigma * gauss())) }; const c = { exact: cost.exact(f), channel: cost.channel(f), sparse: cost.sparse(f) }; const w = Object.entries(c).sort((x, y) => x[1] - y[1])[0][0]; return a + cost[w](r); }, 0);
  }
  console.log(`  selector fed forecasts with lognormal σ=${sigma} (${sigma===0.5?'±65%':sigma===1?'×/÷2.7':'×/÷4.5'} typical error): $${(acc / R).toFixed(0)} (mean of 20 draws)`);
}

// ---- MC4: sparse settlement costs more gas than an EIP-3009 transfer (contract + witness). Multiplier on sparse & channel contract calls.
console.log('\nMC4 — gas multiplier for contract-path settlements (sparse verifier, channel claim/sweep) relative to an EIP-3009 transfer:');
for (const m of [1, 1.5, 2, 3]) {
  const c2 = { exact: (r) => r.n * G, channel: (r) => r.u * 2 * G * m + G * m, sparse: (r) => { const T = Math.max(r.p, Math.min(CAP, r.p * r.n / K)); return r.n * r.p / T * G * m; } };
  let E = 0, C = 0, S = 0, B = 0; const names = { exact: 0, channel: 0, sparse: 0 };
  for (const r of rows) { const e = c2.exact(r), c = c2.channel(r), s = c2.sparse(r); E += e; C += c; S += s; B += Math.min(e, c, s); names[e <= c && e <= s ? 'exact' : c <= s ? 'channel' : 'sparse'] += r.n; }
  const bs = Math.min(E, C, S);
  console.log(`  ×${m}: exact $${E.toFixed(0)} channel $${C.toFixed(0)} sparse $${S.toFixed(0)} | oracle $${B.toFixed(0)} | best-single/oracle ${(bs / B).toFixed(2)}× | calls→sparse ${(100 * names.sparse / N).toFixed(1)}%`);
}
