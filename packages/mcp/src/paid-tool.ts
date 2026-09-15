import type { McpServer, RegisteredTool, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  normalizeObjectSchema,
  safeParseAsync,
  type AnySchema,
  type SchemaOutput,
  type ShapeOutput,
  type ZodRawShapeCompat,
} from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { CallToolResult, RequestInfo, ServerNotification, ServerRequest, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { idempotencyKeyOf, type Gate, type JsonObject, type Payment, type Principal, type Rail } from 'tollstile';
import { isJsonObject, parseJsonObject, parseJsonValue } from './json-object';
import { DENIAL_META, renderDenial } from './render-denial';

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

type ToolSchema = ZodRawShapeCompat | AnySchema;

/** The config `McpServer.registerTool` accepts. */
export type PaidToolConfig<InputArgs extends undefined | ToolSchema, OutputArgs extends ToolSchema> = {
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema?: InputArgs;
  readonly outputSchema?: OutputArgs;
  readonly annotations?: ToolAnnotations;
  readonly _meta?: Record<string, unknown>;
};

export type PaidToolOptions = {
  /** Resolves the authenticated caller, for access policies such as `subscriber()` and `credits()`. */
  readonly principal?: (extra: ToolExtra) => Principal | null | Promise<Principal | null>;
};

/** The SDK's request context for the tool call, plus the payment that admitted it. */
export type PaidToolExtra<Rails extends readonly Rail[]> = ToolExtra & { readonly payment: Payment<Rails> };

/** Validated arguments when the tool has an `inputSchema`, otherwise `undefined`. */
export type PaidToolArgs<InputArgs extends undefined | ToolSchema> = InputArgs extends ZodRawShapeCompat
  ? ShapeOutput<InputArgs>
  : InputArgs extends AnySchema
    ? SchemaOutput<InputArgs>
    : undefined;

export type PaidToolHandler<Rails extends readonly Rail[], InputArgs extends undefined | ToolSchema> = (
  args: PaidToolArgs<InputArgs>,
  extra: PaidToolExtra<Rails>,
) => CallToolResult | Promise<CallToolResult>;

/**
 * Registers an MCP tool that runs only after `gate` admits the call. The call succeeds when the
 * handler returns a result without `isError` that matches `outputSchema`, if one is set; otherwise
 * the reservation is released and nothing is charged. Receipts are merged into `result._meta`.
 *
 * Denials are rendered for the client: MPP's JSON-RPC error `-32042` when the client declared
 * `capabilities.experimental.payment` and a rail offers MPP, otherwise x402's payment-required
 * tool result when a rail offers x402, otherwise an `isError` result with Tollstile's denial body.
 * Every denial rendered as a tool result carries that body in `_meta["tollstile/payment-required"]`.
 *
 * @example
 * ```ts
 * const toll = createTollstile({ rails: [testRail()], ledger: memoryLedger() });
 * const server = new McpServer({ name: 'weather', version: '1.0.0' });
 *
 * paidTool(server, 'forecast', { description: 'Tomorrow in one word' }, toll.price('$0.01'), (_args, { payment }) => ({
 *   content: [{ type: 'text', text: `clear (paid via ${payment.via})` }],
 * }));
 * ```
 */
export function paidTool<
  Rails extends readonly Rail[],
  InputArgs extends undefined | ToolSchema = undefined,
  OutputArgs extends ToolSchema = ZodRawShapeCompat,
>(
  server: McpServer,
  name: string,
  config: PaidToolConfig<InputArgs, OutputArgs>,
  gate: Gate<Rails>,
  handler: PaidToolHandler<Rails, InputArgs>,
  options: PaidToolOptions = {},
): RegisteredTool {
  const call = async (args: unknown, extra: ToolExtra): Promise<CallToolResult> => {
    const meta = parseJsonObject(extra._meta);
    if (meta === undefined) return invalidRequest('meta_not_json');
    const clientCapabilities = parseJsonObject(server.server.getClientCapabilities());
    if (clientCapabilities === undefined) return invalidRequest('client_capabilities_not_json');
    const toolArguments = parseJsonValue(args);
    if (toolArguments === undefined) return invalidRequest('arguments_not_json');

    const entry = await gate.enter({
      transport: 'mcp',
      request: httpRequest(extra.requestInfo),
      mcp: { tool: name, arguments: toolArguments, meta, clientCapabilities },
      principal: options.principal === undefined ? null : await options.principal(extra),
      resource: gate.resource ?? `tool:${name}`,
      requestId: crypto.randomUUID(),
      idempotencyKey: idempotencyKeyOf(null, meta),
      extras: extra,
    });

    if (entry.kind === 'denied') {
      const rendering = renderDenial(entry.denial, acceptsMpp(clientCapabilities));
      if (rendering.kind === 'error') throw rendering.error;
      return rendering.result;
    }

    const { pass } = entry;
    let result: CallToolResult;
    // catch-reason: the adapter entry point records a thrown handler as a failed outcome, so the
    // reservation is released, then lets the SDK render the error as it would for an unpaid tool.
    try {
      // McpServer validated `args` against `config.inputSchema` before calling back.
      result = await handler(args as PaidToolArgs<InputArgs>, { ...extra, payment: pass.payment });
    } catch (error) {
      await pass.complete('failed');
      throw error;
    }

    const { receipt, denial } = await pass.complete((await succeeded(result, registered.outputSchema)) ? 'succeeded' : 'failed');
    if (denial !== null) {
      // Settlement was rejected: the payer does not get the output, only a fresh challenge.
      const rendering = renderDenial(denial, acceptsMpp(clientCapabilities));
      if (rendering.kind === 'error') throw rendering.error;
      return rendering.result;
    }
    if (Object.keys(receipt.meta).length === 0) return result;
    return { ...result, _meta: { ...result._meta, ...receipt.meta } };
  };

  // McpServer calls `(args, extra)` for tools with an inputSchema and `(extra)` for tools without,
  // and types the callback by the same condition, which TypeScript cannot follow through a generic.
  const callback =
    config.inputSchema === undefined ? (extra: ToolExtra) => call(undefined, extra) : (args: unknown, extra: ToolExtra) => call(args, extra);
  const registered = server.registerTool(name, config, callback as ToolCallback<InputArgs>);
  return registered;
}

/**
 * McpServer validates the output against `outputSchema` only after the callback returns, and turns
 * a mismatch into an `isError` result. The same check runs first, so that result is not charged.
 */
async function succeeded(result: CallToolResult, outputSchema: AnySchema | undefined): Promise<boolean> {
  if (result.isError === true) return false;
  if (outputSchema === undefined) return true;
  const objectSchema = normalizeObjectSchema(outputSchema);
  if (result.structuredContent === undefined || objectSchema === undefined) return false;
  return (await safeParseAsync(objectSchema, result.structuredContent)).success;
}

/** MPP's JSON-RPC error is only for clients that said they can pay with it. */
function acceptsMpp(clientCapabilities: JsonObject): boolean {
  const { experimental } = clientCapabilities;
  return experimental !== undefined && isJsonObject(experimental) && experimental.payment !== undefined;
}

function invalidRequest(detail: string): CallToolResult {
  const body = {
    error: { code: 'invalid_request', retryable: false, action: 'fix_request', message: 'The tool call envelope is not plain JSON.', detail },
  };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(body) }], _meta: { [DENIAL_META]: body } };
}

/**
 * Streamable HTTP and SSE transports expose the URL and headers of the HTTP POST that delivered the
 * call, not the request itself, and its body was already consumed as the JSON-RPC message. The
 * Request is rebuilt from those, without a body. stdio and in-memory transports have no HTTP carrier.
 */
function httpRequest(info: RequestInfo | undefined): Request | null {
  if (info?.url === undefined) return null;
  const headers = new Headers();
  for (const [header, value] of Object.entries(info.headers)) {
    // HTTP/2 pseudo-headers (`:authority`) are not header fields and `Headers` refuses them.
    if (value === undefined || header.startsWith(':')) continue;
    for (const item of typeof value === 'string' ? [value] : value) headers.append(header, item);
  }
  return new Request(info.url, { method: 'POST', headers });
}
