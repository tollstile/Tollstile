import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
  encodePaymentSignatureHeader,
} from '@x402/core/http';
import { isPaymentPayloadV2, isPaymentRequiredV2 } from '@x402/core/schemas';
import { x402ResourceServer } from '@x402/core/server';
import { upTo } from 'tollstile';
import { httpContext } from 'tollstile/testing';
import { describe, expect, it } from 'vitest';
import { base64Json, challenge, setup, sign } from './helpers';

// Round-trips the wire format through @x402/core, the reference TypeScript implementation.
describe('x402 V2 conformance with @x402/core', () => {
  it.each([
    ['exact', '$0.01'],
    ['upto', upTo('$0.10')],
  ] as const)('interoperates with reference clients for %s', async (_scheme, price) => {
    const { toll, clock } = setup();
    const gate = toll.price(price);
    const { result, paymentRequired: ours } = await challenge(gate);

    const paymentRequired = decodePaymentRequiredHeader(result.headers.get('payment-required') ?? '');
    expect(isPaymentRequiredV2(paymentRequired)).toBe(true);
    const [offered] = ours.accepts;
    if (offered === undefined) throw new Error('expected an offer');

    const payload = decodePaymentSignatureHeader(base64Json(sign(offered, clock.now())));
    expect(isPaymentPayloadV2(payload)).toBe(true);
    // The reference server's own matching accepts what this rail advertised.
    expect(new x402ResourceServer().findMatchingRequirements(paymentRequired.accepts, payload)).toEqual(paymentRequired.accepts[0]);

    const request = new Request('http://localhost/weather', { headers: { 'PAYMENT-SIGNATURE': encodePaymentSignatureHeader(payload) } });
    const entry = await gate.enter(httpContext(request));
    if (entry.kind !== 'admitted') throw new Error(`expected admission, got ${JSON.stringify(entry.denial.body)}`);
    if (typeof price !== 'string') await entry.pass.payment.fulfill({ amount: '$0.05' });
    const { settlement, receipt } = await entry.pass.complete('succeeded');
    expect(settlement).toBe('settled');

    const response = decodePaymentResponseHeader(receipt.headers.find(([name]: readonly [string, string]) => name === 'payment-response')?.[1] ?? '');
    expect(response).toMatchObject({ success: true, network: 'eip155:84532', transaction: expect.stringMatching(/^0x/) as unknown });
    expect(response.amount).toBe(typeof price === 'string' ? '10000' : '50000');
  });
});
