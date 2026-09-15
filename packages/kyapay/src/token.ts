import type { JsonObject, Money } from 'tollstile';
import type { KeySet } from './key-set';
import { parseUsdDecimal } from './usd-decimal';
import { isJsonObject, parseJson, stringField } from './wire';

/** The KYAPay token types that carry a payment. `kya` tokens identify but cannot be charged. */
export type PaymentTokenType = 'pay' | 'kya-pay';

/** A structurally valid KYAPay payment JWS whose signature and claims have not been checked yet. */
export type DecodedToken = {
  readonly compact: string;
  readonly type: PaymentTokenType;
  readonly header: JsonObject;
  readonly claims: JsonObject;
  readonly signingInput: Uint8Array<ArrayBuffer>;
  readonly signature: Uint8Array<ArrayBuffer>;
};

export type TokenPolicy = {
  /** Trusted issuers, each mapped to its key set. Membership is checked before any key is fetched. */
  readonly issuers: ReadonlyMap<string, KeySet>;
  readonly audience: string;
  readonly serviceId: string;
  readonly environment: string;
  readonly tokenTypes: readonly PaymentTokenType[];
  readonly clockSkewSeconds: number;
};

/** A payment token whose signature and claims were verified. */
export type PaymentToken = {
  readonly compact: string;
  readonly type: PaymentTokenType;
  readonly issuer: string;
  readonly tokenId: string;
  readonly subject: string;
  /** `amt` and `cur`: the funded hold, in currency units. */
  readonly amount: Money;
  /** `exp`, in epoch seconds. */
  readonly expiresAt: number;
  /** RFC 7800 `cnf`: present on sender-constrained tokens, which must not be accepted as bearer tokens. */
  readonly confirmation: JsonObject | null;
};

export type TokenCheck = { readonly ok: true; readonly token: PaymentToken } | { readonly ok: false; readonly reason: string };

const PAYMENT_TYPES: Readonly<Record<string, PaymentTokenType>> = { 'pay+jwt': 'pay', 'kya-pay+jwt': 'kya-pay' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64URL = /^[A-Za-z0-9_-]*$/;
const POSITIVE_INTEGER = /^[1-9]\d*$/;
/** Skyfire issues tokens that live at most 24 hours; a longer lifetime is outside any issuer policy we know. */
const MAX_LIFETIME_SECONDS = 86_400;
/**
 * Card-settled tokens carry a network token and cryptogram in `sti`. They are refused outright so
 * card credentials never reach the ledger, which stores the token to charge it later.
 */
const CARD_SETTLEMENT_TYPES = new Set(['visa_vic', 'mastercard_scof']);
const CARD_CREDENTIAL_MEMBERS = ['payment_token', 'token_security_code', 'token_expiration_month', 'token_expiration_year'];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Splits a `KYAPay-Token` field value (a comma-separated list; repeated fields arrive joined) into
 * payment tokens. Members that are not JWS compact tokens, and `kya` identity tokens, are ignored:
 * the header binding identifies tokens by `typ`, not position.
 */
export function readPaymentTokens(value: string): readonly DecodedToken[] {
  return value.split(',').flatMap((member) => {
    const token = decodeToken(member.trim());
    return token === undefined ? [] : [token];
  });
}

function decodeToken(compact: string): DecodedToken | undefined {
  const parts = compact.split('.');
  if (parts.length !== 3) return undefined;
  const [headerPart = '', payloadPart = '', signaturePart = ''] = parts;
  const header = decodeJsonPart(headerPart);
  const claims = decodeJsonPart(payloadPart);
  const signature = decodeBase64Url(signaturePart);
  if (header === undefined || claims === undefined || signature === undefined) return undefined;

  // `typ` is a media type: compared case-insensitively, with the optional "application/" prefix (RFC 7515 §4.1.9).
  const typ = stringField(header, 'typ')?.toLowerCase().replace(/^application\//, '');
  const type = typ === undefined ? undefined : PAYMENT_TYPES[typ];
  if (type === undefined) return undefined;
  return { compact, type, header, claims, signingInput: encoder.encode(`${headerPart}.${payloadPart}`), signature };
}

/**
 * Validates a payment token per draft-skyfire-oauth-kyapay-token and Skyfire's seller guidance.
 * Checks that need no network run first, and the issuer is compared with the allow list before its
 * key set is consulted, so an untrusted `iss` never causes a fetch.
 */
export async function verifyPaymentToken(token: DecodedToken, policy: TokenPolicy, now: Date, signal: AbortSignal): Promise<TokenCheck> {
  const { header, claims } = token;
  // Only ES256 is accepted: this rejects `none`, HMAC substitution with a public key, and anything else.
  if (stringField(header, 'alg') !== 'ES256') return fail('unsupported_algorithm');
  if (header.crit !== undefined) return fail('unsupported_header');
  if (!policy.tokenTypes.includes(token.type)) return fail('token_type_not_accepted');
  const kid = stringField(header, 'kid');
  if (kid === undefined) return fail('unknown_key');
  const issuer = stringField(claims, 'iss');
  const keys = issuer === undefined ? undefined : policy.issuers.get(issuer);
  if (issuer === undefined || keys === undefined) return fail('untrusted_issuer');

  const signature = await keys.verifyEs256(kid, token.signingInput, token.signature, signal);
  if (signature !== 'verified') return fail(signature);

  if (stringField(claims, 'aud') !== policy.audience) return fail('wrong_audience');
  if (stringField(claims, 'env') !== policy.environment) return fail('wrong_environment');
  const tsi = stringField(claims, 'tsi');
  const ssi = stringField(claims, 'ssi');
  // The draft renamed Skyfire's `ssi` to `tsi`; tokens may carry either, and must not disagree.
  if ((tsi ?? ssi) !== policy.serviceId || (ssi !== undefined && ssi !== policy.serviceId)) return fail('wrong_service');

  const subject = stringField(claims, 'sub');
  const tokenId = stringField(claims, 'jti');
  const { iat, exp, nbf } = claims;
  if (subject === undefined || subject === '' || tokenId === undefined || !UUID.test(tokenId)) return fail('invalid_claims');
  if (!isEpochSeconds(iat) || !isEpochSeconds(exp) || !(nbf === undefined || isEpochSeconds(nbf))) return fail('invalid_claims');

  const seconds = Math.floor(now.getTime() / 1000);
  if (seconds >= exp + policy.clockSkewSeconds) return fail('expired');
  if (iat > seconds + policy.clockSkewSeconds || (nbf !== undefined && nbf > seconds + policy.clockSkewSeconds)) {
    return fail('not_yet_valid');
  }
  if (exp <= iat || exp - iat > MAX_LIFETIME_SECONDS) return fail('lifetime_not_accepted');

  const payment = checkPaymentClaims(claims);
  if (!payment.ok) return payment;

  const { cnf } = claims;
  const confirmation = cnf === undefined ? null : isJsonObject(cnf) ? cnf : undefined;
  if (confirmation === undefined) return fail('invalid_claims');
  return {
    ok: true,
    token: {
      compact: token.compact,
      type: token.type,
      issuer,
      tokenId,
      subject,
      amount: payment.amount,
      expiresAt: exp,
      confirmation,
    },
  };
}

function checkPaymentClaims(claims: JsonObject): { readonly ok: true; readonly amount: Money } | { readonly ok: false; readonly reason: string } {
  const settlementType = stringField(claims, 'stp');
  const instrument = claims.sti;
  if (settlementType === 'card') return fail('card_token_refused');
  if (instrument !== undefined) {
    if (!isJsonObject(instrument)) return fail('invalid_claims');
    const instrumentType = stringField(instrument, 'type');
    if (
      (instrumentType !== undefined && CARD_SETTLEMENT_TYPES.has(instrumentType)) ||
      CARD_CREDENTIAL_MEMBERS.some((member) => instrument[member] !== undefined)
    ) {
      return fail('card_token_refused');
    }
    if (instrument.verified !== true) return fail('settlement_instrument_unverified');
  }

  // Skyfire issues USD tokens only; any other currency would need a conversion Tollstile never makes.
  if (stringField(claims, 'cur') !== 'USD') return fail('unsupported_currency');
  const amt = stringField(claims, 'amt');
  const val = stringField(claims, 'val');
  const amount = amt === undefined ? undefined : parseUsdDecimal(amt);
  if (amount === undefined || amount.micros === 0n || val === undefined || !POSITIVE_INTEGER.test(val)) return fail('invalid_amount');
  return { ok: true, amount };
}

function fail(reason: string): { readonly ok: false; readonly reason: string } {
  return { ok: false, reason };
}

function isEpochSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function decodeJsonPart(part: string): JsonObject | undefined {
  const bytes = decodeBase64Url(part);
  if (bytes === undefined) return undefined;
  // Signatures cover the encoded bytes, so lenient UTF-8 decoding cannot change what was signed.
  const value = parseJson(decoder.decode(bytes));
  return isJsonObject(value) ? value : undefined;
}

function decodeBase64Url(input: string): Uint8Array<ArrayBuffer> | undefined {
  if (input === '' || !BASE64URL.test(input) || input.length % 4 === 1) return undefined;
  const binary = atob(input.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
