/**
 * Live measurement of sparse settlement on Base Sepolia (paper §12.3).
 *
 * It signs real tickets, settles the winners through the real Permit2 with a deployed SparseSettlementProxy, and
 * records realized against expected on both sides — the merchant's and the buyer's — plus the gas of every winner.
 * Opt-in: no test reaches it. It refuses to run on a mainnet.
 *
 *   PAYER_KEY=0x… FACILITATOR_KEY=0x… PAY_TO=0x… pnpm --filter @tollstile/sparse verify-live -- --preflight
 *   PAYER_KEY=0x… FACILITATOR_KEY=0x… PAY_TO=0x… pnpm --filter @tollstile/sparse verify-live -- --tickets 500
 *
 * Keys are read once and never printed or written. See README.md, "Live on Base Sepolia".
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, decodeEventLog, formatUnits, hashTypedData, http, keccak256, parseAbi, parseUnits, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { compileContracts, PERMIT2, sparseWitnessTypes, thresholdFor } from './lib/compile';

// ─── inputs ──────────────────────────────────────────────────────────────────

const env = (name: string) => {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
};
const required = (name: string) => {
  const value = env(name);
  if (value === undefined) throw new Error(`${name} is not set. See packages/sparse/README.md.`);
  return value;
};
/** Read once, never printed, never recorded. */
const key = (name: string): Hex => {
  const value = required(name);
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${name} is not a 32-byte hex private key.`);
  return value as Hex;
};
const flag = (name: string) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};
const has = (name: string) => process.argv.includes(name);

const RPC_URL = env('RPC_URL') ?? 'https://sepolia.base.org';
const USDC = (env('USDC') ?? '0x036CbD53842c5426634e7929541eC2318f3dCF7e') as Address;
const PAY_TO = required('PAY_TO') as Address;
const PRICE = parseUnits(flag('--price') ?? '0.001', 6);
const TICKET = parseUnits(flag('--ticket') ?? '0.10', 6);
const TICKETS = Number(flag('--tickets') ?? '500');
const RECORD = flag('--record') ?? `sparse-live-${new Date().toISOString().slice(0, 10)}.json`;
const PREFLIGHT = has('--preflight');

const erc20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
const proxyAbi = parseAbi([
  'function settle((( address token, uint256 amount) permitted, uint256 nonce, uint256 deadline) permit, address owner, (address to, address facilitator, uint256 price, uint256 threshold, bytes32 commitment, bytes32 challengeId, uint256 validAfter) witness, bytes signature, bytes32 secret, uint256 price)',
  'function PERMIT2() view returns (address)',
]);

// ─── the record: every field listed by hand, nothing spread from a signature or a key ──

type TicketRecord = {
  readonly index: number;
  readonly challengeId: Hex;
  readonly outcome: 'win' | 'lose';
  transaction: Hex | null;
  blockNumber: string | null;
  gasUsed: string | null;
  transferred: string | null;
  failure: string | null;
};

type RunRecord = {
  readonly startedAt: string;
  readonly network: string;
  readonly usdc: Address;
  readonly proxy: Address;
  readonly payTo: Address;
  readonly payer: Address;
  readonly facilitator: Address;
  readonly priceMicros: string;
  readonly ticketMicros: string;
  readonly plannedTickets: number;
  readonly tickets: TicketRecord[];
};

function loadOrStart(about: Omit<RunRecord, 'startedAt' | 'tickets'>): RunRecord {
  if (existsSync(RECORD)) {
    const run = JSON.parse(readFileSync(RECORD, 'utf8')) as RunRecord;
    if (run.proxy !== about.proxy || run.priceMicros !== about.priceMicros || run.ticketMicros !== about.ticketMicros) throw new Error(`${RECORD} is a different run; pass --record with a new path.`);
    console.log(`resuming ${RECORD}: ${String(run.tickets.length)} tickets done`);
    return run;
  }
  return { startedAt: new Date().toISOString(), ...about, tickets: [] };
}
const save = (run: RunRecord) => writeFileSync(RECORD, JSON.stringify(run, null, 2));

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  const payer = privateKeyToAccount(key('PAYER_KEY'));
  const facilitator = privateKeyToAccount(key('FACILITATOR_KEY'));
  const client = createPublicClient({ chain: baseSepolia, transport: http(RPC_URL) });
  const payerWallet = createWalletClient({ account: payer, chain: baseSepolia, transport: http(RPC_URL) });
  const facilitatorWallet = createWalletClient({ account: facilitator, chain: baseSepolia, transport: http(RPC_URL) });

  const chainId = await client.getChainId();
  if (chainId !== baseSepolia.id) throw new Error(`RPC_URL is chain ${String(chainId)}, not Base Sepolia (${String(baseSepolia.id)}). This script does not run on mainnets.`);

  const [payerEth, facilitatorEth, payerUsdc, allowance] = await Promise.all([
    client.getBalance({ address: payer.address }),
    client.getBalance({ address: facilitator.address }),
    client.readContract({ address: USDC, abi: erc20, functionName: 'balanceOf', args: [payer.address] }),
    client.readContract({ address: USDC, abi: erc20, functionName: 'allowance', args: [payer.address, PERMIT2] }),
  ]);
  const expectedWins = Number(PRICE) / Number(TICKET) * TICKETS;
  console.log(`Base Sepolia · payer ${payer.address} · facilitator ${facilitator.address} · payTo ${PAY_TO}`);
  console.log(`  payer: ${formatUnits(payerUsdc, 6)} USDC, ${formatUnits(payerEth, 18)} ETH, Permit2 allowance ${allowance > 0n ? 'present' : 'MISSING'}`);
  console.log(`  facilitator: ${formatUnits(facilitatorEth, 18)} ETH`);
  console.log(`  plan: ${String(TICKETS)} tickets at p = ${formatUnits(PRICE, 6)}, T = ${formatUnits(TICKET, 6)} → ${expectedWins.toFixed(1)} expected wins, ${formatUnits(BigInt(Math.ceil(expectedWins * 3)) * TICKET, 6)} USDC worst-case at 3× expectation`);
  const problems: string[] = [];
  if (payerUsdc < TICKET * BigInt(Math.ceil(expectedWins * 3))) problems.push('payer needs more USDC (faucet.circle.com, Base Sepolia)');
  if (allowance === 0n && payerEth < parseUnits('0.0005', 18)) problems.push('payer needs a little ETH for the one-time Permit2 approval');
  if (facilitatorEth < parseUnits('0.002', 18)) problems.push('facilitator needs ETH for deployment and settlements');
  if (problems.length > 0) {
    for (const problem of problems) console.log(`  ✗ ${problem}`);
    if (!PREFLIGHT) throw new Error('preflight failed');
  }
  if (PREFLIGHT) {
    console.log(problems.length === 0 ? '  ✓ ready; nothing was signed' : '  fix the above, then run again');
    return;
  }

  // One-time Permit2 approval by the payer (bound iv in the paper — the transaction EIP-3009 never needs).
  if (allowance < TICKET) {
    const hash = await payerWallet.writeContract({ address: USDC, abi: erc20, functionName: 'approve', args: [PERMIT2, 2n ** 96n] });
    const receipt = await client.waitForTransactionReceipt({ hash });
    console.log(`  Permit2 approval ${hash} — ${receipt.gasUsed.toString()} gas`);
  }

  // The verifier, deployed by the facilitator unless PROXY names an existing one.
  let proxy = env('PROXY') as Address | undefined;
  if (proxy === undefined) {
    const built = compileContracts().SparseSettlementProxy;
    if (built === undefined) throw new Error('compile produced no SparseSettlementProxy');
    const hash = await facilitatorWallet.deployContract({ abi: built.abi as never, bytecode: built.bytecode, args: [PERMIT2] });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.contractAddress === null || receipt.contractAddress === undefined) throw new Error('deployment produced no address');
    proxy = receipt.contractAddress;
    console.log(`  deployed SparseSettlementProxy at ${proxy} — ${receipt.gasUsed.toString()} gas; pass PROXY=${proxy} to reuse it`);
  }
  const permit2OnProxy = await client.readContract({ address: proxy, abi: proxyAbi, functionName: 'PERMIT2' });
  if (permit2OnProxy.toLowerCase() !== PERMIT2.toLowerCase()) throw new Error(`${proxy} is not a SparseSettlementProxy bound to Permit2`);

  const run = loadOrStart({ network: 'eip155:84532', usdc: USDC, proxy, payTo: PAY_TO, payer: payer.address, facilitator: facilitator.address, priceMicros: PRICE.toString(), ticketMicros: TICKET.toString(), plannedTickets: TICKETS });
  const threshold = thresholdFor(PRICE, TICKET);
  const domain = { name: 'Permit2', chainId: baseSepolia.id, verifyingContract: PERMIT2 } as const;
  const nonceBase = BigInt(Date.now()) << 32n; // unique per run; Permit2 nonces are unordered

  for (let index = run.tickets.length; index < TICKETS; index += 1) {
    // Facilitator commits before the buyer signs.
    const secret = keccak256(`0x${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`);
    const commitment = keccak256(secret);
    const challengeId = keccak256(`0x${(nonceBase + BigInt(index)).toString(16).padStart(64, '0')}`);
    const witness = { to: PAY_TO, facilitator: facilitator.address, price: PRICE, threshold, commitment, challengeId, validAfter: 0n };
    const permit = { permitted: { token: USDC, amount: TICKET }, nonce: nonceBase + BigInt(index), deadline: BigInt(Math.floor(Date.now() / 1000) + 3600) };
    const message = { permitted: permit.permitted, spender: proxy, nonce: permit.nonce, deadline: permit.deadline, witness };
    // Buyer signs; only then is the secret revealed and the outcome known.
    const signature = await payer.signTypedData({ domain, types: sparseWitnessTypes, primaryType: 'PermitWitnessTransferFrom', message });
    const digest = hashTypedData({ domain, types: sparseWitnessTypes, primaryType: 'PermitWitnessTransferFrom', message });
    const roll = BigInt(keccak256(`0x${digest.slice(2)}${secret.slice(2)}`)) >> 128n;
    const outcome = roll < threshold ? 'win' : 'lose';
    const record: TicketRecord = { index, challengeId, outcome, transaction: null, blockNumber: null, gasUsed: null, transferred: null, failure: null };
    run.tickets.push(record);

    if (outcome === 'win') {
      try {
        const hash = await facilitatorWallet.writeContract({ address: proxy, abi: proxyAbi, functionName: 'settle', args: [permit, payer.address, witness, signature, secret, PRICE] });
        record.transaction = hash;
        const receipt = await client.waitForTransactionReceipt({ hash });
        record.blockNumber = receipt.blockNumber.toString();
        record.gasUsed = receipt.gasUsed.toString();
        const transfer = receipt.logs
          .filter((log) => log.address.toLowerCase() === USDC.toLowerCase())
          .map((log) => decodeEventLog({ abi: erc20, data: log.data, topics: log.topics }))
          .find((event) => event.eventName === 'Transfer' && event.args.from.toLowerCase() === payer.address.toLowerCase() && event.args.to.toLowerCase() === PAY_TO.toLowerCase());
        if (transfer === undefined) throw new Error('no Transfer from payer to payTo in the receipt');
        record.transferred = transfer.args.value.toString();
        if (transfer.args.value !== TICKET) throw new Error(`transferred ${transfer.args.value.toString()}, not the ticket ${TICKET.toString()}`);
        console.log(`  #${String(index)} WIN  ${hash} gas ${record.gasUsed} transferred ${formatUnits(transfer.args.value, 6)} USDC`);
      } catch (error) {
        record.failure = error instanceof Error ? error.message : String(error);
        console.log(`  #${String(index)} WIN but settle failed: ${record.failure}`);
      }
    } else if (index % 50 === 0) {
      console.log(`  #${String(index)} …`);
    }
    save(run);
  }

  // Summary: merchant side and buyer side.
  const wins = run.tickets.filter((t) => t.outcome === 'win');
  const settled = wins.filter((t) => t.transferred !== null);
  const expected = PRICE * BigInt(run.tickets.length);
  const realized = settled.reduce((a, t) => a + BigInt(t.transferred ?? '0'), 0n);
  const gas = settled.map((t) => Number(t.gasUsed)).sort((a, b) => a - b);
  console.log(`\n${String(run.tickets.length)} tickets · ${String(wins.length)} wins (${(100 * wins.length / run.tickets.length).toFixed(2)}%, expected ${(100 * Number(PRICE) / Number(TICKET)).toFixed(2)}%) · ${String(settled.length)} settled on-chain`);
  console.log(`  merchant: expected ${formatUnits(expected, 6)} USDC, realized ${formatUnits(realized, 6)} USDC (${expected > 0n ? (100 * Number(realized) / Number(expected)).toFixed(0) : '—'}%)`);
  console.log(`  buyer:    paid ${formatUnits(realized, 6)} USDC for ${String(run.tickets.length)} calls priced ${formatUnits(PRICE, 6)} each; max single outlay ${formatUnits(TICKET, 6)}`);
  if (gas.length > 0) console.log(`  gas per winner: min ${String(gas[0])} median ${String(gas[Math.floor(gas.length / 2)])} max ${String(gas.at(-1))}; per call ≈ ${(gas.reduce((a, b) => a + b, 0) / run.tickets.length).toFixed(0)} — reference EIP-3009 transfer 86,242`);
  console.log(`  record: ${RECORD}`);
}

await main();
