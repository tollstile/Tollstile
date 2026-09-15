import { decodeBase64url, encodeBase64url } from './base64url';

// RFC 9901 SD-JWT, as far as AP2 mandates need it: compact parsing, ES256 signatures, and
// disclosure processing (§7.1). Everything here returns a reason instead of throwing.

export type JsonRecord = { readonly [key: string]: unknown };

export type SdJwt = {
  /** `<issuer-jwt>~<disclosure>~...~`, the input to a following `sd_hash`. */
  readonly serialized: string;
  readonly issuerJwt: string;
  readonly header: JsonRecord;
  readonly payload: JsonRecord;
  readonly disclosures: readonly string[];
  readonly hash: HashAlgorithm;
};

type HashAlgorithm = 'SHA-256' | 'SHA-384' | 'SHA-512';

const HASHES: Readonly<Record<string, HashAlgorithm>> = { 'sha-256': 'SHA-256', 'sha-384': 'SHA-384', 'sha-512': 'SHA-512' };
const ES256_SIGNATURE_BYTES = 64;
const INVALID = Symbol('invalid');

/** Parses `<issuer-jwt>~<disclosure>~...~`. A trailing KB-JWT is not part of an AP2 chain hop. */
export function parseSdJwt(serialized: string): SdJwt | string {
  if (!serialized.endsWith('~')) return 'sd_jwt_malformed';
  const [issuerJwt = '', ...disclosures] = serialized.slice(0, -1).split('~');
  if (disclosures.some((disclosure) => disclosure === '')) return 'sd_jwt_malformed';

  const [headerPart = '', payloadPart = '', signaturePart, extra] = issuerJwt.split('.');
  if (signaturePart === undefined || extra !== undefined) return 'sd_jwt_malformed';
  const header = decodeJson(headerPart);
  const payload = decodeJson(payloadPart);
  if (!isRecord(header) || !isRecord(payload)) return 'sd_jwt_malformed';

  const hash = payload._sd_alg === undefined ? 'SHA-256' : typeof payload._sd_alg === 'string' ? HASHES[payload._sd_alg] : undefined;
  if (hash === undefined) return 'sd_alg_unsupported';
  return { serialized, issuerJwt, header, payload, disclosures, hash };
}

/** Verifies the issuer JWT's ES256 signature with a P-256 public JWK. */
export async function verifyEs256(token: SdJwt, jwk: unknown): Promise<boolean> {
  if (token.header.alg !== 'ES256') return false;
  const key = await importP256(jwk);
  const [header, payload, signature = ''] = token.issuerJwt.split('.');
  const bytes = decodeBase64url(signature);
  if (key === undefined || bytes?.length !== ES256_SIGNATURE_BYTES) return false;
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, bytes, new TextEncoder().encode(`${header ?? ''}.${payload ?? ''}`));
}

/** base64url(hash(ASCII value)), the digest RFC 9901 uses for disclosures and `sd_hash`. */
export async function digest(algorithm: HashAlgorithm, value: string): Promise<string> {
  return encodeBase64url(new Uint8Array(await crypto.subtle.digest(algorithm, new TextEncoder().encode(value))));
}

/**
 * The payload with every disclosure substituted in place (RFC 9901 §7.1 step 3): `_sd` digests in
 * objects, `{"...": digest}` elements in arrays. Undisclosed digests are decoys and disappear. A
 * disclosure that is malformed, referenced twice, or not referenced at all invalidates the token.
 */
export async function disclosedPayload(token: SdJwt): Promise<JsonRecord | string> {
  const byDigest = new Map<string, unknown[]>();
  for (const disclosure of token.disclosures) {
    const decoded = decodeJson(disclosure);
    if (!Array.isArray(decoded) || (decoded.length !== 2 && decoded.length !== 3) || typeof decoded[0] !== 'string') return 'disclosure_malformed';
    const key = await digest(token.hash, disclosure);
    if (byDigest.has(key)) return 'disclosure_duplicated';
    byDigest.set(key, decoded);
  }

  const used = new Set<string>();
  const take = (key: unknown): unknown[] | 'decoy' | 'invalid' => {
    if (typeof key !== 'string') return 'invalid';
    const disclosure = byDigest.get(key);
    if (disclosure === undefined) return 'decoy';
    if (used.has(key)) return 'invalid';
    used.add(key);
    return disclosure;
  };

  const resolve = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (const element of value) {
        if (isRecord(element) && Object.keys(element).length === 1 && '...' in element) {
          const disclosure = take(element['...']);
          if (disclosure === 'invalid' || (disclosure !== 'decoy' && disclosure.length !== 2)) return INVALID;
          if (disclosure !== 'decoy') result.push(resolve(disclosure[1]));
          continue;
        }
        result.push(resolve(element));
      }
      return result.includes(INVALID) ? INVALID : result;
    }
    if (!isRecord(value)) return value;

    // Entries, not assignment, so a claim named `__proto__` stays a plain property.
    const result = new Map<string, unknown>();
    for (const [name, member] of Object.entries(value)) {
      if (name !== '_sd') result.set(name, resolve(member));
    }
    const digests = value._sd ?? [];
    if (!Array.isArray(digests)) return INVALID;
    for (const key of digests) {
      const disclosure = take(key);
      if (disclosure === 'decoy') continue;
      if (disclosure === 'invalid' || disclosure.length !== 3) return INVALID;
      const [, name, member] = disclosure;
      if (typeof name !== 'string' || name === '_sd' || name === '...' || result.has(name)) return INVALID;
      result.set(name, resolve(member));
    }
    return [...result.values()].includes(INVALID) ? INVALID : Object.fromEntries(result);
  };

  // `_sd_alg` describes the token and is not a claim (§4.1.1).
  const payload = resolve(Object.fromEntries(Object.entries(token.payload).filter(([name]) => name !== '_sd_alg')));
  if (payload === INVALID || !isRecord(payload)) return 'disclosure_invalid';
  if (used.size !== byDigest.size) return 'disclosure_unreferenced';
  return payload;
}

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeJson(segment: string): unknown {
  const bytes = decodeBase64url(segment);
  if (bytes === undefined) return undefined;
  // catch-reason: JSON.parse and a fatal TextDecoder report malformed input by throwing; a malformed token is an expected, returned outcome.
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

async function importP256(jwk: unknown): Promise<CryptoKey | undefined> {
  if (!isRecord(jwk) || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') return undefined;
  // catch-reason: WebCrypto reports an invalid point by throwing; an unusable key fails verification.
  try {
    return await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  } catch {
    return undefined;
  }
}
