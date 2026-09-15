import type { Context, JsonObject, Offer, Quote, VerifyTerms, Money } from 'tollstile';
import {
  bindingSlots,
  computeChallengeId,
  QUOTE_OPAQUE_KEY,
  type Challenge,
  type ChallengeSecrets,
} from './challenge';
import { constantTimeEqual, fromBase64url, fromUtf8, isObject, parseJson, utf8 } from './encoding';
import { canonicalize } from './jcs';

export const CREDENTIAL_META = 'org.paymentauth/credential';

/** A credential whose challenge id, expiry, and realm were verified. The payload is still untrusted. */
export type Credential = {
  readonly challenge: Challenge;
  readonly payload: JsonObject;
  readonly source: string | null;
};

export type CredentialRead =
  | { readonly status: 'absent' }
  | {
      readonly status: 'invalid';
      readonly reason: string;
      /**
       * Set only for a challenge this server issued (its id verified) that can no longer be accepted,
       * so a charge rail can let core answer a retry of an already-paid request from the ledger.
       */
      readonly challengeId?: string;
    }
  | { readonly status: 'present'; readonly credential: Credential };

export type Expected = {
  readonly realm: string;
  readonly method: string;
  readonly intent: string;
  readonly secrets: ChallengeSecrets;
  readonly now: Date;
};

const HTTP_CREDENTIAL = /^Payment\s+([A-Za-z0-9_-]+)\s*$/i;

/**
 * Reads `Authorization: Payment <base64url>` (HTTP) or `_meta["org.paymentauth/credential"]` (MCP)
 * and verifies it was issued by this server and is still valid. Credentials for another method or
 * intent are `absent`, so several MPP rails can share one request.
 */
export async function readCredential(context: Context, expected: Expected): Promise<CredentialRead> {
  const raw = rawCredential(context);
  if (raw === undefined) return { status: 'absent' };
  if (!isObject(raw) || !isObject(raw.challenge)) return invalid('malformed_credential');

  const { challenge, payload, source } = raw;
  if (challenge.method !== expected.method || challenge.intent !== expected.intent) return { status: 'absent' };
  if (typeof challenge.id !== 'string' || challenge.id === '' || challenge.realm !== expected.realm) {
    return invalid('challenge_invalid');
  }
  // This server never issues `digest` or `header`; a credential carrying them was not issued here.
  if (challenge.digest !== undefined || challenge.header !== undefined) return invalid('challenge_invalid');
  if (typeof challenge.expires !== 'string') return invalid('challenge_expires_missing');
  const expires = Date.parse(challenge.expires);
  if (Number.isNaN(expires)) return invalid('malformed_credential');

  const request = decodeObject(challenge.request);
  const opaque = challenge.opaque === undefined ? {} : decodeObject(challenge.opaque);
  if (request === undefined || opaque === undefined || !isStringMap(opaque)) return invalid('malformed_credential');

  const issued: Challenge = {
    id: challenge.id,
    realm: expected.realm,
    method: expected.method,
    intent: expected.intent,
    request,
    expires: challenge.expires,
    opaque,
  };
  if (!(await isBound(issued, expected.secrets))) return invalid('challenge_invalid');
  if (expires <= expected.now.getTime()) return { status: 'invalid', reason: 'challenge_expired', challengeId: issued.id };

  if (!isObject(payload)) return invalid('invalid_payload');
  return {
    status: 'present',
    credential: { challenge: issued, payload, source: typeof source === 'string' ? source : null },
  };
}

export type ChargeTerms =
  | { readonly status: 'invalid'; readonly reason: string; readonly challengeId?: string }
  | {
      readonly status: 'ok';
      readonly quote: Quote | null;
      /** The price being paid: the quoted price, or the fixed route price. */
      readonly price: Money;
      /** The signed offer for this rail, when a quote came back. */
      readonly offer: Offer | null;
    };

/** Opens the quote carried in `opaque`, or falls back to the fixed route price. */
export async function chargeTerms(credential: Credential, terms: VerifyTerms, rail: string): Promise<ChargeTerms> {
  const token = credential.challenge.opaque[QUOTE_OPAQUE_KEY];
  if (token === undefined) {
    if (terms.price === null) return { status: 'invalid', reason: 'quote_required' };
    return { status: 'ok', quote: null, price: terms.price, offer: null };
  }
  const quote = await terms.openQuote(token);
  // The challenge is authentic, so its quote expired with it or was issued for another resource.
  if (quote === undefined) return { status: 'invalid', reason: 'quote_invalid', challengeId: credential.challenge.id };
  const offer = quote.offers.find((candidate) => candidate.rail === rail);
  if (offer === undefined) return { status: 'invalid', reason: 'quote_offer_missing' };
  return { status: 'ok', quote, price: quote.price, offer };
}

/** The echoed `request` must be exactly what this server issues for these terms. */
export function sameRequest(credential: Credential, expected: JsonObject): boolean {
  return canonicalize(credential.challenge.request) === canonicalize(expected);
}

function rawCredential(context: Context): unknown {
  if (context.transport === 'mcp') return context.mcp?.meta[CREDENTIAL_META];
  const header = context.request?.headers.get('authorization');
  if (header === null || header === undefined) return undefined;
  if (!/^Payment\s/i.test(header)) return undefined;
  const match = HTTP_CREDENTIAL.exec(header);
  const bytes = match?.[1] === undefined ? undefined : fromBase64url(match[1]);
  const text = bytes === undefined ? undefined : fromUtf8(bytes);
  // A malformed Payment credential is still a Payment credential: report it rather than skip it.
  return text === undefined ? null : (parseJson(text) ?? null);
}

/** HTTP carries base64url(JSON); MCP carries native JSON. Both are accepted from either transport. */
function decodeObject(value: unknown): JsonObject | undefined {
  if (isObject(value)) return value;
  if (typeof value !== 'string') return undefined;
  const bytes = fromBase64url(value);
  const text = bytes === undefined ? undefined : fromUtf8(bytes);
  const parsed = text === undefined ? undefined : parseJson(text);
  return isObject(parsed) ? parsed : undefined;
}

function isStringMap(value: JsonObject): value is Readonly<Record<string, string>> {
  return Object.values(value).every((entry) => typeof entry === 'string');
}

async function isBound(challenge: Challenge, secrets: ChallengeSecrets): Promise<boolean> {
  const slots = bindingSlots(challenge);
  const presented = utf8(challenge.id);
  let bound = false;
  // Every secret is tried, so timing does not reveal which one matched.
  for (const secret of secrets) {
    if (constantTimeEqual(presented, utf8(await computeChallengeId(secret, slots)))) bound = true;
  }
  return bound;
}

/**
 * The verification for a rejected charge credential. Charge rails use the challenge id as proof id,
 * so an authentic challenge is reported with it and core can recognize a retry of a paid request.
 */
export function rejected(result: { readonly reason: string; readonly challengeId?: string }): { readonly status: 'invalid'; readonly reason: string; readonly proofId?: string } {
  return result.challengeId === undefined
    ? { status: 'invalid', reason: result.reason }
    : { status: 'invalid', reason: result.reason, proofId: result.challengeId };
}

function invalid(reason: string): CredentialRead {
  return { status: 'invalid', reason };
}
