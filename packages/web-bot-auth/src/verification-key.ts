import { decodeBase64url, encodeBase64url } from './base64';

// Public keys from a JWK Set, the RFC 7638 thumbprints Web Bot Auth uses as keyid, and the RFC 9421
// algorithms they verify with.

export type SignatureAlgorithm = 'ed25519' | 'ecdsa-p256-sha256' | 'ecdsa-p384-sha384' | 'rsa-pss-sha512';

export type VerificationKey = {
  /** RFC 7638 SHA-256 thumbprint, base64url. */
  readonly thumbprint: string;
  readonly algorithm: SignatureAlgorithm;
  /**
   * Whether the key itself names its algorithm. An RSA key without `alg` could be meant for
   * RSASSA-PKCS1-v1_5, so the signature must name `rsa-pss-sha512` explicitly (RFC 9421 §3.2).
   */
  readonly explicit: boolean;
  /** Seconds since the epoch, from the directory's optional `nbf` / `exp` members. */
  readonly notBefore: number | undefined;
  readonly notAfter: number | undefined;
  readonly cryptoKey: CryptoKey;
};

type KeyShape = {
  readonly algorithm: SignatureAlgorithm;
  /** Both JOSE names and RFC 9421 names appear in directories; the draft restricts `alg` to the latter. */
  readonly names: readonly string[];
  readonly members: readonly string[];
  readonly importParams: EcKeyImportParams | RsaHashedImportParams | Algorithm;
};

const SHAPES: Readonly<Record<string, KeyShape>> = {
  'OKP Ed25519': { algorithm: 'ed25519', names: ['ed25519', 'EdDSA', 'Ed25519'], members: ['crv', 'kty', 'x'], importParams: { name: 'Ed25519' } },
  'EC P-256': {
    algorithm: 'ecdsa-p256-sha256',
    names: ['ecdsa-p256-sha256', 'ES256'],
    members: ['crv', 'kty', 'x', 'y'],
    importParams: { name: 'ECDSA', namedCurve: 'P-256' },
  },
  'EC P-384': {
    algorithm: 'ecdsa-p384-sha384',
    names: ['ecdsa-p384-sha384', 'ES384'],
    members: ['crv', 'kty', 'x', 'y'],
    importParams: { name: 'ECDSA', namedCurve: 'P-384' },
  },
  RSA: { algorithm: 'rsa-pss-sha512', names: ['rsa-pss-sha512', 'PS512'], members: ['e', 'kty', 'n'], importParams: { name: 'RSA-PSS', hash: 'SHA-512' } },
};

const VERIFY_PARAMS: Readonly<Record<SignatureAlgorithm, Algorithm | EcdsaParams | RsaPssParams>> = {
  ed25519: { name: 'Ed25519' },
  'ecdsa-p256-sha256': { name: 'ECDSA', hash: 'SHA-256' },
  'ecdsa-p384-sha384': { name: 'ECDSA', hash: 'SHA-384' },
  'rsa-pss-sha512': { name: 'RSA-PSS', saltLength: 64 },
};

const SIGNATURE_LENGTH: Readonly<Partial<Record<SignatureAlgorithm, number>>> = {
  ed25519: 64,
  'ecdsa-p256-sha256': 64,
  'ecdsa-p384-sha384': 96,
};

const MIN_RSA_MODULUS_BYTES = 256;

/**
 * A verification key from one JWK Set entry, or `undefined` for entries a verifier should skip:
 * unsupported or private keys, a `kid` that is not the thumbprint, or inconsistent `alg`/`use`.
 */
export async function readVerificationKey(entry: unknown): Promise<VerificationKey | undefined> {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined;
  const jwk = entry as Readonly<Record<string, unknown>>;
  const shape = jwk.kty === 'RSA' ? SHAPES.RSA : SHAPES[`${String(jwk.kty)} ${String(jwk.crv)}`];
  if (shape === undefined || 'd' in jwk) return undefined;
  if (jwk.use !== undefined && jwk.use !== 'sig') return undefined;
  if (jwk.key_ops !== undefined && !(Array.isArray(jwk.key_ops) && jwk.key_ops.includes('verify'))) return undefined;
  if (jwk.alg !== undefined && !(typeof jwk.alg === 'string' && shape.names.includes(jwk.alg))) return undefined;

  const members: Record<string, string> = {};
  for (const member of shape.members) {
    const value = jwk[member];
    if (typeof value !== 'string') return undefined;
    members[member] = value;
  }
  if (shape.algorithm === 'rsa-pss-sha512' && (decodeBase64url(members.n ?? '')?.length ?? 0) < MIN_RSA_MODULUS_BYTES) return undefined;

  const thumbprint = await jwkThumbprint(members, shape.members);
  if (jwk.kid !== undefined && jwk.kid !== thumbprint) return undefined;
  const cryptoKey = await importPublicKey(members, shape);
  if (cryptoKey === undefined) return undefined;

  return {
    thumbprint,
    algorithm: shape.algorithm,
    explicit: jwk.alg !== undefined || shape.algorithm !== 'rsa-pss-sha512',
    notBefore: typeof jwk.nbf === 'number' ? jwk.nbf : undefined,
    notAfter: typeof jwk.exp === 'number' ? jwk.exp : undefined,
    cryptoKey,
  };
}

/** The algorithm to verify with, when the key and the signature's `alg` parameter agree (RFC 9421 §3.3.7). */
export function agreedAlgorithm(key: VerificationKey, alg: string | undefined): SignatureAlgorithm | undefined {
  if (alg === undefined) return key.explicit ? key.algorithm : undefined;
  return alg === key.algorithm ? key.algorithm : undefined;
}

export async function verifySignature(
  key: VerificationKey,
  algorithm: SignatureAlgorithm,
  base: string,
  signature: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  const length = SIGNATURE_LENGTH[algorithm];
  if (length !== undefined && signature.length !== length) return false;
  return crypto.subtle.verify(VERIFY_PARAMS[algorithm], key.cryptoKey, signature, new TextEncoder().encode(base));
}

/** RFC 7638: the required members in lexicographic order, no whitespace, SHA-256. */
async function jwkThumbprint(members: Readonly<Record<string, string>>, names: readonly string[]): Promise<string> {
  const canonical = JSON.stringify(Object.fromEntries(names.map((name) => [name, members[name]])));
  return encodeBase64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))));
}

async function importPublicKey(members: Readonly<Record<string, string>>, shape: KeyShape): Promise<CryptoKey | undefined> {
  // catch-reason: WebCrypto reports invalid key material (e.g. a point off the curve) by throwing; such a directory entry is skipped, not fatal.
  try {
    return await crypto.subtle.importKey('jwk', { ...members, ext: true }, shape.importParams, false, ['verify']);
  } catch {
    return undefined;
  }
}
