import { UrlElicitationRequiredError } from '@modelcontextprotocol/sdk/types.js';
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
 * MCP's URL elicitation: the client shows the person a link and stops, rather than handing the
 * model an error. Only clients that declared `capabilities.elicitation.url` are sent one.
 */
export function urlElicitation(checkout: Checkout): UrlElicitationRequiredError {
  return new UrlElicitationRequiredError([
    { mode: 'url', message: checkout.message ?? 'Payment is required to continue.', elicitationId: crypto.randomUUID(), url: checkout.url },
  ]);
}

/** A page a client will open must be one a browser can open, and one this server meant to send. */
export function checkUrl(url: string, tool: string): void {
  const parsed = URL.parse(url);
  if (parsed === null || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
    throw new TollstileError('CONFIG_INVALID', `checkout for tool "${tool}" returned "${url}": use an http or https URL.`);
  }
}
