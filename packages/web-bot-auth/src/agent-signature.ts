import { readSignatures, signatureBase, type SignatureInput } from './http-signature';
import { DIRECTORY_PATH } from './key-directory';
import { parseDictionary, parseItem, type Item } from './structured-fields';
import { agreedAlgorithm, verifySignature, type VerificationKey } from './verification-key';

// The Web Bot Auth profile of RFC 9421 (draft-ietf-webbotauth-httpsig-protocol-00 §5.2): which
// signatures count, what they must cover, and which Signature-Agent member they speak for.

export const WEB_BOT_AUTH_TAG = 'web-bot-auth';

/** A Signature-Agent member the signature covers. Until its directory resolves, it is only a claim. */
export type SignatureAgent = {
  /** ASCII serialization of the origin, e.g. `https://agent.example`. */
  readonly origin: string;
  /** The identifier the draft attributes a verified request to: the well-known directory URL. */
  readonly directory: string;
};

export type KeyResolution =
  | { readonly status: 'found'; readonly key: VerificationKey }
  | { readonly status: 'rejected'; readonly reason: string };

export type AgentSignatureOptions = {
  readonly now: Date;
  readonly maxAgeMs: number;
  readonly clockSkewMs: number;
  readonly requireNonce: boolean;
  /** Called only for signatures that passed every structural and freshness check. */
  resolveKey(agent: SignatureAgent, keyid: string): Promise<KeyResolution>;
};

export type AgentVerification =
  | {
      readonly status: 'verified';
      readonly agent: SignatureAgent;
      readonly keyid: string;
      readonly nonce: string | undefined;
      /** Seconds since the epoch after which this signature can no longer be accepted. */
      readonly acceptableUntil: number;
    }
  | { readonly status: 'rejected'; readonly reason: string };

/**
 * Verifies the Web Bot Auth signatures on `request`, in header order, and returns the first that
 * verifies, or the first rejection.
 */
export async function verifyAgentSignature(request: Request, options: AgentSignatureOptions): Promise<AgentVerification> {
  const signatures = readSignatures(request.headers);
  if (typeof signatures === 'string') return rejected(signatures);
  const candidates = signatures.filter((signature) => signature.parameters.tag === WEB_BOT_AUTH_TAG);
  if (candidates.length === 0) return rejected(signatures.length === 0 ? 'signature_malformed' : 'tag_missing');

  let first: AgentVerification | undefined;
  for (const candidate of candidates) {
    const result = await verifyCandidate(request, candidate, options);
    if (result.status === 'verified') return result;
    first ??= result;
  }
  return first ?? rejected('signature_missing');
}

async function verifyCandidate(request: Request, input: SignatureInput, options: AgentSignatureOptions): Promise<AgentVerification> {
  const { created, expires, keyid, nonce, alg } = input.parameters;
  if (created === undefined || expires === undefined || keyid === undefined) return rejected('signature_parameters_missing');
  if (created > expires) return rejected('signature_malformed');
  if (!input.components.some(isBareTarget)) return rejected('target_not_covered');

  const now = options.now.getTime() / 1000;
  const skew = options.clockSkewMs / 1000;
  if (created > now + skew) return rejected('signature_not_yet_valid');
  if (now >= expires + skew) return rejected('signature_expired');
  if (now - created > options.maxAgeMs / 1000 + skew) return rejected('signature_too_old');
  if (options.requireNonce && nonce === undefined) return rejected('nonce_missing');

  const agent = coveredAgent(request, input.components);
  if (typeof agent === 'string') return rejected(agent);
  const base = signatureBase(request, input);
  if (base === undefined) return rejected('signature_base_invalid');

  const resolution = await options.resolveKey(agent, keyid);
  if (resolution.status === 'rejected') return resolution;
  const { key } = resolution;
  if ((key.notBefore !== undefined && now + skew < key.notBefore) || (key.notAfter !== undefined && now - skew >= key.notAfter)) {
    return rejected('key_not_found');
  }
  const algorithm = agreedAlgorithm(key, alg);
  if (algorithm === undefined) return rejected('algorithm_mismatch');
  if (!(await verifySignature(key, algorithm, base, input.signature))) return rejected('signature_invalid');

  return {
    status: 'verified',
    agent,
    keyid,
    nonce,
    acceptableUntil: Math.min(expires, created + options.maxAgeMs / 1000) + skew,
  };
}

/**
 * The Signature-Agent member this signature covers (§5.2.1). The dictionary form must cover exactly
 * one `signature-agent;key=<member>`; the legacy sf-string form must cover the whole field.
 */
function coveredAgent(request: Request, components: readonly Item[]): SignatureAgent | string {
  const field = request.headers.get('signature-agent');
  if (field === null) return 'signature_agent_missing';
  const covering = components.filter((component) => component.value.value === 'signature-agent');

  const legacy = parseItem(field);
  if (legacy !== undefined) {
    if (legacy.value.type !== 'string' || legacy.parameters.size > 0) return 'signature_agent_malformed';
    if (!covering.some((component) => component.parameters.size === 0)) return 'signature_agent_not_covered';
    return directoryAgent(legacy.value.value) ?? 'signature_agent_malformed';
  }

  const members = parseDictionary(field);
  if (members === undefined) return 'signature_agent_malformed';
  const keys = covering.flatMap((component) => {
    const key = component.parameters.get('key');
    return component.parameters.size === 1 && key?.type === 'string' ? [key.value] : [];
  });
  const [key, another] = keys;
  if (key === undefined || another !== undefined) return 'signature_agent_not_covered';

  const member = members.get(key);
  if (member?.kind !== 'item' || member.value.type !== 'string') return 'signature_agent_malformed';
  const type = member.parameters.get('type');
  // Only `directory` names a domain through a reserved path; `jwks_uri` and `cimd` are not resolved here.
  if (type !== undefined && !(type.type === 'token' && type.value === 'directory')) return 'signature_agent_unsupported';
  return directoryAgent(member.value.value) ?? 'signature_agent_malformed';
}

/** A `directory` member value MUST be an origin; an empty path `/` MAY be accepted. */
function directoryAgent(value: string): SignatureAgent | undefined {
  const origin = httpsOrigin(value);
  return origin === undefined ? undefined : { origin, directory: `${origin}${DIRECTORY_PATH}` };
}

export function httpsOrigin(value: string): string | undefined {
  if (!URL.canParse(value)) return undefined;
  const url = new URL(value);
  if (url.protocol !== 'https:') return undefined;
  return value === url.origin || value === `${url.origin}/` ? url.origin : undefined;
}

function isBareTarget(component: Item): boolean {
  return (component.value.value === '@authority' || component.value.value === '@target-uri') && component.parameters.size === 0;
}

function rejected(reason: string): AgentVerification {
  return { status: 'rejected', reason };
}
