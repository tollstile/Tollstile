import type { Context as HonoContext, MiddlewareHandler } from 'hono';
import { routePath } from 'hono/route';
import { toResponse, type Gate, type Payment, type Principal, type Rail } from 'tollstile';

export type TollstileEnv<Rails extends readonly Rail[]> = {
  Variables: { payment: Payment<Rails> };
};

export type HonoAdapterOptions = {
  /** Resolves the authenticated caller, for access policies such as `subscriber()` and `credits()`. */
  readonly principal?: (context: HonoContext) => Principal | null | Promise<Principal | null>;
};

/**
 * Guards a Hono route with a Tollstile gate. The handler counts as succeeded when it returns a
 * response below 400 without throwing.
 */
export function tollstile<Rails extends readonly Rail[]>(
  gate: Gate<Rails>,
  options: HonoAdapterOptions = {},
): MiddlewareHandler<TollstileEnv<Rails>> {
  return async (c, next) => {
    const entry = await gate.enter({
      transport: 'http',
      request: c.req.raw,
      mcp: null,
      principal: options.principal === undefined ? null : await options.principal(c),
      resource: `${c.req.method} ${routePath(c)}`,
      requestId: crypto.randomUUID(),
      extras: c,
    });
    if (entry.kind === 'denied') return toResponse(entry.denial);

    c.set('payment', entry.pass.payment);
    await next();

    const failed = c.error !== undefined || c.res.status >= 400;
    const { receipt, denial } = await entry.pass.complete(failed ? 'failed' : 'succeeded');
    if (denial !== null) {
      // Settlement was rejected: the payer does not get the output, only a fresh challenge.
      c.res = toResponse(denial);
      return undefined;
    }
    for (const [name, value] of receipt.headers) c.res.headers.append(name, value);
    return undefined;
  };
}
