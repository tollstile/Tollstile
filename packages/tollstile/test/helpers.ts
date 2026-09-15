import {
  createTollstile,
  memoryLedger,
  testRail,
  toResponse,
  type Gate,
  type Outcome,
  type Payment,
  type Principal,
  type Rail,
  type TestRailOptions,
  type TollstileConfig,
  type TollstileEvent,
} from '../src/index';
import { fakeClock, httpContext } from '../src/testing/index';

export type Result = {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly headers: Headers;
  readonly handlerRuns: number;
};

export type CallOptions<Rails extends readonly Rail[]> = {
  readonly payment?: string;
  readonly principal?: Principal;
  readonly handler?: (payment: Payment<Rails>) => Outcome | Promise<Outcome>;
  readonly path?: string;
  readonly method?: string;
  readonly body?: string;
  /** Reads the body in the handler, as an application would. */
  readonly readBody?: (body: string) => void;
};

/** Drives a gate the way an HTTP adapter does. */
export async function call<Rails extends readonly Rail[]>(gate: Gate<Rails>, options: CallOptions<Rails> = {}): Promise<Result> {
  const headers = new Headers();
  if (options.payment !== undefined) headers.set('payment', options.payment);
  const request = new Request(`http://localhost${options.path ?? '/weather'}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  });
  const entry = await gate.enter(httpContext(request, options.principal === undefined ? {} : { principal: options.principal }));

  if (entry.kind === 'denied') {
    const response = toResponse(entry.denial);
    return { status: response.status, body: (await response.json()) as Record<string, unknown>, headers: response.headers, handlerRuns: 0 };
  }

  if (options.readBody !== undefined) options.readBody(await request.text());
  const outcome = options.handler === undefined ? 'succeeded' : await options.handler(entry.pass.payment);
  const completion = await entry.pass.complete(outcome);
  if (completion.denial !== null) {
    const response = toResponse(completion.denial);
    return { status: response.status, body: (await response.json()) as Record<string, unknown>, headers: response.headers, handlerRuns: 1 };
  }
  const responseHeaders = new Headers();
  for (const [name, value] of completion.receipt.headers) responseHeaders.append(name, value);
  return {
    status: outcome === 'succeeded' ? 200 : 500,
    body: { via: entry.pass.payment.via, meta: completion.receipt.meta, settlement: completion.settlement },
    headers: responseHeaders,
    handlerRuns: 1,
  };
}

/** Requests without payment, then pays against the quote it was offered. */
export async function payWithQuote<Rails extends readonly Rail[]>(
  gate: Gate<Rails>,
  parameters = '',
  options: Omit<CallOptions<Rails>, 'payment'> = {},
): Promise<Result> {
  const challenge = await call(gate, options);
  const quote = challenge.body.quote;
  if (typeof quote !== 'string') throw new Error(`expected a quote, got ${JSON.stringify(challenge.body)}`);
  return call(gate, { ...options, payment: `test quote=${quote} ${parameters}`.trim() });
}

export function setup(
  options: { readonly rail?: TestRailOptions; readonly config?: Partial<TollstileConfig<readonly Rail[]>> } = {},
) {
  const rail = testRail(options.rail);
  const clock = fakeClock();
  const ledger = memoryLedger({ clock });
  const events: TollstileEvent[] = [];
  const toll = createTollstile({
    rails: [rail],
    ledger,
    clock,
    onEvent: (event) => events.push(event),
    ...options.config,
  });
  const charges = () => ledger.charges().map((charge) => `${charge.payment}/${charge.fulfillment}`);
  const errors = () => events.flatMap((event) => (event.type === 'error' ? [event.error] : []));
  return { rail, clock, ledger, toll, events, charges, errors };
}
