import { concat, fromBigInt, toBigInt } from './encoding';

/** An RLP item: a byte string or a list of items. */
export type RlpItem = Uint8Array | readonly RlpItem[];

/**
 * Decodes exactly one item spanning all of `bytes`. Non-canonical encodings are refused, so
 * re-encoding a decoded transaction reproduces the bytes its signer signed.
 */
export function decodeRlp(bytes: Uint8Array): RlpItem | undefined {
  const result = decodeAt(bytes, 0);
  return result === undefined || result.end !== bytes.length ? undefined : result.item;
}

export function encodeRlp(item: RlpItem): Uint8Array {
  if (item instanceof Uint8Array) {
    if (item.length === 1 && (item[0] ?? 0) < 0x80) return item;
    return concat(header(0x80, item.length), item);
  }
  const payload = concat(...item.map(encodeRlp));
  return concat(header(0xc0, payload.length), payload);
}

/** A canonical RLP unsigned integer: no leading zero bytes, zero is empty. */
export function rlpInteger(item: RlpItem | undefined): bigint | undefined {
  if (!(item instanceof Uint8Array) || (item.length > 0 && item[0] === 0)) return undefined;
  return toBigInt(item);
}

export function integerBytes(value: bigint): Uint8Array {
  if (value === 0n) return new Uint8Array();
  let size = 0;
  for (let rest = value; rest > 0n; rest >>= 8n) size += 1;
  return fromBigInt(value, size);
}

function header(offset: number, length: number): Uint8Array {
  if (length <= 55) return Uint8Array.of(offset + length);
  const size = integerBytes(BigInt(length));
  return concat(Uint8Array.of(offset + 55 + size.length), size);
}

function decodeAt(bytes: Uint8Array, start: number): { readonly item: RlpItem; readonly end: number } | undefined {
  const prefix = bytes[start];
  if (prefix === undefined) return undefined;
  if (prefix < 0x80) return { item: bytes.subarray(start, start + 1), end: start + 1 };

  const isList = prefix >= 0xc0;
  const base = isList ? 0xc0 : 0x80;
  const short = prefix - base <= 55;
  let length: number;
  let offset: number;
  if (short) {
    length = prefix - base;
    offset = start + 1;
  } else {
    const sizeOfLength = prefix - base - 55;
    const encoded = bytes.subarray(start + 1, start + 1 + sizeOfLength);
    if (encoded.length !== sizeOfLength || encoded[0] === 0) return undefined;
    length = Number(toBigInt(encoded));
    if (length <= 55) return undefined;
    offset = start + 1 + sizeOfLength;
  }
  const end = offset + length;
  if (end > bytes.length) return undefined;

  if (!isList) {
    const item = bytes.subarray(offset, end);
    if (short && length === 1 && (item[0] ?? 0) < 0x80) return undefined;
    return { item, end };
  }
  const items: RlpItem[] = [];
  let cursor = offset;
  while (cursor < end) {
    const next = decodeAt(bytes.subarray(0, end), cursor);
    if (next === undefined) return undefined;
    items.push(next.item);
    cursor = next.end;
  }
  return { item: items, end };
}
