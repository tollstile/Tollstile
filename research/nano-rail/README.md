# Nano (XNO) as a feeless settlement rail — cost picture

Research note, not product. Companion to the rail-abstraction in the core (`createRail()`);
no published package depends on it. The claim it measures: a Nano (XNO) settlement rail, added
beside x402 (Base USDC) and MPP (Stripe), removes the fee-and-gas floor on the smallest agent
payments, because a Nano send has no fee, no gas, and no relayer.

## What a Nano settlement actually is

- A Nano send is a single signed **state block** the payer publishes itself. There is no
  sponsored transaction, no relayer signer, no nonce manager, and no gas for the buyer to hold.
- There is no fee of any kind, so the payer's balance drop and the payee's balance rise are the
  **same integer** — nothing to reconcile with `amount - fee`.
- Finality is a state-block confirmation (~0.3 s with one confirmation on the live network), and
  settlement is final-by-publication: once the block is confirmed, the ledger state IS the receipt.

## What that removes in Tollstile terms

Every network Tollstile can be paid on today goes through a facilitator/relayer for the same
structural reason: the buyer cannot move value without native gas, so the facilitator holds a
signer, sponsors the transfer, and submits it. On a `nano:mainnet` rail that reason is absent:

- the "sponsor the transfer" step disappears (the payer funds its own send),
- the **settle** step has no on-chain work (nothing to relay), so an honest implementation exposes
  `verify` and reports settlement as final-by-publication,
- the credit/refund flow reduces to a reverse signed block.

A Nano rail is therefore the smallest `createRail()` implementation in the set — not a port of one.

## The measured gap it closes

Sub-cent agent payments are the case that motivated this rail set. On Base USDC the caller needs
gas on top of the USDC it moves; `DEFAULT_MAX_GAS_SPEND_PER_CHAIN_WEI` is a fee floor, not a
ceiling — a 0.001 USDC payment can cost more in gas than it moves. On a Nano rail the same 0.001
value moves at zero cost, final by publication, with no synced second asset.

## Live mainnet evidence (re-run, 2026-09-22)

Proof the rail carries real value and confirms with the ledger snapshot shared across this repo's
sibling rails:

```
block: E67FB89426F46E6AE4E0E5750B5F814A699965B8639DA89F38689EA1AFE57FC3
amount: 0.00001292 XNO  (raw 12920000000000000000000000)
confirmed: true  |  height 3  |  type: state (send)
```

- Explorer (loads signed out): https://nanexplorer.com/nano/block/E67FB89426F46E6AE4E0E5750B5F814A699965B8639DA89F38689EA1AFE57FC3
- RPC re-check: `{"action":"block_info","hash":"E67FB89426F46E6AE4E0E5750B5F814A699965B8639DA89F38689EA1AFE57FC3"}` → `confirmed:"true"`.

## Not claimed

Whether a Nano rail should ship as a community rail, where its sandbox record would come from, and
what `railConformance()` cases apply (a rail with no settle step has no "nothing settles twice"
case) — those are open questions for a maintainer, not asserted here.
