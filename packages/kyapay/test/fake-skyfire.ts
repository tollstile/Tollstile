import { parseMoney, type Clock } from 'tollstile';

export const SELLER_ID = 'a0102e21-c16e-4b1f-86cb-d2c237e18860';
export const SERVICE_ID = 'fbd49bd0-99f3-42f0-bb5b-7e689a49ec72';
export const API_KEY = 'test-seller-api-key';
export const SANDBOX_ISSUER = 'https://app-sandbox.skyfire.xyz';
export const SANDBOX_API = 'https://api-sandbox.skyfire.xyz';

type Claims = Record<string, unknown>;

export type Issuer = {
  readonly origin: string;
  readonly kid: string;
  readonly publicJwk: JsonWebKey;
  sign(claims: Claims, header?: Claims): Promise<string>;
};

const encoder = new TextEncoder();

export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodeJson(value: unknown): string {
  return base64url(encoder.encode(JSON.stringify(value)));
}

/** An ES256 token issuer with a freshly generated key. */
export async function createIssuer(origin: string, kid = 'key-1'): Promise<Issuer> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const exported = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const publicJwk: JsonWebKey = { kty: 'EC', crv: 'P-256', x: exported.x, y: exported.y, kid, alg: 'ES256', use: 'sig' } as JsonWebKey;
  return {
    origin,
    kid,
    publicJwk,
    async sign(claims, header = {}) {
      const signingInput = `${encodeJson({ alg: 'ES256', kid, typ: 'kya-pay+JWT', ...header })}.${encodeJson(claims)}`;
      const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, encoder.encode(signingInput));
      return `${signingInput}.${base64url(new Uint8Array(signature))}`;
    },
  };
}

export type ChargeRecord = { tokenId: string; chargeId: string; value: string; chargedAt: string };

export type Simulation = {
  readonly jwks?: 'ok' | 'unavailable';
  /** `after-effect`: the charge is recorded, then the connection hangs until the caller gives up. */
  readonly charge?: 'ok' | 'hang-before-effect' | 'hang-after-effect' | { readonly status: number; readonly body: unknown };
  readonly list?: 'ok' | 'unavailable' | 'not-found';
};

export type FakeSkyfire = {
  readonly fetch: typeof fetch;
  /** `METHOD origin+path` for every request, in order. */
  readonly requests: string[];
  readonly records: ChargeRecord[];
  simulate(simulation: Simulation): void;
  /** Adds a charge record directly, as if made earlier or by someone else. */
  record(tokenId: string, value: string, chargedAt: Date): void;
};

/** A fake Skyfire issuer JWKS endpoint and seller token API. */
export function fakeSkyfire(options: { readonly clock: Clock; readonly issuers: readonly Issuer[]; readonly pageSize?: number }): FakeSkyfire {
  let simulation: Simulation = {};
  const requests: string[] = [];
  const records: ChargeRecord[] = [];
  let sequence = 0;

  const record = (tokenId: string, value: string, chargedAt: Date) => {
    sequence += 1;
    records.push({ tokenId, chargeId: `charge-${String(sequence)}`, value, chargedAt: chargedAt.toISOString() });
  };

  const fetchImpl = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init.method ?? 'GET';
    const signal = init.signal ?? undefined;
    requests.push(`${method} ${url.origin}${url.pathname}`);
    if (signal?.aborted === true) throw signal.reason;

    const issuer = options.issuers.find((candidate) => candidate.origin === url.origin);
    if (issuer !== undefined && url.pathname === '/.well-known/jwks.json') {
      if (simulation.jwks === 'unavailable') return json(503, { code: 'UNAVAILABLE' });
      return json(200, { keys: options.issuers.filter((candidate) => candidate.origin === url.origin).map((candidate) => candidate.publicJwk) });
    }

    const headers = new Headers(init.headers);
    if (headers.get('skyfire-api-key') !== API_KEY) return json(401, { code: 'NOT_AUTHORIZED', message: 'bad api key' });

    if (method === 'POST' && url.pathname === '/api/v1/tokens/charge') {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '') as { token: string; chargeAmount: string };
      const payload = JSON.parse(atob((body.token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/'))) as { jti: string; amt: string };
      const mode = simulation.charge ?? 'ok';
      if (typeof mode === 'object') return json(mode.status, mode.body);
      if (mode === 'hang-before-effect') return hang(signal);

      const amount = parseMoney(`${body.chargeAmount} USD`).micros;
      const spent = records.filter((entry) => entry.tokenId === payload.jti).reduce((sum, entry) => sum + parseMoney(`${entry.value} USD`).micros, 0n);
      const remaining = parseMoney(`${payload.amt} USD`).micros - spent;
      if (amount > remaining) return json(402, { code: 'PAYMENT_ERROR', message: 'Insufficient balance' });
      record(payload.jti, body.chargeAmount, options.clock.now());
      if (mode === 'hang-after-effect') return hang(signal);
      return json(200, { amountCharged: body.chargeAmount, remainingBalance: decimal(remaining - amount) });
    }

    const listing = /^\/api\/v1\/tokens\/([^/]+)\/charges$/.exec(url.pathname);
    if (method === 'GET' && listing !== null) {
      if (simulation.list === 'unavailable') return json(503, { code: 'UNAVAILABLE' });
      if (simulation.list === 'not-found') return json(404, { code: 'NOT_FOUND', message: 'Not Found' });
      const tokenId = decodeURIComponent(listing[1] ?? '');
      const all = records.filter((entry) => entry.tokenId === tokenId);
      const size = options.pageSize ?? Number(url.searchParams.get('size'));
      const start = Number(url.searchParams.get('pageCursor') ?? '0');
      const page = all.slice(start, start + size);
      const next = start + size < all.length ? String(start + size) : undefined;
      return json(200, next === undefined ? { data: page } : { data: page, nextPageCursor: next });
    }

    return json(404, { code: 'NOT_FOUND', message: 'Not Found' });
  };

  return {
    fetch: fetchImpl,
    requests,
    records,
    simulate(next) {
      simulation = next;
    },
    record,
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function hang(signal: AbortSignal | undefined): Promise<Response> {
  return new Promise((_, reject) => {
    signal?.addEventListener('abort', () => {
      reject(new Error('aborted', { cause: signal.reason }));
    });
  });
}

function decimal(micros: bigint): string {
  const fraction = (micros % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction === '' ? (micros / 1_000_000n).toString() : `${(micros / 1_000_000n).toString()}.${fraction}`;
}
