import { flowFor } from './capabilities';
import { canonicalJson, deriveId, hex, sha256, sha256Bytes } from './codec';
import { TollstileError } from './errors';
import {
  move,
  recordSettled,
  refundCharge,
  releaseCharge,
  settleCharge,
  type Current,
  type Executor,
  type Runtime,
} from './lifecycle';
import { compare, formatMoney, parseMoney, type Money } from './money';
import { policyExecutor } from './policy-executor';
import { callProvider } from './provider-call';
import type { Flow } from './states';
import type {
  AccessPolicy,
  Authorization,
  ChallengeOffer,
  Charge,
  Commitment,
  Completion,
  Context,
  Denial,
  DynamicPrice,
  Entry,
  FulfillOptions,
  Gate,
  JsonObject,
  Offer,
  Outcome,
  Pass,
  Quote,
  Rail,
  Receipt,
  Requirement,
  UpTo,
  VerifyTerms,
} from './types';

export type Route = {
  readonly name: string;
  readonly resource: string | undefined;
  readonly price: { readonly kind: 'fixed'; readonly price: Money; readonly variable: boolean } | { readonly kind: 'dynamic'; readonly compute: DynamicPrice };
  readonly access: readonly AccessPolicy[] | undefined;
  readonly requirements: readonly Requirement[];
  readonly flow: Flow | undefined;
  readonly commit: Commitment;
};

type Priced = { readonly price: Money; readonly variable: boolean };
type Denied = { readonly kind: 'denied'; readonly denial: Denial };

const NO_RECEIPT: Receipt = { headers: [], meta: {} };
const NOTHING_CHARGED: Completion = { settlement: 'none', receipt: NO_RECEIPT, denial: null };

export function createGate<Rails extends readonly Rail[]>(runtime: Runtime, route: Route): Gate<Rails> {
  return {
    resource: route.resource,
    async enter(input) {
      const context = route.resource === undefined ? input : { ...input, resource: route.resource };
      if (route.access === undefined) return enterWithPayment<Rails>(runtime, route, context);

      let priced: Priced | undefined;
      for (const policy of route.access) {
        priced ??= await resolvePrice(route, context);
        const decision = await policy.evaluate(context, priced.price);
        switch (decision.kind) {
          case 'skip':
            continue;
          case 'pay':
            return enterWithPayment<Rails>(runtime, route, context);
          case 'grant':
            return admitGrant<Rails>(runtime, route, context, policy, decision.account, priced);
          case 'reserve': {
            const entry = await admitReservation<Rails>(runtime, route, context, policy, decision.account, priced);
            if (entry !== 'insufficient') return entry;
            continue;
          }
        }
      }
      return denied(runtime, context, 403, { error: 'access_denied', resource: context.resource });
    },
  };
}

// ─── Policies ─────────────────────────────────────────────────────────────────

async function admitGrant<Rails extends readonly Rail[]>(
  runtime: Runtime,
  route: Route,
  context: Context,
  policy: AccessPolicy,
  account: string,
  priced: Priced,
): Promise<Entry<Rails>> {
  const denial = await checkRequirements(runtime, route, context, account, priced.price, null);
  if (denial) return denial;

  let completed = false;
  const pass: Pass<Rails> = {
    payment: { via: 'policy', policy: policy.name, account, chargeId: null, amount: priced.price, fulfill: () => Promise.resolve() },
    complete() {
      completed = assertOnce(completed, `${policy.name}:${account}`);
      return Promise.resolve(NOTHING_CHARGED);
    },
  };
  return { kind: 'admitted', pass };
}

async function admitReservation<Rails extends readonly Rail[]>(
  runtime: Runtime,
  route: Route,
  context: Context,
  policy: AccessPolicy,
  account: string,
  priced: Priced,
): Promise<Entry<Rails> | 'insufficient'> {
  if (policy.balance === undefined) {
    throw new TollstileError('CONFIG_INVALID', `Policy "${policy.name}" returned a reserve decision but has no balance.`);
  }
  const denial = await checkRequirements(runtime, route, context, account, priced.price, null);
  if (denial) return denial;

  const executor = policyExecutor(policy.name, policy.balance);
  const { authorization } = await runtime.ledger.openAuthorization({
    id: await deriveId('auth', executor.name, account),
    rail: executor.name,
    payer: account,
    kind: 'reusable',
    limit: null,
    quoteId: null,
    expiresAt: null,
    data: { account },
    at: runtime.clock.now(),
  });
  const created = await createCharge(runtime, context, authorization, priced.price, 'authorization', 'pending');
  if (created.status !== 'created') throw unexpectedCharge(created.status, authorization.id);

  const reservation = await policy.balance.reserve(account, priced.price, created.charge.id);
  if (reservation === 'insufficient') {
    await move(runtime, created.charge, { payment: 'released', fulfillment: 'failed' }, { pending: null });
    return 'insufficient';
  }

  const running = await move(runtime, created.charge, { payment: 'reserved', fulfillment: 'running' });
  const lifecycle = settleAfter(runtime, executor, running, priced, context);
  let completed = false;
  const pass: Pass<Rails> = {
    payment: {
      via: 'policy',
      policy: policy.name,
      account,
      chargeId: running.charge.id,
      amount: priced.price,
      fulfill: (options) => lifecycle.fulfill(options),
    },
    async complete(outcome) {
      completed = assertOnce(completed, running.charge.id);
      return reportFailure(runtime, running.charge, async () => {
        const result = await lifecycle.complete(outcome);
        return { settlement: result.settlement, receipt: NO_RECEIPT, denial: null };
      });
    },
  };
  return { kind: 'admitted', pass };
}

// ─── Rails ────────────────────────────────────────────────────────────────────

async function enterWithPayment<Rails extends readonly Rail[]>(runtime: Runtime, route: Route, context: Context): Promise<Entry<Rails>> {
  const fixed = route.price.kind === 'fixed' ? route.price : undefined;

  for (const rail of runtime.rails) {
    const terms: VerifyTerms = {
      resource: context.resource,
      price: fixed?.price ?? null,
      variable: fixed?.variable ?? false,
      flow: flowFor(rail, route.flow, fixed?.variable ?? false, route.name),
      openQuote: (token) => runtime.quotes.open(token, context),
    };
    const verification = await callProvider(`${context.requestId}:verify:${rail.name}`, runtime.providerTimeoutMs, (operation) =>
      rail.verify(context, terms, operation),
    );
    if (!verification.ok) {
      runtime.emit({ type: 'error', error: verification.error, charge: null });
      return denied(runtime, context, 503, { error: 'payment_unavailable', rail: rail.name });
    }

    const result = verification.value;
    switch (result.status) {
      case 'absent':
        continue;
      case 'invalid':
        return challenge(runtime, route, context, result.reason);
      case 'valid':
        return admitPayment<Rails>(runtime, route, context, rail, result);
    }
  }
  return challenge(runtime, route, context, undefined);
}

async function admitPayment<Rails extends readonly Rail[]>(
  runtime: Runtime,
  route: Route,
  context: Context,
  rail: Rail,
  proof: Extract<Awaited<ReturnType<Rail['verify']>>, { status: 'valid' }>,
): Promise<Entry<Rails>> {
  const terms = await termsFor(route, rail, proof.quote, context);
  if (typeof terms === 'string') return challenge(runtime, route, context, terms);
  if (proof.limit !== null && rail.capabilities.authorization === 'single' && compare(proof.limit, terms.price) < 0) {
    return challenge(runtime, route, context, 'insufficient_authorization');
  }

  const denial = await checkRequirements(runtime, route, context, proof.payer, terms.price, proof.quote);
  if (denial) return denial;

  const opened = await runtime.ledger.openAuthorization({
    id: await deriveId('auth', rail.name, proof.proofId),
    rail: rail.name,
    payer: proof.payer,
    kind: rail.capabilities.authorization,
    limit: proof.limit,
    quoteId: proof.quote?.id ?? null,
    expiresAt: proof.expiresAt,
    data: proof.data,
    at: runtime.clock.now(),
  });
  runtime.emit({ type: 'authorization.opened', authorization: opened.authorization, created: opened.created });

  // A payment that moved during verification is recorded as upfront: the money moved before the handler ran.
  const flow = proof.settled === undefined ? terms.flow : 'upfront';
  const created = await createCharge(runtime, context, opened.authorization, terms.price, flow, flow === 'authorization' ? 'running' : 'pending');
  switch (created.status) {
    case 'busy':
      return challenge(runtime, route, context, 'proof_already_used');
    case 'insufficient':
      return challenge(runtime, route, context, 'insufficient_authorization');
    case 'expired':
      return challenge(runtime, route, context, 'authorization_expired');
    case 'exists':
    case 'missing':
      throw unexpectedCharge(created.status, opened.authorization.id);
    case 'created':
      break;
  }

  const current: Current = { charge: created.charge, authorization: created.authorization };
  const lifecycle =
    proof.settled !== undefined
      ? paidAtVerification(runtime, rail, await recordSettled(runtime, current, proof.settled))
      : terms.flow === 'upfront'
        ? await settleBefore(runtime, route, context, rail, current)
        : settleAfter(runtime, rail, current, terms, context);
  if ('kind' in lifecycle) return lifecycle;

  let completed = false;
  const pass: Pass<Rails> = {
    payment: {
      via: 'rail',
      rail: rail.name,
      payer: proof.payer,
      authorizationId: current.authorization.id,
      chargeId: current.charge.id,
      amount: terms.price,
      fulfill: (options) => lifecycle.fulfill(options),
    },
    async complete(outcome) {
      completed = assertOnce(completed, current.charge.id);
      return reportFailure(runtime, current.charge, async () => {
        const result = await lifecycle.complete(outcome);
        switch (result.settlement) {
          case 'settled':
            return { settlement: 'settled', receipt: rail.receipt(result.authorization, result.charge, context), denial: null };
          case 'rejected':
            return { settlement: 'rejected', receipt: NO_RECEIPT, denial: await rejectedDenial(runtime, route, context) };
          case 'unknown':
          case 'none':
            return { settlement: result.settlement, receipt: NO_RECEIPT, denial: null };
        }
      });
    },
  };
  return { kind: 'admitted', pass };
}

/**
 * The price a proof pays. A single-use proof pays its quote, which must commit to this request:
 * otherwise a quote priced for a small request could pay for a large one. A reusable authorization
 * pays the current price of each request against its limit, so only the offer is taken from the quote.
 */
async function termsFor(
  route: Route,
  rail: Rail,
  quote: Quote | null,
  context: Context,
): Promise<(Priced & { readonly flow: Flow }) | 'quote_required' | 'quote_offer_missing' | 'quote_mismatch'> {
  if (quote !== null) {
    const offer = quote.offers.find((candidate) => candidate.rail === rail.name);
    if (offer === undefined) return 'quote_offer_missing';
    if (rail.capabilities.authorization === 'reusable') return { ...(await resolvePrice(route, context)), flow: offer.flow };
    if (quote.commitment !== (await commitmentFor(route, context))) return 'quote_mismatch';
    return { price: quote.price, variable: quote.variable, flow: offer.flow };
  }
  if (route.price.kind === 'dynamic') return 'quote_required';
  return { price: route.price.price, variable: route.price.variable, flow: flowFor(rail, route.flow, route.price.variable, route.name) };
}

/** Hashes what the quote is bound to. MCP calls bind tool arguments, not the JSON-RPC envelope, which changes per retry. */
async function commitmentFor(route: Route, context: Context): Promise<string> {
  const method = context.mcp === null ? (context.request?.method ?? '') : 'tools/call';
  const parts = [route.commit === 'route' ? 'route' : 'request', method, context.resource];
  if (route.commit === 'request') {
    if (context.mcp !== null) {
      parts.push(context.mcp.tool, canonicalJson(context.mcp.arguments));
    } else if (context.request !== null) {
      const url = new URL(context.request.url);
      parts.push(`${url.pathname}${url.search}`, hex(await sha256Bytes(await readableCopy(context.request).arrayBuffer())));
    }
  } else if (typeof route.commit === 'function') {
    parts.push('custom', await route.commit(withReadableRequest(context)));
  }
  return hex(await sha256(JSON.stringify(parts)));
}

/** Price and commitment functions read a copy, so the handler can still read the body. */
function withReadableRequest(context: Context): Context {
  return context.request === null ? context : { ...context, request: readableCopy(context.request) };
}

function readableCopy(request: Request): Request {
  if (request.bodyUsed) {
    throw new TollstileError(
      'CONFIG_INVALID',
      'The request body was read before Tollstile priced it. Run the Tollstile middleware before anything that reads the body.',
    );
  }
  return request.clone();
}

// ─── Flows ────────────────────────────────────────────────────────────────────

type Settled = { readonly settlement: 'settled' } & Current;
type LifecycleResult = Settled | { readonly settlement: 'rejected' | 'unknown' | 'none' };

type Lifecycle = {
  fulfill(options: FulfillOptions | undefined): Promise<void>;
  /** Carries the charge when it settled, so the adapter can attach a receipt. */
  complete(outcome: Outcome): Promise<LifecycleResult>;
};

const NONE = { settlement: 'none' } as const;

/** authorization: the handler runs on a reservation; the fulfilled amount settles afterwards. */
function settleAfter(runtime: Runtime, executor: Executor, reserved: Current, priced: Priced, context: Context): Lifecycle {
  let current = reserved;

  return {
    async fulfill(options) {
      if (current.charge.fulfillment !== 'running') {
        throw new TollstileError('ALREADY_COMPLETED', `fulfill() was already called for ${current.charge.id}. Call it once.`);
      }
      const amount = fulfilledAmount(options, priced);
      current = await move(runtime, current.charge, { payment: 'reserved', fulfillment: 'completed' }, { amount });
    },

    async complete(outcome) {
      if (current.charge.fulfillment === 'running') {
        if (outcome === 'failed') {
          await releaseCharge(runtime, executor, current, 'failed');
          return NONE;
        }
        if (priced.variable) {
          await releaseCharge(runtime, executor, current, 'failed');
          runtime.emit({
            type: 'error',
            error: new TollstileError(
              'FULFILLMENT_MISSING',
              `Charge ${current.charge.id} on ${context.resource} is priced up to ${formatMoney(priced.price)}, but the handler succeeded without payment.fulfill({ amount }). Nothing was charged.`,
            ),
            charge: current.charge,
          });
          return NONE;
        }
      }

      if (current.charge.amount.micros === 0n) {
        await releaseCharge(runtime, executor, current, 'completed');
        return NONE;
      }
      const settled = await settleCharge(runtime, executor, current, 'completed');
      return settled.status === 'settled'
        ? { settlement: 'settled', charge: settled.charge, authorization: settled.authorization }
        : { settlement: settled.status };
    },
  };
}

/** upfront: settles before the handler; a handler that fails before fulfilling is refunded. */
async function settleBefore(
  runtime: Runtime,
  route: Route,
  context: Context,
  rail: Rail,
  reserved: Current,
): Promise<Lifecycle | Denied> {
  const settled = await settleCharge(runtime, rail, reserved, 'pending');
  switch (settled.status) {
    case 'rejected':
      return challenge(runtime, route, context, 'payment_rejected');
    case 'unknown':
      return denied(runtime, context, 503, { error: 'payment_outcome_unknown', charge: settled.charge.id });
    case 'settled':
      break;
  }
  return paidAtVerification(runtime, rail, await move(runtime, settled.charge, { payment: 'settled', fulfillment: 'running' }));
}

/**
 * The handler runs on money that already moved. A handler that fails before fulfilling is refunded;
 * on a rail that cannot refund, the charge stays settled with failed fulfillment and is reported.
 */
function paidAtVerification(runtime: Runtime, rail: Rail, settled: Current): Lifecycle {
  let current = settled;

  return {
    async fulfill(options) {
      if (current.charge.fulfillment !== 'running') {
        throw new TollstileError('ALREADY_COMPLETED', `fulfill() was already called for ${current.charge.id}. Call it once.`);
      }
      fulfilledAmount(options, { price: current.charge.amount, variable: false });
      current = await move(runtime, current.charge, { payment: 'settled', fulfillment: 'completed' });
    },

    async complete(outcome) {
      if (current.charge.fulfillment === 'completed') return { settlement: 'settled', ...current };
      if (outcome === 'succeeded') {
        current = await move(runtime, current.charge, { payment: 'settled', fulfillment: 'completed' });
        return { settlement: 'settled', ...current };
      }
      if (rail.capabilities.refund) {
        await refundCharge(runtime, rail, current, 'failed');
        return NONE;
      }
      const kept = await move(runtime, current.charge, { payment: 'settled', fulfillment: 'failed' });
      runtime.emit({
        type: 'error',
        error: new TollstileError(
          'REFUND_REJECTED',
          `Charge ${kept.charge.id} was paid when "${rail.name}" verified it, the handler failed, and the rail cannot refund. Refund the payer outside Tollstile.`,
        ),
        charge: kept.charge,
      });
      return NONE;
    },
  };
}

function fulfilledAmount(options: FulfillOptions | undefined, priced: Priced): Money {
  if (!priced.variable) {
    if (options?.amount !== undefined && compare(parseMoney(options.amount), priced.price) !== 0) {
      throw new TollstileError(
        'INVALID_AMOUNT',
        `This route has a fixed price of ${formatMoney(priced.price)}. Use toll.price(upTo("${formatMoney(priced.price)}")) to settle a different amount.`,
      );
    }
    return priced.price;
  }
  if (options?.amount === undefined) {
    throw new TollstileError(
      'INVALID_AMOUNT',
      `This route is priced up to ${formatMoney(priced.price)}. Call payment.fulfill({ amount }) with the amount used.`,
    );
  }
  const amount = parseMoney(options.amount);
  if (compare(amount, priced.price) > 0) {
    throw new TollstileError('INVALID_AMOUNT', `Fulfilled amount ${formatMoney(amount)} exceeds the authorized maximum ${formatMoney(priced.price)}.`);
  }
  return amount;
}

// ─── Shared ───────────────────────────────────────────────────────────────────

async function createCharge(
  runtime: Runtime,
  context: Context,
  authorization: Authorization,
  amount: Money,
  flow: Flow,
  fulfillment: 'pending' | 'running',
) {
  return runtime.ledger.createCharge({
    id: await deriveId('chg', authorization.id, context.requestId),
    authorizationId: authorization.id,
    requestId: context.requestId,
    resource: context.resource,
    payer: authorization.payer,
    flow,
    amount,
    fulfillment,
    at: runtime.clock.now(),
  });
}

async function checkRequirements(
  runtime: Runtime,
  route: Route,
  context: Context,
  payer: string,
  price: Money,
  quote: Quote | null,
): Promise<Denied | undefined> {
  for (const requirement of route.requirements) {
    const call = await callProvider(`${context.requestId}:require:${requirement.name}`, runtime.providerTimeoutMs, (operation) =>
      requirement.check({
        context,
        price,
        payer,
        quote,
        ledger: runtime.ledger,
        claims: runtime.ledger,
        now: runtime.clock.now(),
        signal: operation.signal,
      }),
    );
    if (!call.ok) {
      runtime.emit({ type: 'error', error: call.error, charge: null });
      return denied(runtime, context, 503, { error: 'requirement_unavailable', requirement: requirement.name, reason: call.error.code });
    }
    const result = call.value;
    if (!result.ok) {
      return denied(runtime, context, result.status, {
        error: 'requirement_failed',
        requirement: requirement.name,
        reason: result.reason,
      });
    }
  }
  return undefined;
}

async function challenge(runtime: Runtime, route: Route, context: Context, reason: string | undefined): Promise<Denied> {
  const priced = await resolvePrice(route, context);
  const available: { readonly rail: Rail; readonly offer: Offer }[] = [];
  for (const rail of runtime.rails) {
    const offer = await rail.offer({ resource: context.resource, price: priced.price, variable: priced.variable });
    if (offer !== null) {
      available.push({ rail, offer: { ...offer, flow: flowFor(rail, route.flow, priced.variable, route.name) } });
    }
  }

  const { quote, token } = await runtime.quotes.issue({
    context,
    commitment: await commitmentFor(route, context),
    price: priced.price,
    variable: priced.variable,
    offers: available.map(({ offer }) => offer),
  });
  runtime.emit({ type: 'quote.issued', quote });

  const offers: ChallengeOffer[] = [];
  for (const { rail, offer } of available) {
    const call = await callProvider(`${quote.id}:challenge:${rail.name}`, runtime.providerTimeoutMs, (operation) =>
      rail.challenge(quote, token, offer, context, operation),
    );
    if (call.ok) {
      offers.push({ offer, challenge: call.value });
    } else {
      runtime.emit({ type: 'error', error: call.error, charge: null });
    }
  }
  if (available.length > 0 && offers.length === 0) {
    return denied(runtime, context, 503, { error: 'payment_unavailable', resource: context.resource });
  }

  const body: JsonObject = {
    error: reason === undefined ? 'payment_required' : 'payment_invalid',
    reason: reason ?? null,
    resource: context.resource,
    price: formatMoney(priced.price),
    variable: priced.variable,
    quote: token,
    nonce: quote.nonce,
    expiresAt: quote.expiresAt.toISOString(),
    accepts: offers.map(({ offer, challenge: railChallenge }) => ({
      rail: offer.rail,
      asset: { code: offer.asset.code, network: offer.asset.network, scale: offer.asset.scale },
      amount: offer.amount,
      flow: offer.flow,
      details: railChallenge.accepts,
    })),
  };
  runtime.emit({ type: 'request.denied', resource: context.resource, status: 402, reason: reason ?? 'payment_required' });
  return { kind: 'denied', denial: { status: 402, body, headers: [['cache-control', 'no-store']], offers } };
}

function denied(runtime: Runtime, context: Context, status: number, body: JsonObject): Denied {
  const reason = typeof body.reason === 'string' ? body.reason : typeof body.error === 'string' ? body.error : 'denied';
  runtime.emit({ type: 'request.denied', resource: context.resource, status, reason });
  return { kind: 'denied', denial: { status, body, headers: [['cache-control', 'no-store']], offers: [] } };
}

async function resolvePrice(route: Route, context: Context): Promise<Priced> {
  if (route.price.kind === 'fixed') return route.price;
  return parsePriceInput(await route.price.compute(withReadableRequest(context)), route.name);
}

export function parsePriceInput(input: string | UpTo, name: string): Priced {
  const variable = typeof input !== 'string';
  const price = parseMoney(variable ? input.amount : input);
  if (price.micros === 0n) {
    throw new TollstileError('CONFIG_INVALID', `Route "${name}" has a zero price. Leave the route unpriced instead.`);
  }
  return { price, variable };
}

/**
 * After a rejected settlement the output is withheld. A fresh quote needs the request body, which the
 * handler may have read by now; then the payer gets a plain 402 and asks again without payment.
 */
async function rejectedDenial(runtime: Runtime, route: Route, context: Context): Promise<Denial> {
  if (context.request === null || !context.request.bodyUsed) return (await challenge(runtime, route, context, 'settlement_rejected')).denial;
  return denied(runtime, context, 402, { error: 'payment_invalid', reason: 'settlement_rejected', resource: context.resource }).denial;
}

/** Reports a failure to record the outcome (e.g. the ledger is down) before it reaches the adapter. */
function reportFailure(runtime: Runtime, charge: Charge, run: () => Promise<Completion>): Promise<Completion> {
  return run().then(undefined, (error: unknown) => {
    runtime.emit({ type: 'error', error: error instanceof Error ? error : new Error(String(error)), charge });
    throw error;
  });
}

function assertOnce(completed: boolean, subject: string): true {
  if (completed) {
    throw new TollstileError('ALREADY_COMPLETED', `complete() was already called for ${subject}. Call it once, after the handler.`);
  }
  return true;
}

function unexpectedCharge(status: string, authorization: string): TollstileError {
  return new TollstileError(
    'LEDGER_INCONSISTENT',
    `Creating a charge on ${authorization} returned "${status}". A request id must never create a second charge.`,
  );
}

