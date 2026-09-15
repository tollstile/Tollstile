import { TollstileError, type Json } from 'tollstile';
import { parseJson } from './wire';

export type ProviderResponse = {
  readonly status: number;
  /** `undefined` when the body is not JSON, e.g. an HTML error page. */
  readonly body: Json | undefined;
};

export type ProviderRequest = {
  readonly method: 'GET' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
};

/**
 * The single place this rail catches: a failed `fetch` becomes a provider failure that core records.
 * Messages name the operation only; URLs, tokens, and API keys stay out of errors.
 */
export async function providerRequest(
  fetchImpl: typeof fetch,
  url: string,
  request: ProviderRequest,
  signal: AbortSignal,
  operation: string,
): Promise<ProviderResponse> {
  // catch-reason: an unreachable or aborted provider is converted into PROVIDER_UNAVAILABLE / PROVIDER_TIMEOUT (CODING_RULES §2.3).
  try {
    const response = await fetchImpl(url, { ...request, signal });
    const text = await response.text();
    return { status: response.status, body: parseJson(text) };
  } catch (error) {
    if (signal.aborted) {
      throw new TollstileError('PROVIDER_TIMEOUT', `KYAPay provider did not answer in time during ${operation}.`, { cause: error });
    }
    throw new TollstileError('PROVIDER_UNAVAILABLE', `KYAPay provider could not be reached during ${operation}.`, { cause: error });
  }
}
