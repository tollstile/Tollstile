import type { Denial, Json, JsonObject, Receipt } from 'tollstile';

/** Where every denial rendered as a tool result carries Tollstile's denial body, as `@tollstile/mcp` does. */
export const DENIAL_META = 'tollstile/payment-required';

export type ToolCall = {
  readonly id: string | number;
  readonly name: string;
  readonly arguments: Json;
  readonly meta: JsonObject;
};

export type McpBody =
  | { readonly kind: 'tool-call'; readonly call: ToolCall }
  /** A JSON-RPC batch. Priced tools inside one could not be charged one by one, so batches naming them are refused. */
  | { readonly kind: 'batch'; readonly tools: readonly string[] }
  | { readonly kind: 'other' };

/** Reads an MCP request body without trusting its shape. Anything that is not a JSON-RPC `tools/call` is `other`. */
export function parseMcpBody(text: string): McpBody {
  const parsed = parseJson(text);
  if (Array.isArray(parsed)) {
    return { kind: 'batch', tools: parsed.flatMap((message) => (isObject(message) && message.method === 'tools/call' && isObject(message.params) && typeof message.params.name === 'string' ? [message.params.name] : [])) };
  }
  if (!isObject(parsed) || parsed.method !== 'tools/call' || !isObject(parsed.params)) return { kind: 'other' };
  const { id } = parsed;
  const { name, arguments: args, _meta: meta } = parsed.params;
  if ((typeof id !== 'string' && typeof id !== 'number') || typeof name !== 'string') return { kind: 'other' };
  return { kind: 'tool-call', call: { id, name, arguments: args ?? null, meta: isObject(meta) ? meta : {} } };
}

/**
 * A denial as a tool result, the way `@tollstile/mcp` renders it for clients without MPP's JSON-RPC
 * error: x402's payment-required result when a rail offers it, otherwise Tollstile's body.
 */
export function denialResponse(id: string | number, denial: Denial): Response {
  const meta = { [DENIAL_META]: denial.body };
  const x402 = denial.offers.map((offer) => offer.challenge.mcp).find((mcp) => mcp.style === 'x402' && isObject(mcp.paymentRequired));
  const reason = denial.error.code === 'payment_required' ? undefined : (denial.error.detail ?? denial.error.code);
  const result: JsonObject =
    x402 !== undefined && isObject(x402.paymentRequired)
      ? (() => {
          const paymentRequired = reason === undefined ? x402.paymentRequired : { ...x402.paymentRequired, error: reason };
          return { isError: true, structuredContent: paymentRequired, content: [{ type: 'text', text: JSON.stringify(paymentRequired) }], _meta: meta };
        })()
      : { isError: true, content: [{ type: 'text', text: JSON.stringify(denial.body) }], _meta: meta };
  return Response.json({ jsonrpc: '2.0', id, result }, { headers: { 'cache-control': 'no-store' } });
}

/** The upstream's answer to one tool call, located in a JSON or SSE response body. */
export type ToolResponse = {
  /** Whether the tool succeeded: a result without `isError`. */
  readonly succeeded: boolean;
  /** Rebuilds the response body with the receipt merged into the result's `_meta`. */
  withReceipt(receipt: Receipt): string;
  /** Rebuilds the response body with the result replaced by a denial. */
  withDenial(denial: Denial): string;
};

/**
 * Finds the JSON-RPC response for `id` in the upstream body. Streamable HTTP servers answer with
 * either `application/json` or a `text/event-stream` whose events carry JSON-RPC messages.
 */
export function readToolResponse(body: string, contentType: string, id: string | number): ToolResponse | undefined {
  if (contentType.includes('text/event-stream')) {
    const events = body.split(/\r?\n\r?\n/);
    for (const [index, event] of events.entries()) {
      const lines = event.split(/\r?\n/);
      const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      const message = parseJson(data);
      if (!isObject(message) || message.id !== id || !('result' in message || 'error' in message)) continue;
      const rebuild = (next: JsonObject) => {
        const kept = lines.filter((line) => !line.startsWith('data:'));
        const replaced = [...kept, `data: ${JSON.stringify(next)}`].join('\n');
        return events.map((original, i) => (i === index ? replaced : original)).join('\n\n');
      };
      return toolResponse(message, rebuild);
    }
    return undefined;
  }
  const message = parseJson(body);
  if (!isObject(message) || message.id !== id) return undefined;
  return toolResponse(message, (next) => JSON.stringify(next));
}

function toolResponse(message: JsonObject, rebuild: (next: JsonObject) => string): ToolResponse {
  const result = isObject(message.result) ? message.result : undefined;
  return {
    succeeded: result !== undefined && result.isError !== true,
    withReceipt(receipt) {
      if (result === undefined || Object.keys(receipt.meta).length === 0) return rebuild(message);
      const meta = isObject(result._meta) ? result._meta : {};
      return rebuild({ ...message, result: { ...result, _meta: { ...meta, ...receipt.meta } } });
    },
    withDenial(denial) {
      return rebuild({ jsonrpc: '2.0', id: message.id ?? null, result: denialResult(denial) });
    },
  };
}

function denialResult(denial: Denial): JsonObject {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(denial.body) }], _meta: { [DENIAL_META]: denial.body } };
}

function parseJson(text: string): Json | undefined {
  // catch-reason: request and response bodies are untrusted text; malformed JSON is an expected outcome.
  try {
    return JSON.parse(text) as Json;
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
