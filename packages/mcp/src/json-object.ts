import type { Json, JsonObject } from 'tollstile';

type Parsed = { readonly ok: true; readonly value: Json } | { readonly ok: false };

const INVALID: Parsed = { ok: false };

/**
 * Reads a value from the MCP session (`params._meta`, client capabilities) as a JSON object, or
 * returns `undefined` when it holds something JSON cannot represent. In-process transports skip
 * serialization, so without this a proof could reach a rail in a shape that would never cross a
 * real wire. `undefined` becomes `{}`, and members set to `undefined` are dropped, as
 * `JSON.stringify` would.
 */
export function parseJsonObject(value: unknown): JsonObject | undefined {
  if (value === undefined) return {};
  if (!isRecord(value)) return undefined;
  const parsed = parseJson(value);
  return parsed.ok && isJsonObject(parsed.value) ? parsed.value : undefined;
}

/** Tool arguments as JSON, so a quote can commit to them. `undefined` when they are not JSON. */
export function parseJsonValue(value: unknown): Json | undefined {
  if (value === undefined) return null;
  const parsed = parseJson(value);
  return parsed.ok ? parsed.value : undefined;
}

export function isJsonObject(value: Json): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(value: unknown): Parsed {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return { ok: true, value };
  if (typeof value === 'number') return Number.isFinite(value) ? { ok: true, value } : INVALID;

  if (Array.isArray(value)) {
    const items: Json[] = [];
    for (const item of value) {
      const parsed = parseJson(item);
      if (!parsed.ok) return INVALID;
      items.push(parsed.value);
    }
    return { ok: true, value: items };
  }

  if (isRecord(value)) {
    const members: Record<string, Json> = {};
    for (const [key, member] of Object.entries(value)) {
      if (member === undefined) continue;
      const parsed = parseJson(member);
      if (!parsed.ok) return INVALID;
      members[key] = parsed.value;
    }
    return { ok: true, value: members };
  }

  return INVALID;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
