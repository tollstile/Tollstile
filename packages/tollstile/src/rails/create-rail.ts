import { TollstileError } from '../core/errors';
import type { Flow } from '../core/states';
import type { AuthorizationKind, Context, Json, Operation, Rail, RefundResult, Verification, VerifyTerms } from '../core/types';

/** A rail author's definition. Everything a rail must decide is required; everything with a safe default is optional. */
export type RailDefinition<Name extends string, Data extends Json> = {
  /** Lowercase letters, digits, and dashes, e.g. `"acme-pay"`. Stored with every authorization: never rename a live rail. */
  readonly name: Name;
  /** False for rails that never move real money. */
  readonly livemode: boolean;
  readonly capabilities: {
    readonly flows: readonly Exclude<Flow, 'escrow'>[];
    readonly authorization: AuthorizationKind;
    /** The rail can settle less than it authorized, so `upTo()` prices work. Defaults to `false`. */
    readonly variableAmount?: boolean;
    /** The rail carries a signed quote through its protocol and returns it from `verify`. Defaults to `false`. */
    readonly quotes?: boolean;
    /** Refunds may be partial. Requires `refund`. Defaults to `false`. */
    readonly partialRefund?: boolean;
  };
  readonly offer: Rail<Name, Data>['offer'];
  readonly challenge: Rail<Name, Data>['challenge'];
  readonly verify: Rail<Name, Data>['verify'];
  readonly settle: Rail<Name, Data>['settle'];
  /** Required. Without it an unknown settlement outcome could only be guessed. */
  readonly lookup: Rail<Name, Data>['lookup'];
  /** Omit for rails that cannot refund. Required for the `upfront` flow. */
  readonly refund?: Rail<Name, Data>['refund'];
  /** Tell the provider a reserved amount will not be charged. Defaults to doing nothing. */
  readonly release?: Rail<Name, Data>['release'];
  /** Protocol receipt for a settled charge. Defaults to none. */
  readonly receipt?: Rail<Name, Data>['receipt'];
  /** Drop payer evidence once a single-use charge is final. Omit when `data` holds none. */
  readonly redact?: (data: Data) => Data;
};

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Builds a rail from a definition. It fills safe defaults, refuses declarations no route could use,
 * and checks every `verify` result against the contract (SPEC.md §6), so a rail bug fails loudly in
 * development instead of admitting a payment it should not. Prove the rail with `railConformance()`.
 */
export function createRail<const Name extends string, Data extends Json>(definition: RailDefinition<Name, Data>): Rail<Name, Data> {
  const { name, capabilities } = definition;
  if (!NAME.test(name)) {
    throw invalid(name, 'name must be lowercase letters, digits, and dashes, starting with a letter or digit.');
  }
  if (capabilities.flows.length === 0) throw invalid(name, 'capabilities.flows must name at least one flow.');
  const refund = definition.refund;
  if (refund === undefined && capabilities.flows.includes('upfront')) {
    throw invalid(name, 'the upfront flow settles before the handler and must refund when it fails. Provide refund(), or drop the upfront flow.');
  }
  if (refund === undefined && capabilities.partialRefund === true) throw invalid(name, 'partialRefund requires refund().');

  const quotes = capabilities.quotes ?? false;
  const redact = definition.redact;

  return {
    name,
    livemode: definition.livemode,
    capabilities: {
      flows: capabilities.flows,
      authorization: capabilities.authorization,
      variableAmount: capabilities.variableAmount ?? false,
      quotes,
      refund: refund !== undefined,
      partialRefund: capabilities.partialRefund ?? false,
      lookup: true,
    },
    offer: (terms) => definition.offer(terms),
    challenge: (quote, quoteToken, offer, context, operation) => definition.challenge(quote, quoteToken, offer, context, operation),
    async verify(context: Context, terms: VerifyTerms, operation: Operation): Promise<Verification<Data>> {
      return checkVerification(name, quotes, await definition.verify(context, terms, operation));
    },
    settle: (authorization, charge, operation) => definition.settle(authorization, charge, operation),
    refund:
      refund ??
      ((): Promise<RefundResult> => Promise.resolve({ status: 'rejected', reason: 'refund_unsupported' })),
    release: definition.release ?? (() => Promise.resolve()),
    lookup: (authorization, charge, operation) => definition.lookup(authorization, charge, operation),
    receipt: definition.receipt ?? (() => ({ headers: [], meta: {} })),
    ...(redact === undefined ? {} : { redact: (data: Data) => redact(data) }),
  };
}

/** Contract checks a rail cannot opt out of. A failure is a rail bug, so it throws instead of admitting the request. */
function checkVerification<Data extends Json>(name: string, quotes: boolean, result: Verification<Data>): Verification<Data> {
  switch (result.status) {
    case 'absent':
      return result;
    case 'invalid':
      if (!/^[a-z0-9_:.-]{1,120}$/.test(result.reason)) {
        throw invalid(name, `verify() returned reason ${JSON.stringify(result.reason)}. Use a stable snake_case identifier; it is shown to clients as error.detail.`);
      }
      if (result.proofId?.length === 0) throw invalid(name, 'verify() returned an empty proofId on an invalid result. Omit it instead.');
      return result;
    case 'valid':
      if (result.proofId.length === 0) throw invalid(name, 'verify() returned an empty proofId. It must be stable for the same proof.');
      if (result.payer.trim() !== result.payer || result.payer.length === 0) {
        throw invalid(name, `verify() returned payer ${JSON.stringify(result.payer)}. Return a canonical, trimmed payer id.`);
      }
      if (result.quote !== null && !quotes) throw invalid(name, 'verify() returned a quote, but the rail does not declare capabilities.quotes.');
      if (result.limit !== null && result.limit.micros < 0n) throw invalid(name, 'verify() returned a negative limit.');
      return result;
  }
}

function invalid(name: string, problem: string): TollstileError {
  return new TollstileError('CONFIG_INVALID', `Rail "${name}": ${problem}`);
}
