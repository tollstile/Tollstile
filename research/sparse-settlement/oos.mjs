// Out-of-sample regime selection: fix the rule's inputs on snapshot A, score cost on snapshot B.
// usage: node oos.mjs snapshots/bazaar-2026-09-20.json snapshots/bazaar-2026-10-21.json
import { readFileSync } from 'node:fs';
const [A, B] = process.argv.slice(2);
if (!A || !B) { console.error('usage: node oos.mjs <snapshotA.json> <snapshotB.json>'); process.exit(1); }
const USDC = new Set(['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913','0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48','0x3c499c542cef5e3811e1192ce70d8cc03d5c3359','0xaf88d065e77c8cc2239327c5edb3a432268e5831','epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v']);
const load = (f) => { const m = new Map(); for (const i of JSON.parse(readFileSync(f, 'utf8'))) { const o = i.accepts?.[0] ?? {}; const p = USDC.has(String(o.asset ?? '').toLowerCase()) ? Number(o.maxAmountRequired ?? o.amount ?? 0) / 1e6 : null; const n = i.quality?.l30DaysTotalCalls ?? 0, u = i.quality?.l30DaysUniquePayers ?? 0; if (p && p > 0 && p < 1000 && n > 0) m.set(i.resource ?? i.url, { p, n, u }); } return m; };
const a = load(A), b = load(B);
const G = 0.002, K = 25, CAP = 1;
const cost = { exact: (r) => r.n * G, channel: (r) => r.u * 2 * G + G, sparse: (r) => { const T = Math.max(r.p, Math.min(CAP, r.p * r.n / K)); return r.n * r.p / T * G; } };
const RULE = (r) => (r.n / r.u > 2) ? 'channel' : (r.u >= 100 && r.p <= 0.10) ? 'sparse' : 'exact';
let common = 0, E = 0, C = 0, S = 0, oracleB = 0, ruleA = 0, ruleB = 0, newB = 0;
for (const [k, rb] of b) { const ra = a.get(k); if (!ra) { newB++; continue; } common++;
  const e = cost.exact(rb), c = cost.channel(rb), s = cost.sparse(rb); E += e; C += c; S += s; oracleB += Math.min(e, c, s);
  ruleA += cost[RULE(ra)](rb);   // regime chosen from A's data, cost paid on B's traffic  ← the out-of-sample number
  ruleB += cost[RULE(rb)](rb);   // retrospective, for reference
}
console.log(`snapshot A: ${a.size} resources  snapshot B: ${b.size}  common: ${common}  new in B: ${newB}`);
console.log(`on B's traffic (common resources):`);
console.log(`  always-exact $${E.toFixed(0)}  always-channel $${C.toFixed(0)}  always-sparse $${S.toFixed(0)}`);
console.log(`  oracle on B $${oracleB.toFixed(0)}  |  rule fitted on B (retrospective) $${ruleB.toFixed(0)}  |  RULE FROM A applied to B (out-of-sample) $${ruleA.toFixed(0)}`);
const bs = Math.min(E, C, S); console.log(`  out-of-sample rule vs best single regime on B: ${(bs / ruleA).toFixed(2)}×  (${bs / ruleA > 1 ? 'rule wins' : 'rule loses'});  vs oracle: ${(ruleA / oracleB).toFixed(2)}×`);
