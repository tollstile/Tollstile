import type { Json, JsonObject } from 'tollstile';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function utf8(input: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(input);
}

/** `undefined` for bytes that are not valid UTF-8. */
export function fromUtf8(bytes: Uint8Array): string | undefined {
  // catch-reason: TextDecoder reports invalid UTF-8 by throwing; malformed wire input is an expected outcome.
  try {
    return decoder.decode(bytes);
  } catch {
    return undefined;
  }
}

/** RFC 4648 §5 base64url without padding. */
export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Accepts only the unpadded base64url alphabet. */
export function fromBase64url(input: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(input) || input.length % 4 === 1) return undefined;
  const padded = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(input.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

export function toHex(bytes: Uint8Array): `0x${string}` {
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** Strict `0x`-prefixed, even-length hex. `undefined` otherwise. */
export function fromHex(input: string): Uint8Array | undefined {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(input)) return undefined;
  const bytes = new Uint8Array((input.length - 2) / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(input.slice(2 + index * 2, 4 + index * 2), 16);
  }
  return bytes;
}

export function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/** Big-endian unsigned integer. */
export function toBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/** Big-endian, left-padded to `size` bytes. */
export function fromBigInt(value: bigint, size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let rest = value;
  for (let index = size - 1; index >= 0; index -= 1) {
    bytes[index] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return bytes;
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0;
}

export function parseJson(text: string): Json | undefined {
  // catch-reason: JSON.parse reports malformed input by throwing; malformed wire input is an expected outcome.
  try {
    return JSON.parse(text) as Json;
  } catch {
    return undefined;
  }
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A non-negative base-10 integer string without sign, exponent, or leading zeros. */
export function isIntegerString(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value);
}
