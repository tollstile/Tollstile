import { describe, expect, it } from 'vitest';
import { verifyMandateChain } from '../src/mandate-chain';
import { coversPrice, readClosedMandate, readOpenMandate, satisfiesOpenMandate } from '../src/payment-mandate';
import { digest, disclosedPayload, isRecord, parseSdJwt, verifyEs256 } from '../src/sd-jwt';
import { generateKey, publicJwk } from './mandates';

/**
 * The encoded token under "Open Payment Mandate chained with a closed Payment Mandate" in
 * google-agentic-commerce/AP2 docs/ap2/payment_mandate.md (line 534 at e1ea56d), split on `~`.
 * The root issuer key (`agent-provider-key-1`) is generated at runtime by the AP2 sample and is not
 * published, so everything except the root signature is checked.
 */
const SPEC_CHAIN = [
  'eyJhbGciOiAiRVMyNTYiLCAidHlwIjogImV4YW1wbGUrc2Qtand0IiwgImtpZCI6ICJhZ2VudC1wcm92aWRlci1rZXktMSJ9.eyJkZWxlZ2F0ZV9wYXlsb2FkIjogW3siLi4uIjogIjNZUnRaLWxCTmhJX1loZ2dTaHJkSGhyU3VEUFNwd012SjNWV2pVbmhEUU0ifV0sICJfc2RfYWxnIjogInNoYS0yNTYifQ.ZQ_5x2hYLusuUNAA2OJloeS2w3fxZRCsSvcU-wg9fK7nlMmsbpK6EPlntD8oHq5waegxsLmSL51V5hfyaQViMg',
  'WyJzOVdQdDJVNEdhcGNKc255RWI2YmpnIiwgeyJpZCI6ICJtZXJjaGFudF8xIiwgIm5hbWUiOiAiRGVtbyBNZXJjaGFudCIsICJ3ZWJzaXRlIjogImh0dHBzOi8vZGVtby1tZXJjaGFudC5leGFtcGxlIn1d',
  'WyJadEtTNUZTcklBWTZIbEdCNEhvN21nIiwgeyJ2Y3QiOiAibWFuZGF0ZS5wYXltZW50Lm9wZW4uMSIsICJjb25zdHJhaW50cyI6IFt7InR5cGUiOiAicGF5bWVudC5hbW91bnRfcmFuZ2UiLCAiY3VycmVuY3kiOiAiVVNEIiwgIm1heCI6IDIwMDAwLCAibWluIjogMH0sIHsidHlwZSI6ICJwYXltZW50LmFsbG93ZWRfcGF5ZWVzIiwgImFsbG93ZWQiOiBbeyIuLi4iOiAib0VIN2kxZ3liLXpuNmF3d2p5NTdMdnp4a1FEZkQtOHR2bEMyWHVJa2dPQSJ9XX0sIHsidHlwZSI6ICJwYXltZW50LnJlZmVyZW5jZSIsICJjb25kaXRpb25hbF90cmFuc2FjdGlvbl9pZCI6ICJGekxveGJidGdRR1laeG9TTTJOSllKdGtGVFNzZGZVQm9WRVExMms3Sk44In1dLCAiY25mIjogeyJqd2siOiB7ImNydiI6ICJQLTI1NiIsICJrdHkiOiAiRUMiLCAieCI6ICJRcFN5eFBRSHkzOHhja3l2RHI1NGdaM1Q0MnpqOWlMdFY0a295YjVVMjdjIiwgInkiOiAiMzdITGQ3SkppbnhqSkluOEo3SGlqc3NvZWNCbGZoZFctZ1VMN2ZlSTlsdyJ9fSwgImlhdCI6IDE3NzczNDIzNTcsICJleHAiOiAxNzc3MzQ1OTU3fV0',
  '',
  'eyJhbGciOiAiRVMyNTYiLCAidHlwIjogImtiK3NkLWp3dCJ9.eyJkZWxlZ2F0ZV9wYXlsb2FkIjogW3siLi4uIjogIkcyRHVVNklqeURrRC05SXRTdGRzVW80OEM1dUpxRHMxRTlIZjVHVDNUZ00ifV0sICJpYXQiOiAxNzc3MzQyMzcwLCAiYXVkIjogImNyZWRlbnRpYWwtcHJvdmlkZXIiLCAibm9uY2UiOiAiYThiN2M2ZDVlNGYzYTJiMWMwZDllOGY3YTZiNWM0ZDMiLCAic2RfaGFzaCI6ICJ1aXhvSGVtbWZyckNTYlBSRW85ai16aUx1TWtxRXhzUGVXcndBLVBLMENrIiwgIl9zZF9hbGciOiAic2hhLTI1NiJ9.TgI6w9zeL993uzAYE9fnAJXjnrpliDY5DpDKTSQoioH3msapVIz0Ex23ncQXwmsSmT3xOqkSpigQD1EYKck-dQ',
  'WyJmVzZNY0JKSW1xT0R1aFFscEk0SWR3IiwgeyJ2Y3QiOiAibWFuZGF0ZS5wYXltZW50LjEiLCAidHJhbnNhY3Rpb25faWQiOiAiTml2V2h1cWZ6Y3ZaTmFwdklFSjItM3RzZFFMa2l1SWN5ZTJnNDZXVmdYOCIsICJwYXllZSI6IHsiaWQiOiAibWVyY2hhbnRfMSIsICJuYW1lIjogIkRlbW8gTWVyY2hhbnQiLCAid2Vic2l0ZSI6ICJodHRwczovL2RlbW8tbWVyY2hhbnQuZXhhbXBsZSJ9LCAicGF5bWVudF9hbW91bnQiOiB7ImFtb3VudCI6IDE5OTAwLCAiY3VycmVuY3kiOiAiVVNEIn0sICJwYXltZW50X2luc3RydW1lbnQiOiB7ImlkIjogInN0dWIiLCAidHlwZSI6ICJjYXJkIiwgImRlc2NyaXB0aW9uIjogIkNhcmQgXHUyMDIyXHUyMDIyXHUyMDIyNDI0MiJ9fV0',
  '',
].join('~');

describe('AP2 payment_mandate.md example chain', () => {
  const [openPart = '', closedPart = ''] = SPEC_CHAIN.split('~~');

  it('binds the closed mandate to the open SD-JWT with sd_hash over its disclosures and trailing ~', async () => {
    const open = parseSdJwt(`${openPart}~`);
    const closed = parseSdJwt(closedPart);
    if (typeof open === 'string' || typeof closed === 'string') throw new Error('unparseable example');

    expect(await digest(open.hash, open.serialized)).toBe('uixoHemmfrrCSbPREo9j-ziLuMkqExsPeWrwA-PK0Ck');
    expect(closed.payload.sd_hash).toBe('uixoHemmfrrCSbPREo9j-ziLuMkqExsPeWrwA-PK0Ck');
    expect(closed.header.typ).toBe('kb+sd-jwt');
  });

  it('resolves the disclosures, including the payee nested inside a constraint', async () => {
    const open = parseSdJwt(`${openPart}~`);
    if (typeof open === 'string') throw new Error('unparseable example');
    const payload = await disclosedPayload(open);
    if (typeof payload === 'string' || !Array.isArray(payload.delegate_payload)) throw new Error(`undisclosed: ${JSON.stringify(payload)}`);
    const [mandate] = payload.delegate_payload as unknown[];

    expect(mandate).toMatchObject({
      vct: 'mandate.payment.open.1',
      constraints: [
        { type: 'payment.amount_range', currency: 'USD', max: 20000, min: 0 },
        { type: 'payment.allowed_payees', allowed: [{ id: 'merchant_1', name: 'Demo Merchant', website: 'https://demo-merchant.example' }] },
        { type: 'payment.reference' },
      ],
      exp: 1777345957,
    });
  });

  it("verifies the agent's KB-SD-JWT signature with the open mandate's cnf.jwk", async () => {
    const open = parseSdJwt(`${openPart}~`);
    const closed = parseSdJwt(closedPart);
    if (typeof open === 'string' || typeof closed === 'string') throw new Error('unparseable example');
    const openPayload = await disclosedPayload(open);
    const closedPayload = await disclosedPayload(closed);
    if (typeof openPayload === 'string' || typeof closedPayload === 'string') throw new Error('undisclosed');
    const [openClaims] = openPayload.delegate_payload as unknown[];
    const [closedClaims] = closedPayload.delegate_payload as unknown[];
    if (!isRecord(openClaims) || !isRecord(closedClaims)) throw new Error('no mandate');
    const openMandate = readOpenMandate(openClaims);
    const closedMandate = readClosedMandate(closedClaims);
    if (typeof openMandate === 'string' || typeof closedMandate === 'string') throw new Error('invalid mandate');

    expect(await verifyEs256(closed, openMandate.holderKey)).toBe(true);
    expect(await verifyEs256(closed, await publicJwk(await generateKey()))).toBe(false);
    expect(closedMandate).toMatchObject({ amount: 19900, currency: 'USD', payee: { id: 'merchant_1' } });
    expect(coversPrice(closedMandate, { currency: 'USD', micros: 199_000_000n })).toBe(true);
    expect(coversPrice(closedMandate, { currency: 'USD', micros: 199_000_001n })).toBe(false);
    // payment.reference needs the checkout's open Checkout Mandate, which a per-call API does not have.
    expect(satisfiesOpenMandate(closedMandate, openMandate, new Date(1777342370_000))).toBe('unsupported_constraint:payment.reference');
  });

  it('fails closed on the full chain when the root issuer key is not the one that signed it', async () => {
    const other = await publicJwk(await generateKey());
    const result = await verifyMandateChain(SPEC_CHAIN, {
      resolveKey: (header) => Promise.resolve(header.kid === 'agent-provider-key-1' ? other : undefined),
      now: new Date(1777342370_000),
      clockSkewMs: 0,
    });
    expect(result).toBe('issuer_signature_invalid');
  });

  it('rejects a tampered disclosure because its digest is no longer referenced', async () => {
    const tampered = closedPart.replace(/~([^~]+)~$/, (_match, disclosure: string) => {
      const decoded = Buffer.from(disclosure, 'base64url').toString().replace('19900', '99');
      return `~${Buffer.from(decoded).toString('base64url')}~`;
    });
    const token = parseSdJwt(tampered);
    if (typeof token === 'string') throw new Error('unparseable');
    expect(await disclosedPayload(token)).toBe('disclosure_unreferenced');
  });
});
