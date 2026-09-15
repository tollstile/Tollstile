import type { Clock, Context, Json, JsonObject, Principal } from '../core/types';

export type FakeClock = Clock & { advance(ms: number): void };

export function fakeClock(start: Date = new Date('2026-01-01T00:00:00.000Z')): FakeClock {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance(ms) {
      current += ms;
    },
  };
}

/** A Context for an HTTP request, as an adapter would build it. */
export function httpContext(
  request: Request,
  options: { readonly resource?: string; readonly principal?: Principal; readonly requestId?: string } = {},
): Context {
  return {
    transport: 'http',
    request,
    mcp: null,
    principal: options.principal ?? null,
    resource: options.resource ?? `${request.method} ${new URL(request.url).pathname}`,
    requestId: options.requestId ?? crypto.randomUUID(),
    extras: null,
  };
}

/** A Context for an MCP tool call, as the MCP adapter would build it. */
export function mcpContext(
  tool: string,
  meta: JsonObject,
  options: {
    readonly arguments?: Json;
    readonly principal?: Principal;
    readonly clientCapabilities?: JsonObject;
    readonly requestId?: string;
  } = {},
): Context {
  return {
    transport: 'mcp',
    request: null,
    mcp: { tool, arguments: options.arguments ?? null, meta, clientCapabilities: options.clientCapabilities ?? {} },
    principal: options.principal ?? null,
    resource: `tool:${tool}`,
    requestId: options.requestId ?? crypto.randomUUID(),
    extras: null,
  };
}
