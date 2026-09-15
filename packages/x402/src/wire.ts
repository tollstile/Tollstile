import type { Json, JsonObject } from 'tollstile';

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** x402 V2 headers carry JSON as standard, padded base64 of its UTF-8 bytes. */
export function encodeBase64Json(value: Json): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeBase64Json(value: string): Parsed<Json> {
  if (value.length % 4 !== 0 || !BASE64.test(value)) return { ok: false };
  const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  return parseJson(new TextDecoder().decode(bytes));
}

export function parseJson(text: string): Parsed<Json> {
  // catch-reason: JSON.parse is the platform's only JSON parser and throws on malformed input. Wire
  // data that is not JSON is an expected outcome, returned as a value.
  try {
    return { ok: true, value: JSON.parse(text) as Json };
  } catch {
    return { ok: false };
  }
}

export function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function textField(record: JsonObject, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

export function objectField(record: JsonObject, key: string): JsonObject | undefined {
  const value = record[key];
  return isObject(value) ? value : undefined;
}

/** Structural equality that ignores key order, as x402's reference `deepEqual` does. */
export function jsonEqual(a: Json | undefined, b: Json | undefined): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    const other: readonly Json[] = b;
    return a.every((item: Json, index) => jsonEqual(item, other[index]));
  }
  if (isObject(a) || isObject(b)) {
    if (!isObject(a) || !isObject(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => key in b && jsonEqual(a[key], b[key]));
  }
  return a === b;
}

/**
 * The x402 V2 `extra` rule: every field the server advertised must come back unchanged, and the
 * client may add fields of its own. Arrays and primitives compare exactly.
 */
export function containsSubset(expected: Json, actual: Json | undefined): boolean {
  if (!isObject(expected)) return jsonEqual(expected, actual);
  if (!isObject(actual)) return false;
  return Object.entries(expected).every(([key, value]) => containsSubset(value, actual[key]));
}
