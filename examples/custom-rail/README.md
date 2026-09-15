# Custom rail example

A complete payment rail for **Acme**, an imaginary card-style provider, built with `createRail()` and proven with the conformance kit. Use it as the starting point for your own protocol or provider. The step-by-step walkthrough is [Build a rail](https://tollstile.com/docs/rails/build-a-rail).

| File | What it is |
|---|---|
| `src/acme-rail.ts` | The rail: `offer`, `challenge`, `verify`, `settle`, `lookup`, `refund`, `receipt`, with every contract rule commented |
| `src/acme-provider.ts` | An in-memory stand-in for Acme's HTTP API, with idempotency keys, lookups, and two faults: a lost response and a failure before any effect |
| `test/conformance.test.ts` | `railConformance()` against the fake provider |
| `test/rail.test.ts` | A 402, a payment, a capture, and an underpaid authorization refused |
| `src/demo.ts` | The whole flow in one process, printed |

## Run it

From the repository root, with Node 22.12+ and pnpm 9:

```bash
pnpm install
pnpm --filter @tollstile-examples/custom-rail demo
pnpm vitest run examples/custom-rail
```

Expected demo output:

```
Route GET /report
  pricing: fixed, quote bound to: route
  access: everyone pays
  requirements: none
  rails:
    acme: authorization flow, settles after handler, single authorization, fixed amounts, release on handler failure

402 payment_required: 250000 micro-USD
admitted: payer agent-7
completed: settled, receipt [["acme-receipt","cap_2"]], captures 1
```

## Make it yours

1. Replace `acme-provider.ts` calls with your provider's API, keeping the same shape: idempotency keys on effects, a way to list what happened.
2. Adjust `capabilities` to what your protocol can really do. `toll.explain(gate)` shows how routes use them.
3. Keep the fake provider for tests, and keep every conformance case passing. Try breaking the rail — send a random idempotency key from `settle` — and watch two cases fail.
4. Verify against the provider's sandbox before publishing, and record what you ran.

Nothing here talks to a real provider.
