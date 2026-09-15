import type { JsonObject } from './types';

/** HTTP header carrying a client's idempotency key. */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
/** MCP `_meta` key carrying a client's idempotency key. */
export const IDEMPOTENCY_KEY_META = 'tollstile/idempotency-key';

/** Visible ASCII, so keys cannot collide when joined into identifiers. */
const VALID_KEY = /^[\x21-\x7e]{1,255}$/;

/** Reads the client's idempotency key for an adapter: the header on HTTP, `_meta` on MCP. */
export function idempotencyKeyOf(request: Request | null, meta: JsonObject | null): string | null {
  const fromMeta = meta?.[IDEMPOTENCY_KEY_META];
  if (typeof fromMeta === 'string') return fromMeta;
  return request?.headers.get(IDEMPOTENCY_KEY_HEADER) ?? null;
}

export function isValidIdempotencyKey(key: string): boolean {
  return VALID_KEY.test(key);
}
