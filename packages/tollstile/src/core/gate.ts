import type { ExecutionPlan, RailPlan } from './capabilities';
import { canonicalJson, deriveId, hex, sha256, sha256Bytes } from './codec';
import { denialError, denialHeaders, errorJson, retryAfterSeconds, statusFor, type DenialCode } from './denials';
import { TollstileError } from './errors';
import { isValidIdempotencyKey } from './idempotency';
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
import { compare, formatMoney, parseMoney, subtract, type Money } from './money';
import { policyExecutor } from './policy-executor';
import { callProvider } from './provider-call';
import type { Flow } from './states';
import type {
  AccessPolicy,
  Authorization,
  ChallengeOffer,
  Charge,
  CreateChargeResult,
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
  readonly commit: Commitment;
  readonly plan: ExecutionPlan;
  /** The rails the plan kept, in configuration order, each with how it serves this route. */
  readonly rails: readonly PlannedRail[];
};

type PlannedRail = { readonly rail: Rail; readonly plan: RailPlan };

type Priced = { readonly price: Money; readonly variable: boolean };
type Denied = { readonly kind: 'denied'; readonly denial: Denial };

/** Why a request is refused, before it is rendered. `status` is set only by requirements, which choose their own. */
type Problem = {
  readonly code: DenialCode;
  readonly message: string;
  readonly detail?: string | null;
  readonly status?: number;
  readonly extra?: JsonObject;
};

/** A retry under one idempotency key may be refused this many times before the key must change. */
const MAX_ATTEMPTS_PER_KEY = 20;

const NO_RECEIPT: Receipt = { headers: [], meta: {} };
const NOTHING_CHARGED: Completion = { settlement: 'none', receipt: NO_RECEIPT, denial: null };

export function createGate<Rails extends readonly Rail[]>(runtime: Runtime, route: Route): Gate<Rails> {
  return {
    resource: route.resource,
    plan: route.plan,
    async enter(input) {
      const input0 = route.resource === undefined ? input : { ...input, resource: route.resource };
      if (input0.idempotencyKey !== null && !isValidIdempotencyKey(input0.idempotencyKey)) {
        return deny(runtime, input0, { code: 'invalid_request', message: 'An idempotency key must be 1 to 255 visible ASCII characters.' });
      }
      // Before the body is read, the price computed, or a rail contacted: everything after this line
      // is work an unauthenticated caller asked for, and its size is theirs to choose until here.
      if (declaredBytes(input0) > runtime.maxRequestBytes) return tooLarge(runtime, input0);
      // A body without a declared length is bounded while it is read, and only when the route will
      // read it: what core prices, it holds in memory, and never more than maxRequestBytes of it.
      const context = await boundedBody(input0, route, runtime);
      if (context === 'too_large') return tooLarge(runtime, input0);
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
      return deny(runtime, context, { code: 'access_denied', message: 'No access policy admits this caller.' });
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
  const created = await createCharge(runtime, route, context, authorization, priced.price, 'authorization', 'pending', context.idempotencyKey);
  if (created.status === 'denied') return created.denied;
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

  // Only rails the plan kept are consulted: a proof for a rail that cannot serve this route is never accepted.
  for (const { rail, plan } of route.rails) {
    const terms: VerifyTerms = {
      resource: context.resource,
      price: fixed?.price ?? null,
      variable: fixed?.variable ?? false,
      flow: plan.flow,
      openQuote: (token) => runtime.quotes.open(token, context),
    };
    const verification = await callProvider(`${context.requestId}:verify:${rail.name}`, runtime.providerTimeoutMs, (operation) =>
      rail.verify(context, terms, operation),
    );
    if (!verification.ok) {
      runtime.emit({ type: 'error', error: verification.error, charge: null });
      return deny(runtime, context, { code: 'payment_unavailable', message: `The ${rail.name} payment could not be verified right now.`, extra: { rail: rail.name } });
    }

    const result = verification.value;
    switch (result.status) {
      case 'absent':
        continue;
      case 'invalid':
        return (await alreadyUsed(runtime, route, context, rail, result.proofId, context.idempotencyKey ?? result.idempotencyKey ?? null)) ?? challenge(runtime, route, context, invalidProof(rail, result.reason));
      case 'valid':
        return admitPayment<Rails>(runtime, route, context, { rail, plan }, result);
    }
  }
  return challenge(runtime, route, context, undefined);
}

/**
 * A rejected proof that identifies an authorization this ledger already charged is a retry, not a
 * bad payment: telling the client to pay again would make it pay twice for one request.
 */
async function alreadyUsed(
  runtime: Runtime,
  route: Route,
  context: Context,
  rail: Rail,
  proofId: string | undefined,
  key: string | null,
): Promise<Denied | undefined> {
  if (proofId === undefined) return undefined;
  const authorization = await runtime.ledger.getAuthorization(await deriveId('auth', rail.name, proofId));
  if (authorization === undefined) return undefined;

  if (key !== null) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_KEY; attempt += 1) {
      const existing = await runtime.ledger.getCharge(await deriveId('chg', 'key', authorization.payer, key, String(attempt)));
      if (existing === undefined) break;
      if (existing.payment !== 'released' && existing.payment !== 'refunded') return retried(runtime, route, context, existing);
    }
  }
  if (authorization.kind === 'single' && (authorization.reserved.micros > 0n || authorization.consumed.micros > 0n)) {
    return deny(runtime, context, {
      code: 'proof_already_used',
      message: 'This payment was already used for another request. To retry a request safely, send the same Idempotency-Key.',
    });
  }
  return undefined;
}

function invalidProof(rail: Rail, reason: string): Problem {
  if (reason === 'quote_invalid') {
    return { code: 'quote_invalid', message: 'The quote is forged, expired, or for another resource. Pay with the new quote in this response.' };
  }
  return { code: 'proof_invalid', message: `The ${rail.name} payment was not accepted. Pay again using this response.`, detail: reason };
}

async function admitPayment<Rails extends readonly Rail[]>(
  runtime: Runtime,
  route: Route,
  context: Context,
  { rail, plan }: PlannedRail,
  proof: Extract<Awaited<ReturnType<Rail['verify']>>, { status: 'valid' }>,
): Promise<Entry<Rails>> {
  const terms = await termsFor(route, { rail, plan }, proof.quote, context);
  if ('code' in terms) return challenge(runtime, route, context, terms);
  if (proof.limit !== null && rail.capabilities.authorization === 'single' && compare(proof.limit, terms.price) < 0) {
    return challenge(runtime, route, context, insufficient(terms.price, proof.limit));
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
  const created = await createCharge(
    runtime,
    route,
    context,
    opened.authorization,
    terms.price,
    flow,
    flow === 'authorization' ? 'running' : 'pending',
    context.idempotencyKey ?? proof.idempotencyKey ?? null,
  );
  switch (created.status) {
    case 'denied':
      return created.denied;
    case 'busy':
      return deny(runtime, context, {
        code: 'proof_already_used',
        message: 'This payment was already used for another request. To retry a request safely, send the same Idempotency-Key.',
      });
    case 'insufficient':
      return challenge(runtime, route, context, insufficient(terms.price, remaining(opened.authorization)));
    case 'expired':
      return challenge(runtime, route, context, { code: 'authorization_expired', message: 'The payment authorization has expired. Pay again using this response.' });
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
  { rail, plan }: PlannedRail,
  quote: Quote | null,
  context: Context,
): Promise<(Priced & { readonly flow: Flow }) | Problem> {
  if (quote !== null) {
    const offer = quote.offers.find((candidate) => candidate.rail === rail.name);
    if (offer === undefined) {
      return { code: 'quote_offer_missing', message: `The quote has no offer for ${rail.name}. Pay with an offer from this response.` };
    }
    if (rail.capabilities.authorization === 'reusable') {
      const priced = await resolvePrice(route, context);
      if (priced.variable && plan.amounts !== 'up_to') {
        return { code: 'quote_offer_missing', message: `${rail.name} cannot settle a variable amount for this request. Pay with an offer from this response.` };
      }
      return { ...priced, flow: offer.flow };
    }
    if (quote.commitment !== (await commitmentFor(route, context))) {
      return { code: 'quote_mismatch', message: 'The quote was issued for a different request. Pay with the new quote issued for this one.' };
    }
    return { price: quote.price, variable: quote.variable, flow: offer.flow };
  }
  if (route.price.kind === 'dynamic') {
    return { code: 'quote_required', message: 'This price is computed per request. Pay with the quote in this response.' };
  }
  return { price: route.price.price, variable: route.price.variable, flow: plan.flow };
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


function tooLarge(runtime: Runtime, context: Context): Denied {
  return deny(runtime, context, {
    code: 'invalid_request',
    message: `The request body is larger than this route will price (${String(runtime.maxRequestBytes)} bytes).`,
    detail: 'request_too_large',
  });
}

/**
 * Replaces the request with one whose body is in memory and no larger than the limit, when the
 * route will read it: a computed price, a commitment to the request, or an idempotency key (whose
 * request hash covers the body). Routes that never read the body are left alone, and the caller's
 * own request is untouched either way — the copy is read, and the original still streams to the
 * handler.
 */
async function boundedBody(context: Context, route: Route, runtime: Runtime): Promise<Context | 'too_large'> {
  const { request } = context;
  if (request === null || request.body === null) return context;
  if (route.price.kind !== 'dynamic' && route.commit === 'route' && context.idempotencyKey === null) return context;

  const reader = readableCopy(request).body?.getReader();
  if (reader === undefined) return context;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > runtime.maxRequestBytes) {
      // Not cancelled: cancelling one branch of a cloned body does not settle in Node's fetch while
      // the other branch is unread. The copy is dropped along with the denied request.
      reader.releaseLock();
      return 'too_large';
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ...context, request: new Request(request.url, { method: request.method, headers: request.headers, body }) };
}

/**
 * What the request says it is carrying. A body without a declared length is bounded by the runtime
 * or whatever sits in front of it, not by this check.
 */
function declaredBytes(context: Context): number {
  const declared = context.request?.headers.get('content-length');
  return declared === null || declared === undefined ? 0 : (Number.parseInt(declared, 10) || 0);
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
      current = await move(runtime, current.charge, { payment: 'reserved', fulfillment: 'completed' }, { amount, ...resultRefOf(options) });
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
      return challenge(runtime, route, context, { code: 'payment_rejected', message: 'The provider rejected the payment. Pay again using this response.' });
    case 'unknown':
      return deny(runtime, context, outcomeUnknown(settled.charge));
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
      current = await move(runtime, current.charge, { payment: 'settled', fulfillment: 'completed' }, resultRefOf(options));
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

const MAX_RESULT_REF_LENGTH = 1024;

function resultRefOf(options: FulfillOptions | undefined): { readonly resultRef?: string } {
  const resultRef = options?.resultRef;
  if (resultRef === undefined) return {};
  if (resultRef.length === 0 || resultRef.length > MAX_RESULT_REF_LENGTH) {
    throw new TollstileError('CONFIG_INVALID', `payment.fulfill({ resultRef }) must be 1 to ${String(MAX_RESULT_REF_LENGTH)} characters.`);
  }
  return { resultRef };
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

type ChargeAttempt =
  | Extract<CreateChargeResult, { readonly status: 'created' }>
  | { readonly status: 'busy' | 'insufficient' | 'expired' }
  | { readonly status: 'denied'; readonly denied: Denied };

/**
 * Creates the charge a request runs on. Without an idempotency key, every request is new. With one,
 * a retry finds the charge its first attempt created and is answered from that charge's state, so a
 * client that retries after a lost response never pays twice. See SPEC.md §11.
 */
async function createCharge(
  runtime: Runtime,
  route: Route,
  context: Context,
  authorization: Authorization,
  amount: Money,
  flow: Flow,
  fulfillment: 'pending' | 'running',
  key: string | null,
): Promise<ChargeAttempt> {
  const charge = {
    authorizationId: authorization.id,
    requestId: context.requestId,
    resource: context.resource,
    payer: authorization.payer,
    flow,
    amount,
    fulfillment,
    at: runtime.clock.now(),
  };
  if (key === null) {
    const created = await runtime.ledger.createCharge({ ...charge, id: await deriveId('chg', authorization.id, context.requestId), requestHash: null });
    if (created.status === 'exists' || created.status === 'missing') throw unexpectedCharge(created.status, authorization.id);
    return created.status === 'created' ? created : { status: created.status };
  }

  // A key identifies one request; the route's own commitment decides what "the same request" means,
  // and never less than the request itself.
  const requestHash = await commitmentFor(route.commit === 'route' ? { ...route, commit: 'request' } : route, context);
  for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_KEY; attempt += 1) {
    // Keys are scoped to the payer, not the proof: a client that retries with a freshly signed payment
    // is still asking for the same request. Payer ids are verified by the rail, so one payer cannot
    // occupy another's keys.
    const id = await deriveId('chg', 'key', authorization.payer, key, String(attempt));
    const created = await runtime.ledger.createCharge({ ...charge, id, requestHash });
    if (created.status === 'missing') throw unexpectedCharge(created.status, authorization.id);
    if (created.status === 'created') return created;
    if (created.status !== 'exists') return { status: created.status };

    const existing = created.charge;
    if (existing.requestHash !== requestHash) {
      return { status: 'denied', denied: deny(runtime, context, { code: 'idempotency_key_reused', message: 'This idempotency key was used for a different request.' }) };
    }
    // Nothing was kept from a released or refunded attempt, so the request runs again.
    if (existing.payment === 'released' || existing.payment === 'refunded') continue;
    return { status: 'denied', denied: await retried(runtime, route, context, existing) };
  }
  return {
    status: 'denied',
    denied: deny(runtime, context, {
      code: 'idempotency_key_reused',
      message: `This idempotency key was retried ${String(MAX_ATTEMPTS_PER_KEY)} times without success. Use a new key.`,
    }),
  };
}

/** Answers a retry from the state of the charge its first attempt created. */
async function retried(runtime: Runtime, route: Route, context: Context, existing: Charge): Promise<Denied> {
  const extra = { chargeId: existing.id };
  switch (existing.payment) {
    case 'failed':
      return challenge(runtime, route, context, { code: 'settlement_rejected', message: 'The provider rejected this request\'s payment. Pay again using this response.', extra });
    case 'unknown':
      return deny(runtime, context, outcomeUnknown(existing));
    case 'settled':
      if (existing.fulfillment === 'completed' || existing.fulfillment === 'failed') {
        return deny(runtime, context, {
          code: 'already_paid',
          message:
            existing.fulfillment === 'completed'
              ? `This request was already paid (${existing.id}). It is not charged or run again.`
              : `This request was paid (${existing.id}) but not delivered, and the payment could not be refunded automatically. Contact the merchant.`,
          extra: { ...extra, settlement: existing.settlement?.reference ?? null, result: existing.resultRef },
        });
      }
      return inProgress(runtime, context, existing);
    case 'reserved':
    case 'settling':
    case 'refund_pending':
    case 'released':
    case 'refunded':
      return inProgress(runtime, context, existing);
  }
}

function inProgress(runtime: Runtime, context: Context, existing: Charge): Denied {
  return deny(runtime, context, {
    code: 'request_in_progress',
    message: 'A request with this idempotency key is still being processed.',
    extra: { chargeId: existing.id },
  });
}

function outcomeUnknown(charge: Charge): Problem {
  return {
    code: 'payment_outcome_unknown',
    message: 'The settlement outcome is not known yet. Retry later with the same payment and idempotency key.',
    extra: { chargeId: charge.id },
  };
}

function insufficient(required: Money, authorized: Money): Problem {
  return {
    code: 'insufficient_authorization',
    message: `The payment authorizes ${formatMoney(authorized)}; this request costs ${formatMoney(required)}.`,
    extra: { required: formatMoney(required), authorized: formatMoney(authorized) },
  };
}

/** What is left on an authorization; a limitless one never reports insufficient. */
function remaining(authorization: Authorization): Money {
  const { limit } = authorization;
  if (limit === null) return authorization.consumed;
  const left = subtract(subtract(limit, authorization.consumed), authorization.reserved);
  return left.micros < 0n ? { currency: left.currency, micros: 0n } : left;
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
    const unavailable = `Requirement "${requirement.name}" could not be checked right now.`;
    if (!call.ok) {
      runtime.emit({ type: 'error', error: call.error, charge: null });
      return deny(runtime, context, { code: 'requirement_unavailable', message: unavailable, detail: call.error.code, extra: { requirement: requirement.name } });
    }
    const result = call.value;
    if (!result.ok) {
      return deny(
        runtime,
        context,
        result.status === 503
          ? { code: 'requirement_unavailable', message: unavailable, detail: result.reason, extra: { requirement: requirement.name } }
          : {
              code: 'requirement_failed',
              status: result.status,
              message: `Requirement "${requirement.name}" was not met.`,
              detail: result.reason,
              extra: { requirement: requirement.name },
            },
      );
    }
  }
  return undefined;
}

async function challenge(runtime: Runtime, route: Route, context: Context, problem: Problem | undefined): Promise<Denied> {
  const priced = await resolvePrice(route, context);
  const candidates = railsFor(route, priced.variable);
  if (candidates.length === 0) {
    throw new TollstileError(
      'CAPABILITY_MISSING',
      `Route "${route.name}" computed an upTo() price, but no configured rail can settle a variable amount. Return a fixed price, or add a rail with variable amounts.`,
    );
  }
  const available: { readonly rail: Rail; readonly offer: Offer }[] = [];
  for (const { rail, plan } of candidates) {
    const offer = await rail.offer({ resource: context.resource, price: priced.price, variable: priced.variable });
    if (offer !== null) available.push({ rail, offer: { ...offer, flow: plan.flow } });
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
    return deny(runtime, context, { code: 'payment_unavailable', message: 'No payment rail could issue a challenge right now.' });
  }

  const { code, message, detail = null, extra = {} } = problem ?? {
    code: 'payment_required',
    message: `Payment required: ${formatMoney(priced.price)}${priced.variable ? ' at most' : ''} for ${context.resource}.`,
  };
  const error = denialError(code, 402, message, detail);
  const retryAfter = error.action === 'retry_later' ? retryAfterSeconds() : null;
  const body: JsonObject = {
    error: errorJson(error),
    ...(retryAfter === null ? {} : { retryAfter }),
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
    ...extra,
  };
  runtime.emit({ type: 'request.denied', resource: context.resource, status: 402, code });
  return { kind: 'denied', denial: { status: 402, error, body, headers: denialHeaders(error, retryAfter), offers } };
}

/** A denial without a payment challenge. */
function deny(runtime: Runtime, context: Context, problem: Problem): Denied {
  const status = problem.status ?? statusFor(problem.code);
  const error = denialError(problem.code, status, problem.message, problem.detail ?? null);
  const retryAfter = error.action === 'retry_later' ? retryAfterSeconds() : null;
  const body: JsonObject = {
    error: errorJson(error),
    ...(retryAfter === null ? {} : { retryAfter }),
    resource: context.resource,
    ...problem.extra,
  };
  runtime.emit({ type: 'request.denied', resource: context.resource, status, code: problem.code });
  return { kind: 'denied', denial: { status, error, body, headers: denialHeaders(error, retryAfter), offers: [] } };
}

/** A computed price is known per request; an `upTo()` result can only use rails planned for variable amounts. */
function railsFor(route: Route, variable: boolean): readonly PlannedRail[] {
  return variable ? route.rails.filter(({ plan }) => plan.amounts === 'up_to') : route.rails;
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
  const message = 'The provider rejected settlement, so the output was withheld.';
  if (context.request === null || !context.request.bodyUsed) {
    return (await challenge(runtime, route, context, { code: 'settlement_rejected', message: `${message} Pay again using this response.` })).denial;
  }
  return deny(runtime, context, { code: 'settlement_rejected', message: `${message} Send the request again without payment for a new quote.` }).denial;
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

