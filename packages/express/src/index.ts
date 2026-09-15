import type { NextFunction, Request as ExpressRequest, RequestHandler, Response as ExpressResponse } from 'express';
import { toResponse, TollstileError, type Gate, type Payment, type Principal, type Rail } from 'tollstile';
import { holdResponse } from './held-response';

export type ExpressAdapterOptions = {
  /** Resolves the authenticated caller, for access policies such as `subscriber()` and `credits()`. */
  readonly principal?: (req: ExpressRequest) => Principal | null | Promise<Principal | null>;
};

export type PaidContext<Rails extends readonly Rail[]> = {
  readonly payment: Payment<Rails>;
  /** Express's `next`. `next(error)` completes the payment as failed. */
  readonly next: NextFunction;
};

export type PaidHandler<Rails extends readonly Rail[]> = (
  req: ExpressRequest,
  res: ExpressResponse,
  context: PaidContext<Rails>,
) => unknown;

/**
 * Guards an Express 5 route handler with a Tollstile gate.
 *
 * The outcome is decided when the response is about to send its headers: a status below 400
 * succeeds; 400 or above, a thrown error, or `next(error)` fails. The response is held until the
 * payment is completed — settled, or released — so receipt headers are on it and settlement has
 * finished before anything reaches the client. Once headers are sent, the outcome is fixed: an
 * error thrown halfway through a stream does not undo the charge.
 *
 * The resource is `"<METHOD> <route path>"`, e.g. `GET /users/:id`, when the handler is mounted
 * on a string route path, and `"<METHOD> <pathname>"` otherwise.
 *
 * @example
 * ```ts
 * app.get('/weather', paid(toll.price('$0.01'), (req, res, { payment }) => {
 *   res.json({ forecast: 'clear', paidWith: payment.via });
 * }));
 * ```
 */
export function paid<Rails extends readonly Rail[]>(
  gate: Gate<Rails>,
  handler: PaidHandler<Rails>,
  options: ExpressAdapterOptions = {},
): RequestHandler {
  return async (req, res, next) => {
    const request = webRequest(req);
    const entry = await gate.enter({
      transport: 'http',
      request,
      mcp: null,
      principal: options.principal === undefined ? null : await options.principal(req),
      resource: `${req.method} ${routePath(req, request)}`,
      requestId: crypto.randomUUID(),
      extras: req,
    });
    if (entry.kind === 'denied') {
      const denial = toResponse(entry.denial);
      res.status(denial.status);
      for (const [name, value] of denial.headers) res.append(name, value);
      res.send(await denial.text());
      return;
    }

    const held = holdResponse(res, entry.pass, next);
    try {
      await handler(req, res, { payment: entry.pass.payment, next: held.next });
    } catch (error) {
      // catch-reason: a handler that throws has not fulfilled the request, so the payment is
      // completed as failed before Express renders the error.
      await held.fail();
      throw error;
    }
  };
}

/**
 * The Web `Request` core and rails read. Rails read headers and the URL; core reads the body only to
 * price a request and bind its quote to it, so the body is rebuilt from what Express parsed.
 */
function webRequest(req: ExpressRequest): Request {
  const headers = new Headers();
  for (const [name, values] of Object.entries<readonly string[] | undefined>(req.headersDistinct)) {
    for (const value of values ?? []) headers.append(name, value);
  }
  // Express types `host` as a string, but it is undefined for HTTP/1.0 requests without a Host header.
  const host: unknown = req.host;
  const authority = typeof host === 'string' ? host : 'localhost';
  const url = `${req.protocol}://${authority}${req.originalUrl}`;
  if (req.method === 'GET' || req.method === 'HEAD') return new Request(url, { method: req.method, headers });
  return new Request(url, { method: req.method, headers, body: requestBody(req), duplex: 'half' } as RequestInit);
}

/**
 * Parsed bodies are serialized with sorted keys, so a quote binds to the same bytes on the retry. A
 * body Express did not parse cannot be read without consuming it before the handler, so reading it
 * fails: a price or quote that depends on the body must never be computed from an empty one.
 */
function requestBody(req: ExpressRequest): BodyInit | null {
  const body: unknown = req.body;
  if (Buffer.isBuffer(body)) return new Uint8Array(body);
  if (typeof body === 'string') return body;
  if (typeof body === 'object' && body !== null) return stableJson(body);
  if (!hasBody(req)) return null;
  return new ReadableStream({
    pull(controller) {
      controller.error(
        new TollstileError(
          'CONFIG_INVALID',
          `${req.method} ${req.originalUrl} has a body that Express did not parse. Add express.json(), express.text(), or express.raw() before paid() so Tollstile can price the request and bind its quote to the body.`,
        ),
      );
    },
  });
}

function hasBody(req: ExpressRequest): boolean {
  const length = req.headers['content-length'];
  return req.headers['transfer-encoding'] !== undefined || (length !== undefined && length !== '0');
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'object' && item !== null && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
}

/** A route pattern keeps resource names bounded; `/users/42` and `/users/43` are one resource. */
function routePath(req: ExpressRequest, request: Request): string {
  const route: unknown = req.route;
  if (typeof route === 'object' && route !== null && 'path' in route && typeof route.path === 'string') {
    return `${req.baseUrl}${route.path}`;
  }
  return new URL(request.url).pathname;
}
