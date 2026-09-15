import { isProviderFailure, TollstileError } from './errors';
import type { Operation } from './types';

export type ProviderCall<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: TollstileError };

/**
 * The single place core catches provider failures. An unknown outcome must become a recorded
 * state, not an exception that unwinds the request. Anything else is rethrown.
 */
export async function callProvider<T>(
  key: string,
  timeoutMs: number,
  run: (operation: Operation) => Promise<T>,
): Promise<ProviderCall<T>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TollstileError('PROVIDER_TIMEOUT', `Provider did not answer within ${timeoutMs}ms for "${key}".`));
    }, timeoutMs);
  });

  // eslint-disable-next-line no-restricted-syntax -- catch-reason: unknown provider outcomes become recorded states (CODING_RULES §2.3).
  try {
    const value = await Promise.race([run({ key, signal: controller.signal }), timeout]);
    return { ok: true, value };
  } catch (error) {
    if (isProviderFailure(error)) return { ok: false, error };
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
