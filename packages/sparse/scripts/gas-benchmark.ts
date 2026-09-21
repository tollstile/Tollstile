/**
 * Gas benchmark for SparseSettlementProxy, in-process: solc compiles the contracts, an @ethereumjs VM runs them with
 * the real Permit2 runtime bytecode at its canonical address, and viem signs the Permit2 typed data as a wallet would.
 *
 *   pnpm --filter @tollstile/sparse gas            # prints the table
 *   pnpm --filter @tollstile/sparse gas -- --json  # also writes research/sparse-settlement/gas-benchmark.json
 *
 * Reported alongside a real-chain reference: USDC `transferWithAuthorization` (EIP-3009) on Base, median 86,242 gas
 * over twelve recent single-authorization transactions (2026-09-21).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCustomCommon, Hardfork, Mainnet } from '@ethereumjs/common';
import { createFeeMarket1559Tx } from '@ethereumjs/tx';
import { createAccount, createAddressFromPrivateKey, createAddressFromString, hexToBytes, type Address } from '@ethereumjs/util';
import { createVM, runTx, type VM } from '@ethereumjs/vm';
// solc ships without usable types; the compile entry point is the only thing used.
 
import solc from 'solc';

const compileJson = (solc as { compile: (input: string, options: { import: (path: string) => { contents: string } }) => string }).compile;
import { encodeAbiParameters, encodeFunctionData, hashTypedData, keccak256, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const here = dirname(fileURLToPath(import.meta.url));
const contracts = join(here, '..', 'contracts');
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const CHAIN_ID = 8453;
const TWO_128 = 1n << 128n;

// ─── compile ─────────────────────────────────────────────────────────────────

function compile(): Record<string, { abi: unknown[]; bytecode: Hex }> {
  const sources: Record<string, { content: string }> = {};
  for (const file of ['SparseSettlementProxy.sol', 'MockERC20.sol', 'vendor/ISignatureTransfer.sol']) {
    sources[file] = { content: readFileSync(join(contracts, file), 'utf8') };
  }
  const input = {
    language: 'Solidity',
    sources,
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  };
  const output = JSON.parse(compileJson(JSON.stringify(input), { import: (path: string) => ({ contents: readFileSync(join(contracts, path.replace(/^\.\//, '')), 'utf8') }) })) as {
    errors?: { severity: string; formattedMessage: string }[];
    contracts: Record<string, Record<string, { abi: unknown[]; evm: { bytecode: { object: string } } }>>;
  };
  const errors = (output.errors ?? []).filter((e) => e.severity === 'error');
  if (errors.length > 0) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
  const out: Record<string, { abi: unknown[]; bytecode: Hex }> = {};
  for (const file of Object.values(output.contracts)) for (const [name, c] of Object.entries(file)) out[name] = { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` };
  return out;
}

// ─── a tiny in-process chain ─────────────────────────────────────────────────

type Actor = { readonly key: Hex; readonly address: Address; readonly hex: `0x${string}`; nonce: bigint };

function actor(seed: number): Actor {
  const key: Hex = `0x${seed.toString(16).padStart(64, '0')}`;
  const address = createAddressFromPrivateKey(hexToBytes(key));
  return { key, address, hex: address.toString(), nonce: 0n };
}

async function fund(vm: VM, who: Actor) {
  await vm.stateManager.putAccount(who.address, createAccount({ balance: 10n ** 21n }));
}

async function send(vm: VM, from: Actor, to: Address | null, data: Hex): Promise<{ gasUsed: bigint; created: Address | undefined; reverted: boolean; error: string | undefined }> {
  const base = { data: hexToBytes(data), nonce: from.nonce, gasLimit: 5_000_000n, maxFeePerGas: 10n ** 9n, maxPriorityFeePerGas: 10n ** 9n, chainId: BigInt(CHAIN_ID) };
  const tx = createFeeMarket1559Tx(to === null ? base : { ...base, to }, { common: vm.common }).sign(hexToBytes(from.key));
  from.nonce += 1n;
  const result = await runTx(vm, { tx, skipBlockGasLimitValidation: true, skipHardForkValidation: true });
  const error = result.execResult.exceptionError?.error;
  return { gasUsed: result.totalGasSpent, created: result.createdAddress, reverted: error !== undefined, error };
}

// ─── the benchmark ───────────────────────────────────────────────────────────

const witnessTypes = {
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

const proxyAbi = parseAbi([
  'function settle((( address token, uint256 amount) permitted, uint256 nonce, uint256 deadline) permit, address owner, (address to, address facilitator, uint256 price, uint256 threshold, bytes32 commitment, bytes32 challengeId, uint256 validAfter) witness, bytes signature, bytes32 secret, uint256 price)',
]);
const erc20Abi = parseAbi(['function mint(address to, uint256 amount)', 'function approve(address spender, uint256 amount) returns (bool)', 'function transfer(address to, uint256 amount) returns (bool)']);

const thresholdFor = (price: bigint, ticket: bigint) => (price >= ticket ? TWO_128 : (price << 128n) / ticket);

async function main() {
  const json = process.argv.includes('--json');
  const built = compile();
  const common = createCustomCommon({ chainId: CHAIN_ID }, Mainnet, { hardfork: Hardfork.Cancun });
  const vm = await createVM({ common });

  const deployer = actor(0xa11ce), buyer = actor(0xb0b), facilitator = actor(0xfac), merchant = actor(0x111);
  for (const who of [deployer, buyer, facilitator]) await fund(vm, who);

  // Real Permit2 at its canonical address.
  await vm.stateManager.putCode(createAddressFromString(PERMIT2), hexToBytes(readFileSync(join(contracts, 'vendor', 'Permit2.base.runtime.hex'), 'utf8').trim() as Hex));

  const mock = built.MockERC20, sparseProxy = built.SparseSettlementProxy;
  if (mock === undefined || sparseProxy === undefined) throw new Error('compile produced no contracts');
  const token = (await send(vm, deployer, null, mock.bytecode)).created;
  const proxyDeploy = await send(vm, deployer, null, `${sparseProxy.bytecode}${encodeAbiParameters([{ type: 'address' }], [PERMIT2]).slice(2)}` as Hex);
  const proxy = proxyDeploy.created;
  if (token === undefined || proxy === undefined) throw new Error('deployment failed');
  const tokenHex = token.toString(), proxyHex = proxy.toString();

  await send(vm, deployer, token, encodeFunctionData({ abi: erc20Abi, functionName: 'mint', args: [buyer.hex, 1_000_000_000n] }));

  const rows: { scenario: string; gas: bigint; note: string }[] = [];
  const record = (scenario: string, gas: bigint, note: string) => rows.push({ scenario, gas, note });

  // Baselines on the mock token.
  record('ERC-20 transfer (mock, warm sender, cold recipient)', (await send(vm, buyer, token, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [merchant.hex, 1_000n] }))).gasUsed, 'plain transfer, for scale');
  record('ERC-20 transfer (mock, steady state: warm sender, funded recipient)', (await send(vm, buyer, token, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [merchant.hex, 1_000n] }))).gasUsed, 'compare with USDC transfer() on Base, median 40,271 (15 recent txs): the difference is USDC\'s own overhead (proxy, blacklist) that a mock lacks');
  record('Permit2 approval (one-time, per buyer)', (await send(vm, buyer, token, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [PERMIT2, 2n ** 256n - 1n] }))).gasUsed, 'the onboarding transaction the EIP-3009 path never needs (§4, bound iv)');

  const account = privateKeyToAccount(buyer.key);
  let permitNonce = 0n;

  // `settleAt` searches for the outcome at a lower settle-time price (an upTo route); the witness still carries the signed price.
  async function ticket(priceMicros: bigint, ticketMicros: bigint, want: 'win' | 'lose', settleAt = priceMicros) {
    const threshold = thresholdFor(priceMicros, ticketMicros);
    const decideAt = thresholdFor(settleAt, ticketMicros);
    for (let attempt = 0; attempt < 5_000; attempt += 1) {
      const secret = keccak256(`0x${(attempt + 1).toString(16).padStart(64, '0')}`);
      const commitment = keccak256(secret);
      const witness = { to: merchant.hex, facilitator: facilitator.hex, price: priceMicros, threshold, commitment, challengeId: keccak256(`0x${permitNonce.toString(16).padStart(64, '0')}`), validAfter: 0n };
      const permit = { permitted: { token: tokenHex, amount: ticketMicros }, nonce: permitNonce, deadline: 2n ** 48n };
      const message = { permitted: permit.permitted, spender: proxyHex, nonce: permit.nonce, deadline: permit.deadline, witness };
      const domain = { name: 'Permit2', chainId: CHAIN_ID, verifyingContract: PERMIT2 } as const;
      const digest = hashTypedData({ domain, types: witnessTypes, primaryType: 'PermitWitnessTransferFrom', message });
      const roll = BigInt(keccak256(`0x${digest.slice(2)}${secret.slice(2)}`)) >> 128n;
      const outcome = roll < decideAt ? 'win' : 'lose';
      if (outcome !== want) continue;
      const signature = await account.signTypedData({ domain, types: witnessTypes, primaryType: 'PermitWitnessTransferFrom', message });
      permitNonce += 1n;
      return { permit, witness, signature, secret, attempts: attempt + 1 };
    }
    throw new Error(`no ${want} found`);
  }

  const settle = (t: Awaited<ReturnType<typeof ticket>>, price: bigint) =>
    send(vm, facilitator, proxy, encodeFunctionData({ abi: proxyAbi, functionName: 'settle', args: [t.permit, buyer.hex, t.witness, t.signature, t.secret, price] }));

  // Sparse settlement through the real Permit2 code path.
  const first = await ticket(10_000n, 1_000_000n, 'win');
  const firstRun = await settle(first, 10_000n);
  if (firstRun.reverted) throw new Error(`winning settle reverted: ${String(firstRun.error)}`);
  record('sparse settle, winner — first ever (cold Permit2 nonce word, cold payee balance)', firstRun.gasUsed, `p = $0.01, T = $1, 1 in 100; found after ${String(first.attempts)} tickets`);

  const second = await ticket(10_000n, 1_000_000n, 'win');
  const secondRun = await settle(second, 10_000n);
  if (secondRun.reverted) throw new Error(`second winning settle reverted: ${String(secondRun.error)}`);
  record('sparse settle, winner — steady state (warm nonce word, warm payee)', secondRun.gasUsed, 'the number to compare with EIP-3009');

  const upto = await ticket(1_000_000n, 1_000_000n, 'win', 100_000n);
  const uptoAt = await settle(upto, 100_000n);
  if (uptoAt.reverted) throw new Error(`upTo settle reverted: ${String(uptoAt.error)}`);
  record('sparse settle, winner — upTo route fulfilled at 1/10 of the signed price', uptoAt.gasUsed, 'signed p = T (deterministic), charged $0.10: odds fall to 1 in 10 at settle time; this ticket won at the lower odds');

  const loser = await ticket(10_000n, 1_000_000n, 'lose');
  const lost = await settle(loser, 10_000n);
  record('sparse settle, loser — reverts NotAWinner', lost.gasUsed, `${lost.reverted ? 'reverted as required' : 'DID NOT REVERT'}; a facilitator never submits this, shown for completeness`);
  if (!lost.reverted) throw new Error('invariant 2 violated: a losing ticket settled');

  const stranger = await ticket(10_000n, 1_000_000n, 'win');
  const wrongCaller = await send(vm, buyer, proxy, encodeFunctionData({ abi: proxyAbi, functionName: 'settle', args: [stranger.permit, buyer.hex, stranger.witness, stranger.signature, stranger.secret, 10_000n] }));
  if (!wrongCaller.reverted) throw new Error('invariant 1 violated: a non-facilitator settled');
  const wrongPrice = await settle(stranger, 20_000n);
  if (!wrongPrice.reverted) throw new Error('settled above the signed price');
  const badSecret = await send(vm, facilitator, proxy, encodeFunctionData({ abi: proxyAbi, functionName: 'settle', args: [stranger.permit, buyer.hex, stranger.witness, stranger.signature, keccak256('0x01'), 10_000n] }));
  if (!badSecret.reverted) throw new Error('invariant 2 violated: settled with the wrong secret');
  const forged = { ...stranger, witness: { ...stranger.witness, threshold: TWO_128 } };
  const badOdds = await settle(forged, 10_000n);
  if (!badOdds.reverted) throw new Error('invariant 3 violated: inflated threshold accepted');
  const ok = await settle(stranger, 10_000n);
  if (ok.reverted) throw new Error(`control settle reverted: ${String(ok.error)}`);
  record('invariant checks: wrong caller, price above signed, wrong secret, inflated threshold', 0n, 'all four reverted; the same ticket then settled normally');

  // The one-shot buyer's case: a second buyer, first win ever (cold nonce word), paying a merchant who already holds a balance.
  const buyer2 = actor(0xb0b2);
  await fund(vm, buyer2);
  await send(vm, deployer, token, encodeFunctionData({ abi: erc20Abi, functionName: 'mint', args: [buyer2.hex, 1_000_000_000n] }));
  await send(vm, buyer2, token, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [PERMIT2, 2n ** 256n - 1n] }));
  const account2 = privateKeyToAccount(buyer2.key);
  const oneShot = await (async () => {
    for (let attempt = 0; attempt < 5_000; attempt += 1) {
      const secret = keccak256(`0x${(attempt + 7_001).toString(16).padStart(64, '0')}`);
      const witness = { to: merchant.hex, facilitator: facilitator.hex, price: 10_000n, threshold: thresholdFor(10_000n, 1_000_000n), commitment: keccak256(secret), challengeId: keccak256('0x7001'), validAfter: 0n };
      const permit = { permitted: { token: tokenHex, amount: 1_000_000n }, nonce: 0n, deadline: 2n ** 48n };
      const message = { permitted: permit.permitted, spender: proxyHex, nonce: permit.nonce, deadline: permit.deadline, witness };
      const domain = { name: 'Permit2', chainId: CHAIN_ID, verifyingContract: PERMIT2 } as const;
      const digest = hashTypedData({ domain, types: witnessTypes, primaryType: 'PermitWitnessTransferFrom', message });
      if ((BigInt(keccak256(`0x${digest.slice(2)}${secret.slice(2)}`)) >> 128n) >= witness.threshold) continue;
      const signature = await account2.signTypedData({ domain, types: witnessTypes, primaryType: 'PermitWitnessTransferFrom', message });
      return { permit, witness, signature, secret };
    }
    throw new Error('no one-shot win found');
  })();
  const oneShotRun = await send(vm, facilitator, proxy, encodeFunctionData({ abi: proxyAbi, functionName: 'settle', args: [oneShot.permit, buyer2.hex, oneShot.witness, oneShot.signature, oneShot.secret, 10_000n] }));
  if (oneShotRun.reverted) throw new Error(`one-shot settle reverted: ${String(oneShotRun.error)}`);
  record('sparse settle, winner — a one-shot buyer\'s first ticket (cold nonce word) to a funded merchant', oneShotRun.gasUsed, 'the case the mechanism is for');

  const eip3009 = 86_242n;
  const steady = rows.find((r) => r.scenario.startsWith('sparse settle, winner — steady'))?.gas ?? 0n;
  const oneShotGas = oneShotRun.gasUsed;
  const mockSteady = rows[1]?.gas ?? 0n;
  const usdcOverhead = 40_271n > mockSteady ? 40_271n - mockSteady : 0n;
  console.log('\nSparseSettlementProxy gas, in-process EVM (Cancun), real Permit2 bytecode, solc 0.8.x optimizer 200 runs\n');
  for (const row of rows) console.log(`${row.gas === 0n ? '      —' : row.gas.toString().padStart(7)}  ${row.scenario}\n         ${row.note}`);
  console.log(`\n  ${eip3009.toString().padStart(7)}  reference: USDC transferWithAuthorization on Base (EIP-3009), median of 12 recent txs, 2026-09-21`);
  console.log(`\n  USDC overhead over the mock (steady transfer 40,271 − ${mockSteady.toString()}) ≈ ${usdcOverhead.toString()} gas; adding it: steady sparse ≈ ${(steady + usdcOverhead).toString()}, one-shot sparse ≈ ${(oneShotGas + usdcOverhead).toString()}`);
  console.log(`  steady-state sparse settle / EIP-3009 transfer = ${(Number(steady) / Number(eip3009)).toFixed(2)}× on the mock, ≈ ${(Number(steady + usdcOverhead) / Number(eip3009)).toFixed(2)}× USDC-adjusted; one-shot ≈ ${(Number(oneShotGas + usdcOverhead) / Number(eip3009)).toFixed(2)}× USDC-adjusted`);
  console.log(`  per expected call at 1 in 100: ${(Number(steady) / 100).toFixed(0)} gas, vs ${eip3009.toString()} for one exact settlement — ${(Number(eip3009) / (Number(steady) / 100)).toFixed(0)}× less gas per call`);

  if (json) {
    const out = join(here, '..', '..', '..', 'research', 'sparse-settlement', 'gas-benchmark.json');
    writeFileSync(out, JSON.stringify({ measuredAt: new Date().toISOString().slice(0, 10), evm: 'ethereumjs, Cancun, chainId 8453, real Permit2 runtime bytecode from Base', rows: rows.map((r) => ({ ...r, gas: Number(r.gas) })), reference: { eip3009TransferWithAuthorizationBase: Number(eip3009), sampled: 12, sampledAt: '2026-09-21' }, usdcTransferBaseMedian: 40271, usdcOverheadOverMock: Number(usdcOverhead), ratioSteadyToEip3009: Number(steady) / Number(eip3009), ratioSteadyUsdcAdjusted: Number(steady + usdcOverhead) / Number(eip3009), ratioOneShotUsdcAdjusted: Number(oneShotGas + usdcOverhead) / Number(eip3009), approvalToEip3009: Number(rows[2]?.gas ?? 0n) / Number(eip3009) }, null, 2));
    console.log(`\nwrote ${out}`);
  }
}

await main();
