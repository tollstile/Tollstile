import { TollstileError, type Json } from 'tollstile';

/**
 * RFC 8785 JSON Canonicalization Scheme. The challenge id binds the base64url of this output, so
 * two implementations must produce identical bytes for the same value.
 *
 * ECMAScript's `JSON.stringify` already implements RFC 8785's string escaping and number
 * formatting; what it lacks is key ordering, which RFC 8785 defines over UTF-16 code units —
 * the order of the default `Array.prototype.sort` comparison.
 */
export function canonicalize(value: Json): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TollstileError('UNREACHABLE', 'JCS cannot represent a non-finite number.');
    return JSON.stringify(value);
  }
  if (isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key] ?? null)}`).join(',')}}`;
}

function isArray(value: Json): value is readonly Json[] {
  return Array.isArray(value);
}
