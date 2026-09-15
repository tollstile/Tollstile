const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const BASE64URL = /^[A-Za-z0-9_-]*$/;

/** Standard base64 as used by RFC 8941 Byte Sequences. Missing padding is tolerated, as RFC 8941 §4.2.7 asks. */
export function decodeBase64(input: string): Uint8Array<ArrayBuffer> | undefined {
  if (!BASE64.test(input)) return undefined;
  const unpadded = input.replace(/=+$/, '');
  if (unpadded.length % 4 === 1) return undefined;
  return toBytes(atob(unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, '=')));
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeBase64url(input: string): Uint8Array<ArrayBuffer> | undefined {
  if (!BASE64URL.test(input) || input.length % 4 === 1) return undefined;
  return decodeBase64(input.replace(/-/g, '+').replace(/_/g, '/'));
}

export function encodeBase64url(bytes: Uint8Array): string {
  return encodeBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function toBytes(binary: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
