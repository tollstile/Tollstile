import { createHash } from 'node:crypto';

// An independent signer for tests: it builds RFC 9421 signature bases by hand for the components
// the tests use, so the verifier is not checked against itself.

export type Algorithm = 'ed25519' | 'ecdsa-p256-sha256' | 'rsa-pss-sha512';

export type Agent = { readonly key: CryptoKeyPair; readonly jwk: JsonWebKey; readonly thumbprint: string; readonly algorithm: Algorithm };

export async function createAgent(algorithm: Algorithm = 'ed25519'): Promise<Agent> {
  const params = {
    ed25519: { name: 'Ed25519' },
    'ecdsa-p256-sha256': { name: 'ECDSA', namedCurve: 'P-256' },
    'rsa-pss-sha512': { name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-512' },
  }[algorithm];
  const key = (await crypto.subtle.generateKey(params, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', key.publicKey);
  const members = jwk.kty === 'RSA' ? { e: jwk.e, kty: jwk.kty, n: jwk.n } : jwk.kty === 'EC' ? { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y } : { crv: jwk.crv, kty: jwk.kty, x: jwk.x };
  const thumbprint = createHash('sha256').update(JSON.stringify(members)).digest('base64url');
  return { key, jwk: { ...members, ...(jwk.kty === 'RSA' ? { alg: 'PS512' } : {}) } as JsonWebKey, thumbprint, algorithm };
}

export type SignOptions = {
  readonly agent: Agent;
  readonly created: number;
  readonly expires: number;
  readonly signatureAgent?: string | { readonly legacy: string } | null;
  readonly components?: readonly string[];
  readonly label?: string;
  readonly nonce?: string;
  readonly tag?: string;
  readonly alg?: string | null;
  readonly keyid?: string;
  readonly headers?: Record<string, string>;
  readonly method?: string;
};

/** Signs `url` and returns the Request an agent would send. */
export async function signedRequest(url: string, options: SignOptions): Promise<Request> {
  const target = new URL(url);
  const label = options.label ?? 'sig1';
  const headers = new Headers(options.headers);
  const agentValue = options.signatureAgent === undefined ? `${label}="https://agent.example"` : options.signatureAgent;
  if (agentValue !== null) headers.set('signature-agent', typeof agentValue === 'string' ? agentValue : agentValue.legacy);

  const defaultAgentComponent = typeof agentValue === 'object' && agentValue !== null ? '"signature-agent"' : `"signature-agent";key="${label}"`;
  const components = options.components ?? ['"@authority"', defaultAgentComponent];
  const lines = components.map((identifier) => `${identifier}: ${componentValue(identifier, target, headers, options.method ?? 'GET')}`);

  let params = `;created=${options.created};expires=${options.expires};keyid="${options.keyid ?? options.agent.thumbprint}"`;
  const alg = options.alg === undefined ? options.agent.algorithm : options.alg;
  if (alg !== null) params += `;alg="${alg}"`;
  if (options.nonce !== undefined) params += `;nonce="${options.nonce}"`;
  params += `;tag="${options.tag ?? 'web-bot-auth'}"`;
  const inner = `(${components.join(' ')})${params}`;
  const base = [...lines, `"@signature-params": ${inner}`].join('\n');

  const signature = await sign(options.agent, base);
  headers.set('signature-input', `${label}=${inner}`);
  headers.set('signature', `${label}=:${Buffer.from(signature).toString('base64')}:`);
  return new Request(url, { method: options.method ?? 'GET', headers });
}

function componentValue(identifier: string, url: URL, headers: Headers, method: string): string {
  switch (identifier) {
    case '"@authority"':
      return url.host;
    case '"@path"':
      return url.pathname;
    case '"@method"':
      return method;
    case '"@target-uri"':
      return url.href;
    case '"signature-agent"':
      return headers.get('signature-agent') ?? '';
  }
  const member = /^"signature-agent";key="([^"]+)"$/.exec(identifier);
  if (member?.[1] !== undefined) {
    const found = new RegExp(`(?:^|,\\s*)${member[1]}=("[^"]*"(?:;[a-z]+=[a-z_]+)?)`).exec(headers.get('signature-agent') ?? '');
    return found?.[1] ?? '';
  }
  const field = /^"([a-z-]+)"$/.exec(identifier);
  return headers.get(field?.[1] ?? '') ?? '';
}

async function sign(agent: Agent, base: string): Promise<ArrayBuffer> {
  const data = new TextEncoder().encode(base);
  switch (agent.algorithm) {
    case 'ed25519':
      return crypto.subtle.sign({ name: 'Ed25519' }, agent.key.privateKey, data);
    case 'ecdsa-p256-sha256':
      return crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, agent.key.privateKey, data);
    case 'rsa-pss-sha512':
      return crypto.subtle.sign({ name: 'RSA-PSS', saltLength: 64 }, agent.key.privateKey, data);
  }
}

export type FakeDirectory = {
  readonly fetch: typeof fetch;
  readonly requests: string[];
  /** Replaces the handler for subsequent fetches. */
  respond(handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>): void;
};

/** A directory server that serves `keys` for https://agent.example and records every fetch. */
export function fakeDirectory(keys: readonly JsonWebKey[]): FakeDirectory {
  const requests: string[] = [];
  let handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response> = () => directoryResponse(keys);
  return {
    requests,
    respond(next) {
      handler = next;
    },
    fetch: (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      requests.push(url);
      return Promise.resolve(handler(url, init));
    },
  };
}

export function directoryResponse(keys: readonly unknown[], headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ keys }), {
    status: 200,
    headers: { 'content-type': 'application/http-message-signatures-directory+json', ...headers },
  });
}
