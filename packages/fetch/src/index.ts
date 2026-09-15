import { toResponse, type Gate, type Payment, type Principal, type Rail } from 'tollstile';

export type FetchAdapterOptions = {
  /** Resolves the authenticated caller, for access policies such as `subscriber()` and `credits()`. */
  readonly principal?: (request: Request) => Principal | null | Promise<Principal | null>;
};

export type PaidContext<Rails extends readonly Rail[]> = {
  readonly payment: Payment<Rails>;
};

export type PaidHandler<Rails extends readonly Rail[]> = (
  request: Request,
  context: PaidContext<Rails>,
) => Response | Promise<Response>;

/**
 * Guards a Web-standard `(request) => Response` handler with a Tollstile gate, for Cloudflare
 * Workers, Deno, Bun, and any other runtime built on `Request` and `Response`.
 *
 * The handler counts as succeeded when it returns a response below 400 without throwing. A thrown
 * error completes the payment as failed and is rethrown.
 *
 * The resource is `"<METHOD> <pathname>"`. Paths with parameters make that set of names unbounded,
 * so pass `toll.price(amount, { resource })` for routes like `/users/:id`.
 *
 * @example
 * ```ts
 * const weather = paid(toll.price('$0.01'), (request, { payment }) =>
 *   Response.json({ forecast: 'clear', paidWith: payment.via }),
 * );
 * export default { fetch: weather };
 * ```
 */
export function paid<Rails extends readonly Rail[]>(
  gate: Gate<Rails>,
  handler: PaidHandler<Rails>,
  options: FetchAdapterOptions = {},
): (request: Request) => Promise<Response> {
  return async (request) => {
    const entry = await gate.enter({
      transport: 'http',
      request,
      mcp: null,
      principal: options.principal === undefined ? null : await options.principal(request),
      resource: `${request.method} ${new URL(request.url).pathname}`,
      requestId: crypto.randomUUID(),
      extras: request,
    });
    if (entry.kind === 'denied') return toResponse(entry.denial);

    let response: Response;
    try {
      response = await handler(request, { payment: entry.pass.payment });
    } catch (error) {
      // catch-reason: a handler that throws has not fulfilled the request, so the payment is
      // completed as failed before the error continues to the runtime.
      await entry.pass.complete('failed');
      throw error;
    }

    const receipt = await entry.pass.complete(response.status >= 400 ? 'failed' : 'succeeded');
    if (receipt.headers.length === 0) return response;

    // Responses from fetch() and Response.redirect() have immutable headers, so the receipt goes on
    // a copy that keeps the status, status text, every header, and the unread body stream.
    const receipted = new Response(response.body, response);
    for (const [name, value] of receipt.headers) receipted.headers.append(name, value);
    return receipted;
  };
}
