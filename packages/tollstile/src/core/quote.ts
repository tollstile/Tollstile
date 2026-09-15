import { base64urlDecode, base64urlEncode, constantTimeEqual, fromUtf8, hmacSha256, randomToken, utf8 } from './codec';
import { TollstileError } from './errors';
import { money, type Money } from './money';
import type { Clock, Context, Json, Offer, Quote } from './types';

type WireQuote = {
  readonly v: 1;
  readonly id: string;
  readonly resource: string;
  readonly commitment: string;
  readonly currency: string;
  readonly micros: string;
  readonly variable: boolean;
  readonly offers: readonly Offer[];
  readonly nonce: string;
  readonly iat: number;
  readonly exp: number;
};

export type QuoteSigner = {
  issue(input: {
    context: Context;
    commitment: string;
    price: Money;
    variable: boolean;
    offers: readonly Offer[];
  }): Promise<{ quote: Quote; token: string }>;
  /** Checks signature, expiry, and resource. The caller compares the commitment with the current request. */
  open(token: string, context: Context): Promise<Quote | undefined>;
};

export function createQuoteSigner(secrets: readonly string[], ttlMs: number, clock: Clock): QuoteSigner {
  const [signingSecret] = secrets;
  if (signingSecret === undefined) throw new TollstileError('UNREACHABLE', 'Quote signing needs at least one secret.');

  return {
    async issue({ context, commitment, price, variable, offers }) {
      const issuedAt = clock.now();
      const quote: Quote = {
        id: randomToken(12),
        resource: context.resource,
        commitment,
        price,
        variable,
        offers,
        nonce: randomToken(16),
        issuedAt,
        expiresAt: new Date(issuedAt.getTime() + ttlMs),
      };
      const payload = base64urlEncode(utf8(JSON.stringify(toWire(quote))));
      const signature = base64urlEncode(await hmacSha256(signingSecret, payload));
      return { quote, token: `${payload}.${signature}` };
    },

    async open(token, context) {
      const [payload, signature, extra] = token.split('.');
      if (payload === undefined || signature === undefined || extra !== undefined) return undefined;
      const presented = base64urlDecode(signature);
      if (presented === undefined) return undefined;

      let authentic = false;
      for (const secret of secrets) {
        if (constantTimeEqual(presented, await hmacSha256(secret, payload))) authentic = true;
      }
      if (!authentic) return undefined;

      const bytes = base64urlDecode(payload);
      const quote = bytes === undefined ? undefined : fromWire(parseJson(fromUtf8(bytes)));
      if (quote === undefined) return undefined;
      if (quote.expiresAt.getTime() <= clock.now().getTime()) return undefined;
      if (quote.resource !== context.resource) return undefined;
      return quote;
    },
  };
}

function toWire(quote: Quote): WireQuote {
  return {
    v: 1,
    id: quote.id,
    resource: quote.resource,
    commitment: quote.commitment,
    currency: quote.price.currency,
    micros: quote.price.micros.toString(),
    variable: quote.variable,
    offers: quote.offers,
    nonce: quote.nonce,
    iat: quote.issuedAt.getTime(),
    exp: quote.expiresAt.getTime(),
  };
}

/** Only authentic payloads reach this, so a shape mismatch means a version change, not an attack. */
function fromWire(value: unknown): Quote | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const wire = value as Partial<Record<keyof WireQuote, unknown>>;
  if (
    wire.v !== 1 ||
    typeof wire.id !== 'string' ||
    typeof wire.resource !== 'string' ||
    typeof wire.commitment !== 'string' ||
    typeof wire.currency !== 'string' ||
    typeof wire.micros !== 'string' ||
    !/^\d+$/.test(wire.micros) ||
    typeof wire.variable !== 'boolean' ||
    !Array.isArray(wire.offers) ||
    typeof wire.nonce !== 'string' ||
    typeof wire.iat !== 'number' ||
    typeof wire.exp !== 'number'
  ) {
    return undefined;
  }
  return {
    id: wire.id,
    resource: wire.resource,
    commitment: wire.commitment,
    price: money(wire.currency, BigInt(wire.micros)),
    variable: wire.variable,
    offers: wire.offers as readonly Offer[],
    nonce: wire.nonce,
    issuedAt: new Date(wire.iat),
    expiresAt: new Date(wire.exp),
  };
}

function parseJson(text: string): Json | undefined {
  // eslint-disable-next-line no-restricted-syntax -- catch-reason: JSON.parse reports malformed input by throwing; malformed quotes are an expected, returned outcome.
  try {
    return JSON.parse(text) as Json;
  } catch {
    return undefined;
  }
}
