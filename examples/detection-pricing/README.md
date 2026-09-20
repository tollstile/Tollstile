# Pay for what was found

"Find every solar panel in this image." Nobody knows what that costs until it runs, and the detector that answers also scores its own answers. This example authorizes a ceiling, runs the detector, has **something else look at each crop**, and charges only for the detections that survive.

```bash
pnpm --filter @tollstile-examples/detection-pricing start   # http://localhost:3100
pnpm --filter @tollstile-examples/detection-pricing agent   # in another terminal
```

```
"find a solar panel" — authorized $0.20
  detector proposed 6, verifier kept 4 at p ≥ 0.7
    ✓ 40,48 56×34          detector 0.99  verifier 0.90
    ✓ 108,48 56×34         detector 0.99  verifier 0.90
    · 210,60 34×28         detector 0.96  verifier 0.15
    · 262,60 34×28         detector 0.96  verifier 0.15
    ✓ 40,92 56×34          detector 0.99  verifier 0.90
    ✓ 300,196 64×38        detector 0.99  verifier 0.90
  charged $0.04 · verified by rules · 16 ms
```

The two rows that were not charged for are **skylights**. The detector is sure about them — `0.96` — because they are dark blue rectangles on a roof, which is what its rule for "panel" says. Billing per detection on the detector's own confidence would have charged for six. That is the whole point of the example: a count scored by the seller's model is the seller marking their own homework.

## What is here

| File | |
|---|---|
| `src/scene.ts` | The image, drawn rather than downloaded: four panels, two skylights that look like panels, a pool that does not. No dataset, no licence, no network, and the same result every run. |
| `src/detect.ts` | The detector — connected regions of dark blue — and the confidence it gives its own work. |
| `src/verify.ts` | The second opinion. `ruleVerifier` uses geometry; `modelVerifier` asks a vision model one yes/no question per crop and reads the probability **out of the token logprobs** rather than asking the model to state its own certainty. |
| `src/app.ts` | The route: authorize `$0.20`, detect, verify, settle `$0.01` per survivor, `422` and release when none survive. |
| `test/detection.test.ts` | The detector over-detecting, the price following the verifier and not the detector, the empty result releasing the hold, and the billing log carrying no image data. |

## Verify with a model instead of the rules

The rule verifier is the floor: it knows panels here are wider and larger than skylights, and nothing else. A vision model can be asked the actual question. Any [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) key works:

```bash
export AI_GATEWAY_API_KEY='…'     # never committed, never logged
pnpm --filter @tollstile-examples/detection-pricing start
```

Each crop becomes one request with `max_tokens: 1` and `logprobs: true`, and the charge depends on `p(yes)` read from the distribution over that single token. A model that writes `"confidence": 0.95` is guessing at its own certainty; a token probability is measured. Questions are independent, so the crops go out in parallel.

Ask for something that is not there, and nothing is charged:

```bash
pnpm --filter @tollstile-examples/detection-pricing agent -- --target 'a helipad'
```

## On a real photograph

The drawn scene keeps the example honest and offline; a photograph needs a model at both ends. One proposes regions, another looks at each crop:

```bash
export AI_GATEWAY_API_KEY='…'
pnpm --filter @tollstile-examples/detection-pricing photo -- ~/Pictures/street.jpg 'a car'
```

`DETECTOR_MODEL` and `VERIFIER_MODEL` choose them (`meta/llama-4-maverick` proposing and `openai/gpt-4o-mini` checking, by default). Keeping them from different vendors is the point: a model grading its own output is the thing this pattern exists to avoid. `DETECTOR_URL` points the proposer somewhere else entirely — Meta's own API speaks the same shape at `https://api.llama.com/compat/v1/chat/completions`.

Images are read and cropped with `ffmpeg`, so no image library is pulled in, and nothing but the crop for one detection is ever sent anywhere.

## The rules this encodes

1. **The buyer is billed on the verifier, never on the detector.** Tested.
2. **Nothing found is free.** No survivors answers `422`, which releases the hold; the caller keeps the authorization.
3. **The threshold is published.** `p ≥ 0.7` is in the response, with every detection's two numbers — what the detector said, what the verifier said — so a disputed invoice is a conversation about evidence.
4. **A detection that could not be checked is not charged for.** A verifier that times out or errors scores `0`, which costs the seller rather than the buyer.
5. **The billing log holds counts and probabilities, never the image.** Tested.

## What has actually been run

The output above is a real run of this example: the detector, the rule verifier, `upTo()`, and a settlement of `$0.04` against a `$0.20` ceiling on the test rail. The model verifier is exercised in tests against a stubbed gateway — the logprob arithmetic, the failure paths — but **the numbers a real vision model gives on real imagery are not measured here**, and they are the ones that decide whether this pricing scheme is fair. Measure them on your own images before charging anyone: how often the verifier agrees with a person, and what it costs per image.

The pattern, and when not to use it, is written up in [Charge for what was found](https://tollstile.com/docs/guides/charge-for-what-was-found).
