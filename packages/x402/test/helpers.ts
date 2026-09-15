import {
  createTollstile,
  type Completion,
  memoryLedger,
  toResponse,
  type Gate,
  type JsonObject,
  type Outcome,
  type Payment,
  type Rail,
  type TollstileEvent,
} from 'tollstile';
import { fakeClock, httpContext } from 'tollstile/testing';
import { x402, type X402Options } from '../src/index';
import { FACILITATOR_URL, fakeNetwork, RPC_URL, UPTO_PROXY } from './fake-network';

export const PAY_TO = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C';
export const PAYER = '0x857b06519E91e3A54538791bDbb0E22373e36b66';
export const FACILITATOR_ADDRESS = '0xd407e409E34E0b9afb99EcCeb609bDbcD5e7f1bf';

export type Result = {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly headers: Headers;
  readonly handlerRuns: number;
  /** `null` when the request was not admitted. */
  readonly settlement: Completion['settlement'] | null;
};

/** `undefined` removes a default option. */
export function setup(options: { readonly [K in keyof X402Options]?: X402Options[K] | undefined } = {}) {
  const clock = fakeClock();
  const network = fakeNetwork(clock);
  const merged = {
    network: 'eip155:84532',
    payTo: PAY_TO,
    denomination: 'USD',
    rpcUrl: RPC_URL,
    facilitator: { url: FACILITATOR_URL },
    upto: { facilitatorAddress: FACILITATOR_ADDRESS },
    fetch: network.fetch,
    ...options,
  };
  const rail = x402(Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined)) as X402Options);
  const ledger = memoryLedger({ clock });
  const events: TollstileEvent[] = [];
  const toll = createTollstile({
    rails: [rail],
    ledger,
    clock,
    secret: 's'.repeat(32),
    providerTimeoutMs: 200,
    onEvent: (event) => events.push(event),
  });
  const charges = () => ledger.charges().map((charge) => `${charge.payment}/${charge.fulfillment}`);
  const errors = () => events.flatMap((event) => (event.type === 'error' ? [event.error] : []));
  return { clock, network, rail, ledger, toll, events, charges, errors };
}

export type Handler<Rails extends readonly Rail[]> = (payment: Payment<Rails>) => Outcome | Promise<Outcome>;

/** Drives a gate the way an HTTP adapter does. */
export async function call<Rails extends readonly Rail[]>(
  gate: Gate<Rails>,
  options: { readonly payment?: JsonObject; readonly handler?: Handler<Rails>; readonly path?: string } = {},
): Promise<Result> {
  const headers = new Headers();
  if (options.payment !== undefined) headers.set('PAYMENT-SIGNATURE', base64Json(options.payment));
  const request = new Request(`http://localhost${options.path ?? '/weather'}`, { headers });
  const entry = await gate.enter(httpContext(request));

  if (entry.kind === 'denied') {
    const response = toResponse(entry.denial);
    return { status: response.status, body: (await response.json()) as Record<string, unknown>, headers: response.headers, handlerRuns: 0, settlement: null };
  }

  const outcome = options.handler === undefined ? 'succeeded' : await options.handler(entry.pass.payment);
  const { settlement, receipt, denial } = await entry.pass.complete(outcome);
  if (denial !== null) {
    const response = toResponse(denial);
    return { status: response.status, body: (await response.json()) as Record<string, unknown>, headers: response.headers, handlerRuns: 1, settlement };
  }
  const responseHeaders = new Headers();
  for (const [name, value] of receipt.headers) responseHeaders.append(name, value);
  return { status: outcome === 'succeeded' ? 200 : 500, body: { meta: receipt.meta }, headers: responseHeaders, handlerRuns: 1, settlement };
}

export type PaymentRequired = {
  readonly x402Version: number;
  readonly resource: { readonly url: string };
  readonly accepts: readonly Requirement[];
};

export type Requirement = {
  readonly scheme: string;
  readonly network: string;
  readonly amount: string;
  readonly asset: string;
  readonly payTo: string;
  readonly maxTimeoutSeconds: number;
  readonly extra: Record<string, string>;
};

/** Asks for the resource without paying and decodes the x402 challenge. */
export async function challenge<Rails extends readonly Rail[]>(gate: Gate<Rails>, path?: string) {
  const result = await call(gate, path === undefined ? {} : { path });
  const header = result.headers.get('payment-required');
  if (header === null) throw new Error(`expected PAYMENT-REQUIRED, got ${JSON.stringify(result.body)}`);
  return { result, paymentRequired: JSON.parse(atob(header)) as PaymentRequired };
}

export type SignOptions = {
  readonly nonce?: number;
  readonly from?: string;
  readonly to?: string;
  readonly value?: string;
  readonly validBefore?: bigint;
  readonly spender?: string;
  readonly facilitator?: string;
};

/** What an x402 client would send for `accepted`. The facilitator is fake, so the signature is too. */
export function sign(accepted: Requirement, now: Date, options: SignOptions = {}): JsonObject {
  const nowSeconds = BigInt(Math.floor(now.getTime() / 1000));
  const validBefore = (options.validBefore ?? nowSeconds + BigInt(accepted.maxTimeoutSeconds)).toString();
  const nonce = options.nonce ?? 1;
  const signature = `0x${'ab'.repeat(65)}`;
  const payload =
    accepted.scheme === 'exact'
      ? {
          signature,
          authorization: {
            from: options.from ?? PAYER,
            to: options.to ?? accepted.payTo,
            value: options.value ?? accepted.amount,
            validAfter: '0',
            validBefore,
            nonce: `0x${nonce.toString(16).padStart(64, '0')}`,
          },
        }
      : {
          signature,
          permit2Authorization: {
            permitted: { token: accepted.asset, amount: options.value ?? accepted.amount },
            from: options.from ?? PAYER,
            spender: options.spender ?? UPTO_PROXY,
            nonce: `0x${(nonce + 0x1234_0000).toString(16).padStart(64, '0')}`,
            deadline: validBefore,
            witness: { to: options.to ?? accepted.payTo, facilitator: options.facilitator ?? FACILITATOR_ADDRESS, validAfter: '0' },
          },
        };
  return { x402Version: 2, resource: { url: 'http://localhost/weather' }, accepted, payload };
}

/** 402, then pay what was offered. */
export async function pay<Rails extends readonly Rail[]>(
  gate: Gate<Rails>,
  now: Date,
  options: SignOptions & { readonly handler?: Handler<Rails> } = {},
) {
  const { paymentRequired } = await challenge(gate);
  const [accepted] = paymentRequired.accepts;
  if (accepted === undefined) throw new Error('expected an x402 offer');
  const payment = sign(accepted, now, options);
  const result = await call(gate, options.handler === undefined ? { payment } : { payment, handler: options.handler });
  return { result, payment, accepted };
}

export function base64Json(value: unknown): string {
  return btoa(JSON.stringify(value));
}

export function decodeHeader(value: string | null): Record<string, unknown> {
  if (value === null) throw new Error('expected a header');
  return JSON.parse(atob(value)) as Record<string, unknown>;
}
