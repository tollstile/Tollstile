import { createPublicKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyAgentSignature } from '../src/agent-signature';
import { readSignatures, signatureBase } from '../src/http-signature';
import { parseDictionary, parseItem, serializeMember } from '../src/structured-fields';
import { readVerificationKey, verifySignature } from '../src/verification-key';

// RFC 9421 Appendix B and draft-ietf-webbotauth-httpsig-protocol-00 Appendix E, verbatim.

const ED25519_KEY = { kty: 'OKP', crv: 'Ed25519', x: 'JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs' };
const RSA_PSS_KEY = createPublicKey(
  [
    '-----BEGIN PUBLIC KEY-----',
    'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAr4tmm3r20Wd/PbqvP1s2',
    '+QEtvpuRaV8Yq40gjUR8y2Rjxa6dpG2GXHbPfvMs8ct+Lh1GH45x28Rw3Ry53mm+',
    'oAXjyQ86OnDkZ5N8lYbggD4O3w6M6pAvLkhk95AndTrifbIFPNU8PPMO7OyrFAHq',
    'gDsznjPFmTOtCEcN2Z1FpWgchwuYLPL+Wokqltd11nqqzi+bJ9cvSKADYdUAAN5W',
    'Utzdpiy6LbTgSxP7ociU4Tn0g5I6aDZJ7A8Lzo0KSyZYoA485mqcO0GVAdVw9lq4',
    'aOT9v6d+nb4bnNkQVklLQ3fVAvJm+xdDOp9LCNCN48V2pnDOkFV6+U9nV5oyc6XI',
    '2wIDAQAB',
    '-----END PUBLIC KEY-----',
  ].join('\n'),
).export({ format: 'jwk' });

/** RFC 9421 B.2 test-request. */
function testRequest(signatureInput: string, signature: string): Request {
  return new Request('https://example.com/foo?param=Value&Pet=dog', {
    method: 'POST',
    headers: {
      host: 'example.com',
      date: 'Tue, 20 Apr 2021 02:07:55 GMT',
      'content-type': 'application/json',
      'content-digest': 'sha-512=:WZDPaVn/7XgHaAy8pmojAkGWoRx2UFChF41A2svX+TaPm+AbwAgBWnrIiYllu7BNNyealdVLvRwEmTHWXvJwew==:',
      'content-length': '18',
      'signature-input': signatureInput,
      signature,
    },
    body: '{"hello": "world"}',
  });
}

async function verifyRfcVector(request: Request, jwk: object, algorithm: 'ed25519' | 'rsa-pss-sha512') {
  const [input] = readSignatures(request.headers) as Exclude<ReturnType<typeof readSignatures>, string>;
  if (input === undefined) throw new Error('no signature');
  const base = signatureBase(request, input);
  const key = await readVerificationKey(jwk);
  if (base === undefined || key === undefined) throw new Error('unusable vector');
  return { base, valid: await verifySignature(key, algorithm, base, input.signature) };
}

describe('RFC 9421 Appendix B', () => {
  it('B.2.6 verifies the ed25519 request signature over a rebuilt signature base', async () => {
    const request = testRequest(
      'sig-b26=("date" "@method" "@path" "@authority" "content-type" "content-length");created=1618884473;keyid="test-key-ed25519"',
      'sig-b26=:wqcAqbmYJ2ji2glfAMaRy4gruYYnx2nEFN2HN6jrnDnQCK1u02Gb04v9EDgwUPiu4A0w6vuQv5lIp5WPpBKRCw==:',
    );
    const { base, valid } = await verifyRfcVector(request, ED25519_KEY, 'ed25519');

    expect(base).toBe(
      [
        '"date": Tue, 20 Apr 2021 02:07:55 GMT',
        '"@method": POST',
        '"@path": /foo',
        '"@authority": example.com',
        '"content-type": application/json',
        '"content-length": 18',
        '"@signature-params": ("date" "@method" "@path" "@authority" "content-type" "content-length");created=1618884473;keyid="test-key-ed25519"',
      ].join('\n'),
    );
    expect(valid).toBe(true);
  });

  it('B.2.2 verifies rsa-pss-sha512 over a named query parameter and a header', async () => {
    const request = testRequest(
      'sig-b22=("@authority" "content-digest" "@query-param";name="Pet");created=1618884473;keyid="test-key-rsa-pss";tag="header-example"',
      'sig-b22=:LjbtqUbfmvjj5C5kr1Ugj4PmLYvx9wVjZvD9GsTT4F7GrcQEdJzgI9qHxICagShLRiLMlAJjtq6N4CDfKtjvuJyE5qH7KT8UCMkSowOB4+ECxCmT8rtAmj/0PIXxi0A0nxKyB09RNrCQibbUjsLS/2YyFYXEu4TRJQzRw1rLEuEfY17SARYhpTlaqwZVtR8NV7+4UKkjqpcAoFqWFQh62s7Cl+H2fjBSpqfZUJcsIk4N6wiKYd4je2U/lankenQ99PZfB4jY3I5rSV2DSBVkSFsURIjYErOs0tFTQosMTAoxk//0RoKUqiYY8Bh0aaUEb0rQl3/XaVe4bXTugEjHSw==:',
    );
    const { base, valid } = await verifyRfcVector(request, RSA_PSS_KEY, 'rsa-pss-sha512');

    expect(base.split('\n')[2]).toBe('"@query-param";name="Pet": dog');
    expect(valid).toBe(true);
  });

  it('B.2.3 verifies rsa-pss-sha512 with full coverage including @query', async () => {
    const request = testRequest(
      'sig-b23=("date" "@method" "@path" "@query" "@authority" "content-type" "content-digest" "content-length");created=1618884473;keyid="test-key-rsa-pss"',
      'sig-b23=:bbN8oArOxYoyylQQUU6QYwrTuaxLwjAC9fbY2F6SVWvh0yBiMIRGOnMYwZ/5MR6fb0Kh1rIRASVxFkeGt683+qRpRRU5p2voTp768ZrCUb38K0fUxN0O0iC59DzYx8DFll5GmydPxSmme9v6ULbMFkl+V5B1TP/yPViV7KsLNmvKiLJH1pFkh/aYA2HXXZzNBXmIkoQoLd7YfW91kE9o/CCoC1xMy7JA1ipwvKvfrs65ldmlu9bpG6A9BmzhuzF8Eim5f8ui9eH8LZH896+QIF61ka39VBrohr9iyMUJpvRX2Zbhl5ZJzSRxpJyoEZAFL2FUo5fTIztsDZKEgM4cUA==:',
    );
    const { valid } = await verifyRfcVector(request, RSA_PSS_KEY, 'rsa-pss-sha512');
    expect(valid).toBe(true);
  });

  it('fails the signature base for a missing header, a duplicate component, or a repeated query parameter', () => {
    const cases = [
      'sig=("x-missing");created=1',
      'sig=("@method" "@method");created=1',
      'sig=("@status");created=1',
      'sig=("@query-param";name="a");created=1',
    ];
    for (const input of cases) {
      const request = new Request('https://example.com/?a=1&a=2', { headers: { 'signature-input': input, signature: 'sig=:AA==:' } });
      const [parsed] = readSignatures(request.headers) as Exclude<ReturnType<typeof readSignatures>, string>;
      expect(parsed && signatureBase(request, parsed)).toBeUndefined();
    }
  });

  it('re-encodes query parameters as RFC 9421 §2.2.8 shows', () => {
    const request = new Request('https://www.example.com/parameters?var=this%20is%20a%20big%0Amultiline%20value&bar=with+plus+whitespace&fa%C3%A7ade%22%3A%20=something', {
      headers: {
        'signature-input': 'sig=("@query-param";name="var" "@query-param";name="bar" "@query-param";name="fa%C3%A7ade%22%3A%20");created=1',
        signature: 'sig=:AA==:',
      },
    });
    const [parsed] = readSignatures(request.headers) as Exclude<ReturnType<typeof readSignatures>, string>;
    expect(parsed && signatureBase(request, parsed)?.split('\n').slice(0, 3)).toEqual([
      '"@query-param";name="var": this%20is%20a%20big%0Amultiline%20value',
      '"@query-param";name="bar": with%20plus%20whitespace',
      '"@query-param";name="fa%C3%A7ade%22%3A%20": something',
    ]);
  });
});

describe('structured fields', () => {
  it('round-trips dictionaries with inner lists, parameters, and every bare item type', () => {
    const field = 'a=(1 "two" three);p=?0, b=:AQID:;q=-1.5, c, d="\\"quoted\\""';
    const dictionary = parseDictionary(field);
    expect(dictionary && [...dictionary].map(([key, member]) => `${key}=${serializeMember(member)}`)).toEqual([
      'a=(1 "two" three);p=?0',
      'b=:AQID:;q=-1.5',
      'c=?1',
      'd="\\"quoted\\""',
    ]);
  });

  it('rejects malformed fields as a whole', () => {
    for (const field of ['a=', 'a=1,', 'A=1', 'a=1234567890123456', 'a=1.2345', 'a="é"', 'a=(1', 'a=?2', 'a=1 b=2']) {
      expect(parseDictionary(field), field).toBeUndefined();
    }
    expect(parseItem('agent="x"')).toBeUndefined();
    expect(parseItem('"https://agent.example"')?.value).toEqual({ type: 'string', value: 'https://agent.example' });
  });
});

describe('Web Bot Auth Appendix E', () => {
  const vectors = [
    {
      name: 'E.2.1 ed25519, dictionary Signature-Agent',
      jwk: ED25519_KEY,
      agent: 'agent2="https://signature-agent.test"',
      input:
        'sig2=("@authority" "signature-agent";key="agent2");created=1735689600;keyid="poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";alg="ed25519";expires=4889289600;nonce="n9p433xm+NJ3ph3upfBIGmsuwHw387YV7Q/F+6BSpGCVjYCqQw6rznNA8PVVLySrAWsv0hQtFioQb6E1YsauiA==";tag="web-bot-auth"',
      signature: 'sig2=:RdNFx5Bj6au3YgAMQL/RzmUlZE8QZLIaXGRpw985hWnwPfMxT228NMk6ehRS1PSl4e8PhbNZACSanGdhEwYCCg==:',
    },
    {
      name: 'E.2.2 ed25519, legacy sf-string Signature-Agent',
      jwk: ED25519_KEY,
      agent: '"https://signature-agent.test"',
      input:
        'sig2=("@authority" "signature-agent");created=1735689600;keyid="poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";alg="ed25519";expires=1735693200;nonce="e8N7S2MFd/qrd6T2R3tdfAuuANngKI7LFtKYI/vowzk4lAZYadIX6wW25MwG7DCT9RUKAJ0qVkU0mEeLElW1qg==";tag="web-bot-auth"',
      signature: 'sig2=:jdq0SqOwHdyHr9+r5jw3iYZH6aNGKijYp/EstF4RQTQdi5N5YYKrD+mCT1HA1nZDsi6nJKuHxUi/5Syp3rLWBA==:',
    },
    {
      name: 'E.1.1 rsa-pss-sha512, dictionary Signature-Agent',
      jwk: RSA_PSS_KEY,
      agent: 'agent2="https://signature-agent.test"',
      input:
        'sig2=("@authority" "signature-agent";key="agent2");created=1735689600;keyid="oD0HwocPBSfpNy5W3bpJeyFGY_IQ_YpqxSjQ3Yd-CLA";alg="rsa-pss-sha512";expires=4889289600;nonce="wcfPQPh7SzkvrIVvhD00vNk9PkxJNY2NVbYl2PVBB4zmUoluSwE7W6bPtF60QA3k8g06FU7PPCD+J58YofY1zg==";tag="web-bot-auth"',
      signature:
        'sig2=:gHzpLNeHaHIO19NaJH9YMW5dcVSi2s0wOMBr6p18vcofS106sfC4KBIS0/szPlBBd1vIcyQ88B6CTEWIhRAiVrb9zfX0mx1aG12CSGWcYkSirHeyTxhbuJvXd27ed6skWoy4PjXItq38936ivUQjfdIwXh1aX6HxkAC3vRnEdSNfntkLWeEuIQ5BLIOBGE39fSwg27Qjq6OVWYas/9/aFUr3HA34MXWYdp+//cvlEKDp3kRoLOw9ro0AOr6srHrTeEtxon2afcws1aZVSlPdd2fZSEIGmw9HAHLDCEkFTERu1gH2k/zIEqgy7CAYXI9E5slog0cLg/Vc6+f8gih33g==:',
    },
    {
      name: 'E.1.2 rsa-pss-sha512, legacy sf-string Signature-Agent',
      jwk: RSA_PSS_KEY,
      agent: '"https://signature-agent.test"',
      input:
        'sig2=("@authority" "signature-agent");created=1735689600;keyid="oD0HwocPBSfpNy5W3bpJeyFGY_IQ_YpqxSjQ3Yd-CLA";alg="rsa-pss-sha512";expires=1735693200;nonce="XSHtZVCThSIAksXsH9WBs6AtxtXC0eQGiIcUGSoJstFs8lAWakjhrfwzLhyjtme5iXMZvmFWqDEs6cT3Jf+BbQ==";tag="web-bot-auth"',
      signature:
        'sig2=:I1QWNzGXdP1a4dSvOHLCVOOanEYHDk+ZsVxM9MLX/p4ko69ghKwR5EOtAD96g7g4GWP7lmpM/jFAf9q8EFRDTPLjUXySwMv4YPgabv2LQihTJG2y8a2m6IGltyruwQNiqSJVUuRaG9+b17CGmAMFZh30X6GXLdQJrCARpeTqPwp2DC+a8haDE/VE5EruqzjA5/2mKwvrkzkSqeW5tOVtFwWRRHIOidquf/8Je6kM9mhgkg4arudLA5SL4wyyYE1jURIgcOl8agrfdJ5Def23DIRtiOLRa8jT9cpTLFAuFHN+mrZA/LH9h0gSIg1cPb+0cMASee5uku1KjWcFer7jWA==:',
    },
  ];

  for (const vector of vectors) {
    it(vector.name, async () => {
      const request = new Request('https://example.com/', {
        headers: { 'signature-agent': vector.agent, 'signature-input': vector.input, signature: vector.signature },
      });
      const key = await readVerificationKey(vector.jwk);
      const resolved: string[] = [];
      const result = await verifyAgentSignature(request, {
        now: new Date(1735689600_000),
        maxAgeMs: 300_000,
        clockSkewMs: 0,
        requireNonce: true,
        resolveKey: (agent, keyid) => {
          resolved.push(`${agent.directory} ${keyid}`);
          return Promise.resolve(key === undefined ? { status: 'rejected', reason: 'key_not_found' } : { status: 'found', key });
        },
      });

      expect(result).toMatchObject({ status: 'verified', agent: { origin: 'https://signature-agent.test' } });
      expect(resolved).toEqual([`https://signature-agent.test/.well-known/http-message-signatures-directory ${key?.thumbprint ?? ''}`]);
    });
  }

  it('rejects the E.2.1 signature when the covered Signature-Agent member changes', async () => {
    const [vector] = vectors;
    if (vector === undefined) throw new Error('missing vector');
    const request = new Request('https://example.com/', {
      headers: { 'signature-agent': 'agent2="https://other.test"', 'signature-input': vector.input, signature: vector.signature },
    });
    const key = await readVerificationKey(vector.jwk);
    const result = await verifyAgentSignature(request, {
      now: new Date(1735689600_000),
      maxAgeMs: 300_000,
      clockSkewMs: 0,
      requireNonce: false,
      resolveKey: () => Promise.resolve(key === undefined ? { status: 'rejected', reason: 'key_not_found' } : { status: 'found', key }),
    });
    expect(result).toEqual({ status: 'rejected', reason: 'signature_invalid' });
  });
});
