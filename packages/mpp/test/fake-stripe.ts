type Json = Record<string, unknown>;

export type StripeMode =
  | 'ok'
  /** fetch rejects before Stripe sees the request. */
  | 'down'
  /** Stripe performs the request, then the connection drops. */
  | 'timeout-after-effect'
  | 'server-error';

type StoredResponse = { readonly status: number; readonly body: Json; readonly params: string };

/** An in-memory Stripe API with idempotency, search, and refunds, reached through an injected fetch. */
export function fakeStripe() {
  const intents = new Map<string, Json>();
  const refunds: Json[] = [];
  const idempotency = new Map<string, StoredResponse>();
  const requests: { method: string; path: string; headers: Headers; body: URLSearchParams }[] = [];
  const modes: { payment: StripeMode; refund: StripeMode; read: StripeMode } = { payment: 'ok', refund: 'ok', read: 'ok' };
  /** Search results appear only when this is true, to model index lag. */
  let searchable = true;

  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const body = new URLSearchParams(init?.body instanceof URLSearchParams ? init.body : undefined);
    requests.push({ method, path: url.pathname + url.search, headers, body });
    await Promise.resolve();

    if (method === 'GET') {
      if (modes.read === 'down') throw new TypeError('fetch failed');
      return read(url);
    }
    const mode = url.pathname === '/v1/refunds' ? modes.refund : modes.payment;
    if (mode === 'down') throw new TypeError('fetch failed');
    if (mode === 'server-error') return json(500, { error: { type: 'api_error' } });

    const key = headers.get('idempotency-key');
    const params = body.toString();
    const stored = key === null ? undefined : idempotency.get(key);
    let response: Response;
    if (stored !== undefined) {
      if (stored.params !== params) {
        response = json(400, { error: { type: 'idempotency_error', message: 'Keys for idempotent requests can only be used with the same parameters.' } });
      } else {
        response = json(stored.status, stored.body, { 'idempotent-replayed': 'true' });
      }
    } else {
      const [status, result] = url.pathname === '/v1/refunds' ? createRefund(body) : createIntent(body);
      if (key !== null) idempotency.set(key, { status, body: result, params });
      response = json(status, result);
    }
    if (mode === 'timeout-after-effect') throw new DOMException('The operation timed out.', 'TimeoutError');
    return response;
  };

  function createIntent(body: URLSearchParams): [number, Json] {
    const spt = body.get('shared_payment_granted_token') ?? body.get('payment_method_data[shared_payment_granted_token]');
    if (spt === 'spt_declined') return [402, { error: { type: 'card_error', code: 'card_declined', decline_code: 'insufficient_funds' } }];
    if (spt === null) return [400, { error: { type: 'invalid_request_error', code: 'parameter_missing' } }];
    const id = `pi_${String(intents.size + 1)}`;
    const intent = {
      id,
      object: 'payment_intent',
      status: spt === 'spt_action' ? 'requires_action' : 'succeeded',
      amount: Number(body.get('amount')),
      currency: body.get('currency'),
      metadata: metadata(body),
    };
    intents.set(id, intent);
    return [200, intent];
  }

  function createRefund(body: URLSearchParams): [number, Json] {
    const intent = intents.get(body.get('payment_intent') ?? '');
    if (intent === undefined) return [404, { error: { type: 'invalid_request_error', code: 'resource_missing' } }];
    const refund = { id: `re_${String(refunds.length + 1)}`, object: 'refund', status: 'succeeded', payment_intent: intent.id, amount: Number(body.get('amount')), metadata: metadata(body) };
    refunds.push(refund);
    return [200, refund];
  }

  function read(url: URL): Response {
    if (url.pathname === '/v1/payment_intents/search') {
      const match = /metadata\['challenge_id'\]:'([^']*)'/.exec(url.searchParams.get('query') ?? '');
      const data = searchable ? [...intents.values()].filter((intent) => (intent.metadata as Json).challenge_id === match?.[1]) : [];
      return json(200, { object: 'search_result', data });
    }
    if (url.pathname === '/v1/refunds') {
      return json(200, { object: 'list', data: refunds.filter((refund) => refund.payment_intent === url.searchParams.get('payment_intent')) });
    }
    const intent = intents.get(url.pathname.replace('/v1/payment_intents/', ''));
    return intent === undefined ? json(404, { error: { type: 'invalid_request_error', code: 'resource_missing' } }) : json(200, intent);
  }

  return {
    fetch,
    intents,
    refunds,
    requests,
    simulate(next: Partial<typeof modes>) {
      Object.assign(modes, { payment: 'ok', refund: 'ok', read: 'ok' }, next);
    },
    setSearchable(value: boolean) {
      searchable = value;
    },
  };
}

function metadata(body: URLSearchParams): Json {
  return Object.fromEntries([...body.entries()].flatMap(([name, value]) => {
    const match = /^metadata\[(.+)\]$/.exec(name);
    return match?.[1] === undefined ? [] : [[match[1], value]];
  }));
}

function json(status: number, body: Json, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}
