import { createTollstile, memoryLedger, toResponse, type Gate, type Outcome, type Rail, type TollstileEvent } from 'tollstile';
import { fakeClock, httpContext } from 'tollstile/testing';
import { memoryFacilitator, sparse, type MemoryFacilitator, type SparseAccepts, type Wallet } from '../src/index';
import { encodeTicket, TICKET_HEADER, type Ticket } from '../src/ticket';

export const URL_UNDER_TEST = 'http://localhost/research';

/** A seeded generator so tickets and secrets are reproducible across runs. */
export function seeded(seed = 1): () => string {
  let state = seed >>> 0;
  return () => {
    // xorshift32; enough entropy for tests, none for production.
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return `r${state.toString(16).padStart(8, '0')}${(state * 2654435761 >>> 0).toString(16).padStart(8, '0')}`;
  };
}

export function setup(options: { readonly ticket?: string; readonly price?: string; readonly random?: () => string; readonly facilitator?: MemoryFacilitator } = {}) {
  const clock = fakeClock();
  const facilitator = options.facilitator ?? memoryFacilitator({ random: options.random ?? seeded() });
  const rail = sparse({ facilitator, payTo: '0xmerchant', ticket: options.ticket ?? '$1' });
  const ledger = memoryLedger({ clock });
  const events: TollstileEvent[] = [];
  const toll = createTollstile({ rails: [rail], ledger, clock, secret: 'sparse-test-secret-0123456789abcdef', onEvent: (event) => events.push(event) });
  return { clock, facilitator, rail, ledger, toll, events };
}

export type Result = {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly headers: Headers;
  readonly settlement: string | null;
};

/** Drives a gate the way an HTTP adapter does. */
export async function call<Rails extends readonly Rail[]>(
  gate: Gate<Rails>,
  options: { readonly ticket?: Ticket; readonly outcome?: Outcome; readonly idempotencyKey?: string } = {},
): Promise<Result> {
  const headers = new Headers();
  if (options.ticket !== undefined) headers.set(TICKET_HEADER, encodeTicket(options.ticket));
  if (options.idempotencyKey !== undefined) headers.set('idempotency-key', options.idempotencyKey);
  const entry = await gate.enter(httpContext(new Request(URL_UNDER_TEST, { headers }), { resource: URL_UNDER_TEST }));
  if (entry.kind === 'denied') {
    const response = toResponse(entry.denial);
    return { status: response.status, body: (await response.json()) as Record<string, unknown>, headers: response.headers, settlement: null };
  }
  const completion = await entry.pass.complete(options.outcome ?? 'succeeded');
  if (completion.denial !== null) {
    const response = toResponse(completion.denial);
    return { status: response.status, body: (await response.json()) as Record<string, unknown>, headers: response.headers, settlement: null };
  }
  const responseHeaders = new Headers();
  for (const [name, value] of completion.receipt.headers) responseHeaders.append(name, value);
  return { status: options.outcome === 'failed' ? 500 : 200, body: { meta: completion.receipt.meta }, headers: responseHeaders, settlement: completion.settlement };
}

/** Ask for a 402 and return the sparse offer's `accepts`. */
export async function challenge<Rails extends readonly Rail[]>(gate: Gate<Rails>): Promise<SparseAccepts> {
  const result = await call(gate);
  if (result.status !== 402) throw new Error(`expected a 402, got ${String(result.status)}`);
  const accepts = (result.body.accepts as { rail: string; details: SparseAccepts }[]).find((offer) => offer.rail.startsWith('sparse'));
  if (accepts === undefined) throw new Error('no sparse offer in the 402');
  return accepts.details;
}

/** Challenge, sign with the wallet, pay. */
export async function pay<Rails extends readonly Rail[]>(gate: Gate<Rails>, wallet: Wallet, options: { readonly outcome?: Outcome } = {}) {
  const accepts = await challenge(gate);
  const ticket = await wallet.sign(accepts);
  const result = await call(gate, { ticket, ...options });
  return { accepts, ticket, result };
}
