import { TollstileError, type Charge, type LookupResult } from 'tollstile';
import {
  AUTHORIZATION_CANCELED_TOPIC,
  AUTHORIZATION_STATE_SELECTOR,
  AUTHORIZATION_USED_TOPIC,
  encodeCall,
  NONCE_BITMAP_SELECTOR,
  readWord,
  selectorOf,
  TRANSFER_TOPIC,
  UNORDERED_NONCE_INVALIDATION_TOPIC,
  UPTO_SETTLE_SELECTOR,
  UPTO_SETTLE_WITH_PERMIT_SELECTOR,
  word,
} from './abi';
import type { Block, Chain, Log } from './json-rpc';
import { PERMIT2_ADDRESS, sameAddress, UPTO_PROXY_ADDRESS } from './networks';
import type { X402Data } from './x402-data';

// Charges are created by the server clock; blocks are stamped by the sequencer's. Searching from
// this far before the charge tolerates skew between the two.
const CLOCK_SKEW_SECONDS = 600n;

/**
 * Asks the chain what happened to a payment. Facilitators have no status endpoint and `/settle` is
 * not idempotent, so on-chain state is the only authority.
 *
 * Everything is read at the `finalized` block, so `none` is answered only when the signature can
 * no longer settle in any later block: its nonce is unused and the finalized block is already past
 * its deadline. Before that the outcome is still open and this throws `PROVIDER_TIMEOUT`.
 */
export async function lookupSettlement(chain: Chain, data: X402Data, charge: Charge, signal: AbortSignal): Promise<LookupResult> {
  const finalized = await chain.block('finalized', signal);
  const lastValidSecond = data.scheme === 'exact' ? BigInt(data.validBefore) - 1n : BigInt(data.validBefore);

  const used = data.scheme === 'exact' ? await eip3009NonceUsed(chain, data, finalized, signal) : await permit2NonceUsed(chain, data, finalized, signal);
  if (!used) {
    if (finalized.timestamp > lastValidSecond) return { status: 'none' };
    throw pending(`${data.payer}'s authorization is unused but valid until ${data.validBefore}; ask again after it expires.`);
  }

  const range = await searchRange(chain, finalized, BigInt(Math.floor(charge.createdAt.getTime() / 1000)) - CLOCK_SKEW_SECONDS, lastValidSecond, signal);
  const evidence = data.scheme === 'exact' ? await eip3009Evidence(chain, data, range, signal) : await permit2Evidence(chain, data, range, signal);
  if (evidence === 'cancelled') return { status: 'none' };
  if (evidence === undefined) {
    throw pending(
      `the nonce of ${data.payer}'s authorization is used, but no settlement or cancellation was found in blocks ${String(range.fromBlock)}-${String(range.toBlock)}. Investigate before resolving by hand.`,
    );
  }
  return {
    status: 'settled',
    reference: evidence.transaction,
    details: { transaction: evidence.transaction, network: data.network, payer: data.payer, amount: evidence.amount },
  };
}

type Range = { readonly fromBlock: bigint; readonly toBlock: bigint };
type Evidence = { readonly transaction: string; readonly amount: string } | 'cancelled' | undefined;

/**
 * Block timestamps strictly increase, so block `n - k` is at least `k` seconds older than block
 * `n`. That bounds the blocks that can hold the settlement without searching or assuming a block time.
 */
async function searchRange(chain: Chain, finalized: Block, fromSecond: bigint, lastValidSecond: bigint, signal: AbortSignal): Promise<Range> {
  const back = finalized.timestamp > fromSecond ? finalized.timestamp - fromSecond : 0n;
  const fromBlock = finalized.number > back ? finalized.number - back : 0n;
  const start = await chain.block(fromBlock, signal);
  const ahead = lastValidSecond > start.timestamp ? lastValidSecond - start.timestamp : 0n;
  const toBlock = fromBlock + ahead < finalized.number ? fromBlock + ahead : finalized.number;
  return { fromBlock, toBlock };
}

async function eip3009NonceUsed(chain: Chain, data: X402Data, at: Block, signal: AbortSignal): Promise<boolean> {
  const result = await chain.call(data.asset, encodeCall(AUTHORIZATION_STATE_SELECTOR, word(data.payer), word(data.nonce)), at.number, signal);
  const state = readWord(result, 0);
  if (state === undefined) throw pending('authorizationState returned malformed data.');
  return state === 1n;
}

async function permit2NonceUsed(chain: Chain, data: X402Data, at: Block, signal: AbortSignal): Promise<boolean> {
  const nonce = BigInt(data.nonce);
  const result = await chain.call(PERMIT2_ADDRESS, encodeCall(NONCE_BITMAP_SELECTOR, word(data.payer), word(nonce >> 8n)), at.number, signal);
  const bitmap = readWord(result, 0);
  if (bitmap === undefined) throw pending('Permit2 nonceBitmap returned malformed data.');
  return ((bitmap >> (nonce & 0xffn)) & 1n) === 1n;
}

/** The token emits `AuthorizationUsed(payer, nonce)` in the same transaction as the transfer to `payTo`. */
async function eip3009Evidence(chain: Chain, data: X402Data, range: Range, signal: AbortSignal): Promise<Evidence> {
  const used = await chain.logs({ address: data.asset, topics: [AUTHORIZATION_USED_TOPIC, word(data.payer), word(data.nonce)], ...range }, signal);
  for (const log of used) {
    const receipt = await chain.receiptLogs(log.transactionHash, signal);
    if (receipt.some((entry) => isTransfer(entry, data) && readWord(entry.data, 0) === BigInt(data.authorizedAmount))) {
      return { transaction: log.transactionHash, amount: data.authorizedAmount };
    }
  }
  const cancelled = await chain.logs({ address: data.asset, topics: [AUTHORIZATION_CANCELED_TOPIC, word(data.payer), word(data.nonce)], ...range }, signal);
  return cancelled.length > 0 ? 'cancelled' : undefined;
}

/**
 * Permit2 emits nothing that names the nonce, so a transfer from the payer to `payTo` counts only
 * when its transaction called the upto proxy with this nonce, owner, and token.
 */
async function permit2Evidence(chain: Chain, data: X402Data, range: Range, signal: AbortSignal): Promise<Evidence> {
  const transfers = await chain.logs({ address: data.asset, topics: [TRANSFER_TOPIC, word(data.payer), word(data.payTo)], ...range }, signal);
  for (const log of transfers) {
    const transaction = await chain.transaction(log.transactionHash, signal);
    const amount = readWord(log.data, 0);
    if (amount !== undefined && transaction.to !== null && sameAddress(transaction.to, UPTO_PROXY_ADDRESS) && settlesNonce(transaction.input, data)) {
      return { transaction: log.transactionHash, amount: amount.toString() };
    }
  }

  const invalidations = await chain.logs({ address: PERMIT2_ADDRESS, topics: [UNORDERED_NONCE_INVALIDATION_TOPIC, word(data.payer)], ...range }, signal);
  const nonce = BigInt(data.nonce);
  const cancelled = invalidations.some((log) => readWord(log.data, 0) === nonce >> 8n && (((readWord(log.data, 1) ?? 0n) >> (nonce & 0xffn)) & 1n) === 1n);
  return cancelled ? 'cancelled' : undefined;
}

// Calldata layouts of x402UptoPermit2Proxy. `settle` starts with the static PermitTransferFrom
// (token, amount, nonce, deadline), then amount and owner; `settleWithPermit` prepends the
// five-word EIP2612Permit.
const SETTLE_LAYOUTS: Readonly<Record<string, number>> = {
  [UPTO_SETTLE_SELECTOR]: 0,
  [UPTO_SETTLE_WITH_PERMIT_SELECTOR]: 5,
};

function settlesNonce(input: string, data: X402Data): boolean {
  const base = SETTLE_LAYOUTS[selectorOf(input)];
  if (base === undefined) return false;
  return (
    readWord(input, base, 4) === BigInt(data.asset) &&
    readWord(input, base + 2, 4) === BigInt(data.nonce) &&
    readWord(input, base + 5, 4) === BigInt(data.payer)
  );
}

function isTransfer(log: Log, data: X402Data): boolean {
  return (
    sameAddress(log.address, data.asset) &&
    log.topics[0] === TRANSFER_TOPIC &&
    log.topics[1] === word(data.payer) &&
    log.topics[2] === word(data.payTo)
  );
}

function pending(message: string): TollstileError {
  return new TollstileError('PROVIDER_TIMEOUT', `x402 settlement lookup: ${message}`);
}
