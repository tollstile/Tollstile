import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

/** Serves a Web-standard handler, such as `createProxy()`, on Node's HTTP server. */
export function serve(handler: (request: Request) => Promise<Response>, options: { readonly port: number; readonly hostname?: string }): Promise<Server> {
  const server = createServer((req, res) => {
    void respond(handler, req, res);
  });
  return new Promise((resolve) => {
    server.listen(options.port, options.hostname ?? '0.0.0.0', () => {
      resolve(server);
    });
  });
}

async function respond(handler: (request: Request) => Promise<Response>, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const headers = new Headers();
  for (const [name, values] of Object.entries(req.headersDistinct)) {
    for (const value of values ?? []) headers.append(name, value);
  }
  const url = `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`;
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const request = new Request(url, {
    method: req.method,
    headers,
    ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream, duplex: 'half' } : {}),
  } as RequestInit);

  const response = await handler(request).then(undefined, (error: unknown) => {
    // catch-reason: the process must keep serving other requests; the failure is logged and answered with 500.
    console.error(error);
    return Response.json({ error: { code: 'proxy_error', retryable: true, action: 'retry_later', message: 'The payment gateway failed.', detail: null } }, { status: 500 });
  });
  res.statusCode = response.status;
  res.statusMessage = response.statusText;
  for (const [name, value] of response.headers) res.appendHeader(name, value);
  if (response.body === null) {
    res.end();
    return;
  }
  Readable.fromWeb(response.body as NodeReadableStream).pipe(res);
}
