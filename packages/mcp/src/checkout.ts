import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { ElicitResultSchema, UrlElicitationRequiredError, type CallToolResult, type ServerNotification, type ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { TollstileError, type Denial } from 'tollstile';

/** Where a person goes to pay, and what the client tells them before sending them there. */
export type Checkout = {
  /** An `http:` or `https:` page: your top-up page, a hosted checkout, a subscription page. */
  readonly url: string;
  /** Shown by the client with the link. Defaults to the denial's own message. */
  readonly message?: string;
};

/**
 * Sends the person at the client to a page where they can pay, instead of answering a denial the
 * agent cannot act on. The call is not charged and does not run; they pay, then call again.
 *
 * @example
 * ```ts
 * paidTool(server, 'forecast', {}, toll.price('$0.01'), handler, {
 *   principal,
 *   checkout: () => ({ url: 'https://weather.example/credits', message: 'Add credit to keep calling.' }),
 * });
 * ```
 */
export type CheckoutResolver = (denial: Denial) => Checkout | null | Promise<Checkout | null>;

/** Where a denial carries the page, for clients that cannot open one themselves. */
export const CHECKOUT_META = 'tollstile/checkout';

/**
 * The page, said out loud. A client that cannot open one usually does not render `_meta` either, so
 * a person there is told the tool failed and never sees the link. Putting it in the content the
 * model reads is the only way through such a client: the model can repeat it to them.
 *
 * The denial body keeps its own block, after this one, and `_meta` still carries it in full.
 */
export function withCheckout(result: CallToolResult, checkout: Checkout): CallToolResult {
  const message = checkout.message ?? 'Payment is required to continue.';
  return {
    ...result,
    content: [{ type: 'text', text: `${message}\n${checkout.url}` }, ...result.content],
    _meta: { ...result._meta, [CHECKOUT_META]: { url: checkout.url, ...(checkout.message === undefined ? {} : { message: checkout.message }) } },
  };
}

/**
 * MCP's URL elicitation: the client shows the person a link and stops, rather than handing the
 * model an error. Only clients that declared `capabilities.elicitation.url` are sent one.
 */
export function urlElicitation(checkout: Checkout): UrlElicitationRequiredError {
  return new UrlElicitationRequiredError([
    { mode: 'url', message: checkout.message ?? 'Payment is required to continue.', elicitationId: crypto.randomUUID(), url: checkout.url },
  ]);
}

/**
 * The page, as a question a client that cannot open one can still put on screen. Clients that
 * declare only `form` — the common case — show the message and wait, which is the difference
 * between a person seeing an address and a model being asked to recite one.
 *
 * The answer is not used: whatever they press, the call was not paid for and the denial stands.
 */
export async function showCheckout(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  checkout: Checkout,
): Promise<void> {
  const message = checkout.message ?? 'Payment is required to continue.';
  await extra.sendRequest(
    { method: 'elicitation/create', params: { mode: 'form', message: `${message}\n\n${checkout.url}`, requestedSchema: { type: 'object' as const, properties: {} } } },
    ElicitResultSchema,
    { signal: extra.signal },
  );
}

/** A page a client will open must be one a browser can open, and one this server meant to send. */
export function checkUrl(url: string, tool: string): void {
  const parsed = URL.parse(url);
  if (parsed === null || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
    throw new TollstileError('CONFIG_INVALID', `checkout for tool "${tool}" returned "${url}": use an http or https URL.`);
  }
}
