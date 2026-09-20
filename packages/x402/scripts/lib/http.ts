import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A local HTTP server for the run: the paid routes, and the facilitator proxy that breaks `/settle`. */

export type Served = {
  readonly url: string;
  close(): Promise<void>;
};

export async function serve(handler: (request: Request) => Promise<Response>): Promise<Served> {
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      try {
        await respond(outgoing, await handler(await toRequest(incoming)));
      } catch (error) {
        await respond(outgoing, new Response(`harness: ${String(error)}`, { status: 500 }));
      }
    })();
  });
  return listen(server);
}

export type ProxyMode =
  | { readonly settle: 'forward-then-fail' }
  | { readonly settle: 'drop' };

export type FacilitatorProxy = Served & {
  /** How many `/settle` requests actually reached the facilitator. */
  readonly forwarded: () => number;
};

/**
 * Stands in for the facilitator so a settlement can be made ambiguous on purpose.
 *
 * `forward-then-fail` settles for real and then loses the answer, which is the case reconciliation
 * exists for. `drop` never forwards, so the authorization simply expires.
 */
export async function proxyFacilitator(upstream: string, mode: ProxyMode): Promise<FacilitatorProxy> {
  let forwarded = 0;
  const served = await serve(async (request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith('/settle')) {
      if (mode.settle === 'drop') return new Response(JSON.stringify({ error: 'harness dropped this request' }), { status: 504, headers: { 'content-type': 'application/json' } });
      forwarded += 1;
      await forward(upstream, path, request);
      return new Response(JSON.stringify({ error: 'harness lost this response' }), { status: 504, headers: { 'content-type': 'application/json' } });
    }
    return forward(upstream, path, request);
  });
  return { ...served, forwarded: () => forwarded };
}

async function forward(upstream: string, path: string, request: Request): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.delete('host');
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text();
  const response = await fetch(new URL(path, upstream), { method: request.method, headers, ...(body === undefined ? {} : { body }) });
  return new Response(await response.text(), { status: response.status, headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' } });
}

async function listen(server: Server): Promise<Served> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === 'string') throw new Error('The harness server did not get a port.');
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

async function toRequest(incoming: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (typeof value === 'string') headers.set(name, value);
    else if (Array.isArray(value)) for (const one of value) headers.append(name, one);
  }
  const method = incoming.method ?? 'GET';
  return new Request(new URL(incoming.url ?? '/', `http://127.0.0.1`), {
    method,
    headers,
    ...(method === 'GET' || method === 'HEAD' || body.length === 0 ? {} : { body }),
  });
}

async function respond(outgoing: ServerResponse, response: Response): Promise<void> {
  const body = Buffer.from(await response.arrayBuffer());
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  outgoing.writeHead(response.status, headers);
  outgoing.end(body);
}
