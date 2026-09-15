const HEX = /^(?:[0-9a-fA-F]{2})*$/;
const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Returns undefined for anything that is not whole-byte hex. */
export function fromHex(input: string): Uint8Array<ArrayBuffer> | undefined {
  if (!HEX.test(input)) return undefined;
  const bytes = new Uint8Array(input.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(input.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Accepts standard and URL-safe alphabets, padded or not: the L402 spec says standard base64,
 * but deployed clients (lnget) also accept the URL-safe form.
 */
export function fromBase64(input: string): Uint8Array<ArrayBuffer> | undefined {
  if (!BASE64.test(input)) return undefined;
  const standard = input.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  if (standard.length % 4 === 1) return undefined;
  const binary = atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, '='));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0;
}
