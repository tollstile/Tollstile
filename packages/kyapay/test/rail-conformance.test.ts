import { fakeClock, railConformance, type RailHarness } from 'tollstile/testing';
import { describe, it } from 'vitest';
import { kyapay } from '../src/index';
import { API_KEY, base64url, createIssuer, fakeSkyfire, SANDBOX_ISSUER, SELLER_ID, SERVICE_ID } from './fake-skyfire';

const issuer = await createIssuer(SANDBOX_ISSUER);

/**
 * The KYAPay rail against the fake Skyfire JWKS and seller API. An economic effect is a charge
 * Skyfire recorded against a token. Settlement faults hit the next `POST /api/v1/tokens/charge`:
 * a lost response is charged by Skyfire and answered by a gateway timeout; a failure never reaches it.
 */
function harness(): RailHarness {
  const clock = fakeClock();
  const skyfire = fakeSkyfire({ clock, issuers: [issuer] });
  let fault: 'lose-response' | 'fail' | undefined;

  const fetchWithFaults: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const next = init?.method === 'POST' && new URL(url).pathname === '/api/v1/tokens/charge' ? fault : undefined;
    if (next !== undefined) fault = undefined;
    if (next === 'fail') throw new TypeError('fetch failed');
    const response = await skyfire.fetch(input, init);
    return next === 'lose-response' ? new Response('<html>504 Gateway Time-out</html>', { status: 504 }) : response;
  };

  return {
    rail: kyapay({ environment: 'sandbox', sellerId: SELLER_ID, serviceId: SERVICE_ID, apiKey: API_KEY, fetch: fetchWithFaults, clock }),
    clock,
    pay: async ({ url }) => {
      const now = Math.floor(clock.now().getTime() / 1000);
      const token = await issuer.sign({
        iss: SANDBOX_ISSUER,
        sub: 'buyer-1',
        aud: SELLER_ID,
        env: 'sandbox',
        tsi: SERVICE_ID,
        iat: now - 5,
        exp: now + 3600,
        jti: crypto.randomUUID(),
        amt: '5',
        cur: 'USD',
        val: '5000000',
        stp: 'coin',
        sti: { type: 'usdc', verified: true },
      });
      return new Request(url, { headers: { 'KYAPay-Token': token } });
    },
    settlements: () => skyfire.records.length,
    loseNextSettleResponse: () => (fault = 'lose-response'),
    failNextSettle: () => (fault = 'fail'),
    tamper: (request) => {
      const [header = '', payload = '', signature = ''] = (request.headers.get('KYAPay-Token') ?? '').split('.');
      const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;
      const raised = base64url(new TextEncoder().encode(JSON.stringify({ ...claims, amt: '500', val: '500000000' })));
      return new Request(request.url, { headers: { 'KYAPay-Token': `${header}.${raised}.${signature}` } });
    },
    // Skyfire's charge list may trail a charge; reconcile no sooner than the window the README recommends.
    reconcileAfterMs: 15 * 60_000,
  };
}

describe('rail conformance: kyapay against fake Skyfire', () => {
  for (const test of railConformance(harness)) (test.skip === undefined ? it : it.skip)(test.name, () => test.run());
});
