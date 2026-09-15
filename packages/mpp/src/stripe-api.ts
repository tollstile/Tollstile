import { TollstileError, type JsonObject } from 'tollstile';
import { isObject } from './encoding';

export type StripeConfig = {
  readonly secretKey: string;
  readonly apiBase: string;
  readonly apiVersion: string;
  readonly fetch: typeof fetch;
};

export type StripeCall = {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: URLSearchParams;
  readonly idempotencyKey?: string;
  readonly signal: AbortSignal;
};

/** A definitive answer from Stripe. Ambiguous answers are thrown as `PROVIDER_*`. */
export type StripeResponse =
  | { readonly ok: true; readonly body: JsonObject; readonly replayed: boolean }
  | { readonly ok: false; readonly status: number; readonly code: string };

export type PaymentIntent = {
  readonly id: string;
  readonly status: string;
  readonly amount: number;
  readonly currency: string;
};

export type StripeRefund = { readonly id: string; readonly status: string; readonly charge: string | null };

/**
 * One Stripe API call. A POST whose outcome cannot be known (network failure, 5xx, a concurrent
 * request on the same idempotency key) throws `PROVIDER_TIMEOUT`, so core records `unknown` and
 * resolves it by lookup. A read that fails throws `PROVIDER_UNAVAILABLE`: nothing could have moved.
 */
export async function stripeCall(config: StripeConfig, call: StripeCall): Promise<StripeResponse> {
  const mutation = call.method === 'POST';
  const headers = new Headers({
    authorization: `Bearer ${config.secretKey}`,
    'stripe-version': config.apiVersion,
  });
  if (call.body !== undefined) headers.set('content-type', 'application/x-www-form-urlencoded');
  if (call.idempotencyKey !== undefined) headers.set('idempotency-key', call.idempotencyKey);

  let response: Response;
  // catch-reason: a failed fetch is the boundary where an unreachable provider becomes PROVIDER_*.
  try {
    response = await config.fetch(`${config.apiBase}${call.path}`, {
      method: call.method,
      headers,
      ...(call.body === undefined ? {} : { body: call.body }),
      signal: call.signal,
    });
  } catch (error) {
    throw failure(mutation, `Stripe ${call.method} ${routeOf(call.path)} did not complete.`, error);
  }

  const body = await readJson(response);
  const code = errorCode(body);
  if (response.ok) {
    if (body === undefined) throw failure(mutation, `Stripe ${call.method} ${routeOf(call.path)} returned an unreadable body.`);
    return { ok: true, body, replayed: response.headers.get('idempotent-replayed') === 'true' };
  }
  if (response.status >= 500) throw failure(mutation, `Stripe answered ${String(response.status)} for ${routeOf(call.path)}.`);
  if (response.status === 429 || response.status === 401 || response.status === 403) {
    // Rate-limited and unauthenticated requests are refused before Stripe does anything.
    throw new TollstileError('PROVIDER_UNAVAILABLE', `Stripe refused ${routeOf(call.path)} with ${String(response.status)}. Check the API key and rate limits.`);
  }
  if (response.status === 409 || code === 'idempotency_key_in_use' || errorType(body) === 'idempotency_error') {
    // Another request with this key is in flight or was sent with other parameters: the payment
    // may exist, so only a lookup can tell.
    throw new TollstileError('PROVIDER_TIMEOUT', `Stripe reported an idempotency conflict for ${routeOf(call.path)}.`);
  }
  return { ok: false, status: response.status, code: code ?? errorType(body) ?? `http_${String(response.status)}` };
}

export function parsePaymentIntent(body: JsonObject): PaymentIntent | undefined {
  const { id, status, amount, currency } = body;
  if (typeof id !== 'string' || typeof status !== 'string' || typeof amount !== 'number' || typeof currency !== 'string') {
    return undefined;
  }
  return { id, status, amount, currency };
}

export function parseRefund(body: JsonObject): StripeRefund | undefined {
  const { id, status, charge } = body;
  if (typeof id !== 'string' || typeof status !== 'string') return undefined;
  return { id, status, charge: typeof charge === 'string' ? charge : null };
}

/** `data` of a Stripe list or search result, or `undefined` when the shape is not one. */
export function listData(body: JsonObject): readonly JsonObject[] | undefined {
  const { data } = body;
  if (!Array.isArray(data)) return undefined;
  const items = data.filter(isObject);
  return items.length === data.length ? items : undefined;
}

export function metadataOf(body: JsonObject): JsonObject {
  return isObject(body.metadata) ? body.metadata : {};
}

async function readJson(response: Response): Promise<JsonObject | undefined> {
  // catch-reason: an unparsable provider body is an expected, classified outcome, not a crash.
  try {
    const parsed: unknown = await response.json();
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function errorCode(body: JsonObject | undefined): string | undefined {
  const error = body?.error;
  if (!isObject(error)) return undefined;
  if (typeof error.decline_code === 'string') return error.decline_code;
  return typeof error.code === 'string' ? error.code : undefined;
}

function errorType(body: JsonObject | undefined): string | undefined {
  const error = body?.error;
  return isObject(error) && typeof error.type === 'string' ? error.type : undefined;
}

/** Only the route shape goes into messages: ids in paths and query strings stay out of logs. */
function routeOf(path: string): string {
  return path.replace(/\?.*$/, '').replace(/\/(pi|re|ch)_[A-Za-z0-9]+/g, '/:id');
}

function failure(mutation: boolean, message: string, cause?: unknown): TollstileError {
  return new TollstileError(mutation ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE', message, cause === undefined ? undefined : { cause });
}
