/** A token that settles x402 payments on an EVM network. */
export type X402Asset = {
  /** Asset code recorded on offers, e.g. `"USDC"`. */
  readonly code: string;
  readonly address: string;
  readonly decimals: number;
  /** EIP-712 domain name of the token contract, advertised as `extra.name`. */
  readonly name: string;
  /** EIP-712 domain version of the token contract, advertised as `extra.version`. */
  readonly version: string;
};

type KnownNetwork = {
  readonly asset: X402Asset;
  readonly testnet: boolean;
  /** Public facilitator used when none is configured. Only ever set for testnets. */
  readonly facilitator: string | null;
  /** What one unit of the asset is pegged to, for `denomination`. */
  readonly peg: string;
};

// Values from x402-foundation/x402 typescript/packages/mechanisms/evm/src/defaultAssets.ts. The
// EIP-712 names differ between the two deployments, and a wrong name makes every signature fail.
export const KNOWN_NETWORKS: Readonly<Record<string, KnownNetwork>> = {
  'eip155:8453': {
    asset: { code: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, name: 'USD Coin', version: '2' },
    testnet: false,
    facilitator: null,
    peg: 'USD',
  },
  'eip155:84532': {
    asset: { code: 'USDC', address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', decimals: 6, name: 'USDC', version: '2' },
    testnet: true,
    facilitator: 'https://x402.org/facilitator',
    peg: 'USD',
  },
};

/** Canonical Permit2, deployed at the same address on every EVM chain. */
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

/**
 * `x402UptoPermit2Proxy`, the Permit2 spender for `upto` payments, deployed with CREATE2 at the
 * same address on every chain (x402 typescript/packages/mechanisms/evm/src/constants.ts).
 */
export const UPTO_PROXY_ADDRESS = '0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function isAddress(value: string): boolean {
  return ADDRESS.test(value);
}

export function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
