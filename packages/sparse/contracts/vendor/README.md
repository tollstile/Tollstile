# Vendored for the gas benchmark

- `ISignatureTransfer.sol` — Permit2's signature-transfer interface, as carried in `x402-foundation/x402` (`contracts/evm/src/interfaces`, MIT).
- `Permit2.base.runtime.hex` — runtime bytecode of the canonical Permit2 contract (`0x000000000022D473030F116dDEE9F6B43aC78BA3`) read from Base mainnet with `eth_getCode` on 2026-09-21. The benchmark places it at the canonical address in an in-process EVM so a sparse settlement runs through the real Permit2 code path.
