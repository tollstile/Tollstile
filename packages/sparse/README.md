# @tollstile/sparse

> **Experimental. Not published.** Reference implementation for *When Not to Settle Probabilistically: Sparse Settlement and Regime Selection for x402* (`research/sparse-settlement/`). It exists to put the ledger semantics, the retry rule and the regime selector under test — not to charge anyone with it.

Sparse settlement is a probabilistic payment for one-shot, sub-cent calls from a buyer who has deposited nothing anywhere: the buyer signs a ticket for `T`, and the ticket settles — one on-chain transfer of `T` — with probability `p / T`, decided inside the request. Expected revenue per call is `p`; realized is `T` or `0`; both are recorded.

What is here:

- `sparse({ facilitator, payTo, ticket })` — the rail. `createRail()` underneath: `authorization` flow, single-use tickets, `variableAmount` (odds only fall between signing and settling, so `upTo()` routes work), quotes carried in the ticket.
- `memoryFacilitator()` — an in-memory facilitator implementing commit–reveal, signature and threshold checks, balance checks, idempotent settlement, and the faults a rail must survive (lost settle response, failed settle, **selective abort**).
- `selectRegime()` — the deployable two-threshold rule of the paper's §6.
- `ticket.ts` — the four invariants as pure functions: `thresholdFor`, `digestOf`, `outcomeOf`, `commitmentOf`.

What is not here: a Permit2 verifier contract, a network facilitator, or any on-chain transfer. The facilitator's "transfer" is a balance movement in memory; the signature is an HMAC-style stand-in for ecrecover; the digest stands in for an EIP-712 digest. The rail's contract with the runtime is what is being tested, not the chain.

```ts
import { createTollstile, memoryLedger, upTo } from 'tollstile';
import { memoryFacilitator, sparse } from '@tollstile/sparse';

const facilitator = memoryFacilitator();
const toll = createTollstile({
  rails: [sparse({ facilitator, payTo: '0xmerchant', ticket: '$1' })],
  ledger: memoryLedger(),
  secret: process.env.TOLLSTILE_SECRET,
});
// toll.price('$0.01') → a 402 whose `accepts` carries ticket, price, threshold, commitment, challengeId
```

Tests: `pnpm vitest run packages/sparse` — the rail conformance suite, plus the mechanism's own: expected vs realized over many tickets, odds enforcement, replay, the selective-abort retry rule, concurrent spend against one balance, and the selector against the paper's numbers.
