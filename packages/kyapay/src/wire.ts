import type { Json, JsonObject } from 'tollstile';

/** Parses untrusted JSON. `undefined` means the text is not JSON, which is an expected outcome on the wire. */
export function parseJson(text: string): Json | undefined {
  // catch-reason: JSON.parse is the only standard validator for untrusted JSON, and it reports malformed input by throwing.
  try {
    // JSON.parse can only produce JSON values, so the cast narrows rather than asserts.
    return JSON.parse(text) as Json;
  } catch {
    return undefined;
  }
}

export function isJsonObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function stringField(object: JsonObject, key: string): string | undefined {
  const value = object[key];
  return typeof value === 'string' ? value : undefined;
}

export function objectField(object: JsonObject, key: string): JsonObject | undefined {
  const value = object[key];
  return isJsonObject(value) ? value : undefined;
}
