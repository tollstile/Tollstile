# Live verification on Base Sepolia

`verify-live.ts` runs the `upto` scheme against a real facilitator and a real chain, and writes a record of what happened. It exists because the fake-provider tests cannot prove that a signature this rail asks for is one the facilitator will settle, or that a lost settlement can be recovered from the chain. Proposed in [#37](https://github.com/tollstile/tollstile/issues/37).

It is opt-in: no test run, no CI job, and no `pnpm test` reaches it. It signs real payments on a testnet, refuses to run on a mainnet, and spends at most 7 cents of testnet USDC per full run.

## What it checks

| Scenario | Ends as |
|---|---|
| `success` | a payment below the authorization cap settles for what the handler fulfilled, not the cap |
| `replay` | the same signature sent again is `409 proof_already_used`, with no charge and no transfer |
| `retry` | a handler that fails releases the reservation; the same signature then settles exactly once |
| `lost-settle` | the facilitator settles, the answer is lost, `reconcile()` finds the transfer on chain and sends no second `/settle` |
| `dropped-settle` | the facilitator never sees `/settle`; the authorization expires and the charge fails with nothing moved |

Every scenario reads the settlement's own transaction receipt and fails the run if the transfer is not from the payer to the receiver, if it is above the authorized cap, or if it is not the amount the handler fulfilled.

## Before the first run

1. **Two wallets.** A payer and a receiver (`PAY_TO`). They must be different addresses.
2. **USDC.** Fund the payer with Base Sepolia USDC from [faucet.circle.com](https://faucet.circle.com). Half a dollar is plenty.
3. **A little ETH.** For the one-time Permit2 approval below. Any Base Sepolia faucet.
4. **Approve Permit2 once.** `upto` moves money through Permit2, so the payer must approve it for USDC:

   ```bash
   cast send 0x036CbD53842c5426634e7929541eC2318f3dCF7e \
     "approve(address,uint256)" 0x000000000022D473030F116dDEE9F6B43aC78BA3 1000000 \
     --rpc-url https://sepolia.base.org --private-key "$PAYER_KEY"
   ```

Check all of it without signing anything:

```bash
PAYER_KEY=0x… PAY_TO=0x… TOLLSTILE_SECRET=$(openssl rand -hex 24) \
  pnpm --filter @tollstile/x402 verify-live -- --preflight
```

Preflight reads the chain id, the token's decimals, both balances, the Permit2 allowance, and the facilitator's own `/supported` — including the `upto` spender address, which is read there and never taken from configuration, because signing against a stale one fails only at settlement, after the service was delivered.

## Running it

```bash
PAYER_KEY=0x… PAY_TO=0x… TOLLSTILE_SECRET=$(openssl rand -hex 24) \
  pnpm --filter @tollstile/x402 verify-live
```

| Variable | Default |
|---|---|
| `PAYER_KEY` | required; the payer's private key, read once and never printed or written |
| `PAY_TO` | required; the receiver |
| `TOLLSTILE_SECRET` | required; signs quotes, and must stay the same across a resumed run |
| `NETWORK` | `eip155:84532` |
| `RPC_URL` | `https://sepolia.base.org` |
| `FACILITATOR_URL` | `https://x402.org/facilitator` |

| Flag | |
|---|---|
| `--preflight` | check readiness and stop |
| `--scenario <name>` | run one scenario |
| `--record <path>` | where the record and its ledger go (default `x402-live-eip155-84532.json`) |
| `--timeout <minutes>` | how long a single wait for the chain may take (default 15) |

The last two scenarios wait for finality — minutes on Base Sepolia, and the expiry case also waits for the authorization's deadline to pass. A run that times out keeps its charge ids in the record: **run it again with the same `--record` and it resumes rather than paying again.**

## What it writes

A JSON record beside a SQLite ledger. Every field in the record is listed by hand in `lib/record.ts`: scenario, state, HTTP status, denial code, transaction hash, block number, the transferred amount in atomic units, and the authorized cap. Nothing is spread or serialized from a charge, a payload, or an HTTP exchange, so a key, a signature, or payer evidence cannot reach the file by someone adding a property elsewhere. The ledger next to it is a working file, not part of the record.

A passing record belongs in the x402 README, under **Live verification status**.
