import { TollstileError, type Header, type JsonObject, type Quote, type RailChallenge } from 'tollstile';
import { base64url, utf8 } from './encoding';
import { canonicalize } from './jcs';

/** The opaque key that carries Tollstile's signed quote through the challenge. */
export const QUOTE_OPAQUE_KEY = 'tollstile_quote';

/** A Payment challenge as issued. `request` and `opaque` are native JSON; the wire encodes them. */
export type Challenge = {
  readonly id: string;
  readonly realm: string;
  readonly method: string;
  readonly intent: string;
  readonly request: JsonObject;
  /** RFC 3339. Always set: a challenge without an expiry could be replayed indefinitely. */
  readonly expires: string;
  readonly opaque: Readonly<Record<string, string>>;
};

export type ChallengeInput = Omit<Challenge, 'id'>;

/** The HMAC slots of the spec's recommended binding. `header` is never issued, so slot 7 never exists. */
export type BindingSlots = {
  readonly realm: string;
  readonly method: string;
  readonly intent: string;
  readonly request: string;
  readonly expires: string;
  readonly digest: string;
  readonly opaque: string;
};

/** Stateless challenge binding with rotation: the first secret signs, every secret verifies. */
export type ChallengeSecrets = readonly [string, ...string[]];

const MIN_SECRET_LENGTH = 32;

export function challengeSecrets(secret: string | readonly string[], rail: string): ChallengeSecrets {
  const secrets = typeof secret === 'string' ? [secret] : secret;
  const [first, ...rest] = secrets;
  if (first === undefined || secrets.some((value) => value.length < MIN_SECRET_LENGTH)) {
    throw new TollstileError(
      'CONFIG_INVALID',
      `Rail "${rail}" needs \`secret\` of at least ${String(MIN_SECRET_LENGTH)} characters to bind MPP challenge ids. Pass a list to rotate: the first signs, all verify.`,
    );
  }
  return [first, ...rest];
}

export async function issueChallenge(secrets: ChallengeSecrets, input: ChallengeInput): Promise<Challenge> {
  const id = await computeChallengeId(secrets[0], bindingSlots(input));
  return { id, ...input };
}

export function bindingSlots(input: ChallengeInput): BindingSlots {
  return {
    realm: input.realm,
    method: input.method,
    intent: input.intent,
    request: encodeJson(input.request),
    expires: input.expires,
    digest: '',
    opaque: Object.keys(input.opaque).length === 0 ? '' : encodeJson(input.opaque),
  };
}

/** `id = base64url(HMAC-SHA256(secret, realm|method|intent|request|expires|digest|opaque))`. */
export async function computeChallengeId(secret: string, slots: BindingSlots): Promise<string> {
  const input = [slots.realm, slots.method, slots.intent, slots.request, slots.expires, slots.digest, slots.opaque].join('|');
  const key = await crypto.subtle.importKey('raw', utf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(input))));
}

/** base64url(JCS(value)), the encoding of `request` and `opaque` on HTTP. */
export function encodeJson(value: JsonObject): string {
  return base64url(utf8(canonicalize(value)));
}

/** `WWW-Authenticate: Payment ...`. `description` and `header` are never emitted. */
export function challengeHeader(challenge: Challenge): Header {
  const slots = bindingSlots(challenge);
  const parameters: [string, string][] = [
    ['id', challenge.id],
    ['realm', challenge.realm],
    ['method', challenge.method],
    ['intent', challenge.intent],
    ['request', slots.request],
    ['expires', challenge.expires],
  ];
  if (slots.opaque !== '') parameters.push(['opaque', slots.opaque]);
  return ['www-authenticate', `Payment ${parameters.map(([name, value]) => `${name}="${quoted(value)}"`).join(', ')}`];
}

/** The JSON-RPC transport form: `request` stays native JSON, `opaque` stays base64url as on HTTP. */
export function mcpChallenge(challenge: Challenge): JsonObject {
  const slots = bindingSlots(challenge);
  return {
    id: challenge.id,
    realm: challenge.realm,
    method: challenge.method,
    intent: challenge.intent,
    request: challenge.request,
    expires: challenge.expires,
    ...(slots.opaque === '' ? {} : { opaque: slots.opaque }),
  };
}

/**
 * What every MPP rail answers a quote with: the HMAC-bound challenge, carrying the quote token in
 * `opaque` and expiring with the quote.
 */
export async function quoteChallenge(
  secrets: ChallengeSecrets,
  input: { readonly realm: string; readonly method: string; readonly intent: string; readonly request: JsonObject },
  quote: Quote,
  quoteToken: string,
): Promise<RailChallenge> {
  const challenge = await issueChallenge(secrets, {
    ...input,
    expires: rfc3339(quote.expiresAt),
    opaque: { [QUOTE_OPAQUE_KEY]: quoteToken },
  });
  const native = mcpChallenge(challenge);
  return { headers: [challengeHeader(challenge)], accepts: native, mcp: { style: 'mpp', challenge: native } };
}

/** Realms go into a quoted header parameter, so they are restricted to printable ASCII. */
export function asciiRealm(realm: string): string {
  if (!/^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$/.test(realm) || realm.includes('"') || realm.includes('\\')) {
    throw new TollstileError('CONFIG_INVALID', `MPP realm "${realm}" must be printable ASCII without quotes, e.g. "api.example.com".`);
  }
  return realm;
}

/** RFC 3339 at second precision, rounded down so the challenge never outlives the quote it carries. */
export function rfc3339(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

function quoted(value: string): string {
  if (/[\r\n]/.test(value)) throw new TollstileError('CONFIG_INVALID', 'Challenge parameters cannot contain line breaks.');
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
