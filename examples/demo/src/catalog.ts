import { credits, payPerCall, upTo, type Gate, type Rail, type Tollstile } from 'tollstile';
import { pricePerWord } from './handlers';
import { BATCH_CAP, RESEARCH_CAP } from './judge';
import { createToll, credits as balance, guests, type Env } from './toll';

/**
 * Every priced thing in this demo, defined once. The routes and the MCP tools take their gate from
 * here, and `/.well-known/tollstile` describes the same objects, so a price can never drift from
 * what is charged: what an agent reads before calling is what the gate will enforce.
 */
export type Offer = {
  /** How to call it: `GET /v1/forecast`, or `tool:summarize` over MCP. */
  readonly call: string;
  readonly price: string;
  readonly description: string;
  readonly gate: Gate<readonly Rail[]>;
};

export type Offers = {
  readonly forecast: Offer;
  readonly research: Offer;
  readonly batch: Offer;
  readonly translate: Offer;
  readonly summarize: Offer;
  readonly toolForecast: Offer;
  readonly toolSummarize: Offer;
  readonly toolWeek: Offer;
};

export function offers(env: Env, toll: Tollstile<readonly Rail[]> = createToll(env)): Offers {
  return {
    forecast: {
      call: 'GET /v1/forecast?city=',
      price: '$0.01',
      description: 'Tomorrow in one word, for a city.',
      gate: toll.price('$0.01'),
    },
    research: {
      call: 'POST /v1/research',
      price: 'up to $0.05, settled at what the answer was worth',
      description:
        'Authorize a ceiling; a judge reads the answer and settles $0.01, $0.02, $0.04 — or nothing, if the desk found nothing. The response says which tier, how confident, and who judged it.',
      gate: toll.price(upTo(RESEARCH_CAP), { resource: 'POST /v1/research' }),
    },
    batch: {
      call: 'POST /v1/research/batch',
      price: 'up to $0.50, settled at the sum of what each answer was worth',
      description:
        'Ten questions in one call, judged in parallel and settled as one charge. What a judge that answers in milliseconds is actually for: a burst from one agent, priced individually, paid once.',
      gate: toll.price(upTo(BATCH_CAP), { resource: 'POST /v1/research/batch' }),
    },
    translate: {
      call: 'POST /v1/translate',
      price: '$0.001 per word',
      description: 'Priced from the body it was given. The quote is bound to that body: a cheap quote cannot pay for a bigger request.',
      gate: toll.price(pricePerWord),
    },
    summarize: {
      call: 'POST /v1/summarize',
      price: 'up to $0.50, then $0.001 per word',
      description: 'Authorize a maximum; the handler reports what it used and only that is charged. `x-api-key: demo-member` draws on prepaid credits instead.',
      gate: toll.price(upTo('$0.50'), { access: [credits({ balance }), payPerCall()] }),
    },
    toolForecast: {
      call: 'tool:forecast',
      price: '$0.01',
      description: 'The forecast, over MCP.',
      gate: toll.price('$0.01', { resource: 'tool:forecast' }),
    },
    toolWeek: {
      call: 'tool:forecast_week',
      price: '$0.25, from the demo credit',
      description: "Seven days, not one. Nothing to pay: it is drawn from the $1 this demo gives every visitor — but it is still spent only after you approve it.",
      gate: toll.price('$0.25', { resource: 'tool:forecast_week', access: [credits({ name: 'guest-credit', balance: guests, account: () => 'demo_guest' })] }),
    },
    toolSummarize: {
      call: 'tool:summarize',
      price: 'up to $0.50, then $0.001 per word',
      description: 'Over MCP, and charged only after the person at the client approves the maximum.',
      gate: toll.price(upTo('$0.50'), { resource: 'tool:summarize' }),
    },
  };
}

/**
 * What an agent can read before it calls anything: what is on sale, what it costs, and what will
 * happen to the money. Every field below `plan` is Tollstile's own description of the route.
 */
export function catalog(env: Env): Record<string, unknown> {
  return {
    tollstile: '0.1',
    service: {
      name: 'Tollstile demo',
      docs: 'https://tollstile.com/docs',
      mcp: 'https://demo.tollstile.com/mcp',
      ledger: 'https://demo.tollstile.com/api/charges',
    },
    payment: {
      note: 'The test rail: paying costs nothing. Send `Payment: test quote=<quote>`, or `_meta["tollstile/test-payment"]` over MCP.',
      idempotency: 'Send `Idempotency-Key`, or `_meta["tollstile/idempotency-key"]`. A repeat is answered `already_paid` with a reference to what the first call produced.',
    },
    offers: Object.values(offers(env)).map(({ call, price, description, gate }) => ({ call, price, description, plan: gate.plan })),
  };
}
