// A stand-in for a real payment provider's HTTP API, so the rail in acme-rail.ts can be written
// and tested against something that behaves like a network service: idempotency keys, lookups,
// and responses that can be lost. Replace it with the real provider; the rail stays the same.

type Payment = { readonly id: string; readonly token: string; readonly payer: string; readonly amount: string; readonly currency: string; readonly quote: string };
type Capture = { readonly id: string; readonly paymentId: string; readonly amount: string; readonly key: string };

export type AcmeProvider = {
  /** What a payer's wallet does: authorize a payment and receive a token to present. */
  authorize(input: { readonly payer: string; readonly amount: string; readonly currency: string; readonly quote: string }): { readonly token: string };
  /** The provider's HTTP API, as a `fetch` implementation. */
  readonly fetch: typeof fetch;
  /** Captures that moved money. */
  captures(): readonly Capture[];
  /** The next capture is performed, but its response is lost. */
  loseNextCaptureResponse(): void;
  /** The next capture fails before moving money. */
  failNextCapture(): void;
};

export function acmeProvider(): AcmeProvider {
  const payments = new Map<string, Payment>();
  const captures = new Map<string, Capture>();
  const refunds = new Map<string, string>();
  let fault: 'lose-response' | 'fail' | undefined;
  let sequence = 0;
  const next = (prefix: string) => `${prefix}_${String((sequence += 1))}`;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get('authorization') !== 'Bearer sk_test_acme') return json(401, { error: 'unauthorized' });

    if (request.method === 'POST' && url.pathname === '/v1/verify') {
      const { token } = (await request.json()) as { token: string };
      const payment = [...payments.values()].find((candidate) => candidate.token === token);
      if (payment === undefined) return json(200, { valid: false, reason: 'token_unknown' });
      return json(200, { valid: true, payment_id: payment.id, payer: payment.payer, amount: payment.amount, currency: payment.currency, quote: payment.quote });
    }

    if (request.method === 'POST' && url.pathname === '/v1/captures') {
      const key = request.headers.get('idempotency-key') ?? '';
      const { payment_id: paymentId, amount } = (await request.json()) as { payment_id: string; amount: string };
      const existing = captures.get(key);
      if (existing !== undefined) return json(200, { id: existing.id });

      const current = fault;
      fault = undefined;
      if (current === 'fail') return json(503, { error: 'unavailable' });
      const payment = payments.get(paymentId);
      if (payment === undefined || BigInt(amount) > BigInt(payment.amount)) return json(402, { error: 'capture_declined' });
      const capture = { id: next('cap'), paymentId, amount, key };
      captures.set(key, capture);
      if (current === 'lose-response') return Promise.reject(new TypeError('fetch failed: socket hang up'));
      return json(200, { id: capture.id });
    }

    const listed = /^\/v1\/payments\/([^/]+)\/captures$/.exec(url.pathname);
    if (request.method === 'GET' && listed?.[1] !== undefined) {
      const found = [...captures.values()].filter((capture) => capture.paymentId === listed[1]);
      return json(200, { data: found.map((capture) => ({ id: capture.id, amount: capture.amount, idempotency_key: capture.key })) });
    }

    if (request.method === 'POST' && url.pathname === '/v1/refunds') {
      const key = request.headers.get('idempotency-key') ?? '';
      const { capture_id: captureId } = (await request.json()) as { capture_id: string };
      const existing = refunds.get(key) ?? next('ref');
      refunds.set(key, existing);
      return json(captureId.length > 0 ? 200 : 400, { id: existing });
    }

    return json(404, { error: 'not_found' });
  }

  return {
    authorize(input) {
      const payment = { ...input, id: next('pay'), token: `tok_${String(sequence)}_${crypto.randomUUID()}` };
      payments.set(payment.id, payment);
      return { token: payment.token };
    },
    fetch: (input, init) => handle(new Request(input, init)),
    captures: () => [...captures.values()],
    loseNextCaptureResponse: () => {
      fault = 'lose-response';
    },
    failNextCapture: () => {
      fault = 'fail';
    },
  };
}
