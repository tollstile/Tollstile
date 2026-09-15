import { createTollstile, memoryLedger, toResponse, type Gate, type Pass, type JsonObject, type Rail, type TollstileEvent } from 'tollstile';
import { fakeClock, httpContext, mcpContext } from 'tollstile/testing';

/** A parsed `WWW-Authenticate: Payment` challenge, as a client sees it. */
export type WireChallenge = Record<string, string>;

export function parseChallenges(headers: Headers): WireChallenge[] {
  const value = headers.get('www-authenticate') ?? '';
  return value
    .split(/,\s*(?=Payment )/)
    .filter((part) => part.startsWith('Payment '))
    .map((part) => Object.fromEntries([...part.matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)].map((match) => [match[1] ?? '', match[2] ?? ''])));
}

export function decodeJson(value: string): JsonObject {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as JsonObject;
}

export function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function authorization(challenge: WireChallenge, payload: JsonObject, source?: string): string {
  return `Payment ${encodeJson({ challenge, payload, ...(source === undefined ? {} : { source }) })}`;
}

export type Outcome = {
  readonly status: number;
  readonly body: JsonObject;
  readonly headers: Headers;
  readonly handlerRuns: number;
  readonly meta: JsonObject;
  /** `none` when denied before the handler. */
  readonly settlement?: Awaited<ReturnType<Pass<readonly Rail[]>['complete']>>['settlement'];
};

export function setup<R extends Rail>(rail: R, clock = fakeClock()) {
  const ledger = memoryLedger({ clock });
  const events: TollstileEvent[] = [];
  const toll = createTollstile({ rails: [rail], ledger, clock, secret: 's'.repeat(32), onEvent: (event) => events.push(event) });
  const charges = () => ledger.charges().map((charge) => `${charge.payment}/${charge.fulfillment}`);
  const errors = () => events.flatMap((event) => (event.type === 'error' ? [event.error] : []));
  return { toll, ledger, clock, events, charges, errors };
}

/** Drives a gate the way the HTTP adapter does. */
export async function get(
  gate: Gate<readonly Rail[]>,
  options: {
    readonly path?: string;
    readonly authorization?: string;
    readonly outcome?: 'succeeded' | 'failed';
    readonly handler?: () => void;
  } = {},
): Promise<Outcome> {
  const headers = new Headers();
  if (options.authorization !== undefined) headers.set('authorization', options.authorization);
  const entry = await gate.enter(httpContext(new Request(`https://api.example.com${options.path ?? '/report'}`, { headers })));
  if (entry.kind === 'denied') {
    const response = toResponse(entry.denial);
    return { status: response.status, body: (await response.json()) as JsonObject, headers: response.headers, handlerRuns: 0, meta: {} };
  }
  options.handler?.();
  const outcome = options.outcome ?? 'succeeded';
  const completion = await entry.pass.complete(outcome);
  if (completion.denial !== null) {
    // Settlement was rejected after the handler: the adapter withholds the output and sends the fresh 402.
    const response = toResponse(completion.denial);
    return { status: response.status, body: (await response.json()) as JsonObject, headers: response.headers, handlerRuns: 1, meta: {}, settlement: completion.settlement };
  }
  const receiptHeaders = new Headers();
  for (const [name, value] of completion.receipt.headers) receiptHeaders.append(name, value);
  return {
    status: outcome === 'succeeded' ? 200 : 500,
    body: {},
    headers: receiptHeaders,
    handlerRuns: 1,
    meta: completion.receipt.meta,
    settlement: completion.settlement,
  };
}

/** Drives a gate the way the MCP adapter does. */
export async function callTool(gate: Gate<readonly Rail[]>, meta: JsonObject = {}): Promise<Outcome & { readonly mcp: JsonObject[] }> {
  const entry = await gate.enter(mcpContext('report', meta));
  if (entry.kind === 'denied') {
    return {
      status: entry.denial.status,
      body: entry.denial.body,
      headers: new Headers(),
      handlerRuns: 0,
      meta: {},
      mcp: entry.denial.offers.map((offer) => offer.challenge.mcp),
    };
  }
  const completion = await entry.pass.complete('succeeded');
  return { status: 200, body: {}, headers: new Headers(), handlerRuns: 1, meta: completion.receipt.meta, mcp: [] };
}

/** Requests without payment and returns the first challenge. */
export async function challengeFor(gate: Gate<readonly Rail[]>, path?: string): Promise<WireChallenge> {
  const result = await get(gate, path === undefined ? {} : { path });
  const [challenge] = parseChallenges(result.headers);
  if (challenge === undefined) throw new Error(`expected a challenge, got ${JSON.stringify(result.body)}`);
  return challenge;
}
