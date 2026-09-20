# Pay for what was found

"Find every solar panel in this image." Nobody knows what that costs until it runs, and the detector that answers also scores its own answers. This example authorizes a ceiling, runs the detector, has **something else look at each crop**, and charges only for the detections that survive.

```bash
pnpm --filter @tollstile-examples/detection-pricing start   # http://localhost:3100
pnpm --filter @tollstile-examples/detection-pricing agent   # in another terminal
```

```
"find a solar panel" — authorized $0.20
  detector proposed 6, verifier kept 4 at p ≥ 0.9
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

## On a real photograph, with SAM 3

```bash
export FAL_KEY='…' AI_GATEWAY_API_KEY='…'
pnpm --filter @tollstile-examples/detection-pricing photo -- street.jpg car
```

A real run, on a photograph of a suburban intersection with three cars in it:

![Three cars boxed, each labelled with SAM's score, the judge's probability, and the cent charged](https://tollstile.com/img/detection-cars.jpg)

```
"find every car" in street.jpg (1024×768)
  fal-ai/sam-3 proposed 3 in 2067 ms
    ✓ 138,580 347×114        proposer 0.97  judge 0.99  "A gray sedan parked on the street."
    ✓ 437,555 229×89         proposer 0.97  judge 0.98  "A dark gray SUV parked beside another car."
    ✓ 311,564 125×34         proposer 0.93  judge 0.96  "A white vehicle partially obscured by a gray car."
  checked in 38520 ms by typesafe-ai/jev · kept 3 of 3 at p ≥ 0.9
  authorized $0.20 · charged $0.03
```

And the case a flat fee gets wrong:

```
"find every bicycle" — fal-ai/sam-3 proposed 0 in 1353 ms
  authorized $0.20 · charged $0.00
```

**Three models, none of them marking their own homework.**

- **SAM 3** (`fal-ai/sam-3`) takes the noun phrase and returns every instance, with a mask, a box and its own score. It is confident — `0.97` — and the price depends on none of that.
- **A vision model** says what each crop *shows*, in one sentence. It did not choose the crop.
- **Jev**, a System One model, says whether that sentence is the thing the buyer asked for, as a calibrated probability. The charge is the survivors at `p ≥ 0.9` — a threshold chosen from the measurement below, not from taste.

The two stages exist because neither model can do the job alone. A vision model will not give you a number: through this gateway `logprobs` come back empty — for text as well as images — and a model that *states* its own confidence is guessing at it. Jev answers with a probability but cannot see. Describe, then decide.

### Is the judge earning its place?

Measured on seven crops of the same photograph — the three cars, plus a wheel, a traffic light, a palm tree and bare road:

| crop | truth | vision model, yes/no | describe → Jev | describe → general LLM |
|---|---|---|---|---|
| grey sedan | car | yes ✓ | 0.99 ✓ | 1.00 ✓ |
| dark SUV | car | yes ✓ | 0.98 ✓ | 1.00 ✓ |
| white car, half hidden | car | yes ✓ | 0.98 ✓ | 1.00 ✓ |
| **front wheel only** | **not a car** | **yes ✗** | **0.85 ✗** | **1.00 ✗** |
| traffic light | not a car | no ✓ | 0.02 ✓ | 0.00 ✓ |
| palm tree | not a car | no ✓ | 0.01 ✓ | 0.00 ✓ |
| empty road | not a car | no ✓ | 0.03 ✓ | 0.00 ✓ |
| | | **6 / 7** | **6 / 7** | **6 / 7** |

**Equal on accuracy. Not equal on what you can do about it.** All three are wrong about the wheel, but only the judge is *unsure* — 0.85, against a confident yes from the other two. The cars sit at 0.98 and above, so moving the threshold to `0.9` makes that column 7 / 7 and leaves the rest untouched. A yes/no has no such knob.

That is the whole argument for the second stage, and it rests on seven crops of one photograph. Run it on yours before believing it.

Thirty-eight seconds for three crops is not the models being slow: the gateway team used here allows **five vision calls a minute**, so the crops queue. On a paid tier they go out together. `SPACING_MS` in `src/second-opinion.ts` is the knob.

Without `FAL_KEY`, the proposer falls back to a vision model asked for boxes — which is worse at it, and a useful demonstration of why a segmentation model exists. Images are read and cropped with `ffmpeg`; nothing but one detection's crop leaves the machine at a time.

## The rules this encodes

1. **The buyer is billed on the verifier, never on the detector.** Tested.
2. **Nothing found is free.** No survivors answers `422`, which releases the hold; the caller keeps the authorization.
3. **The threshold is published.** `p ≥ 0.9` is in the response, with every detection's two numbers — what the detector said, what the verifier said — so a disputed invoice is a conversation about evidence.
4. **A detection that could not be checked is not charged for.** A verifier that times out or errors scores `0`, which costs the seller rather than the buyer.
5. **The billing log holds counts and probabilities, never the image.** Tested.

## What has actually been run

Both outputs above are real runs, on 20 September 2026: the drawn scene with the rule verifier, and the photograph through SAM 3, a vision model and Jev. Money moved on the test rail — `$0.04` and `$0.03` against `$0.20` ceilings, and `$0.00` for the bicycle.

What is **not** established is accuracy at any scale. Three cars in one photograph, agreed on by two models, is an anecdote. Before this decides anyone's invoice, measure the thing that matters: how often the judge agrees with a person, over enough images to mean something, including the ones where the answer is arguable — a car reflected in a window, a van, a photograph of a car on a billboard. Publish that number next to the price.

The pattern, and when not to use it, is written up in [Charge for what was found](https://tollstile.com/docs/guides/charge-for-what-was-found).
