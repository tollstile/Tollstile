const BASE64URL = /^[A-Za-z0-9_-]*$/;

export function decodeBase64url(input: string): Uint8Array<ArrayBuffer> | undefined {
  if (!BASE64URL.test(input) || input.length % 4 === 1) return undefined;
  const padded = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(input.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

export function encodeBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
