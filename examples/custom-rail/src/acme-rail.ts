import { createRail, formatMoney, TollstileError, type Json } from 'tollstile';

/** HTTP header the payer sends: the token their wallet got from Acme. */
export const ACME_TOKEN_HEADER = 'acme-payment-token';
/** MCP `_meta` key carrying the same token. */
export const ACME_TOKEN_META = 'acme/payment-token';

export type AcmeRailOptions = {
  readonly apiKey: string;
  /** Defaults to Acme's API. */
  readonly apiUrl?: string;
  readonly fetch?: typeof fetch;
};

/** What the ledger keeps per authorization: enough to capture, look up, and refund. Never the token. */
export type AcmeData = { readonly paymentId: string };

/**
 * A rail for Acme, an imaginary card-style provider: the payer's wallet authorizes a payment against
 * the 402's quote and sends a token; the rail verifies it with Acme, captures after the handler
 * succeeds, and looks captures up when a response is lost. Every rule it follows is in SPEC.md.
 */
export function acmeRail(options: AcmeRailOptions) {
  const apiUrl = options.apiUrl ?? 'https://api.acme.example';
  const fetchImpl = options.fetch ?? fetch;

  /** Calls Acme. A network failure or 5xx means the outcome is unknown: throw, never guess (SPEC §9). */
  async function call(path: string, init: { readonly method: string; readonly body?: Json; readonly key?: string; readonly signal: AbortSignal }) {
    const headers: Record<string, string> = { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' };
    if (init.key !== undefined) headers['idempotency-key'] = init.key;
    const response = await fetchImpl(`${apiUrl}${path}`, {
      method: init.method,
      headers,
      signal: init.signal,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }).catch((error: unknown) => {
      throw new TollstileError('PROVIDER_TIMEOUT', `Acme did not answer ${init.method} ${path}.`, { cause: error });
    });
    if (response.status >= 500) throw new TollstileError('PROVIDER_UNAVAILABLE', `Acme answered ${String(response.status)} to ${init.method} ${path}.`);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  return createRail<'acme', AcmeData>({
    name: 'acme',
    livemode: !options.apiKey.startsWith('sk_test_'),
    capabilities: {
      // Capture happens after the handler, so a failed handler costs the payer nothing.
      flows: ['authorization'],
      // One token pays for one request.
      authorization: 'single',
      // The quote token travels inside the payment, so computed prices work.
      quotes: true,
    },

    // The asset Acme settles in, for the price. Acme charges USD at par; other currencies get no offer.
    offer: ({ price }) =>
      Promise.resolve(
        price.currency === 'USD'
          ? { rail: 'acme', asset: { code: 'USD', network: null, scale: 6 }, amount: price.micros.toString(), basis: 'par', details: {} }
          : null,
      ),

    // What the payer needs to pay: the amount and the quote token to authorize against.
    challenge: (quote, quoteToken, offer) => {
      const accepts = { amount: offer.amount, currency: 'USD', quote: quoteToken, header: ACME_TOKEN_HEADER };
      return Promise.resolve({
        headers: [['acme-payment-required', `amount=${offer.amount}, currency=USD, price="${formatMoney(quote.price)}"`]],
        accepts,
        mcp: { style: 'acme', meta: ACME_TOKEN_META, ...accepts },
      });
    },

    async verify(context, terms, operation) {
      const fromMeta = context.mcp?.meta[ACME_TOKEN_META];
      const token = typeof fromMeta === 'string' ? fromMeta : context.request?.headers.get(ACME_TOKEN_HEADER);
      // No proof for this rail: let the next rail look.
      if (token === undefined || token === null) return { status: 'absent' };

      const { status, body } = await call('/v1/verify', { method: 'POST', body: { token }, signal: operation.signal });
      if (status !== 200 || body.valid !== true) return { status: 'invalid', reason: typeof body.reason === 'string' ? body.reason : 'token_invalid' };

      const paymentId = String(body.payment_id);
      // The provider echoes the quote the payer authorized. Open it: forged, expired, or for another resource means no.
      const quote = typeof body.quote === 'string' ? await terms.openQuote(body.quote) : undefined;
      if (quote === undefined) return { status: 'invalid', reason: 'quote_invalid', proofId: paymentId };

      // The server decides the price (SPEC §6): the authorized amount must cover the quoted price exactly.
      if (body.currency !== 'USD' || body.amount !== quote.price.micros.toString()) return { status: 'invalid', reason: 'amount_mismatch' };

      return {
        status: 'valid',
        // Stable for the same payment, so presenting it twice finds the same authorization.
        proofId: paymentId,
        // Canonical and trimmed: requirements and idempotency keys compare it exactly.
        payer: String(body.payer).trim().toLowerCase(),
        quote,
        limit: quote.price,
        expiresAt: quote.expiresAt,
        data: { paymentId },
      };
    },

    // `operation.key` is derived from the charge: a retry of the same capture never captures twice.
    async settle(authorization, charge, operation) {
      const { status, body } = await call('/v1/captures', {
        method: 'POST',
        key: operation.key,
        body: { payment_id: authorization.data.paymentId, amount: charge.amount.micros.toString() },
        signal: operation.signal,
      });
      if (status === 200) return { status: 'settled', reference: String(body.id), details: {} };
      return { status: 'rejected', reason: typeof body.error === 'string' ? body.error : 'capture_rejected' };
    },

    // Asked only when an outcome is unknown. Answer from the provider's records, never from memory.
    async lookup(authorization, charge, operation) {
      const { status, body } = await call(`/v1/payments/${authorization.data.paymentId}/captures`, { method: 'GET', signal: operation.signal });
      if (status !== 200) throw new TollstileError('PROVIDER_UNAVAILABLE', `Acme could not list captures (${String(status)}).`);
      const captures = Array.isArray(body.data) ? (body.data as { id: string; idempotency_key: string }[]) : [];
      const capture = captures.find((candidate) => candidate.idempotency_key === `${charge.id}:settle`);
      return capture === undefined ? { status: 'none' } : { status: 'settled', reference: capture.id, details: {} };
    },

    async refund(_authorization, charge, operation) {
      const { status, body } = await call('/v1/refunds', {
        method: 'POST',
        key: operation.key,
        body: { capture_id: charge.settlement?.reference ?? '' },
        signal: operation.signal,
      });
      return status === 200 ? { status: 'refunded', reference: String(body.id) } : { status: 'rejected', reason: 'refund_rejected' };
    },

    receipt: (_authorization, charge, context) => {
      const reference = charge.settlement?.reference ?? charge.id;
      return context.transport === 'mcp' ? { headers: [], meta: { 'acme/receipt': reference } } : { headers: [['acme-receipt', reference]], meta: {} };
    },
  });
}
