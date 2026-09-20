# Charge for what the work turned out to be worth

A research desk with one endpoint and one price ceiling. The caller authorizes **up to $0.05** before the desk starts; the desk answers; a judge says what the answer was worth; Tollstile settles **$0.01, $0.02, $0.04 — or nothing at all**.

```bash
pnpm --filter @tollstile-examples/jev-pricing start   # http://localhost:3000
pnpm --filter @tollstile-examples/jev-pricing agent   # in another terminal
```

```
"What do anglers say about fishing the bay?"
  authorized $0.05 → charged $0.01 (lookup, judged by rules)

"When is the next ferry refund due?"
  authorized $0.05 → charged $0.02 (synthesis, judged by rules)

"Should I book the Oshima ferry in September, given tides, swell and refunds?"
  authorized $0.05 → charged $0.04 (investigation, judged by rules)

"What is the capital of Mars?"
  authorized $0.05 → charged $0.00 (nothing was found for this question)

Authorized $0.05 four times over; paid $0.07 in total.
```

## What this example is about

`upTo()` prices exist because the work is not known when the money is authorized. The gate holds the ceiling, the handler calls `payment.fulfill({ amount })`, and only that amount settles. That leaves one question the protocol cannot answer: **what was the work worth?**

Counting tokens does not answer it. Two answers of the same length can be a fact restated and a week of reading. This example puts that decision behind an interface, `(work) => verdict`, and ships two implementations:

| Judge | What it is |
|---|---|
| `ruleJudge` | Thresholds on what the handler measured: sources read, characters written. No key, no network, deterministic. |
| `jevJudge` | [Jev](https://typesafe.ai), TypeSafe AI's System One model, asked two typed questions: *was this answered* (`noul`) and *how much work was it* (`score`, three levels). Returns probabilities and a confidence, no prose. |

Set `JEV_API_KEY` and the model prices the work; leave it unset and the rules do. **Nothing here breaks when the key expires** — every failure path falls back to the rules and says so in the response.

```bash
export JEV_API_KEY='…'   # a TypeSafe key, or a Vercel AI Gateway key (vck_…)
```

A key beginning `vck_` is a Vercel AI Gateway key, not a TypeSafe one; it goes to the gateway's compatibility endpoint under the model id `typesafe-ai/jev`. Sent to the wrong address it is a `401`, and the fallback quietly prices by rules — so the key's prefix picks the door.

### Or run the judge on your own machine

`POST /v1/systemone` is a small enough contract that servers implement it. [LocalJev](https://github.com/githubnext/localjev), from GitHub Next, speaks it in front of a local model:

```bash
# in the LocalJev checkout: Bun 1.2+, with an oMLX server running on :8000
bun install && bun run start        # listens on http://127.0.0.1:8080

# then, here:
export JEV_URL=http://127.0.0.1:8080/v1/systemone   # no key is sent
pnpm --filter @tollstile-examples/jev-pricing start
```

Nothing then leaves your machine — no question, no answer, no key. Two things to know before trusting it with money: LocalJev's probabilities are **reported by the model rather than read from its logits**, so the confidence that gates the price is softer than a hosted System One model's; and the tier boundaries this example uses were chosen against Jev's scale, not another judge's. Check both against your own examples before a local judge decides what to charge. [`us/jev-local`](https://github.com/us/jev-local) implements the same endpoint over open weights if you would rather not depend on a model server you also have to run.

## The seller's judge decides whether the seller gets paid

That is a conflict of interest, and the example treats it as one. Three rules, all enforced in code and covered by tests:

1. **Doubt costs the seller.** The score is a position on the three-level scale, so a confident judgement takes the nearest level — and one below a confidence of 0.6 rounds *down* instead. Uncertainty only ever moves the price toward the buyer.
2. **An unanswered question is free.** The handler answers `422`, which releases the hold: the caller is told why and pays nothing. Their authorization is still theirs to spend.
3. **The buyer is told.** Every response carries `pricing`: what was charged, what was authorized, the tier, the confidence, the reason, and **which judge and model version** decided.

```json
{
  "answered": true,
  "answer": "…",
  "pricing": {
    "charged": "$0.02",
    "authorized": "$0.05",
    "tier": "synthesis",
    "judgedBy": "jev-1.13.0",
    "confidence": 0.81,
    "reason": "judged 1.20 on the effort scale (lookup · synthesis · investigation) with confidence 0.81"
  }
}
```

A price nobody can question is a price nobody trusts. The tier is also what a refund argument would be about, and Tollstile can refund on rails that support it.

## What leaves your server

With `jevJudge`, one request per priced call goes to TypeSafe: **the question, the answer this server wrote, and three counts** (sources read, characters written, milliseconds spent). The fields are listed by hand in `src/jev.ts`; nothing joins them by accident, and a test asserts the exact set.

That is still customer text leaving your process. Decide whether it should — and if it should not, the same interface takes a judge that never leaves the building.

The pricing log is separate and narrower: charge id, counts, tier, amount, confidence, judge. **The question and the answer stay out of it**, because a pricing log is read by people who have no business reading them. A test checks that too.

## Files

| File | |
|---|---|
| `src/judge.ts` | The interface, the tiers, the two honesty rules, and the rule-based judge |
| `src/jev.ts` | The Jev call: what is sent, how the answer is read, and every path back to the rules |
| `src/app.ts` | The route: authorize a ceiling, do the work, settle the verdict, log one line |
| `src/research.ts` | The service being sold — a tiny local corpus, no network, no model |
| `test/pricing.test.ts` | Tiers, the unanswered case, the buyer's explanation, the log, and each fallback |

The example runs on `testRail()` and an in-memory ledger: no wallet, no account, no network. Swap in `x402()` or `mpp()` and the handler does not change — see [Rails](https://tollstile.com/docs/rails).

## Measured, not claimed

Against the real model, through the Vercel AI Gateway, on 20 September 2026 — the same four questions, from the deployed [demo](https://demo.tollstile.com/jev):

| Question | Jev's effort (0–2) | Confidence | Settled |
|---|---|---|---|
| What do anglers say about fishing? | 0.01 | 0.98 | $0.01 |
| How do the tide and the moon line up in Tokyo? | 0.95 | 0.75 | $0.02 |
| Should I book the ferry in September, given the swell and a refund? | 1.80 | 0.70 | $0.04 |
| What is the capital of Mars? | — | 0.91 | $0.00 |

Round trips were 1.1–1.7 s including the 402, the payment, the judgement and the ledger write. TypeSafe publishes no latency figure of its own, and the numbers in circulation are other people's measurements of other workloads — so record your own, with the model version the response carries, and the date.
