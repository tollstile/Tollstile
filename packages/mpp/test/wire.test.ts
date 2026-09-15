import { describe, expect, it } from 'vitest';
import { bindingSlots, challengeHeader, computeChallengeId, issueChallenge, mcpChallenge, rfc3339 } from '../src/challenge';
import { canonicalize } from '../src/jcs';

/** HMAC challenge-id vectors published with the mppx reference implementation (secret `test-vector-secret`). */
const vectors = [
  { label: 'required fields only', request: { amount: '1000000' }, expected: 'X6v1eo7fJ76gAxqY0xN9Jd__4lUyDDYmriryOM-5FO4' },
  { label: 'with expires', request: { amount: '1000000' }, expires: '2025-01-06T12:00:00Z', expected: 'ChPX33RkKSZoSUyZcu8ai4hhkvjZJFkZVnvWs5s0iXI' },
  { label: 'with digest', request: { amount: '1000000' }, digest: 'sha-256=X48E9qOokqqrvdts8nOJRJN3OWDUoyWxBf7kbu9DBPE', expected: 'JHB7EFsPVb-xsYCo8LHcOzeX1gfXWVoUSzQsZhKAfKM' },
  { label: 'with opaque', request: { amount: '1000000' }, opaque: { pi: 'pi_3abc123XYZ' }, expected: 'rxzKZ2qjXvinqCH96RORTZEPs1KXsA-0AUjrCAPFOWc' },
  { label: 'with opaque and expires', request: { amount: '1000000' }, expires: '2025-01-06T12:00:00Z', opaque: { pi: 'pi_3abc123XYZ' }, expected: 'KAfoMrA4fnzS1DPWN_cUv_b3_yHxCizdp6OhH7gluMY' },
  { label: 'with multi-key opaque', request: { amount: '1000000' }, opaque: { pi: 'pi_3abc123XYZ', deposit: 'dep_456' }, expected: 'aKskU8sadR5ZuFbUCsIwhO-ENxuVpTw17FdwHEXsJDk' },
  { label: 'with nested methodDetails', request: { methodDetails: { chainId: 42431 }, currency: '0x1234', amount: '1000000' }, expected: 'TqujwpuDDg_zsWGINAd5XObO2rRe6uYufpqvtDmr6N8' },
  { label: 'with empty request', request: {}, expected: 'yLN7yChAejW9WNmb54HpJIWpdb1WWXeA3_aCx4dxmkU' },
  { label: 'different method', request: { amount: '1000000' }, method: 'stripe', expected: 'o0ra2sd7HcB4Ph0Vns69gRDUhSj5WNOnUopcDqKPLz4' },
  { label: 'different intent', request: { amount: '1000000' }, intent: 'session', expected: 'aAY7_IEDzsznNYplhOSE8cERQxvjFcT4Lcn-7FHjLVE' },
] as const;

describe('challenge binding', () => {
  it.each(vectors)('matches the reference HMAC vector: $label', async (vector) => {
    const slots = bindingSlots({
      realm: 'api.example.com',
      method: 'method' in vector ? vector.method : 'tempo',
      intent: 'intent' in vector ? vector.intent : 'charge',
      request: vector.request,
      expires: 'expires' in vector ? vector.expires : '',
      opaque: 'opaque' in vector ? vector.opaque : {},
    });
    const withDigest = 'digest' in vector ? { ...slots, digest: vector.digest } : slots;
    expect(await computeChallengeId('test-vector-secret', withDigest)).toBe(vector.expected);
  });

  it('serializes the header without `header` or `description`, and keeps MCP request native', async () => {
    const challenge = await issueChallenge(['k'.repeat(32)], {
      realm: 'api.example.com',
      method: 'tempo',
      intent: 'charge',
      request: { amount: '1000' },
      expires: '2025-01-15T12:05:00Z',
      opaque: { tollstile_quote: 'a.b' },
    });
    const [name, value] = challengeHeader(challenge);

    expect(name).toBe('www-authenticate');
    expect(value).toBe(
      `Payment id="${challenge.id}", realm="api.example.com", method="tempo", intent="charge", request="eyJhbW91bnQiOiIxMDAwIn0", expires="2025-01-15T12:05:00Z", opaque="eyJ0b2xsc3RpbGVfcXVvdGUiOiJhLmIifQ"`,
    );
    expect(mcpChallenge(challenge)).toEqual({
      id: challenge.id,
      realm: 'api.example.com',
      method: 'tempo',
      intent: 'charge',
      request: { amount: '1000' },
      expires: '2025-01-15T12:05:00Z',
      opaque: 'eyJ0b2xsc3RpbGVfcXVvdGUiOiJhLmIifQ',
    });
  });

  it('formats expiry at second precision, rounded down', () => {
    expect(rfc3339(new Date('2026-01-01T00:05:00.999Z'))).toBe('2026-01-01T00:05:00Z');
  });
});

describe('RFC 8785 canonicalization', () => {
  it('orders keys by UTF-16 code units and formats numbers like ECMAScript', () => {
    // RFC 8785 §3.2.3 sorting example and §3.2.2.3 number examples.
    expect(canonicalize({ '\u20ac': 'Euro Sign', '\r': 'Carriage Return', '\ufb33': 'Hebrew Letter Dalet With Dagesh', '1': 'One', '\ud83d\ude00': 'Emoji: Grinning Face', '\u0080': 'Control', '\u00f6': 'Latin Small Letter O With Diaeresis' })).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","\u00f6":"Latin Small Letter O With Diaeresis","\u20ac":"Euro Sign","\ud83d\ude00":"Emoji: Grinning Face","\ufb33":"Hebrew Letter Dalet With Dagesh"}',
    );
    expect(canonicalize({ numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 0.000000000000000000000000001], literals: [null, true, false] })).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27]}',
    );
  });
});
