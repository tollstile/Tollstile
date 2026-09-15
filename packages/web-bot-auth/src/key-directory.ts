import { readVerificationKey, type VerificationKey } from './verification-key';

// HTTP Message Signatures Directory discovery (draft-ietf-webbotauth-httpsig-protocol-00 §5.5) with
// the bounds §6.7 asks for, and the cache semantics of §6.10: a directory that resolves replaces
// what is cached; a failed fetch is not evidence and never evicts.

export const DIRECTORY_PATH = '/.well-known/http-message-signatures-directory';
const MEDIA_TYPE = 'application/http-message-signatures-directory+json';

const MAX_BYTES = 64 * 1024;
const MAX_KEYS = 32;
const MAX_DIRECTORIES = 1024;
/** Lower bound on a directory's cache lifetime, so `max-age=0` cannot turn every request into a fetch. */
const MIN_TTL_MS = 60_000;
/** How long a failed origin is not retried (Appendix C.5 caps negative entries at five minutes). */
const RETRY_AFTER_FAILURE_MS = 30_000;
/** How long past its expiry a cached directory keeps verifying while its origin is unreachable. */
const STALE_IF_ERROR_MS = 24 * 60 * 60 * 1000;

export type DirectoryLookup =
  | { readonly status: 'resolved'; readonly keys: ReadonlyMap<string, VerificationKey> }
  | { readonly status: 'unavailable' };

export type KeyDirectory = {
  /** Keys published by `origin`, from cache when fresh. `origin` must already be trusted. */
  lookup(origin: string, now: Date): Promise<DirectoryLookup>;
};

export type KeyDirectoryOptions = {
  readonly fetch: typeof fetch;
  readonly timeoutMs: number;
  readonly cacheTtlMs: number;
};

type Fetched = { readonly keys: ReadonlyMap<string, VerificationKey>; readonly ttlMs: number };

type Entry = {
  /** `null` for an origin that has never resolved. */
  readonly keys: ReadonlyMap<string, VerificationKey> | null;
  readonly expiresAt: number;
  readonly retryAt: number;
};

export function keyDirectory(options: KeyDirectoryOptions): KeyDirectory {
  const entries = new Map<string, Entry>();
  const inFlight = new Map<string, Promise<Fetched | undefined>>();

  const remember = (origin: string, entry: Entry) => {
    entries.delete(origin);
    if (entries.size >= MAX_DIRECTORIES) {
      const oldest = entries.keys().next();
      if (oldest.done !== true) entries.delete(oldest.value);
    }
    entries.set(origin, entry);
  };

  const cached = (entry: Entry | undefined, at: number): DirectoryLookup => {
    if (entry?.keys == null || at >= entry.expiresAt + STALE_IF_ERROR_MS) return { status: 'unavailable' };
    return { status: 'resolved', keys: entry.keys };
  };

  // Concurrent requests naming the same directory share one fetch (Appendix C.3).
  const fetchOnce = (origin: string): Promise<Fetched | undefined> => {
    const pending = inFlight.get(origin);
    if (pending !== undefined) return pending;
    const started = fetchDirectory(origin, options).finally(() => inFlight.delete(origin));
    inFlight.set(origin, started);
    return started;
  };

  return {
    async lookup(origin, now) {
      const at = now.getTime();
      const entry = entries.get(origin);
      if (entry?.keys != null && at < entry.expiresAt) return { status: 'resolved', keys: entry.keys };
      if (entry !== undefined && at < entry.retryAt) return cached(entry, at);

      const fetched = await fetchOnce(origin);
      if (fetched === undefined) {
        remember(origin, { keys: entry?.keys ?? null, expiresAt: entry?.expiresAt ?? at, retryAt: at + RETRY_AFTER_FAILURE_MS });
        return cached(entry, at);
      }
      remember(origin, { keys: fetched.keys, expiresAt: at + Math.min(options.cacheTtlMs, fetched.ttlMs), retryAt: 0 });
      return { status: 'resolved', keys: fetched.keys };
    },
  };
}

async function fetchDirectory(origin: string, options: KeyDirectoryOptions): Promise<Fetched | undefined> {
  const response = await readBounded(`${origin}${DIRECTORY_PATH}`, options);
  if (response === undefined) return undefined;

  const document = parseJson(response.body);
  if (typeof document !== 'object' || document === null || !('keys' in document) || !Array.isArray(document.keys)) return undefined;
  const entries: readonly unknown[] = document.keys;
  if (entries.length > MAX_KEYS) return undefined;

  const keys = new Map<string, VerificationKey>();
  for (const entry of entries) {
    const key = await readVerificationKey(entry);
    if (key !== undefined) keys.set(key.thumbprint, key);
  }
  return { keys, ttlMs: Math.max(MIN_TTL_MS, maxAgeMs(response.cacheControl) ?? Number.POSITIVE_INFINITY) };
}

/**
 * GETs `url` without following redirects, accepting only 200 and at most MAX_BYTES within the
 * timeout. `undefined` is a discovery failure: not evidence about the signer (§6.10).
 */
async function readBounded(
  url: string,
  options: KeyDirectoryOptions,
): Promise<{ readonly body: string; readonly cacheControl: string | null } | undefined> {
  // catch-reason: DNS, TLS, connection, and timeout failures surface as rejections from fetch and the
  // body stream; each is a discovery failure, which the caller reports as an unverified request.
  try {
    const response = await options.fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: MEDIA_TYPE },
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (response.status !== 200 || response.body === null) {
      await response.body?.cancel();
      return undefined;
    }
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > MAX_BYTES) {
      await response.body.cancel();
      return undefined;
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return { body: new TextDecoder().decode(bytes), cacheControl: response.headers.get('cache-control') };
  } catch {
    return undefined;
  }
}

function maxAgeMs(cacheControl: string | null): number | undefined {
  if (cacheControl === null) return undefined;
  if (/(?:^|,)\s*(?:no-store|no-cache)\s*(?:,|$)/i.test(cacheControl)) return 0;
  const match = /(?:^|,)\s*max-age\s*=\s*(\d+)\s*(?:,|$)/i.exec(cacheControl);
  return match?.[1] === undefined ? undefined : Number(match[1]) * 1000;
}

function parseJson(text: string): unknown {
  // catch-reason: JSON.parse reports malformed input by throwing; a malformed directory is a discovery failure.
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
