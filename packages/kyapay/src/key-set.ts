import { TollstileError, type Clock, type JsonObject } from 'tollstile';
import { providerRequest } from './provider-request';
import { isJsonObject, stringField } from './wire';

export type SignatureCheck = 'verified' | 'bad_signature' | 'unknown_key';

export type KeySet = {
  verifyEs256(kid: string, signingInput: Uint8Array<ArrayBuffer>, signature: Uint8Array<ArrayBuffer>, signal: AbortSignal): Promise<SignatureCheck>;
};

/** Skyfire recommends caching its JWK Set for 60 minutes. */
const CACHE_MS = 60 * 60_000;
/** Bounds refetches caused by unknown `kid` values, which an unauthenticated sender controls. */
const MIN_REFRESH_MS = 60_000;
/** A JWS ES256 signature is the raw 32-byte r and s values, concatenated (RFC 7518 §3.4). */
const ES256_SIGNATURE_BYTES = 64;

type Loaded = { readonly at: number; readonly keys: readonly JsonObject[] };

/**
 * One trusted issuer's JWK Set. It is created only for issuers on the configured allow list, and the
 * URL is derived from that configuration — never from a token — so an unverified token cannot make
 * the server fetch an address of its choosing.
 */
export function issuerKeySet(options: { readonly issuer: string; readonly fetch: typeof fetch; readonly clock: Clock }): KeySet {
  const url = `${options.issuer}/.well-known/jwks.json`;
  let loaded: Loaded | undefined;
  let imported = new Map<string, CryptoKey>();

  const load = async (signal: AbortSignal): Promise<Loaded> => {
    const response = await providerRequest(options.fetch, url, { method: 'GET', headers: { accept: 'application/json' } }, signal, 'JWK Set retrieval');
    const keys = isJsonObject(response.body) ? response.body.keys : undefined;
    if (response.status !== 200 || !Array.isArray(keys)) {
      throw new TollstileError('PROVIDER_UNAVAILABLE', `KYAPay issuer returned an unusable JWK Set (HTTP ${response.status}).`);
    }
    imported = new Map();
    loaded = { at: options.clock.now().getTime(), keys: keys.filter(isJsonObject) };
    return loaded;
  };

  const find = async (kid: string, signal: AbortSignal): Promise<JsonObject | undefined> => {
    const now = options.clock.now().getTime();
    let current = loaded === undefined || now - loaded.at >= CACHE_MS ? await load(signal) : loaded;
    const match = (set: Loaded) => set.keys.find((key) => stringField(key, 'kid') === kid);
    if (match(current) === undefined && now - current.at >= MIN_REFRESH_MS) current = await load(signal);
    return match(current);
  };

  const importKey = async (kid: string, jwk: JsonObject): Promise<CryptoKey | undefined> => {
    // RFC 8725 §3.1: a key is used only with the algorithm and purpose it declares.
    const declaredAlg = stringField(jwk, 'alg');
    const declaredUse = stringField(jwk, 'use');
    if (stringField(jwk, 'kty') !== 'EC' || stringField(jwk, 'crv') !== 'P-256') return undefined;
    if ((declaredAlg !== undefined && declaredAlg !== 'ES256') || (declaredUse !== undefined && declaredUse !== 'sig')) return undefined;

    const cached = imported.get(kid);
    if (cached !== undefined) return cached;

    // Only public members are copied, so private material in a misconfigured JWK Set is never imported.
    const x = stringField(jwk, 'x');
    const y = stringField(jwk, 'y');
    if (x === undefined || y === undefined) return undefined;
    const key = await importPublicKey({ kty: 'EC', crv: 'P-256', x, y });
    imported.set(kid, key);
    return key;
  };

  return {
    async verifyEs256(kid, signingInput, signature, signal) {
      if (signature.byteLength !== ES256_SIGNATURE_BYTES) return 'bad_signature';
      const jwk = await find(kid, signal);
      if (jwk === undefined) return 'unknown_key';
      const key = await importKey(kid, jwk);
      if (key === undefined) return 'unknown_key';
      const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, signingInput);
      return valid ? 'verified' : 'bad_signature';
    },
  };
}

async function importPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
  // catch-reason: a key the issuer published that Web Crypto cannot import is a provider failure, not a bug in this process.
  try {
    return await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  } catch (error) {
    throw new TollstileError('PROVIDER_UNAVAILABLE', 'KYAPay issuer published a JWK that cannot be imported.', { cause: error });
  }
}
