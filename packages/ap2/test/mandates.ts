import { createHash, randomBytes } from 'node:crypto';

// Builds AP2 v0.2 open → closed Payment Mandate chains the way the AP2 SDK does, independently of
// the verifier under test.

export const MERCHANT = { id: 'merchant_1', name: 'Demo Merchant', website: 'https://merchant.example' };

export type ChainOptions = {
  readonly issuer: CryptoKeyPair;
  readonly agent: CryptoKeyPair;
  readonly iat: number;
  readonly nonce: string;
  readonly aud?: string;
  /** Replaces or adds claims of the open mandate. `undefined` values remove the claim. */
  readonly open?: Record<string, unknown>;
  readonly constraints?: readonly unknown[];
  readonly closed?: Record<string, unknown>;
  readonly binding?: 'sd_hash' | 'issuer_jwt_hash' | 'both' | 'none';
  readonly kbTyp?: string;
  readonly kbSigner?: CryptoKeyPair;
  readonly rootTyp?: string;
};

export function generateKey(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
}

export async function publicJwk(key: CryptoKeyPair): Promise<JsonWebKey> {
  const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', key.publicKey);
  return { kty, crv, x, y } as JsonWebKey;
}

export async function mandateChain(options: ChainOptions): Promise<{ readonly chain: string; readonly root: string }> {
  const payee = disclosure([salt(), MERCHANT]);
  const openMandate = strip({
    vct: 'mandate.payment.open.1',
    constraints: options.constraints ?? [
      { type: 'payment.amount_range', currency: 'USD', max: 1000, min: 0 },
      { type: 'payment.allowed_payees', allowed: [{ '...': payee.digest }] },
    ],
    cnf: { jwk: await publicJwk(options.agent) },
    iat: options.iat,
    exp: options.iat + 3600,
    ...options.open,
  });
  const open = disclosure([salt(), openMandate]);
  const rootJwt = await signJwt(
    { alg: 'ES256', typ: options.rootTyp ?? 'example+sd-jwt', kid: 'issuer-1' },
    { delegate_payload: [{ '...': open.digest }], _sd_alg: 'sha-256' },
    options.issuer,
  );
  // The payee disclosure is only presented when the default allowed_payees constraint references it.
  const root = options.constraints === undefined ? `${rootJwt}~${payee.encoded}~${open.encoded}~` : `${rootJwt}~${open.encoded}~`;

  const closedMandate = strip({
    vct: 'mandate.payment.1',
    transaction_id: 'NivWhuqfzcvZNapvIEJ2-3tsdQLkiuIcye2g46WVgX8',
    payee: MERCHANT,
    payment_amount: { amount: 500, currency: 'USD' },
    payment_instrument: { id: 'stub', type: 'card' },
    ...options.closed,
  });
  const closed = disclosure([salt(), closedMandate]);
  const binding = options.binding ?? 'sd_hash';
  const kbJwt = await signJwt(
    { alg: 'ES256', typ: options.kbTyp ?? 'kb+sd-jwt' },
    {
      delegate_payload: [{ '...': closed.digest }],
      iat: options.iat,
      aud: options.aud ?? 'https://api.example',
      nonce: options.nonce,
      ...(binding === 'sd_hash' || binding === 'both' ? { sd_hash: hash(root) } : {}),
      ...(binding === 'issuer_jwt_hash' || binding === 'both' ? { issuer_jwt_hash: hash(rootJwt) } : {}),
      _sd_alg: 'sha-256',
    },
    options.kbSigner ?? options.agent,
  );
  return { chain: `${root}~${kbJwt}~${closed.encoded}~`, root };
}

export function hash(value: string): string {
  return createHash('sha256').update(value, 'ascii').digest('base64url');
}

function disclosure(value: readonly unknown[]): { readonly encoded: string; readonly digest: string } {
  const encoded = Buffer.from(JSON.stringify(value)).toString('base64url');
  return { encoded, digest: hash(encoded) };
}

async function signJwt(header: object, payload: object, key: CryptoKeyPair): Promise<string> {
  const input = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, new TextEncoder().encode(input));
  return `${input}.${Buffer.from(signature).toString('base64url')}`;
}

function salt(): string {
  return randomBytes(16).toString('base64url');
}

function strip(claims: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(claims).filter(([, value]) => value !== undefined));
}
