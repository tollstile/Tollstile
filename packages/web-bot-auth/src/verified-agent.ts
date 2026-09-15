import { TollstileError, type Requirement } from 'tollstile';
import { httpsOrigin, verifyAgentSignature, type KeyResolution, type SignatureAgent } from './agent-signature';
import { keyDirectory } from './key-directory';

export type VerifiedAgentOptions = {
  /**
   * Signature-Agent origins you accept, e.g. `["https://agent.example"]`, or a predicate over the
   * origin. Directories of other origins are never fetched.
   */
  readonly trust: readonly string[] | ((origin: string) => boolean);
  /** Oldest `created` accepted, in milliseconds. Defaults to 5 minutes. */
  readonly maxAgeMs?: number;
  /** Tolerated clock difference with signers, in milliseconds. Defaults to 5 seconds. */
  readonly clockSkewMs?: number;
  /** Reject signatures without a `nonce`. Nonces that are present are always single-use. Defaults to `false`. */
  readonly requireNonce?: boolean;
  /** Longest a fetched directory is reused, in milliseconds; a shorter `Cache-Control: max-age` wins. Defaults to 1 hour. */
  readonly cacheTtlMs?: number;
  /** Upper bound for one directory fetch, in milliseconds. Defaults to 3 seconds. */
  readonly timeoutMs?: number;
  /** Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
};

/** Thumbprints of the RFC 9421 Appendix B.1 test keys, which verifiers SHOULD reject (draft §6.8). */
const TEST_KEYS = new Set([
  'poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U',
  'oD0HwocPBSfpNy5W3bpJeyFGY_IQ_YpqxSjQ3Yd-CLA',
  'ydQXMtvbsOsZyFir-Y7A8t7fKEM1gbKPvyFkdpu4fvI',
]);

const NONCE_SCOPE = 'web-bot-auth';

/**
 * Admits only requests signed by a trusted agent under Web Bot Auth (RFC 9421 HTTP message
 * signatures, draft-ietf-webbotauth-httpsig-protocol-00). Keys come from the agent's
 * `/.well-known/http-message-signatures-directory`. Denies with 403 and a reason such as
 * `signature_missing`, `signature_invalid`, `agent_untrusted`, or `key_not_found`.
 *
 * @example
 * ```ts
 * import { verifiedAgent } from "@tollstile/web-bot-auth";
 *
 * app.get("/data", tollstile(toll.price("$0.01", {
 *   require: [verifiedAgent({ trust: ["https://agent.example"] })],
 * })), handler);
 * ```
 */
export function verifiedAgent(options: VerifiedAgentOptions): Requirement {
  const trusted = trustPredicate(options.trust);
  const maxAgeMs = duration('maxAgeMs', options.maxAgeMs, 300_000);
  const clockSkewMs = duration('clockSkewMs', options.clockSkewMs, 5_000, true);
  const directory = keyDirectory({
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    timeoutMs: duration('timeoutMs', options.timeoutMs, 3_000),
    cacheTtlMs: duration('cacheTtlMs', options.cacheTtlMs, 3_600_000),
  });

  const resolveKey = async (agent: SignatureAgent, keyid: string, now: Date): Promise<KeyResolution> => {
    if (!trusted(agent.origin)) return { status: 'rejected', reason: 'agent_untrusted' };
    const lookup = await directory.lookup(agent.origin, now);
    if (lookup.status === 'unavailable') return { status: 'rejected', reason: 'directory_unavailable' };
    const key = lookup.keys.get(keyid);
    if (key === undefined || TEST_KEYS.has(key.thumbprint)) return { status: 'rejected', reason: 'key_not_found' };
    return { status: 'found', key };
  };

  return {
    name: 'verified-agent',
    async check({ context, claims, now }) {
      // An MCP call's context describes the JSON-RPC message, not the HTTP request an agent signed.
      if (context.transport !== 'http' || context.request === null) return deny('http_request_required');

      const verification = await verifyAgentSignature(context.request, {
        now,
        maxAgeMs,
        clockSkewMs,
        requireNonce: options.requireNonce ?? false,
        resolveKey: (agent, keyid) => resolveKey(agent, keyid, now),
      });
      if (verification.status === 'rejected') return deny(verification.reason);

      if (verification.nonce !== undefined) {
        const key = `${verification.agent.directory} ${verification.keyid} ${verification.nonce}`;
        const claimed = await claims.claim(NONCE_SCOPE, key, new Date(verification.acceptableUntil * 1000));
        if (claimed === 'exists') return deny('nonce_replayed');
      }
      return { ok: true };
    },
  };
}

function trustPredicate(trust: VerifiedAgentOptions['trust']): (origin: string) => boolean {
  if (typeof trust === 'function') return trust;
  const origins = new Set(
    trust.map((entry) => {
      const origin = httpsOrigin(entry);
      if (origin === undefined) {
        throw new TollstileError(
          'CONFIG_INVALID',
          `verifiedAgent() trust entry "${entry}" is not an HTTPS origin. Use the lowercase origin only, e.g. "https://agent.example".`,
        );
      }
      return origin;
    }),
  );
  if (origins.size === 0) {
    throw new TollstileError('CONFIG_INVALID', 'verifiedAgent() needs at least one trusted origin, or a trust predicate.');
  }
  return (origin) => origins.has(origin);
}

function duration(name: string, value: number | undefined, fallback: number, allowZero = false): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || (value === 0 && !allowZero)) {
    throw new TollstileError('CONFIG_INVALID', `verifiedAgent() ${name} must be a positive integer number of milliseconds, got ${String(value)}.`);
  }
  return value;
}

function deny(reason: string) {
  return { ok: false, status: 403, reason } as const;
}
