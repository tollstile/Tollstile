import type { JsonObject } from 'tollstile';
import {
  readClosedMandate,
  readOpenMandate,
  type OpenPaymentMandate,
  type PaymentMandate,
} from './payment-mandate';
import { digest, disclosedPayload, isRecord, parseSdJwt, verifyEs256, type JsonRecord, type SdJwt } from './sd-jwt';

// A Delegate SD-JWT chain as AP2 v0.2 uses it for Human Not Present payments
// (draft-gco-oauth-delegate-sd-jwt §Verification): a root SD-JWT carrying the user's open Payment
// Mandate with the agent key in `cnf`, and a KB-SD-JWT signed by that key carrying the closed one.

export type ChainOptions = {
  /** The root issuer's public JWK for this protected header, or `undefined` if it is not trusted. */
  readonly resolveKey: (header: JsonObject) => Promise<JsonWebKey | undefined>;
  readonly now: Date;
  readonly clockSkewMs: number;
};

export type VerifiedChain = {
  readonly open: OpenPaymentMandate;
  readonly closed: PaymentMandate;
  readonly binding: { readonly iat: number; readonly aud: string; readonly nonce: string };
  /** Stable for the signed content of the terminal hop: what single-use enforcement keys on. */
  readonly id: string;
};

const TERMINAL_TYPES = new Set(['kb+sd-jwt', 'kb-sd-jwt']);
const INTERMEDIATE_TYPES = new Set(['kb+sd-jwt+kb', 'kb-sd-jwt+kb']);

export async function verifyMandateChain(presented: string, options: ChainOptions): Promise<VerifiedChain | string> {
  // Each SD-JWT ends in `~`, so hops are separated by `~~` (AP2 SDK chain.py).
  const hops = presented.split('~~');
  if (hops.length === 1) return 'key_binding_required';
  const [rootPart = '', terminalPart = '', ...extra] = hops;
  if (extra.length > 0) return 'delegation_depth_unsupported';

  const root = parseSdJwt(`${rootPart}~`);
  const terminal = parseSdJwt(terminalPart);
  if (typeof root === 'string') return root;
  if (typeof terminal === 'string') return terminal;

  if (typeof root.header.typ === 'string' && (TERMINAL_TYPES.has(root.header.typ) || INTERMEDIATE_TYPES.has(root.header.typ))) {
    return 'root_type_invalid';
  }
  const issuerKey = await options.resolveKey(root.header as JsonObject);
  if (issuerKey === undefined) return 'issuer_untrusted';
  if (!(await verifyEs256(root, issuerKey))) return 'issuer_signature_invalid';
  const rootClaims = await delegateClaims(root);
  if (typeof rootClaims === 'string') return rootClaims;
  const open = readOpenMandate(rootClaims.mandate);
  if (typeof open === 'string') return `open_mandate:${open}`;

  const typ = terminal.header.typ;
  if (typeof typ !== 'string' || !TERMINAL_TYPES.has(typ)) {
    return typeof typ === 'string' && INTERMEDIATE_TYPES.has(typ) ? 'delegation_depth_unsupported' : 'kb_type_invalid';
  }
  if (!(await verifyEs256(terminal, open.holderKey))) return 'kb_signature_invalid';
  const binding = await verifyBinding(terminal.payload, root);
  if (binding !== undefined) return binding;
  const { iat, aud, nonce } = terminal.payload;
  if (typeof iat !== 'number' || typeof aud !== 'string' || typeof nonce !== 'string') return 'kb_claims_missing';

  const terminalClaims = await delegateClaims(terminal);
  if (typeof terminalClaims === 'string') return terminalClaims;
  const closed = readClosedMandate(terminalClaims.mandate);
  if (typeof closed === 'string') return `closed_mandate:${closed}`;

  const expired = checkTimes([root.payload, rootClaims.mandate, terminal.payload, terminalClaims.mandate], options);
  if (expired !== undefined) return expired;

  const [header = '', payload = ''] = terminal.issuerJwt.split('.');
  return { open, closed, binding: { iat, aud, nonce }, id: await digest('SHA-256', `${header}.${payload}`) };
}

/**
 * Exactly one of `sd_hash` (over the previous SD-JWT and its disclosures) or `issuer_jwt_hash`
 * (over its issuer JWT alone), hashed with the previous token's `_sd_alg`.
 */
async function verifyBinding(payload: JsonRecord, previous: SdJwt): Promise<string | undefined> {
  const { sd_hash: sdHash, issuer_jwt_hash: issuerJwtHash } = payload;
  if ((sdHash === undefined) === (issuerJwtHash === undefined)) return 'kb_binding_missing';
  const expected = await digest(previous.hash, sdHash === undefined ? previous.issuerJwt : previous.serialized);
  return (sdHash ?? issuerJwtHash) === expected ? undefined : 'kb_binding_mismatch';
}

/** The single disclosed `delegate_payload` element: the mandate this hop speaks for. */
async function delegateClaims(token: SdJwt): Promise<{ readonly mandate: JsonRecord } | string> {
  const payload = await disclosedPayload(token);
  if (typeof payload === 'string') return payload;
  const delegate = payload.delegate_payload;
  if (!Array.isArray(delegate) || delegate.length !== 1 || !isRecord(delegate[0])) return 'delegate_payload_invalid';
  return { mandate: delegate[0] };
}

function checkTimes(claimSets: readonly JsonRecord[], options: ChainOptions): string | undefined {
  const now = options.now.getTime() / 1000;
  const skew = options.clockSkewMs / 1000;
  for (const claims of claimSets) {
    const { exp, nbf, iat } = claims;
    if ((exp !== undefined && typeof exp !== 'number') || (nbf !== undefined && typeof nbf !== 'number') || (iat !== undefined && typeof iat !== 'number')) {
      return 'time_claims_invalid';
    }
    if (exp !== undefined && now >= exp + skew) return 'expired';
    if (nbf !== undefined && now + skew < nbf) return 'not_yet_valid';
    if (iat !== undefined && iat > now + skew) return 'issued_in_future';
  }
  return undefined;
}
