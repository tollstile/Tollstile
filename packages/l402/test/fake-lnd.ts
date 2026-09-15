import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { LightningNetwork } from '../src/index';

type StoredInvoice = {
  readonly preimage: Buffer;
  readonly valueMsat: bigint;
  readonly memo: string;
  readonly expiry: number;
  state: 'OPEN' | 'SETTLED' | 'CANCELED';
};

export const LND_MACAROON_HEX = '0201036c6e64';
const HRP: Record<LightningNetwork, string> = { mainnet: 'bc', testnet: 'tb', signet: 'tbs', regtest: 'bcrt' };
const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

/**
 * LND's REST API as far as the rail uses it, behind an injectable `fetch`, plus a wallet that pays
 * its invoices. Payment requests carry a real BOLT 11 human-readable part and a fake data part.
 */
export function fakeLnd(options: { readonly network?: LightningNetwork } = {}) {
  const network = options.network ?? 'regtest';
  const invoices = new Map<string, StoredInvoice>();
  const byRequest = new Map<string, string>();
  const requests: { method: string; url: string; headers: Headers; body: unknown }[] = [];
  let mode: 'up' | 'down' | 'error' = 'up';

  const fetch = (input: string, init: RequestInit): Promise<Response> => {
    const headers = new Headers(init.headers);
    const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({ method: init.method ?? 'GET', url: input, headers, body });
    if (mode === 'down') return Promise.reject(new TypeError('fetch failed'));
    if (mode === 'error') return Promise.resolve(json(503, { code: 14, message: 'server is still starting' }));
    if (headers.get('grpc-metadata-macaroon') !== LND_MACAROON_HEX) {
      return Promise.resolve(json(500, { code: 2, message: 'verification failed: signature mismatch after caveat verification' }));
    }

    const path = new URL(input).pathname;
    if (init.method === 'POST' && path === '/v1/invoices') {
      const request = body as { value_msat: string; memo: string; expiry: string };
      const preimage = randomBytes(32);
      const hash = createHash('sha256').update(preimage).digest();
      const paymentRequest = `ln${HRP[network]}${(BigInt(request.value_msat) * 10n).toString()}p1${encode(invoices.size + 1)}`;
      invoices.set(hash.toString('hex'), {
        preimage,
        valueMsat: BigInt(request.value_msat),
        memo: request.memo,
        expiry: Number(request.expiry),
        state: 'OPEN',
      });
      byRequest.set(paymentRequest, hash.toString('hex'));
      return Promise.resolve(
        json(200, { r_hash: hash.toString('base64'), payment_request: paymentRequest, add_index: String(invoices.size), payment_addr: randomBytes(32).toString('base64') }),
      );
    }

    const lookup = /^\/v1\/invoice\/([0-9a-f]{64})$/.exec(path);
    const invoice = lookup === null ? undefined : invoices.get(lookup[1] ?? '');
    if (lookup !== null && invoice === undefined) return Promise.resolve(json(404, { code: 5, message: 'unable to locate invoice' }));
    if (invoice !== undefined) {
      return Promise.resolve(
        json(200, {
          memo: invoice.memo,
          value_msat: invoice.valueMsat.toString(),
          amt_paid_msat: invoice.state === 'SETTLED' ? invoice.valueMsat.toString() : '0',
          state: invoice.state,
        }),
      );
    }
    return Promise.resolve(json(404, { code: 5, message: 'Not Found' }));
  };

  return {
    fetch,
    requests,
    invoices,
    setMode(next: 'up' | 'down' | 'error') {
      mode = next;
    },
    /** Pays an invoice the way a wallet would, returning the preimage it learns. */
    pay(paymentRequest: string): string {
      const invoice = invoices.get(byRequest.get(paymentRequest) ?? '');
      if (invoice === undefined) throw new Error(`unknown invoice ${paymentRequest}`);
      invoice.state = 'SETTLED';
      return invoice.preimage.toString('hex');
    },
    /** The preimage without paying, as a leaked preimage would be. */
    preimageOf(paymentRequest: string): string {
      const invoice = invoices.get(byRequest.get(paymentRequest) ?? '');
      if (invoice === undefined) throw new Error(`unknown invoice ${paymentRequest}`);
      return invoice.preimage.toString('hex');
    },
  };
}

/** Appends a first-party caveat the way a macaroon holder can, without the root key (go-macaroon AddFirstPartyCaveat). */
export function appendCaveat(macaroonBase64: string, caveat: string): string {
  const bytes = Buffer.from(macaroonBase64, 'base64');
  const tail = bytes.length - 35;
  if (bytes[tail] !== 0 || bytes[tail + 1] !== 6 || bytes[tail + 2] !== 32) throw new Error('not a V2 macaroon');
  const signature = bytes.subarray(bytes.length - 32);
  const id = Buffer.from(caveat, 'utf8');
  const next = createHmac('sha256', signature).update(id).digest();
  return Buffer.concat([bytes.subarray(0, tail), Buffer.from([2, ...varint(id.length)]), id, Buffer.from([0, 0, 6, 32]), next]).toString('base64');
}

/** Reads the first L402 or LSAT challenge the way lnget does. */
export function readChallenge(headers: Headers): { readonly scheme: string; readonly macaroon: string; readonly invoice: string } {
  const match = /(LSAT|L402)\s+macaroon="([^"]+)",\s*invoice="([^"]+)"/i.exec(headers.get('www-authenticate') ?? '');
  if (match === null) throw new Error(`no L402 challenge in ${headers.get('www-authenticate') ?? 'nothing'}`);
  return { scheme: match[1] ?? '', macaroon: match[2] ?? '', invoice: match[3] ?? '' };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function encode(value: number): string {
  let rest = value;
  let out = '';
  do {
    out = (BECH32[rest % 32] ?? 'q') + out;
    rest = Math.floor(rest / 32);
  } while (rest > 0);
  return `qqqqsyqcyq5rqwzqf${out}`;
}

function varint(value: number): number[] {
  const bytes: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  bytes.push(rest);
  return bytes;
}
