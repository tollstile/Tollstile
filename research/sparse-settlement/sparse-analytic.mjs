import { readFileSync } from 'node:fs';

/**
 * Sparse settlement over the observed month, analytically.
 *
 * Per resource i with price p_i, calls n_i and ticket T: wins ~ Binomial(n_i, q_i), q_i = p_i / T.
 *   expected settlements = Σ n_i q_i        (exact)
 *   aggregate realized   = Σ T · W_i        mean Σ n_i p_i, variance Σ T² n_i q_i (1 − q_i)   (exact)
 *   per resource, P(|W_i/(n_i q_i) − 1| ≤ 0.1) from the binomial CDF (exact for small n q, normal above).
 * A 10,000-run Monte Carlo cross-checks the aggregate.
 */
const items = JSON.parse(readFileSync(process.env.SNAPSHOT ?? './snapshots/bazaar-2026-09-20.json', 'utf8'));
const USDC = new Set(['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913','0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48','0x3c499c542cef5e3811e1192ce70d8cc03d5c3359','0xaf88d065e77c8cc2239327c5edb3a432268e5831','epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v']);
const resources = items.map((i) => {
  const o = i.accepts?.[0] ?? {};
  const price = USDC.has(String(o.asset ?? '').toLowerCase()) ? Number(o.maxAmountRequired ?? o.amount ?? 0) / 1e6 : null;
  return { price, n: i.quality?.l30DaysTotalCalls ?? 0 };
}).filter((r) => r.price !== null && r.price > 0 && r.price < 1000 && r.n > 0);

const N = resources.reduce((a, r) => a + r.n, 0);
const E = resources.reduce((a, r) => a + r.n * r.price, 0);
console.log(`priced active resources ${resources.length} (of ${items.length} listed) · calls ${N.toLocaleString()} · expected gross $${E.toFixed(2)}\n`);

// log Binomial pmf via lgamma
const lg = (x) => { // Lanczos
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, t = x + 5.5; t -= (x + 0.5) * Math.log(t); let s = 1.000000000190015; for (const ci of c) s += ci / ++y; return -t + Math.log(2.5066282746310005 * s / x);
};
const logPmf = (n, k, q) => lg(n + 1) - lg(k + 1) - lg(n - k + 1) + k * Math.log(q) + (n - k) * Math.log(1 - q);
const Phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
function erf(x) { const s = Math.sign(x); x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return s * y; }

/** P(|W/(nq) − 1| ≤ tol) for W ~ Binomial(n, q). */
function withinTolerance(n, q, tol = 0.1) {
  if (q >= 1) return 1; // deterministic
  const mu = n * q, lo = Math.ceil(mu * (1 - tol)), hi = Math.floor(mu * (1 + tol));
  if (hi < lo) return 0;
  if (mu > 2000) { const sd = Math.sqrt(n * q * (1 - q)); return Phi((hi + 0.5 - mu) / sd) - Phi((lo - 0.5 - mu) / sd); }
  let s = 0; for (let k = Math.max(0, lo); k <= Math.min(n, hi); k += 1) s += Math.exp(logPmf(n, k, q)); return s;
}

let seed = 1; const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const gauss = () => { const u = 1 - rand(), v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

for (const T of [0.1, 1, 10]) {
  let settlements = 0, variance = 0;
  const groups = { 'under 100': [], '100–999': [], '1,000+': [] };
  const perResource = [];
  for (const r of resources) {
    const ticket = Math.max(T, r.price), q = r.price / ticket;
    settlements += r.n * q;
    variance += ticket * ticket * r.n * q * (1 - q);
    const w = withinTolerance(r.n, q);
    perResource.push({ n: r.n, q, ticket, w });
    (r.n < 100 ? groups['under 100'] : r.n < 1000 ? groups['100–999'] : groups['1,000+']).push(w);
  }
  const sd = Math.sqrt(variance);
  // Monte Carlo cross-check of the aggregate: 10,000 runs, normal approximation per resource where n q is large, exact-ish Poisson where small.
  const runs = 10_000; const totals = new Array(runs).fill(0);
  for (const r of perResource) {
    const mu = r.n * r.q, s = Math.sqrt(r.n * r.q * (1 - r.q));
    for (let k = 0; k < runs; k += 1) {
      let w;
      if (r.q >= 1) w = r.n;                                   // priced above the ticket: settles every call, as today
      else if (mu > 30) w = Math.max(0, Math.round(mu + s * gauss()));
      else { // Poisson via Knuth for small means
        const L = Math.exp(-mu); let kk = 0, p = 1; do { kk += 1; p *= rand(); } while (p > L); w = kk - 1;
      }
      totals[k] += w * r.ticket;
    }
  }
  totals.sort((a, b) => a - b);
  const pct = (f) => totals[Math.floor(runs * f)];
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  console.log(`T = $${T}`);
  console.log(`  expected settlements ${Math.round(settlements).toLocaleString()} (1 in ${Math.round(N / settlements)}) · aggregate realized: mean $${E.toFixed(0)}, sd $${sd.toFixed(0)} (${(sd / E * 100).toFixed(1)}%), analytic 95% band $${(E - 1.96 * sd).toFixed(0)}–$${(E + 1.96 * sd).toFixed(0)}`);
  console.log(`  Monte Carlo 10,000 runs: p5 $${pct(0.05).toFixed(0)} · p50 $${pct(0.5).toFixed(0)} · p95 $${pct(0.95).toFixed(0)}`);
  for (const [g, ws] of Object.entries(groups)) {
    const share50 = (ws.filter((w) => w >= 0.5).length / ws.length * 100).toFixed(0);
    console.log(`  resources ${g.padEnd(9)} n=${String(ws.length).padStart(5)}  mean P(within ±10%) = ${(mean(ws) * 100).toFixed(0)}%   resources with P ≥ 0.5: ${share50}%`);
  }
  console.log();
}
