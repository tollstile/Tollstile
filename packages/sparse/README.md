# @tollstile/sparse

> **Experimental. Not published.** Reference implementation for *When Not to Settle Probabilistically: Sparse Settlement and Regime Selection for x402* (`research/sparse-settlement/`). It exists to put the ledger semantics, the retry rule and the regime selector under test — not to charge anyone with it.

Sparse settlement is a probabilistic payment for one-shot, sub-cent calls from a buyer who has deposited nothing anywhere: the buyer signs a ticket for `T`, and the ticket settles — one on-chain transfer of `T` — with probability `p / T`, decided inside the request. Expected revenue per call is `p`; realized is `T` or `0`; both are recorded.

What is here:

- `sparse({ facilitator, payTo, ticket })` — the rail. `createRail()` underneath: `authorization` flow, single-use tickets, `variableAmount` (odds only fall between signing and settling, so `upTo()` routes work), quotes carried in the ticket.
- `memoryFacilitator()` — an in-memory facilitator implementing commit–reveal, signature and threshold checks, balance checks, idempotent settlement, and the faults a rail must survive (lost settle response, failed settle, **selective abort**).
- `selectRegime()` — the deployable two-threshold rule of the paper's §6.
- `ticket.ts` — the four invariants as pure functions: `thresholdFor`, `digestOf`, `outcomeOf`, `commitmentOf`.

Also here: `contracts/SparseSettlementProxy.sol`, the on-chain verifier (a fork of `x402UptoPermit2Proxy`'s structure enforcing the invariants), and `pnpm --filter @tollstile/sparse gas`, which compiles it with solc and runs it in an in-process EVM against the real Permit2 bytecode from Base — a winning settlement is 72,829 gas for a repeat buyer and 89,917 for a one-shot buyer's first ticket, against 86,242 for a USDC EIP-3009 transfer on Base. The contract is unaudited and undeployed.

What is not here: a network facilitator or any on-chain transfer. The facilitator's "transfer" is a balance movement in memory; the signature is an HMAC-style stand-in for ecrecover; the digest stands in for an EIP-712 digest. The rail's contract with the runtime is what is being tested, not the chain.

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

## Live on Base Sepolia

`scripts/verify-live.ts` is the paper's §12.3: real tickets, real Permit2, a deployed `SparseSettlementProxy`, and a record of realized against expected on both sides plus the gas of every winner. Opt-in — no test reaches it — and it refuses to run on a mainnet. Keys are read once and never printed or written.

**Before the first run.** Two keys and one address:

1. `PAYER_KEY` — the buyer. Needs Base Sepolia **USDC** (a few dollars from [faucet.circle.com](https://faucet.circle.com), network *Base Sepolia*) and a **little ETH** for the one-time Permit2 approval (any Base Sepolia faucet, e.g. the Coinbase Developer Platform faucet; 0.001 ETH is plenty). The script performs the approval itself on the first run.
2. `FACILITATOR_KEY` — deploys the verifier and submits every winning settlement. Needs **ETH only** (deployment ≈ 0.7M gas plus ≈ 90k per winner; 0.01 ETH covers hundreds of wins). Reuse a deployment by passing `PROXY=0x…`.
3. `PAY_TO` — the merchant's address. Any address you control; winners' USDC lands here.

Make the keys with any wallet, or `openssl rand -hex 32` prefixed with `0x`, and keep them in a shell file that is not committed (`.env*` is git-ignored). Never paste them into a chat or a ticket.

```bash
PAYER_KEY=0x… FACILITATOR_KEY=0x… PAY_TO=0x… pnpm --filter @tollstile/sparse verify-live -- --preflight
```

checks balances, the allowance and the chain without signing anything, and says what is missing. Then:

```bash
PAYER_KEY=0x… FACILITATOR_KEY=0x… PAY_TO=0x… pnpm --filter @tollstile/sparse verify-live -- --tickets 500
```

Defaults: `--price 0.001`, `--ticket 0.10` (one win in a hundred, so 500 tickets ≈ 5 wins ≈ $0.50), `--record sparse-live-<date>.json`. A run that stops keeps its tickets in the record and resumes from there. The record lists its fields by hand — outcome, transaction, block, gas, transferred amount — and never a key or a signature.
