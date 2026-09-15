import { money, type Money } from 'tollstile';
import type { Credential } from './credential';
import { equalBytes, toHex } from './encoding';
import { decodeMacaroon, encodeMacaroon, hmac, mintMacaroon, verifyMacaroon, type Bytes } from './macaroon';

/**
 * First-party caveat conditions. `preimage` is appended by aperture and lnget clients before they
 * send the macaroon; the others are minted by this rail.
 */
export const CAVEAT = {
  quote: 'tollstile_quote',
  limit: 'tollstile_limit',
  validUntil: 'tollstile_valid_until',
  preimage: 'preimage',
} as const;

/** What a verified credential entitles its holder to. */
export type TokenTerms = {
  /** Lowercase hex; the proof id, since clients re-sign the macaroon when they append `preimage=`. */
  readonly paymentHash: string;
  readonly quoteToken: string;
  readonly limit: Money;
  /** The expiry the credential was minted with. Holders may shorten it for one presentation, never for the authorization. */
  readonly validUntil: Date;
};

export type ReadToken =
  /** `proofId` (the payment hash) is set only for authentic credentials that were acceptable once, e.g. expired ones. */
  | { readonly status: 'invalid'; readonly reason: string; readonly proofId?: string }
  | ({ readonly status: 'valid' } & TokenTerms);

/** aperture's identifier v0: uint16 version | payment_hash[32] | token_id[32]. */
const IDENTIFIER_VERSION = 0;
const IDENTIFIER_LENGTH = 66;
const MINTED = [CAVEAT.quote, CAVEAT.limit, CAVEAT.validUntil] as const;
const LIMIT_VALUE = /^([A-Z]{3}):(\d{1,24})$/;
const SECONDS_VALUE = /^\d{1,12}$/;
const PREIMAGE_VALUE = /^[0-9a-fA-F]{64}$/;
const encoder = new TextEncoder();
/** Non-fatal, so invalid UTF-8 is detected by a lossy round trip instead of an exception. */
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

export async function mintToken(secret: string, paymentHash: Bytes, terms: Omit<TokenTerms, 'paymentHash'>): Promise<Bytes> {
  const identifier = new Uint8Array(IDENTIFIER_LENGTH);
  identifier.set(paymentHash, 2);
  identifier.set(crypto.getRandomValues(new Uint8Array(32)), 34);

  const values = [
    terms.quoteToken,
    `${terms.limit.currency}:${terms.limit.micros.toString()}`,
    Math.floor(terms.validUntil.getTime() / 1000).toString(),
  ];
  const macaroon = await mintMacaroon(
    await rootKey(secret, identifier),
    identifier,
    MINTED.map((condition, index) => `${condition}=${values[index] ?? ''}`),
  );
  return encodeMacaroon(macaroon);
}

/**
 * Verifies the macaroon chain against every secret, the preimage against the payment hash, and
 * every caveat. The chain signs caveat order, so the first three are the terms this rail minted;
 * anything after them was appended by a holder without the root key and can only restrict: a
 * `preimage` must match, a `valid_until` shortens this presentation, a restated quote or limit must
 * be identical, and any other condition is refused rather than ignored.
 */
export async function readToken(secrets: readonly string[], credential: Credential, now: Date): Promise<ReadToken> {
  const macaroon = decodeMacaroon(credential.macaroon);
  if (macaroon?.identifier.length !== IDENTIFIER_LENGTH || version(macaroon.identifier) !== IDENTIFIER_VERSION) {
    return invalid('macaroon_invalid');
  }

  let authentic = false;
  for (const secret of secrets) {
    if (await verifyMacaroon(await rootKey(secret, macaroon.identifier), macaroon)) authentic = true;
  }
  if (!authentic) return invalid('macaroon_invalid');

  const paymentHash = macaroon.identifier.slice(2, 34);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', credential.preimage));
  if (!equalBytes(digest, paymentHash)) return invalid('preimage_mismatch');

  const caveats: { readonly condition: string; readonly value: string }[] = [];
  for (const caveat of macaroon.caveats) {
    const text = decodeCaveat(caveat.id);
    const separator = text?.indexOf('=') ?? -1;
    if (text === undefined || separator <= 0) return invalid('caveat_malformed');
    caveats.push({ condition: text.slice(0, separator), value: text.slice(separator + 1) });
  }

  const [quote, limit, validUntil, ...appended] = caveats;
  if (quote?.condition !== CAVEAT.quote || limit?.condition !== CAVEAT.limit || validUntil?.condition !== CAVEAT.validUntil) {
    return invalid('caveat_missing');
  }
  const limitParts = LIMIT_VALUE.exec(limit.value);
  if (limitParts === null || !SECONDS_VALUE.test(validUntil.value)) return invalid('caveat_malformed');

  const preimageHex = toHex(credential.preimage);
  let expiresAt = Number(validUntil.value) * 1000;
  for (const { condition, value } of appended) {
    switch (condition) {
      case CAVEAT.preimage:
        if (!PREIMAGE_VALUE.test(value) || value.toLowerCase() !== preimageHex) return invalid('preimage_mismatch');
        break;
      case CAVEAT.validUntil:
        if (!SECONDS_VALUE.test(value)) return invalid('caveat_malformed');
        expiresAt = Math.min(expiresAt, Number(value) * 1000);
        break;
      case CAVEAT.quote:
      case CAVEAT.limit:
        if (value !== (condition === CAVEAT.quote ? quote.value : limit.value)) return invalid('caveat_conflict');
        break;
      default:
        return invalid('caveat_unsupported');
    }
  }
  if (expiresAt <= now.getTime()) return { status: 'invalid', reason: 'credential_expired', proofId: toHex(paymentHash) };

  return {
    status: 'valid',
    paymentHash: toHex(paymentHash),
    quoteToken: quote.value,
    limit: money(limitParts[1] ?? '', BigInt(limitParts[2] ?? '')),
    validUntil: new Date(Number(validUntil.value) * 1000),
  };
}

/** Stateless per-macaroon root key: never disclosed, and recomputable in any process that has the secret. */
function rootKey(secret: string, identifier: Bytes): Promise<Bytes> {
  return hmac(encoder.encode(secret), identifier);
}

function version(identifier: Bytes): number {
  return ((identifier[0] ?? 0) << 8) | (identifier[1] ?? 0);
}

function decodeCaveat(id: Bytes): string | undefined {
  const text = decoder.decode(id);
  return equalBytes(encoder.encode(text), id) ? text : undefined;
}

function invalid(reason: string): ReadToken {
  return { status: 'invalid', reason };
}
