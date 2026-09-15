import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { concat, fromBigInt, fromHex, toBigInt, toHex, utf8 } from './encoding';

export type Address = `0x${string}`;

const HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
export const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

export function keccak256(bytes: Uint8Array): Uint8Array {
  return keccak_256(bytes);
}

export function selector(signature: string): string {
  return toHex(keccak256(utf8(signature)).subarray(0, 4));
}

/** Lowercase `0x` address, or `undefined`. Addresses are compared by their 20 bytes, never by case. */
export function parseAddress(value: unknown): Address | undefined {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) ? (value.toLowerCase() as Address) : undefined;
}

export function parseBytes32(value: unknown): `0x${string}` | undefined {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value) ? (value.toLowerCase() as `0x${string}`) : undefined;
}

/**
 * Recovers the signer of a 32-byte digest from a 65-byte `r‖s‖v` (v ∈ 0,1,27,28) or 64-byte
 * EIP-2098 signature. High-s signatures are refused: they are the malleable twin of a valid one.
 */
export function recoverAddress(digest: Uint8Array, signature: Uint8Array): Address | undefined {
  let r: bigint;
  let s: bigint;
  let recovery: number;
  if (signature.length === 65) {
    r = toBigInt(signature.subarray(0, 32));
    s = toBigInt(signature.subarray(32, 64));
    const v = signature[64] ?? 0;
    recovery = v >= 27 ? v - 27 : v;
  } else if (signature.length === 64) {
    r = toBigInt(signature.subarray(0, 32));
    const yParityAndS = toBigInt(signature.subarray(32, 64));
    recovery = Number(yParityAndS >> 255n);
    s = yParityAndS & ((1n << 255n) - 1n);
  } else {
    return undefined;
  }
  if (recovery !== 0 && recovery !== 1) return undefined;
  if (r === 0n || s === 0n || s > HALF_ORDER || r >= secp256k1.Point.CURVE().n) return undefined;

  // catch-reason: noble reports signatures that do not recover to a point by throwing; that is an invalid proof, a returned value.
  try {
    const point = new secp256k1.Signature(r, s, recovery).recoverPublicKey(digest);
    return publicKeyAddress(point.toBytes(false));
  } catch {
    return undefined;
  }
}

export function publicKeyAddress(uncompressed: Uint8Array): Address {
  return toHex(keccak256(uncompressed.subarray(1)).subarray(12));
}

export function word(value: bigint): Uint8Array {
  return fromBigInt(value, 32);
}

export function addressWord(address: Address): Uint8Array {
  return concat(new Uint8Array(12), fromHex(address) ?? new Uint8Array(20));
}

/** The 32-byte ABI word at `index`, or `undefined` past the end. */
export function wordAt(data: Uint8Array, index: number): Uint8Array | undefined {
  const slice = data.subarray(index * 32, index * 32 + 32);
  return slice.length === 32 ? slice : undefined;
}

/** An ABI-encoded address word: 12 zero bytes, then 20. */
export function addressAt(data: Uint8Array, index: number): Address | undefined {
  const slice = wordAt(data, index);
  if (slice === undefined || slice.subarray(0, 12).some((byte) => byte !== 0)) return undefined;
  return toHex(slice.subarray(12));
}
