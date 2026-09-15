import { TollstileError } from 'tollstile';
import { fromBase64, fromHex, toHex } from './encoding';
import type { InvoiceProvider, InvoiceState } from './invoice';

export type LndRestOptions = {
  /** LND's REST listener, e.g. `https://127.0.0.1:8080`. */
  readonly url: string;
  /** Hex-encoded macaroon. `invoice.macaroon` is enough: it can create and read invoices, nothing else. */
  readonly macaroon: string;
  /**
   * LND serves a self-signed certificate by default. Pass a `fetch` that trusts it (or set
   * `NODE_EXTRA_CA_CERTS`), and in tests, a fake.
   */
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
};

const HTTP_NOT_FOUND = 404;
const INVOICE_STATES = new Set(['OPEN', 'SETTLED', 'CANCELED', 'ACCEPTED']);

/**
 * Creates and looks up invoices through LND's REST API.
 *
 * @example
 * const invoices = lndRest({ url: 'https://127.0.0.1:8080', macaroon: invoiceMacaroonHex });
 */
export function lndRest(options: LndRestOptions): InvoiceProvider {
  const base = parseUrl(options.url);
  // Messages name the origin only, so credentials in the URL never reach an error.
  const origin = new URL(base).origin;
  if (options.macaroon.length === 0 || fromHex(options.macaroon) === undefined) {
    throw new TollstileError('CONFIG_INVALID', 'lndRest() needs `macaroon` as hex, e.g. `xxd -p -c 1000 invoice.macaroon`.');
  }
  const send = options.fetch ?? ((input, init) => fetch(input, init));

  async function call(method: 'GET' | 'POST', path: string, body: unknown, signal: AbortSignal) {
    const init: RequestInit = {
      method,
      headers: { 'grpc-metadata-macaroon': options.macaroon, 'content-type': 'application/json' },
      signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    // catch-reason: the boundary where a failed network call becomes PROVIDER_* (CODING_RULES §2.3).
    try {
      const response = await send(`${base}${path}`, init);
      return { status: response.status, text: await response.text() };
    } catch (error) {
      throw new TollstileError(
        signal.aborted ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE',
        `LND at ${origin} did not answer. Check that the node is running and \`url\` points at its REST listener.`,
        { cause: error },
      );
    }
  }

  return {
    async createInvoice(amountMsat, memo, expirySeconds, signal) {
      const body = { value_msat: amountMsat.toString(), memo, expiry: expirySeconds.toString() };
      const response = await call('POST', '/v1/invoices', body, signal);
      if (response.status !== 200) throw rejected(origin, 'create an invoice', response);

      const created = parseJson(response.text);
      const hash = typeof created?.r_hash === 'string' ? fromBase64(created.r_hash) : undefined;
      if (hash?.length !== 32 || typeof created?.payment_request !== 'string') {
        throw new TollstileError('PROVIDER_UNAVAILABLE', `LND at ${origin} returned an invoice without r_hash or payment_request.`);
      }
      return { paymentHash: toHex(hash), paymentRequest: created.payment_request };
    },

    async lookupInvoice(paymentHash, signal) {
      const response = await call('GET', `/v1/invoice/${paymentHash}`, undefined, signal);
      if (response.status === HTTP_NOT_FOUND) return { status: 'not_found' };
      if (response.status !== 200) throw rejected(origin, 'look up an invoice', response);
      return parseInvoiceState(origin, parseJson(response.text));
    },
  };
}

function parseInvoiceState(origin: string, invoice: Record<string, unknown> | undefined): InvoiceState {
  const state = invoice?.state;
  const paid = invoice?.amt_paid_msat;
  // A success status with an unreadable body says nothing about whether the invoice was paid.
  if (typeof state !== 'string' || !INVOICE_STATES.has(state)) {
    throw new TollstileError('PROVIDER_TIMEOUT', `LND at ${origin} returned an invoice with an unrecognized state.`);
  }
  switch (state) {
    case 'SETTLED':
      if (typeof paid !== 'string' || !/^\d+$/.test(paid)) {
        throw new TollstileError('PROVIDER_TIMEOUT', `LND at ${origin} returned a settled invoice without amt_paid_msat.`);
      }
      return { status: 'settled', amountPaidMsat: BigInt(paid) };
    case 'CANCELED':
      return { status: 'canceled' };
    default:
      // ACCEPTED means HTLCs are held but not settled: not final.
      return { status: 'open' };
  }
}

function rejected(origin: string, action: string, response: { readonly status: number; readonly text: string }): TollstileError {
  const message = parseJson(response.text)?.message;
  const detail = typeof message === 'string' ? `: ${message.slice(0, 200)}` : '';
  return new TollstileError('PROVIDER_UNAVAILABLE', `LND at ${origin} refused to ${action} (HTTP ${String(response.status)})${detail}.`);
}

function parseUrl(url: string): string {
  if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) {
    throw new TollstileError('CONFIG_INVALID', `lndRest() needs \`url\` like "https://127.0.0.1:8080", got "${url}".`);
  }
  return url.replace(/\/+$/, '');
}

function parseJson(text: string): Record<string, unknown> | undefined {
  // catch-reason: JSON.parse reports malformed input by throwing; a malformed provider body is a returned outcome here.
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
