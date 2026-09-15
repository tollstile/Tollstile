import { TollstileError } from 'tollstile';
import { describe, expect, it } from 'vitest';
import { lndRest } from '../src/index';
import { fakeLnd, LND_MACAROON_HEX } from './fake-lnd';

const signal = () => new AbortController().signal;

function provider(respond: (input: string, init: RequestInit) => Promise<Response>) {
  return lndRest({ url: 'https://lnd.test:8080/', macaroon: LND_MACAROON_HEX, fetch: respond });
}

const reply = (status: number, body: unknown) => () => Promise.resolve(new Response(JSON.stringify(body), { status }));

describe('lndRest', () => {
  it('creates an invoice with int64 fields as strings and the macaroon header, and returns the hash as hex', async () => {
    const lnd = fakeLnd();
    const invoices = lndRest({ url: 'https://lnd.test:8080/', macaroon: LND_MACAROON_HEX, fetch: lnd.fetch });

    const invoice = await invoices.createInvoice(21_000n, 'L402', 300, signal());

    expect(lnd.requests[0]).toMatchObject({
      method: 'POST',
      url: 'https://lnd.test:8080/v1/invoices',
      body: { value_msat: '21000', memo: 'L402', expiry: '300' },
    });
    expect(lnd.requests[0]?.headers.get('grpc-metadata-macaroon')).toBe(LND_MACAROON_HEX);
    expect(invoice.paymentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(invoice.paymentRequest).toMatch(/^lnbcrt210000p1/);
  });

  it('looks up open, settled, and missing invoices', async () => {
    const lnd = fakeLnd();
    const invoices = lndRest({ url: 'https://lnd.test:8080', macaroon: LND_MACAROON_HEX, fetch: lnd.fetch });
    const invoice = await invoices.createInvoice(5_000n, 'L402', 60, signal());

    expect(await invoices.lookupInvoice(invoice.paymentHash, signal())).toEqual({ status: 'open' });
    lnd.pay(invoice.paymentRequest);
    expect(await invoices.lookupInvoice(invoice.paymentHash, signal())).toEqual({ status: 'settled', amountPaidMsat: 5_000n });
    expect(lnd.requests.at(-1)).toMatchObject({ method: 'GET', url: `https://lnd.test:8080/v1/invoice/${invoice.paymentHash}` });
    expect(await invoices.lookupInvoice('00'.repeat(32), signal())).toEqual({ status: 'not_found' });
  });

  it('treats held HTLCs as open and canceled invoices as canceled', async () => {
    expect(await provider(reply(200, { state: 'ACCEPTED', amt_paid_msat: '0' })).lookupInvoice('00'.repeat(32), signal())).toEqual({ status: 'open' });
    expect(await provider(reply(200, { state: 'CANCELED' })).lookupInvoice('00'.repeat(32), signal())).toEqual({ status: 'canceled' });
  });

  it('reports an unreachable node as PROVIDER_UNAVAILABLE and an aborted call as PROVIDER_TIMEOUT', async () => {
    const down = provider(() => Promise.reject(new TypeError('fetch failed')));
    await expect(down.createInvoice(1_000n, 'L402', 60, signal())).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });

    const controller = new AbortController();
    controller.abort();
    await expect(down.lookupInvoice('00'.repeat(32), controller.signal)).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
  });

  it('reports refusals as PROVIDER_UNAVAILABLE without leaking the macaroon', async () => {
    const error: unknown = await provider(reply(500, { code: 2, message: 'verification failed' }))
      .createInvoice(1_000n, 'L402', 60, signal())
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TollstileError);
    expect(error).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', message: expect.stringContaining('verification failed') as unknown });
    expect((error as Error).message).not.toContain(LND_MACAROON_HEX);
  });

  it('never reads an unrecognizable lookup answer as paid or unpaid', async () => {
    await expect(provider(reply(200, { state: 'PAID' })).lookupInvoice('00'.repeat(32), signal())).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
    await expect(provider(reply(200, { state: 'SETTLED' })).lookupInvoice('00'.repeat(32), signal())).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
    await expect(
      provider(() => Promise.resolve(new Response('<html>', { status: 200 }))).lookupInvoice('00'.repeat(32), signal()),
    ).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
    await expect(provider(reply(200, { payment_request: 'lnbc1' })).createInvoice(1_000n, 'L402', 60, signal())).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
  });

  it('refuses invalid configuration at construction', () => {
    expect(() => lndRest({ url: 'lnd:8080', macaroon: LND_MACAROON_HEX })).toThrow(/url/);
    expect(() => lndRest({ url: 'https://lnd.test:8080', macaroon: 'not hex' })).toThrow(/macaroon/);
    expect(() => lndRest({ url: 'https://lnd.test:8080', macaroon: '' })).toThrow(/macaroon/);
  });
});
