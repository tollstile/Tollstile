import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// solc ships without usable types; the compile entry point is the only thing used, and it is typed below.
import solc from 'solc';
import type { Hex } from 'viem';

const compileJson = (solc as { compile: (input: string, options: { import: (path: string) => { contents: string } }) => string }).compile;

export const contractsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'contracts');

export type Compiled = { readonly abi: unknown[]; readonly bytecode: Hex };

/** Compiles `contracts/` with solc (optimizer on, Cancun) and returns each contract's ABI and creation bytecode. */
export function compileContracts(): Record<string, Compiled> {
  const sources: Record<string, { content: string }> = {};
  for (const file of ['SparseSettlementProxy.sol', 'MockERC20.sol', 'vendor/ISignatureTransfer.sol']) {
    sources[file] = { content: readFileSync(join(contractsDir, file), 'utf8') };
  }
  const input = {
    language: 'Solidity',
    sources,
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  };
  const output = JSON.parse(compileJson(JSON.stringify(input), { import: (path: string) => ({ contents: readFileSync(join(contractsDir, path.replace(/^\.\//, '')), 'utf8') }) })) as {
    errors?: { severity: string; formattedMessage: string }[];
    contracts: Record<string, Record<string, { abi: unknown[]; evm: { bytecode: { object: string } } }>>;
  };
  const errors = (output.errors ?? []).filter((e) => e.severity === 'error');
  if (errors.length > 0) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
  const out: Record<string, Compiled> = {};
  for (const file of Object.values(output.contracts)) for (const [name, c] of Object.entries(file)) out[name] = { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` };
  return out;
}

/** The EIP-712 types a wallet signs for a sparse ticket: Permit2's witness transfer with `SparseWitness`. */
export const sparseWitnessTypes = {
  PermitWitnessTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'witness', type: 'SparseWitness' },
  ],
  TokenPermissions: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  SparseWitness: [
    { name: 'to', type: 'address' },
    { name: 'facilitator', type: 'address' },
    { name: 'price', type: 'uint256' },
    { name: 'threshold', type: 'uint256' },
    { name: 'commitment', type: 'bytes32' },
    { name: 'challengeId', type: 'bytes32' },
    { name: 'validAfter', type: 'uint256' },
  ],
} as const;

export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const;
export const TWO_128 = 1n << 128n;
export const thresholdFor = (price: bigint, ticket: bigint): bigint => (price >= ticket ? TWO_128 : (price << 128n) / ticket);
