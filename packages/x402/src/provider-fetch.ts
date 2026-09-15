import { TollstileError, type Json } from 'tollstile';
import { parseJson } from './wire';

export type Fetch = typeof fetch;

/** `body` is `undefined` when the provider answered with something that is not JSON. */
export type JsonReply = { readonly status: number; readonly body: Json | undefined };

/**
 * The boundary where a failed HTTP exchange with the facilitator or a JSON-RPC node becomes a
 * provider failure. `label` names the provider in errors; URLs are left out because RPC URLs
 * often embed API keys.
 */
export async function postJson(
  fetcher: Fetch,
  request: {
    readonly url: string;
    readonly body: Json;
    readonly headers: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
    readonly label: string;
  },
): Promise<JsonReply> {
  let status: number;
  let text: string;
  // catch-reason: fetch rejects on network failure and abort; both are provider outcomes that core
  // records (CODING_RULES §2.3), not bugs.
  try {
    const response = await fetcher(request.url, {
      method: 'POST',
      headers: { ...request.headers, 'content-type': 'application/json' },
      body: JSON.stringify(request.body),
      signal: request.signal,
    });
    status = response.status;
    text = await response.text();
  } catch (error) {
    if (request.signal.aborted) {
      throw new TollstileError('PROVIDER_TIMEOUT', `${request.label} did not answer in time.`, { cause: error });
    }
    throw new TollstileError('PROVIDER_UNAVAILABLE', `${request.label} could not be reached.`, { cause: error });
  }

  const parsed = parseJson(text);
  return { status, body: parsed.ok ? parsed.value : undefined };
}
