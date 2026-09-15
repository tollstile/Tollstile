import { toResponse, type Gate, type Payment, type Principal, type Rail } from 'tollstile';

export type NextAdapterOptions = {
  /** Resolves the authenticated caller, for access policies such as `subscriber()` and `credits()`. */
  readonly principal?: (request: Request) => Principal | null | Promise<Principal | null>;
};

/** The second argument Next.js passes to an App Router route handler. */
export type RouteContext<Params> = {
  readonly params: Promise<Params>;
};

export type PaidContext<Rails extends readonly Rail[], Params> = RouteContext<Params> & {
  readonly payment: Payment<Rails>;
};

export type PaidHandler<Rails extends readonly Rail[], Params> = (
  request: Request,
  context: PaidContext<Rails, Params>,
) => Response | Promise<Response>;

/**
 * Guards a Next.js App Router route handler with a Tollstile gate.
 *
 * The handler counts as succeeded when it returns a response below 400 without throwing. A thrown
 * error completes the payment as failed and is rethrown. That includes `redirect()` and
 * `notFound()` from `next/navigation`, which work by throwing: return `NextResponse.redirect()`
 * instead when the redirect is the paid result.
 *
 * The resource is `"<METHOD> <pathname>"`. Dynamic segments make that set of names unbounded, so
 * pass `toll.price(amount, { resource })` in routes like `app/reports/[id]/route.ts`.
 *
 * @example
 * ```ts
 * // app/reports/[id]/route.ts
 * export const GET = paid(
 *   toll.price('$0.01', { resource: 'GET /reports/[id]' }),
 *   async (request, { params, payment }) => {
 *     const { id } = await params;
 *     return Response.json({ id, paidWith: payment.via });
 *   },
 * );
 * ```
 */
export function paid<Rails extends readonly Rail[], Params = Record<string, string | string[] | undefined>>(
  gate: Gate<Rails>,
  handler: PaidHandler<Rails, Params>,
  options: NextAdapterOptions = {},
): (request: Request, context: RouteContext<Params>) => Promise<Response> {
  return async (request, { params }) => {
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
      response = await handler(request, { params, payment: entry.pass.payment });
    } catch (error) {
      // catch-reason: a handler that throws has not fulfilled the request, so the payment is
      // completed as failed before the error continues to Next.js.
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
