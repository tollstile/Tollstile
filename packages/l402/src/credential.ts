import { fromBase64, fromHex } from './encoding';
import type { Bytes } from './macaroon';

/** What a client presents after paying: `L402 <base64 macaroon>:<hex preimage>`. */
export type Credential = {
  readonly macaroon: Bytes;
  readonly preimage: Bytes;
};

export type ParsedCredential =
  | { readonly status: 'absent' }
  | { readonly status: 'invalid'; readonly reason: string }
  | { readonly status: 'present'; readonly credential: Credential };

/**
 * `LSAT` is the protocol's former name; the spec requires servers to accept both. aperture's client
 * sends one line of each, which `Headers.get` joins with ", ", so the value is split before each scheme.
 */
const SCHEME_BOUNDARY = /,\s*(?=(?:L402|LSAT)(?:\s|$))/i;
const SCHEME = /^\s*(?:L402|LSAT)(?:\s+(.*?))?\s*$/is;
const TOKEN = /^([A-Za-z0-9+/=_,-]+):([0-9A-Fa-f]{64})$/;

/** Reads an `Authorization` header value (or the same string from MCP `_meta`). Other schemes are absent. */
export function parseCredential(value: string | undefined): ParsedCredential {
  if (value === undefined) return { status: 'absent' };

  const tokens = value
    .split(SCHEME_BOUNDARY)
    .map((item) => SCHEME.exec(item))
    .filter((match) => match !== null)
    .map((match) => match[1] ?? '');
  const [token, ...others] = tokens;
  if (token === undefined) return { status: 'absent' };
  if (others.some((other) => other !== token)) return { status: 'invalid', reason: 'conflicting_credentials' };

  const parts = TOKEN.exec(token);
  if (parts === null) return { status: 'invalid', reason: 'malformed_credential' };
  const [, encodedMacaroon = '', encodedPreimage = ''] = parts;
  // The grammar allows several macaroons; no deployed server or client uses more than one.
  if (encodedMacaroon.includes(',')) return { status: 'invalid', reason: 'multiple_macaroons_unsupported' };

  const macaroon = fromBase64(encodedMacaroon);
  const preimage = fromHex(encodedPreimage);
  if (macaroon === undefined || preimage === undefined) return { status: 'invalid', reason: 'malformed_credential' };
  return { status: 'present', credential: { macaroon, preimage } };
}

export function challengeValue(scheme: 'L402' | 'LSAT', macaroon: string, invoice: string): string {
  return `${scheme} macaroon="${macaroon}", invoice="${invoice}"`;
}
