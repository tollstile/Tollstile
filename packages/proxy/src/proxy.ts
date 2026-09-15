import { idempotencyKeyOf, toResponse, TollstileError, type Completion, type Entry, type Gate, type Principal, type Rail, type Tollstile } from 'tollstile';
import { denialResponse, parseMcpBody, readToolResponse, type ToolCall } from './mcp';
import { canonicalPath, compileHttpRoute, matchHttpRoute, type HttpRoute, type ProxyRoute, type ToolRoute } from './routes';

/** Headers the upstream may set to report a variable amount and where it stored the result. Never forwarded to clients. */
export const FULFILL_AMOUNT_HEADER = 'tollstile-fulfill-amount';
export const RESULT_REF_HEADER = 'tollstile-result-ref';

/** Headers the proxy sets on upstream requests. Clients cannot send them: incoming `tollstile-*` headers are removed. */
export const PAYMENT_HEADERS = {
  via: 'tollstile-payment-via',
  payer: 'tollstile-payer',
  charge: 'tollstile-charge-id',
  amount: 'tollstile-amount',
} as const;

export type ProxyOptions<Rails extends readonly Rail[]> = {
  readonly toll: Tollstile<Rails>;
  /** Base URL of the service behind the proxy, e.g. `http://127.0.0.1:8000`. */
  readonly upstream: string;
  readonly routes: readonly ProxyRoute[];
  /** The upstream's MCP endpoint. Required when any route prices a tool. */
  readonly mcp?: { readonly path: string };
  /** What happens to requests no route prices. Defaults to `pass`: forwarded for free. */
  readonly unmatched?: 'pass' | 'deny';
  /** Resolves the caller for access policies such as `subscriber()` and `credits()`. */
  readonly principal?: (request: Request) => Principal | null | Promise<Principal | null>;
  /** Largest MCP request body inspected for tool calls. Larger bodies to the MCP endpoint are refused. Defaults to 10 MiB. */
  readonly maxMcpBodyBytes?: number;
  /** Gives up on the upstream after this long. Defaults to 60 seconds. */
  readonly upstreamTimeoutMs?: number;
  readonly fetch?: typeof fetch;
};

const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host'];

/**
 * A Web-standard handler that charges for the upstream's routes and tools, then forwards the paid
 * request unchanged. The upstream needs no Tollstile code; it only has to be reachable from the proxy
 * and nothing else.
 *
 * The outcome is decided when the upstream answers: a status below 400 (and, for tools, a result
 * without `isError`) succeeds and settles before the response reaches the client; anything else
 * releases the charge.
 */
export function createProxy<Rails extends readonly Rail[]>(options: ProxyOptions<Rails>): (request: Request) => Promise<Response> {
  const upstream = new URL(options.upstream);
  const fetchImpl = options.fetch ?? fetch;
  const maxMcpBodyBytes = options.maxMcpBodyBytes ?? 10 * 1024 * 1024;
  const timeoutMs = options.upstreamTimeoutMs ?? 60_000;

  const httpRoutes = options.routes.filter((route): route is HttpRoute => 'path' in route && !('tool' in route)).map(compileHttpRoute);
  const toolRoutes = new Map(
    options.routes
      .filter((route): route is ToolRoute => 'tool' in route)
      .map((route) => [route.tool, gateFor(options.toll, route, route.resource ?? `tool:${route.tool}`)] as const),
  );
  if (toolRoutes.size > 0 && options.mcp === undefined) {
    throw new TollstileError('CONFIG_INVALID', 'Tool routes need `mcp: { path }`, the upstream MCP endpoint whose tool calls are priced.');
  }
  const httpGates = new Map(httpRoutes.map((compiled) => [compiled, gateFor(options.toll, compiled.route, compiled.resource)] as const));

  const mcpPath = options.mcp === undefined ? undefined : canonicalPath(options.mcp.path)?.match;

  return async (incoming) => {
    const path = canonicalPath(new URL(incoming.url).pathname);
    if (path === undefined) return proxyError(400, 'invalid_path', 'The request path has malformed percent-encoding.');
    // From here on the request carries its canonical path: what is priced is exactly what is forwarded.
    const request = withPath(incoming, path.forward);
    const url = new URL(request.url);
    const principal = options.principal === undefined ? null : await options.principal(request);

    if (mcpPath !== undefined && path.match === mcpPath && request.method === 'POST' && toolRoutes.size > 0) {
      const length = Number(request.headers.get('content-length') ?? '0');
      if (length > maxMcpBodyBytes) return proxyError(413, 'mcp_body_too_large', `MCP request bodies over ${String(maxMcpBodyBytes)} bytes are refused.`);
      const text = await request.clone().text();
      if (new TextEncoder().encode(text).byteLength > maxMcpBodyBytes) {
        return proxyError(413, 'mcp_body_too_large', `MCP request bodies over ${String(maxMcpBodyBytes)} bytes are refused.`);
      }
      const body = parseMcpBody(text);
      if (body.kind === 'batch' && body.tools.some((tool) => toolRoutes.has(tool))) {
        return proxyError(400, 'mcp_batch_unsupported', 'Priced tools cannot be called inside a JSON-RPC batch. Send each tool call on its own.');
      }
      if (body.kind === 'tool-call') {
        const gate = toolRoutes.get(body.call.name);
        if (gate !== undefined) return forwardToolCall(gate, request, body.call, text, principal);
      }
      return (await forward(request, text)).response;
    }

    const matched = matchHttpRoute(httpRoutes, request.method, path.match);
    const gate = matched === undefined ? undefined : httpGates.get(matched);
    if (gate === undefined) {
      if (options.unmatched === 'deny') return proxyError(404, 'route_not_priced', 'This path is not served through the payment gateway.');
      return (await forward(request)).response;
    }

    const entry = await gate.enter({
      transport: 'http',
      request,
      mcp: null,
      principal,
      resource: gate.resource ?? `${request.method} ${url.pathname}`,
      requestId: crypto.randomUUID(),
      idempotencyKey: idempotencyKeyOf(request, null),
      extras: request,
    });
    if (entry.kind === 'denied') return toResponse(entry.denial);

    const { response, reached } = await forward(request, undefined, entry);
    if (!reached) {
      await entry.pass.complete('failed');
      return response;
    }
    const fulfilled = await fulfill(entry, response);
    const outcome = fulfilled && response.status < 400 ? 'succeeded' : 'failed';
    const completion = await entry.pass.complete(outcome);
    if (completion.denial !== null) {
      await response.body?.cancel();
      return toResponse(completion.denial);
    }
    return withReceipt(response, completion);
  };

  async function forwardToolCall(gate: Gate<Rails>, request: Request, call: ToolCall, text: string, principal: Principal | null): Promise<Response> {
    const entry = await gate.enter({
      transport: 'mcp',
      request,
      mcp: { tool: call.name, arguments: call.arguments, meta: call.meta, clientCapabilities: {} },
      principal,
      resource: gate.resource ?? `tool:${call.name}`,
      requestId: crypto.randomUUID(),
      idempotencyKey: idempotencyKeyOf(null, call.meta),
      extras: request,
    });
    if (entry.kind === 'denied') return denialResponse(call.id, entry.denial);

    const { response, reached } = await forward(request, text, entry);
    if (!reached) {
      await entry.pass.complete('failed');
      return response;
    }
    const contentType = response.headers.get('content-type') ?? '';
    const bodyText = await response.text();
    const tool = response.status < 400 ? readToolResponse(bodyText, contentType, call.id) : undefined;
    const fulfilled = await fulfill(entry, response);
    const completion = await entry.pass.complete(tool?.succeeded === true && fulfilled ? 'succeeded' : 'failed');

    const headers = responseHeaders(response);
    headers.delete('content-length');
    if (tool === undefined) return new Response(bodyText, { status: response.status, statusText: response.statusText, headers });
    const rewritten = completion.denial !== null ? tool.withDenial(completion.denial) : tool.withReceipt(completion.receipt);
    return new Response(rewritten, { status: response.status, statusText: response.statusText, headers });
  }

  /** Forwards to the upstream. A request that was admitted carries who paid; spoofed payment headers are removed. */
  async function forward(
    request: Request,
    bodyText?: string,
    entry?: Extract<Entry<Rails>, { kind: 'admitted' }>,
  ): Promise<{ readonly response: Response; readonly reached: boolean }> {
    const source = new URL(request.url);
    const target = new URL(`${source.pathname}${source.search}`, upstream);
    const headers = new Headers();
    for (const [name, value] of request.headers) {
      if (HOP_BY_HOP.includes(name) || name.startsWith('tollstile-')) continue;
      headers.append(name, value);
    }
    headers.set('x-forwarded-host', source.host);
    headers.set('x-forwarded-proto', source.protocol.replace(':', ''));
    if (entry !== undefined) {
      const { payment } = entry.pass;
      headers.set(PAYMENT_HEADERS.via, payment.via);
      headers.set(PAYMENT_HEADERS.payer, payment.via === 'rail' ? payment.payer : payment.account);
      if (payment.chargeId !== null) headers.set(PAYMENT_HEADERS.charge, payment.chargeId);
      headers.set(PAYMENT_HEADERS.amount, `${payment.amount.currency} ${payment.amount.micros.toString()}`);
    }
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const init: RequestInit & { duplex?: 'half' } = {
      method: request.method,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      ...(hasBody ? { body: bodyText ?? request.body, duplex: 'half' } : {}),
    };
    return fetchImpl(target, init).then(
      (response) => ({ response, reached: true }),
      // catch-reason: an unreachable upstream is an answer for the client (502) and a failed outcome
      // for the charge, not an exception that leaves the reservation hanging.
      (error: unknown) => ({
        response: proxyError(502, 'upstream_unavailable', `The upstream service did not answer: ${error instanceof Error ? error.message : String(error)}`, true),
        reached: false,
      }),
    );
  }
}

function withPath(request: Request, pathname: string): Request {
  const url = new URL(request.url);
  if (url.pathname === pathname) return request;
  url.pathname = pathname;
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  return new Request(url, { method: request.method, headers: request.headers, ...(hasBody ? { body: request.body, duplex: 'half' } : {}) });
}

function gateFor<Rails extends readonly Rail[]>(toll: Tollstile<Rails>, route: HttpRoute | ToolRoute, resource: string): Gate<Rails> {
  return toll.price(route.price, {
    resource,
    ...(route.access === undefined ? {} : { access: route.access }),
    ...(route.require === undefined ? {} : { require: route.require }),
    ...(route.flow === undefined ? {} : { flow: route.flow }),
    ...(route.commit === undefined ? {} : { commit: route.commit }),
  });
}

/** Reports a variable amount and result reference from the upstream. An invalid amount fails the request instead of charging it. */
async function fulfill<Rails extends readonly Rail[]>(entry: Extract<Entry<Rails>, { kind: 'admitted' }>, response: Response): Promise<boolean> {
  const amount = response.headers.get(FULFILL_AMOUNT_HEADER);
  const resultRef = response.headers.get(RESULT_REF_HEADER);
  if (amount === null && resultRef === null) return true;
  if (response.status >= 400) return true;
  return entry.pass.payment.fulfill({ ...(amount === null ? {} : { amount }), ...(resultRef === null ? {} : { resultRef }) }).then(
    () => true,
    // catch-reason: an upstream reporting an amount above the authorized maximum, or a malformed one,
    // must not be charged; the request completes as failed and the reservation is released.
    () => false,
  );
}

function withReceipt(response: Response, completion: Completion): Response {
  const headers = responseHeaders(response);
  for (const [name, value] of completion.receipt.headers) headers.append(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function responseHeaders(response: Response): Headers {
  const headers = new Headers();
  for (const [name, value] of response.headers) {
    // fetch() already decoded the body, so its original encoding and length no longer apply.
    if (HOP_BY_HOP.includes(name) || name === 'content-encoding' || name === 'content-length' || name === FULFILL_AMOUNT_HEADER || name === RESULT_REF_HEADER) continue;
    headers.append(name, value);
  }
  return headers;
}

function proxyError(status: number, code: string, message: string, retryable = false): Response {
  const action = retryable ? 'retry_later' : status === 400 || status === 413 ? 'fix_request' : 'stop';
  return Response.json({ error: { code, retryable, action, message, detail: null } }, { status, headers: { 'cache-control': 'no-store' } });
}
