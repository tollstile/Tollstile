import { createTollstile, memoryLedger, testRail, toResponse, TollstileError, type Gate, type Rail } from 'tollstile';
import { fakeClock, httpContext, mcpContext } from 'tollstile/testing';
import { describe, expect, it } from 'vitest';
import { verifiedAgent, type VerifiedAgentOptions } from '../src/index';
import { createAgent, directoryResponse, fakeDirectory, signedRequest, type Agent, type SignOptions } from './signer';

const URL_ = 'https://api.example/data';
const DIRECTORY = 'https://agent.example/.well-known/http-message-signatures-directory';

async function setup(options: Partial<VerifiedAgentOptions> = {}, agent?: Agent) {
  const signer = agent ?? (await createAgent());
  const directory = fakeDirectory([signer.jwk]);
  const clock = fakeClock();
  const ledger = memoryLedger({ clock });
  const rail = testRail();
  const toll = createTollstile({ rails: [rail], ledger, clock, secret: 's'.repeat(32) });
  const gate = toll.price('$0.01', { require: [verifiedAgent({ trust: ['https://agent.example'], fetch: directory.fetch, ...options })] });
  const seconds = () => Math.floor(clock.now().getTime() / 1000);

  const sign = (overrides: Partial<SignOptions> = {}, url = URL_) =>
    signedRequest(url, { agent: signer, created: seconds(), expires: seconds() + 60, headers: { payment: 'test' }, ...overrides });

  return { signer, directory, clock, ledger, rail, gate, sign, seconds };
}

async function enter(gate: Gate<readonly Rail[]>, request: Request) {
  const entry = await gate.enter(httpContext(request));
  if (entry.kind === 'admitted') {
    await entry.pass.complete('succeeded');
    return { status: 200, reason: null };
  }
  const body = (await toResponse(entry.denial).json()) as { reason?: string | null };
  return { status: entry.denial.status, reason: body.reason ?? null };
}

describe('verifiedAgent', () => {
  it('admits a request signed by a trusted agent and reuses the fetched directory', async () => {
    const { gate, sign, directory, rail } = await setup();

    expect(await enter(gate, await sign())).toEqual({ status: 200, reason: null });
    expect(await enter(gate, await sign({ nonce: 'second' }))).toEqual({ status: 200, reason: null });
    expect(directory.requests).toEqual([DIRECTORY]);
    expect(rail.effects.settlements).toBe(2);
  });

  it('fetches without following redirects and asks for the directory media type', async () => {
    const { gate, sign, directory, signer } = await setup();
    let init: RequestInit | undefined;
    directory.respond((_url, received) => {
      init = received;
      return directoryResponse([signer.jwk]);
    });
    await enter(gate, await sign());

    expect(init?.redirect).toBe('manual');
    expect(new Headers(init?.headers).get('accept')).toBe('application/http-message-signatures-directory+json');
  });

  it('denies unsigned requests with 403 before anything is reserved', async () => {
    const { gate, ledger, rail } = await setup();
    const result = await enter(gate, new Request(URL_, { headers: { payment: 'test' } }));

    expect(result).toEqual({ status: 403, reason: 'signature_missing' });
    expect(ledger.charges()).toHaveLength(0);
    expect(rail.effects.settlements).toBe(0);
  });

  it('never fetches the directory of an untrusted origin', async () => {
    const { gate, sign, directory } = await setup();
    const result = await enter(gate, await sign({ signatureAgent: 'sig1="https://evil.example"' }));

    expect(result).toEqual({ status: 403, reason: 'agent_untrusted' });
    expect(directory.requests).toEqual([]);
  });

  it('accepts a trust predicate', async () => {
    const { gate, sign } = await setup({ trust: (origin) => origin.endsWith('.example') });
    expect(await enter(gate, await sign({ signatureAgent: 'sig1="https://agent.example"' }))).toEqual({ status: 200, reason: null });
  });

  it('rebuilds the signature base from the received request', async () => {
    const { gate, sign } = await setup();
    const signed = await sign({ components: ['"@authority"', '"@path"', '"signature-agent";key="sig1"'] });
    const moved = new Request('https://api.example/other', { headers: signed.headers });

    expect(await enter(gate, moved)).toEqual({ status: 403, reason: 'signature_invalid' });
    expect(await enter(gate, signed)).toEqual({ status: 200, reason: null });
  });

  it('requires the web-bot-auth tag, the required parameters, and a covered target', async () => {
    const { gate, sign } = await setup();

    expect(await enter(gate, await sign({ tag: 'other' }))).toMatchObject({ reason: 'tag_missing' });
    expect(await enter(gate, await sign({ components: ['"@path"', '"signature-agent";key="sig1"'] }))).toMatchObject({ reason: 'target_not_covered' });
    expect(await enter(gate, await sign({ components: ['"@authority"'] }))).toMatchObject({ reason: 'signature_agent_not_covered' });
    expect(await enter(gate, await sign({ signatureAgent: null }))).toMatchObject({ reason: 'signature_agent_missing' });
  });

  it('checks created, expires, and the maximum age with clock skew', async () => {
    const { gate, sign, seconds } = await setup({ maxAgeMs: 60_000, clockSkewMs: 1_000 });

    expect(await enter(gate, await sign({ created: seconds() + 10, expires: seconds() + 70 }))).toMatchObject({ reason: 'signature_not_yet_valid' });
    expect(await enter(gate, await sign({ created: seconds() - 30, expires: seconds() - 5 }))).toMatchObject({ reason: 'signature_expired' });
    expect(await enter(gate, await sign({ created: seconds() - 120, expires: seconds() + 60 }))).toMatchObject({ reason: 'signature_too_old' });
    expect(await enter(gate, await sign({ created: seconds() + 1, expires: seconds() + 60 }))).toEqual({ status: 200, reason: null });
  });

  it('accepts the legacy sf-string Signature-Agent covered as a whole', async () => {
    const { gate, sign } = await setup();
    const request = await sign({ signatureAgent: { legacy: '"https://agent.example"' } });
    expect(await enter(gate, request)).toEqual({ status: 200, reason: null });
  });

  it('ignores Signature-Agent members of a type it does not resolve', async () => {
    const { gate, sign, directory } = await setup();
    const request = await sign({ signatureAgent: 'sig1="https://agent.example/jwks.json";type=jwks_uri' });

    expect(await enter(gate, request)).toMatchObject({ reason: 'signature_agent_unsupported' });
    expect(directory.requests).toEqual([]);
  });

  it('selects keys by thumbprint, and skips directory entries whose kid is not the thumbprint', async () => {
    const { gate, sign, directory, signer } = await setup();
    directory.respond(() => directoryResponse([{ ...signer.jwk, kid: 'my-key' }]));

    expect(await enter(gate, await sign())).toMatchObject({ reason: 'key_not_found' });
    expect(await enter(gate, await sign({ keyid: 'not-a-thumbprint' }))).toMatchObject({ reason: 'key_not_found' });
  });

  it('requires the signature alg to agree with the key', async () => {
    const { gate, sign } = await setup();
    expect(await enter(gate, await sign({ alg: 'ecdsa-p256-sha256' }))).toMatchObject({ reason: 'algorithm_mismatch' });
  });

  it('verifies ecdsa-p256-sha256 and rsa-pss-sha512 keys', async () => {
    for (const algorithm of ['ecdsa-p256-sha256', 'rsa-pss-sha512'] as const) {
      const { gate, sign } = await setup({}, await createAgent(algorithm));
      expect(await enter(gate, await sign()), algorithm).toEqual({ status: 200, reason: null });
    }
  });

  it('requires an explicit algorithm for RSA keys that do not name one', async () => {
    const agent = await createAgent('rsa-pss-sha512');
    const { gate, sign } = await setup({}, { ...agent, jwk: { kty: 'RSA', n: agent.jwk.n ?? '', e: agent.jwk.e ?? '' } });
    expect(await enter(gate, await sign({ alg: null }))).toMatchObject({ reason: 'algorithm_mismatch' });
    expect(await enter(gate, await sign())).toEqual({ status: 200, reason: null });
  });

  it('rejects the RFC 9421 test keys even when a directory publishes them', async () => {
    const { gate, directory, clock } = await setup();
    directory.respond(() => directoryResponse([{ kty: 'OKP', crv: 'Ed25519', x: 'JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs' }]));
    clock.advance(new Date(1735689600_000).getTime() - clock.now().getTime());
    const request = new Request('https://example.com/', {
      headers: {
        payment: 'test',
        'signature-agent': 'agent2="https://agent.example"',
        'signature-input':
          'sig2=("@authority" "signature-agent";key="agent2");created=1735689600;keyid="poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";alg="ed25519";expires=4889289600;tag="web-bot-auth"',
        signature: 'sig2=:AAAA:',
      },
    });
    expect(await enter(gate, request)).toMatchObject({ reason: 'key_not_found' });
  });

  it('does not accept redirects, other statuses, oversized or malformed directories', async () => {
    const cases: (() => Response)[] = [
      () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/keys' } }),
      () => new Response('{}', { status: 404 }),
      () => new Response(JSON.stringify({ keys: [], padding: 'x'.repeat(70_000) }), { status: 200 }),
      () => new Response('not json', { status: 200 }),
      () => directoryResponse(Array.from({ length: 33 }, () => ({ kty: 'OKP' }))),
    ];
    for (const response of cases) {
      const { gate, sign, directory } = await setup();
      directory.respond(response);
      expect(await enter(gate, await sign())).toMatchObject({ status: 403, reason: 'directory_unavailable' });
    }
  });

  it('reports an unreachable directory as unavailable, and retries it only after a pause', async () => {
    const { gate, sign, directory, clock, signer } = await setup();
    directory.respond(() => Promise.reject(new TypeError('fetch failed')));

    expect(await enter(gate, await sign())).toMatchObject({ reason: 'directory_unavailable' });
    expect(await enter(gate, await sign({ nonce: 'again' }))).toMatchObject({ reason: 'directory_unavailable' });
    expect(directory.requests).toHaveLength(1);

    directory.respond(() => directoryResponse([signer.jwk]));
    clock.advance(31_000);
    expect(await enter(gate, await sign())).toEqual({ status: 200, reason: null });
  });

  it('keeps verifying with the cached directory when a refresh fails, and drops a key the directory removed', async () => {
    const { gate, sign, directory, clock } = await setup({ cacheTtlMs: 60_000 });
    expect(await enter(gate, await sign({ nonce: '1' }))).toEqual({ status: 200, reason: null });

    clock.advance(61_000);
    directory.respond(() => new Response('unavailable', { status: 503 }));
    expect(await enter(gate, await sign({ nonce: '2' }))).toEqual({ status: 200, reason: null });

    clock.advance(31_000);
    directory.respond(() => directoryResponse([]));
    expect(await enter(gate, await sign({ nonce: '3' }))).toMatchObject({ reason: 'key_not_found' });
    expect(directory.requests).toHaveLength(3);
  });

  it('honors a shorter Cache-Control max-age, bounded below by a minute', async () => {
    const { gate, sign, directory, clock, signer } = await setup();
    directory.respond(() => directoryResponse([signer.jwk], { 'cache-control': 'max-age=0' }));
    await enter(gate, await sign({ nonce: '1' }));
    clock.advance(59_000);
    await enter(gate, await sign({ nonce: '2' }));
    clock.advance(2_000);
    await enter(gate, await sign({ nonce: '3' }));

    expect(directory.requests).toHaveLength(2);
  });

  it('shares one directory fetch between concurrent requests', async () => {
    const { gate, sign, directory } = await setup();
    const requests = await Promise.all([sign({ nonce: 'a' }), sign({ nonce: 'b' }), sign({ nonce: 'c' })]);
    const results = await Promise.all(requests.map((request) => enter(gate, request)));

    expect(results.map((result) => result.status)).toEqual([200, 200, 200]);
    expect(directory.requests).toHaveLength(1);
  });

  it('accepts a nonce once', async () => {
    const { gate, sign, rail } = await setup();
    const request = await sign({ nonce: 'n-1' });

    expect(await enter(gate, request.clone())).toEqual({ status: 200, reason: null });
    expect(await enter(gate, request)).toEqual({ status: 403, reason: 'nonce_replayed' });
    expect(rail.effects.settlements).toBe(1);
  });

  it('requires a nonce when configured', async () => {
    const { gate, sign } = await setup({ requireNonce: true });
    expect(await enter(gate, await sign())).toMatchObject({ reason: 'nonce_missing' });
    expect(await enter(gate, await sign({ nonce: 'n' }))).toEqual({ status: 200, reason: null });
  });

  it('fails closed for MCP calls, which carry no signed HTTP request', async () => {
    const { gate, directory } = await setup();
    const entry = await gate.enter(mcpContext('search', { 'tollstile/test-payment': 'test' }));

    expect(entry.kind === 'denied' && entry.denial).toMatchObject({ status: 403, body: { reason: 'http_request_required' } });
    expect(directory.requests).toEqual([]);
  });

  it('refuses invalid configuration at construction', () => {
    const invalid: VerifiedAgentOptions[] = [
      { trust: [] },
      { trust: ['http://agent.example'] },
      { trust: ['https://agent.example/path'] },
      { trust: ['https://agent.example'], maxAgeMs: 0 },
      { trust: ['https://agent.example'], timeoutMs: 1.5 },
    ];
    for (const options of invalid) {
      expect(() => verifiedAgent(options)).toThrow(TollstileError);
    }
  });
});
