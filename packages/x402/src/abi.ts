/**
 * The few ABI selectors and event topics reconciliation needs, precomputed so this package needs no
 * keccak implementation. Each is keccak-256 of the signature in its comment (first 4 bytes for a
 * selector); recompute with any keccak tool, e.g. `cast sig` / `cast keccak`.
 */

/** `authorizationState(address,bytes32)` on EIP-3009 tokens. */
export const AUTHORIZATION_STATE_SELECTOR = '0xe94a0102';
/** `nonceBitmap(address,uint256)` on Permit2. */
export const NONCE_BITMAP_SELECTOR = '0x4fe02b44';
/** `settle(((address,uint256),uint256,uint256),uint256,address,(address,address,uint256),bytes)` on x402UptoPermit2Proxy. */
export const UPTO_SETTLE_SELECTOR = '0xff11e7b4';
/** `settleWithPermit((uint256,uint256,bytes32,bytes32,uint8),((address,uint256),uint256,uint256),uint256,address,(address,address,uint256),bytes)` on x402UptoPermit2Proxy. */
export const UPTO_SETTLE_WITH_PERMIT_SELECTOR = '0x016c1748';

/** `Transfer(address,address,uint256)` */
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** `AuthorizationUsed(address,bytes32)` */
export const AUTHORIZATION_USED_TOPIC = '0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5';
/** `AuthorizationCanceled(address,bytes32)` */
export const AUTHORIZATION_CANCELED_TOPIC = '0x1cdd46ff242716cdaa72d159d339a485b3438398348d68f09d7c8c0a59353d81';
/** `UnorderedNonceInvalidation(address,uint256,uint256)` on Permit2. */
export const UNORDERED_NONCE_INVALIDATION_TOPIC = '0x3704902f963766a4e561bbaab6e6cdc1b1dd12f6e9e99648da8843b3f46b918d';

const WORD = 64;
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;

/** A 32-byte word as 0x-prefixed lowercase hex: a uint256, an address, or a bytes32. */
export function word(value: bigint | string): string {
  const digits = typeof value === 'bigint' ? value.toString(16) : value.slice(2).toLowerCase();
  return `0x${digits.padStart(WORD, '0')}`;
}

export function encodeCall(selector: string, ...words: readonly string[]): string {
  return selector + words.map((value) => value.slice(2)).join('');
}

/** Reads word `index` of ABI data, skipping `offset` leading bytes (4 for calldata). */
export function readWord(data: string, index: number, offset = 0): bigint | undefined {
  if (!HEX.test(data)) return undefined;
  const start = 2 + offset * 2 + index * WORD;
  const slice = data.slice(start, start + WORD);
  return slice.length === WORD ? BigInt(`0x${slice}`) : undefined;
}

export function selectorOf(calldata: string): string {
  return calldata.slice(0, 10).toLowerCase();
}
