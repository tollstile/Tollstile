import {
  parseDictionary,
  serializeMember,
  type BareItem,
  type InnerList,
  type Item,
  type Parameters,
} from './structured-fields';

// RFC 9421 HTTP Message Signatures, for requests: reading Signature-Input and Signature, and
// rebuilding the signature base from the request the server actually received.

/** One labelled signature on a request, before any trust decision. */
export type SignatureInput = {
  readonly label: string;
  /** Covered component identifiers; each value is a String. */
  readonly components: readonly Item[];
  readonly parameters: SignatureParameters;
  readonly signature: Uint8Array<ArrayBuffer>;
  /** The inner list exactly as it is re-serialized into `@signature-params`. */
  readonly raw: InnerList;
};

export type SignatureParameters = {
  readonly created: number | undefined;
  readonly expires: number | undefined;
  readonly nonce: string | undefined;
  readonly alg: string | undefined;
  readonly keyid: string | undefined;
  readonly tag: string | undefined;
};

const INTEGER_PARAMETERS = new Set(['created', 'expires']);
const STRING_PARAMETERS = new Set(['nonce', 'alg', 'keyid', 'tag']);
const FIELD_NAME = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/;
const SIGNATURE_BASE = /^[\t\n\x20-\x7e]*$/;

/**
 * Every well-formed signature on the request, in header order. `signature_missing` when either field
 * is absent; `signature_malformed` when either is not a valid Dictionary, since RFC 8941 fails a
 * field as a whole.
 */
export function readSignatures(headers: Headers): readonly SignatureInput[] | 'signature_missing' | 'signature_malformed' {
  const inputField = headers.get('signature-input');
  const signatureField = headers.get('signature');
  if (inputField === null || signatureField === null) return 'signature_missing';

  const inputs = parseDictionary(inputField);
  const signatures = parseDictionary(signatureField);
  if (inputs === undefined || signatures === undefined) return 'signature_malformed';

  const result: SignatureInput[] = [];
  for (const [label, member] of inputs) {
    const signature = signatures.get(label);
    if (member.kind !== 'inner-list' || signature?.kind !== 'item' || signature.value.type !== 'bytes') continue;
    if (!member.items.every((component) => component.value.type === 'string')) continue;
    const parameters = readParameters(member.parameters);
    if (parameters === undefined) continue;
    result.push({ label, components: member.items, parameters, signature: signature.value.value, raw: member });
  }
  return result;
}

/**
 * The signature base (RFC 9421 §2.5) for `input`, derived only from `request`. `undefined` when a
 * covered component is absent, duplicated, unsupported, or not ASCII: each of these MUST fail.
 */
export function signatureBase(request: Request, input: SignatureInput): string | undefined {
  const url = new URL(request.url);
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const component of input.components) {
    const identifier = serializeMember(component);
    if (seen.has(identifier)) return undefined;
    seen.add(identifier);
    const value = componentValue(request, url, component);
    if (value === undefined) return undefined;
    lines.push(`${identifier}: ${value}`);
  }
  lines.push(`"@signature-params": ${serializeMember(input.raw)}`);
  const base = lines.join('\n');
  return SIGNATURE_BASE.test(base) ? base : undefined;
}

function componentValue(request: Request, url: URL, component: Item): string | undefined {
  const name = stringValue(component.value);
  if (name === undefined) return undefined;
  const parameters = [...component.parameters];

  if (name === '@query-param') {
    const [only, ...rest] = parameters;
    if (only === undefined || only[0] !== 'name' || rest.length > 0) return undefined;
    const wanted = stringValue(only[1]);
    return wanted === undefined ? undefined : queryParameter(url, wanted);
  }
  if (name.startsWith('@')) {
    // `req` only applies to responses, which a requirement never verifies.
    return parameters.length === 0 ? derivedComponent(request, url, name) : undefined;
  }

  if (!FIELD_NAME.test(name)) return undefined;
  const field = request.headers.get(name);
  if (field === null) return undefined;
  if (parameters.length === 0) return field;

  const [only, ...rest] = parameters;
  if (only?.[0] !== 'key' || rest.length > 0) return undefined;
  const key = stringValue(only[1]);
  const member = key === undefined ? undefined : parseDictionary(field)?.get(key);
  return member === undefined ? undefined : serializeMember(member);
}

function derivedComponent(request: Request, url: URL, name: string): string | undefined {
  switch (name) {
    case '@method':
      return request.method;
    case '@target-uri':
      return url.href;
    case '@authority':
      return url.host;
    case '@scheme':
      return url.protocol.slice(0, -1);
    case '@request-target':
      return `${url.pathname}${url.search}`;
    case '@path':
      return url.pathname === '' ? '/' : url.pathname;
    case '@query':
      return url.search === '' ? '?' : url.search;
    default:
      return undefined;
  }
}

/** RFC 9421 §2.2.8: form-decode, then re-encode with `%20` for spaces; repeated names MUST fail. */
function queryParameter(url: URL, wanted: string): string | undefined {
  const matches = [...new URLSearchParams(url.search)].filter(([name]) => formEncode(name) === wanted);
  const [match, duplicate] = matches;
  return match === undefined || duplicate !== undefined ? undefined : formEncode(match[1]);
}

function formEncode(value: string): string {
  return new URLSearchParams([['', value]]).toString().slice(1).replace(/\+/g, '%20');
}

function readParameters(parameters: Parameters): SignatureParameters | undefined {
  const values = new Map<string, string | number>();
  for (const [key, value] of parameters) {
    if (INTEGER_PARAMETERS.has(key) && value.type === 'integer') values.set(key, value.value);
    else if (STRING_PARAMETERS.has(key) && value.type === 'string') values.set(key, value.value);
    else return undefined;
  }
  const integer = (key: string) => {
    const value = values.get(key);
    return typeof value === 'number' ? value : undefined;
  };
  const string = (key: string) => {
    const value = values.get(key);
    return typeof value === 'string' ? value : undefined;
  };
  return {
    created: integer('created'),
    expires: integer('expires'),
    nonce: string('nonce'),
    alg: string('alg'),
    keyid: string('keyid'),
    tag: string('tag'),
  };
}

function stringValue(item: BareItem): string | undefined {
  return item.type === 'string' ? item.value : undefined;
}
