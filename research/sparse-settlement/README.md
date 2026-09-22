# Sparse settlement / regime selection — research scripts

Companion to `paper-v0.9.md` (earlier drafts kept alongside). Not part of the published packages. The reference rail is `packages/sparse` (`pnpm vitest run packages/sparse`).

- `fetch-bazaar.mjs` — pulls the CDP Bazaar discovery index in full into `snapshots/bazaar-<date>.json` (`OUT=` to override).
- All analysis scripts read `SNAPSHOT=<path>` (default `snapshots/bazaar-2026-09-20.json`).
- `quadrant.mjs` recurrence × price split · `sparse-analytic.mjs` merchant-side variance · `buyer-side.mjs` client caps · `region2.mjs` the (n, p) figure · `misselect.mjs` regime cost table · `sensitivity.mjs` oracle sweep · `fixed-selector.mjs` deployable-rule sweep (§6) · `callfrac.mjs` / `review-fixes.mjs` call-definition and bound checks.
- `gas-benchmark.json` — output of `pnpm --filter @tollstile/sparse gas -- --json` (§6, §12).
- `oos.mjs A B` — out-of-sample test: rule fixed on snapshot A, cost scored on snapshot B (§11 v). Needs two snapshots ≥ 30 days apart.

```bash
node fetch-bazaar.mjs
SNAPSHOT=snapshots/bazaar-2026-10-21.json node fixed-selector.mjs
node oos.mjs snapshots/bazaar-2026-09-20.json snapshots/bazaar-2026-10-21.json
```
