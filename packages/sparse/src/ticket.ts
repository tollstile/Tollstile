import type { Json } from 'tollstile';

/** HTTP header carrying a signed sparse ticket. */
export const TICKET_HEADER = 'sparse-ticket';
/** MCP `_meta` key carrying the same ticket. */
export const TICKET_META = 'sparse/ticket';
/** HTTP header on the 402 describing what to sign. */
export const CHALLENGE_HEADER = 'sparse-payment-required';
export const RECEIPT_HEADER = 'sparse-receipt';
export const RECEIPT_META = 'sparse/receipt';
/** Domain separator for the digest. Stands in for an EIP-712 domain in this off-chain reference. */
export const DOMAIN = 'tollstile-sparse-v0';

export const TWO_256 = 1n << 256n;

/** What the buyer signs over, mirroring `SparseWitness` in the paper (§3). Amounts are decimal strings of micro-units. */
export type Witness = {
  readonly to: string;
  readonly facilitator: string;
  readonly price: string;
  readonly ticket: string;
  readonly threshold: string;
  readonly commitment: string;
  readonly challengeId: string;
  readonly validAfter: number;
};

/** The witness plus the permit fields and the buyer's signature. This is the proof the rail verifies. */
export type Ticket = Witness & {
  readonly quote: string;
  readonly payer: string;
  readonly nonce: string;
  readonly digest: string;
  readonly signature: string;
};

export type Outcome = 'win' | 'lose';

/** floor(p / T · 2^256). `p ≥ T` yields 2^256: every hash is below it, so settlement is deterministic. */
export function thresholdFor(priceMicros: bigint, ticketMicros: bigint): bigint {
  if (priceMicros <= 0n || ticketMicros <= 0n) return 0n;
  if (priceMicros >= ticketMicros) return TWO_256;
  return (priceMicros << 256n) / ticketMicros;
}

/** Odds as a number in [0, 1], for receipts and events. */
export function oddsOf(threshold: bigint): number {
  return threshold >= TWO_256 ? 1 : Number((threshold * 1_000_000_000n + TWO_256 / 2n) / TWO_256) / 1_000_000_000;
}

const encoder = new TextEncoder();
const SEPARATOR = '|';

export async function sha256Hex(...parts: readonly string[]): Promise<string> {
  const bytes = encoder.encode(parts.map((part) => `${String(part.length)}:${part}`).join(SEPARATOR));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const isArray = (value: Json): value is readonly Json[] => Array.isArray(value);

/** Sorted-key JSON so that the same fields always hash the same. */
export function canonical(value: Json): string {
  if (isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export type DigestFields = Omit<Ticket, 'digest' | 'signature'>;

/** The digest the buyer signs: canonical over every field of the witness and the permit, under the domain. */
export function digestOf(fields: DigestFields): Promise<string> {
  return sha256Hex(DOMAIN, canonical({ ...fields }));
}

/** H(d ‖ s) as a 256-bit integer, compared to the threshold. */
export async function outcomeOf(digest: string, secret: string, threshold: bigint): Promise<Outcome> {
  const roll = BigInt(`0x${await sha256Hex(digest, secret)}`);
  return roll < threshold ? 'win' : 'lose';
}

export function commitmentOf(secret: string): Promise<string> {
  return sha256Hex('commit', secret);
}

function base64UrlEncode(text: string): string {
  const bytes = encoder.encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64UrlDecode(text: string): string | undefined {
  const padded = text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (text.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return undefined;
  }
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

export function encodeTicket(ticket: Ticket): string {
  return base64UrlEncode(canonical({ ...ticket }));
}

const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isMicros = (value: unknown): value is string => typeof value === 'string' && /^[0-9]{1,30}$/.test(value);

export function decodeTicket(encoded: string): Ticket | undefined {
  const text = base64UrlDecode(encoded);
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const t = parsed as Record<string, unknown>;
  if (
    !isString(t.to) ||
    !isString(t.facilitator) ||
    !isMicros(t.price) ||
    !isMicros(t.ticket) ||
    !isString(t.threshold) ||
    !/^[0-9]{1,80}$/.test(t.threshold) ||
    !isString(t.commitment) ||
    !isString(t.challengeId) ||
    typeof t.validAfter !== 'number' ||
    !isString(t.quote) ||
    !isString(t.payer) ||
    !isString(t.nonce) ||
    !isString(t.digest) ||
    !isString(t.signature)
  ) {
    return undefined;
  }
  return {
    to: t.to,
    facilitator: t.facilitator,
    price: t.price,
    ticket: t.ticket,
    threshold: t.threshold,
    commitment: t.commitment,
    challengeId: t.challengeId,
    validAfter: t.validAfter,
    quote: t.quote,
    payer: t.payer,
    nonce: t.nonce,
    digest: t.digest,
    signature: t.signature,
  };
}

export function digestFieldsOf(ticket: Ticket): DigestFields {
  return {
    to: ticket.to,
    facilitator: ticket.facilitator,
    price: ticket.price,
    ticket: ticket.ticket,
    threshold: ticket.threshold,
    commitment: ticket.commitment,
    challengeId: ticket.challengeId,
    validAfter: ticket.validAfter,
    quote: ticket.quote,
    payer: ticket.payer,
    nonce: ticket.nonce,
  };
}
