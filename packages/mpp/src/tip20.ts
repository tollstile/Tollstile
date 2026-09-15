import type { JsonObject, Quote } from 'tollstile';
import { fromHex, toBigInt, toHex, utf8 } from './encoding';
import { addressAt, keccak256, selector, wordAt, type Address } from './evm';
import type { TempoCall } from './tempo-transaction';
import type { RpcLog } from './tempo-rpc';

/** One transfer a charge requires: the primary recipient's remainder, or a split. */
export type Transfer = {
  readonly recipient: Address;
  readonly amount: bigint;
  readonly memo: `0x${string}` | null;
};

const TRANSFER = selector('transfer(address,uint256)');
const TRANSFER_WITH_MEMO = selector('transferWithMemo(address,uint256,bytes32)');
const TRANSFER_EVENT = toHex(keccak256(utf8('Transfer(address,address,uint256)')));
const TRANSFER_WITH_MEMO_EVENT = toHex(keccak256(utf8('TransferWithMemo(address,address,uint256,bytes32)')));

/**
 * The memo bound into every challenge. It is derived from the quote, which is unique per 402, so a
 * transfer made for one challenge can never satisfy another: that is what stops one on-chain
 * payment from being presented twice under different challenge ids.
 */
export function challengeMemo(realm: string, quote: Quote): `0x${string}` {
  return toHex(keccak256(utf8(`tollstile/mpp:${realm}:${quote.id}:${quote.nonce}`)));
}

/** The primary transfer carries the challenge memo and receives `amount − Σ splits`. */
export function requiredTransfers(amount: bigint, recipient: Address, memo: `0x${string}`, splits: readonly Transfer[]): readonly Transfer[] {
  const splitTotal = splits.reduce((total, split) => total + split.amount, 0n);
  return [{ recipient, amount: amount - splitTotal, memo }, ...splits];
}

export function requestTransfersJson(splits: readonly Transfer[]): JsonObject[] {
  return splits.map((split) => ({
    amount: split.amount.toString(),
    recipient: split.recipient,
    ...(split.memo === null ? {} : { memo: split.memo }),
  }));
}

/**
 * The transaction must consist of exactly the required transfers on `token`, in any order. Extra
 * calls are refused as local policy: anything else in the batch could make the transfers revert
 * after the handler has already run.
 */
export function callsPay(calls: readonly TempoCall[], token: Address, transfers: readonly Transfer[]): boolean {
  if (calls.length !== transfers.length) return false;
  const remaining = [...transfers];
  for (const call of calls) {
    const decoded = decodeCall(call, token);
    const index = decoded === undefined ? -1 : remaining.findIndex((transfer) => sameTransfer(transfer, decoded));
    if (index === -1) return false;
    remaining.splice(index, 1);
  }
  return remaining.length === 0;
}

/**
 * The receipt must contain a distinct `Transfer`/`TransferWithMemo` log on `token` for every
 * required transfer, all from the same sender. Returns that sender.
 */
export function logsPay(logs: readonly RpcLog[], token: Address, transfers: readonly Transfer[]): Address | undefined {
  const events = transferEvents(logs, token);
  let sender: Address | undefined;
  for (const transfer of transfers) {
    const index = events.findIndex((event) => (sender === undefined || event.from === sender) && sameTransfer(transfer, event));
    const event = events[index];
    if (event === undefined) return undefined;
    sender = event.from;
    events.splice(index, 1);
  }
  return sender;
}

type Decoded = { readonly recipient: Address; readonly amount: bigint; readonly memo: `0x${string}` | null };

function sameTransfer(expected: Transfer, actual: Decoded): boolean {
  if (expected.recipient !== actual.recipient || expected.amount !== actual.amount) return false;
  // A split without a memo may be paid with either transfer form; a required memo must match.
  return expected.memo === null || expected.memo === actual.memo;
}

function decodeCall(call: TempoCall, token: Address): Decoded | undefined {
  if (call.to !== token || call.value !== 0n) return undefined;
  const method = toHex(call.data.subarray(0, 4));
  const args = call.data.subarray(4);
  if (method === TRANSFER && args.length === 64) return decodeArgs(args, null);
  if (method === TRANSFER_WITH_MEMO && args.length === 96) {
    const memo = wordAt(args, 2);
    return memo === undefined ? undefined : decodeArgs(args, toHex(memo));
  }
  return undefined;
}

function decodeArgs(args: Uint8Array, memo: `0x${string}` | null): Decoded | undefined {
  const recipient = addressAt(args, 0);
  const amount = wordAt(args, 1);
  return recipient === undefined || amount === undefined ? undefined : { recipient, amount: toBigInt(amount), memo };
}

type Event = Decoded & { readonly from: Address };

/** TIP-20 emits both `Transfer` and `TransferWithMemo` for a memo transfer; each pair counts once. */
function transferEvents(logs: readonly RpcLog[], token: Address): Event[] {
  const events: (Event & { readonly kind: 'plain' | 'memo' })[] = [];
  for (const log of logs) {
    if (log.address !== token) continue;
    const [topic, from, to, memo] = log.topics;
    const data = fromHex(log.data);
    const amount = data === undefined ? undefined : wordAt(data, 0);
    const sender = from === undefined ? undefined : addressAt(fromHex(from) ?? new Uint8Array(), 0);
    const recipient = to === undefined ? undefined : addressAt(fromHex(to) ?? new Uint8Array(), 0);
    if (amount === undefined || sender === undefined || recipient === undefined) continue;
    if (topic === TRANSFER_EVENT && log.topics.length === 3) {
      events.push({ kind: 'plain', from: sender, recipient, amount: toBigInt(amount), memo: null });
    } else if (topic === TRANSFER_WITH_MEMO_EVENT && memo !== undefined) {
      events.push({ kind: 'memo', from: sender, recipient, amount: toBigInt(amount), memo });
    }
  }
  const memoEvents = events.filter((event) => event.kind === 'memo');
  const plain = events.filter((event) => event.kind === 'plain');
  for (const memoEvent of memoEvents) {
    const twin = plain.findIndex((event) => event.from === memoEvent.from && event.recipient === memoEvent.recipient && event.amount === memoEvent.amount);
    if (twin !== -1) plain.splice(twin, 1);
  }
  return [...memoEvents, ...plain];
}
