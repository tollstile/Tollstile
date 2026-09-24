import {
  money,
  TollstileError,
  toAssetUnits,
  type Charge,
  type JsonObject,
  type Money,
  type Quote,
  type Rail,
  type Verification,
} from 'tollstile';
import { resolveFacilitator } from './facilitator';
import { jsonRpcChain } from './json-rpc';
import { sameAddress, UPTO_PROXY_ADDRESS } from './networks';
import { resolveOptions, type Settings, type X402Options } from './options';
import { parseEip3009, parsePermit2, paymentIdentifier, readProof } from './payment-payload';
import { acceptedMatches, paymentRequired, QUOTE_EXTRA_KEY, requirementsFor, type PaymentRequirements } from './payment-requirements';
import { lookupSettlement } from './settlement-lookup';
import { encodeBase64Json, objectField, textField } from './wire';
import type { X402Data } from './x402-data';

export type X402Rail = Rail<'x402', X402Data>;

const PAYMENT_REQUIRED_HEADER = 'payment-required';
const PAYMENT_RESPONSE_HEADER = 'payment-response';
const PAYMENT_RESPONSE_META = 'x402/payment-response';

const NAME = 'x402';
// `Date` cannot represent later instants; a signature valid that long is effectively unbounded.
const MAX_DATE_SECONDS = 8_640_000_000_000n;

type Signed = {
  readonly payer: string;
  readonly nonce: string;
  readonly validBefore: bigint;
  readonly authorizedAmount: bigint;
};

type Invalid = Extract<Verification, { status: 'invalid' }>;

/**
 * The x402 V2 rail: `exact` (EIP-3009) for fixed prices and `upto` (Permit2) for `upTo()` prices,
 * over HTTP (`PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE`) and MCP
 * (`_meta["x402/payment"]`). Payments are verified before the handler and settled after it.
 *
 * @example
 * ```ts
 * const toll = createTollstile({
 *   rails: [
 *     x402({
 *       network: 'eip155:84532',
 *       payTo: '0xYourAddress',
 *       denomination: 'USD',
 *       rpcUrl: 'https://sepolia.base.org',
 *     }),
 *   ],
 *   ledger: memoryLedger(),
 *   secret: process.env.TOLLSTILE_SECRET,
 * });
 * ```
 */
export function x402(options: X402Options): X402Rail {
  const settings = resolveOptions(options);
  const facilitator = resolveFacilitator(settings.facilitator, settings.fetch);
  const chain = jsonRpcChain(settings.rpcUrl, settings.fetch);
  const { asset, network } = settings;

  return {
    name: NAME,
    livemode: true,
    capabilities: {
      // exact cannot be refunded, so the payer is charged only after the handler succeeded.
      flows: ['authorization'],
      authorization: 'single',
      variableAmount: settings.upto !== null,
      quotes: true,
      refund: false,
      partialRefund: false,
      lookup: true,
    },

    async offer({ price, variable }) {
      if (variable && settings.upto === null) return null;
      const amount = await assetUnits(settings, price);
      if (amount === null) return null;
      return {
        rail: NAME,
        asset: { code: asset.code, network, scale: asset.decimals },
        amount: amount.toString(),
        basis: settings.basis.kind,
        details: {},
      };
    },

    challenge(quote, quoteToken, offer, context) {
      const requirements = requirementsFor(settings, { amount: offer.amount, variable: quote.variable, quoteToken });
      const body = paymentRequired(requirements, context);
      return Promise.resolve({
        headers: [[PAYMENT_REQUIRED_HEADER, encodeBase64Json(body)]],
        accepts: body,
        mcp: { style: 'x402', paymentRequired: body },
      });
    },

    async verify(context, terms, operation) {
      const proof = readProof(context);
      if (proof.status !== 'present') return proof;

      const identifier = paymentIdentifier(proof.paymentPayload);
      if (identifier.status === 'invalid') return invalid('payment_identifier_invalid');
      const idempotency = identifier.status === 'present' ? { idempotencyKey: identifier.id } : {};

      const extra = objectField(proof.accepted, 'extra');
      const quoteToken = extra === undefined ? undefined : textField(extra, QUOTE_EXTRA_KEY);
      const priced = quoteToken === undefined ? await routeTerms(settings, terms) : quotedTerms(settings, await terms.openQuote(quoteToken));
      if ('status' in priced) {
        // An expired quote on a payment this server already charged is a retry; let core recognize it.
        const identified = priced.reason === 'quote_invalid' ? identify(proof.payload, settings) : undefined;
        return identified === undefined ? priced : { ...priced, proofId: identified, ...idempotency };
      }

      if (priced.variable && settings.upto === null) return invalid('variable_amount_unsupported');
      const requirements = requirementsFor(settings, { amount: priced.amount, variable: priced.variable, quoteToken: quoteToken ?? null });
      if (!acceptedMatches(requirements, proof.accepted)) return invalid('accepted_mismatch');

      const signed = requirements.scheme === 'exact' ? signedEip3009(proof.payload, requirements) : signedPermit2(proof.payload, requirements, settings);
      if ('status' in signed) return signed;

      // Always our own requirements: the client's copy is only trusted after it matched them.
      const verdict = await facilitator.verify({ x402Version: 2, paymentPayload: proof.paymentPayload, paymentRequirements: requirements }, operation);
      if (!verdict.isValid) {
        // A rejected but genuine payment (e.g. its nonce was already used) still names the
        // authorization it paid for, so core can answer a retry instead of asking to pay twice. A bad
        // signature proves no identity.
        const genuine = !verdict.invalidReason.includes('signature');
        return genuine ? { ...invalid(verdict.invalidReason), proofId: proofIdOf(settings, signed), ...idempotency } : invalid(verdict.invalidReason);
      }
      if (verdict.payer !== undefined && !sameAddress(verdict.payer, signed.payer)) return invalid('payer_mismatch');

      const limit = settings.basis.kind === 'par' ? money(settings.basis.currency, signed.authorizedAmount / 10n ** BigInt(asset.decimals - 6)) : priced.price;
      const data: X402Data = {
        scheme: requirements.scheme,
        network,
        asset: asset.address,
        payTo: settings.payTo,
        payer: signed.payer,
        nonce: signed.nonce,
        validBefore: signed.validBefore.toString(),
        authorizedAmount: signed.authorizedAmount.toString(),
        limitMicros: limit.micros.toString(),
        paymentPayload: proof.paymentPayload,
        paymentRequirements: requirements,
      };
      return {
        status: 'valid',
        proofId: proofIdOf(settings, signed),
        ...idempotency,
        payer: signed.payer,
        quote: priced.quote,
        limit,
        expiresAt: new Date(Number(signed.validBefore < MAX_DATE_SECONDS ? signed.validBefore : MAX_DATE_SECONDS) * 1000),
        data,
      };
    },

    async settle(authorization, charge, operation) {
      const { data } = authorization;
      // Redacted evidence cannot be settled. Rejecting records the charge as failed instead of
      // leaving it to reconciliation, which could never settle it either.
      if (data.paymentPayload === null || data.paymentRequirements === null) {
        return { status: 'rejected', reason: 'payment_evidence_redacted' };
      }
      const amount = settledUnits(data, charge).toString();
      const response = await facilitator.settle(
        { x402Version: 2, paymentPayload: data.paymentPayload, paymentRequirements: { ...data.paymentRequirements, amount } },
        operation,
      );
      if (!response.success) return { status: 'rejected', reason: response.errorReason };
      return {
        status: 'settled',
        reference: response.transaction,
        details: { transaction: response.transaction, network: data.network, payer: data.payer, amount },
      };
    },

    refund() {
      return Promise.reject(
        new TollstileError('UNREACHABLE', 'x402 exact and upto payments cannot be refunded, and the rail declares refund: false.'),
      );
    },

    // The signature expires at validBefore; there is nothing to cancel with the facilitator.
    release() {
      return Promise.resolve();
    },

    lookup(authorization, charge, operation) {
      return lookupSettlement(chain, authorization.data, charge, operation.signal);
    },

    // The signature is only needed to settle; lookup works from the nonce, payer, and deadline.
    redact(data) {
      return { ...data, paymentPayload: null, paymentRequirements: null };
    },

    receipt(authorization, charge, context) {
      if (charge.settlement === null) return { headers: [], meta: {} };
      const { data } = authorization;
      const response: JsonObject = {
        success: true,
        transaction: charge.settlement.reference,
        network: data.network,
        payer: data.payer,
        amount: settledUnits(data, charge).toString(),
      };
      return context.transport === 'mcp'
        ? { headers: [], meta: { [PAYMENT_RESPONSE_META]: response } }
        : { headers: [[PAYMENT_RESPONSE_HEADER, encodeBase64Json(response)]], meta: {} };
    },
  };
}

type Priced = { readonly price: Money; readonly amount: string; readonly variable: boolean; readonly quote: Quote | null };

function quotedTerms(settings: Settings, quote: Quote | undefined): Priced | Invalid {
  if (quote === undefined) return invalid('quote_invalid');
  const offer = quote.offers.find((candidate) => candidate.rail === NAME);
  if (offer === undefined) return invalid('quote_offer_missing');
  const { asset } = offer;
  if (asset.network !== settings.network || asset.code !== settings.asset.code || asset.scale !== settings.asset.decimals) {
    return invalid('quote_offer_mismatch');
  }
  return { price: quote.price, amount: offer.amount, variable: quote.variable, quote };
}

async function routeTerms(settings: Settings, terms: { readonly price: Money | null; readonly variable: boolean }): Promise<Priced | Invalid> {
  if (terms.price === null) return invalid('quote_required');
  const amount = await assetUnits(settings, terms.price);
  if (amount === null) return invalid('price_unsupported');
  return { price: terms.price, amount: amount.toString(), variable: terms.variable, quote: null };
}

/** The price in atomic units of the asset, or `null` when the configured basis cannot convert it. */
async function assetUnits(settings: Settings, price: Money): Promise<bigint | null> {
  const { basis, asset } = settings;
  if (basis.kind === 'par') return price.currency === basis.currency ? toAssetUnits(price, asset.decimals) : null;
  const amount = await basis.rate(price);
  if (amount <= 0n) {
    throw new TollstileError('CONFIG_INVALID', `x402: rate() converted a price to ${amount.toString()} ${asset.code} units; it must be positive.`);
  }
  return amount;
}

/** Stable per signed authorization: the same payment always maps to the same Tollstile authorization. */
function proofIdOf(settings: Settings, signed: Pick<Signed, 'payer' | 'nonce'>): string {
  return [settings.network, settings.asset.address, signed.payer, signed.nonce].join(':').toLowerCase();
}

/** The proof id of a well-formed payload, without checking it against any requirements. */
function identify(payload: JsonObject, settings: Settings): string | undefined {
  const eip3009 = parseEip3009(payload);
  if (eip3009 !== undefined) return proofIdOf(settings, { payer: eip3009.from.toLowerCase(), nonce: eip3009.nonce });
  const permit2 = parsePermit2(payload);
  return permit2 === undefined ? undefined : proofIdOf(settings, { payer: permit2.from.toLowerCase(), nonce: permit2.nonce.toString() });
}

function signedEip3009(payload: JsonObject, requirements: PaymentRequirements): Signed | Invalid {
  const authorization = parseEip3009(payload);
  if (authorization === undefined) return invalid('payload_invalid');
  if (!sameAddress(authorization.to, requirements.payTo)) return invalid('recipient_mismatch');
  if (authorization.value !== BigInt(requirements.amount)) return invalid('amount_mismatch');
  return {
    payer: authorization.from.toLowerCase(),
    nonce: authorization.nonce,
    validBefore: authorization.validBefore,
    authorizedAmount: authorization.value,
  };
}

function signedPermit2(payload: JsonObject, requirements: PaymentRequirements, settings: Settings): Signed | Invalid {
  const authorization = parsePermit2(payload);
  if (authorization === undefined || settings.upto === null) return invalid('payload_invalid');
  if (!sameAddress(authorization.token, requirements.asset)) return invalid('asset_mismatch');
  if (!sameAddress(authorization.to, requirements.payTo)) return invalid('recipient_mismatch');
  if (authorization.amount !== BigInt(requirements.amount)) return invalid('amount_mismatch');
  if (!sameAddress(authorization.spender, UPTO_PROXY_ADDRESS)) return invalid('spender_mismatch');
  if (!sameAddress(authorization.facilitator, settings.upto.facilitatorAddress)) return invalid('facilitator_mismatch');
  return {
    payer: authorization.from.toLowerCase(),
    nonce: authorization.nonce.toString(),
    validBefore: authorization.deadline,
    authorizedAmount: authorization.amount,
  };
}

/**
 * exact settles what was signed. upto settles the fulfilled amount at the ratio the quote fixed,
 * rounded down so the payer is never charged more than the price they were quoted.
 */
function settledUnits(data: X402Data, charge: Charge): bigint {
  const authorized = BigInt(data.authorizedAmount);
  if (data.scheme === 'exact') return authorized;
  return (authorized * charge.amount.micros) / BigInt(data.limitMicros);
}

function invalid(reason: string): Invalid {
  return { status: 'invalid', reason };
}
