import {
  TollstileError,
  money,
  toAssetUnits,
  type Authorization,
  type Charge,
  type Clock,
  type Json,
  type JsonObject,
  type Rail,
} from 'tollstile';
import { asciiRealm, challengeSecrets, quoteChallenge } from './challenge';
import { chargeTerms, readCredential, sameRequest } from './credential';
import { fromHex, isIntegerString, isObject } from './encoding';
import { parseBytes32, recoverAddress, ZERO_ADDRESS, type Address } from './evm';
import { paymentReceipt } from './receipt';
import {
  channelId,
  closeCall,
  decodeChannelState,
  getChannelStateCall,
  MAX_UINT96,
  parseDescriptor,
  TEMPO_CHANNEL_ESCROW,
  voucherDigest,
  voucherSigner,
  type ChannelDescriptor,
} from './tempo-channel';
import { requireAddress, type TempoToken } from './tempo-rail';
import { rpcCall, type RpcConfig } from './tempo-rpc';

export type MppTempoSessionOptions = {
  /** The protection space advertised in challenges, e.g. `"api.example.com"`. ASCII. */
  readonly realm: string;
  /** Binds challenge ids (HMAC-SHA256). At least 32 characters. Pass a list to rotate: the first signs, all verify. */
  readonly secret: string | readonly string[];
  readonly rpcUrl: string;
  /** `4217` for mainnet, `42431` for Moderato testnet. */
  readonly chainId: number;
  /** The channel payee: the address that can close channels and receives captured funds. */
  readonly recipient: string;
  readonly token: TempoToken;
  /** The price currency the token is worth at par, e.g. `"USD"`. */
  readonly denomination: string;
  /** Defaults to the TIP-20 channel escrow precompile `0x4d50500000000000000000000000000000000000`. */
  readonly escrow?: string;
  /** Payee-side operator bound into channel descriptors. Defaults to none (the zero address). */
  readonly operator?: string;
  readonly fetch?: typeof fetch;
  readonly clock?: Clock;
};

/** Channel identity recorded on the authorization. `baseline` is the on-chain `settled` when Tollstile first saw the channel. */
export type MppTempoSessionData = {
  readonly channelId: string;
  readonly descriptor: { readonly [K in keyof ChannelDescriptor]: string };
  readonly baseline: string;
};

export type MppTempoSessionRail = Rail<'mpp-tempo-session', MppTempoSessionData>;

type Voucher = {
  readonly channelId: `0x${string}`;
  readonly cumulativeAmount: bigint;
  readonly signature: `0x${string}`;
  readonly challengeId: string;
  readonly expiresAt: number;
};

const NAME = 'mpp-tempo-session';
const METHOD = 'tempo';
const INTENT = 'session';
const TOKEN_SCALE = 6;

/**
 * **Experimental.** MPP `tempo` `session` (protocol v2) on Tempo payment channels. The channel is a
 * reusable authorization whose limit is its deposit; each paid call is a charge that settles by
 * holding a payer-signed cumulative voucher covering everything consumed on the channel.
 *
 * Settlement here is off-chain. Funds reach the payee only when the channel is closed on-chain
 * with {@link tempoSessionClose}, which must happen before a payer's forced close completes.
 *
 * @example
 * ```ts
 * const session = mppTempoSession({
 *   realm: 'api.example.com',
 *   secret: process.env.MPP_SECRET,
 *   rpcUrl: 'https://rpc.moderato.tempo.xyz',
 *   chainId: 42431,
 *   recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
 *   token: { address: '0x20c0000000000000000000000000000000000000', code: 'pathUSD' },
 *   denomination: 'USD',
 * });
 * const toll = createTollstile({ rails: [session], ledger, secret: process.env.TOLLSTILE_SECRET });
 * ```
 */
export function mppTempoSession(options: MppTempoSessionOptions): MppTempoSessionRail {
  const secrets = challengeSecrets(options.secret, NAME);
  const realm = asciiRealm(options.realm);
  const recipient = requireAddress(options.recipient, 'recipient');
  const token = requireAddress(options.token.address, 'token.address');
  const escrow = requireAddress(options.escrow ?? TEMPO_CHANNEL_ESCROW, 'escrow');
  const operator = requireAddress(options.operator ?? ZERO_ADDRESS, 'operator');
  const clock = options.clock ?? { now: () => new Date() };
  const rpc: RpcConfig = { url: options.rpcUrl, fetch: options.fetch ?? ((input, init) => fetch(input, init)) };

  // Vouchers pass from verify to settle inside one request. The upfront flow never settles a
  // charge in another process: a charge left mid-settlement is released, so nothing is lost when
  // this map is.
  const vouchers = new Map<string, Voucher>();

  const request = (amount: bigint): JsonObject => ({
    amount: amount.toString(),
    unitType: 'request',
    currency: token,
    recipient,
    methodDetails: {
      chainId: options.chainId,
      escrowContract: escrow,
      sessionProtocol: 'v2',
      ...(operator === ZERO_ADDRESS ? {} : { operator }),
    },
  });

  return {
    name: NAME,
    livemode: true,
    capabilities: {
      flows: ['upfront'],
      authorization: 'reusable',
      variableAmount: false,
      quotes: true,
      // Nothing is captured on-chain per charge, so a refund is releasing consumption the close
      // helper would otherwise capture. See README: closing must use the ledger's consumption.
      refund: true,
      partialRefund: false,
      lookup: true,
    },

    offer({ price }) {
      if (price.currency !== options.denomination) return Promise.resolve(null);
      return Promise.resolve({
        rail: NAME,
        asset: { code: options.token.code, network: `eip155:${String(options.chainId)}`, scale: TOKEN_SCALE },
        amount: toAssetUnits(price, TOKEN_SCALE).toString(),
        basis: 'par',
        details: { method: METHOD, intent: INTENT, escrow, recipient },
      });
    },

    challenge(quote, quoteToken, offer) {
      return quoteChallenge(secrets, { realm, method: METHOD, intent: INTENT, request: request(BigInt(offer.amount)) }, quote, quoteToken);
    },

    async verify(context, terms, operation) {
      const now = clock.now();
      for (const [key, entry] of vouchers) if (entry.expiresAt <= now.getTime()) vouchers.delete(key);

      const read = await readCredential(context, { realm, method: METHOD, intent: INTENT, secrets, now });
      if (read.status !== 'present') return read;
      const { credential } = read;

      const resolved = await chargeTerms(credential, terms, NAME);
      if (resolved.status === 'invalid') return resolved;
      const amount = resolved.offer === null ? toAssetUnits(resolved.price, TOKEN_SCALE) : BigInt(resolved.offer.amount);
      if (resolved.price.currency !== options.denomination || !sameRequest(credential, request(amount))) {
        return { status: 'invalid', reason: 'challenge_terms_mismatch' };
      }

      const { payload } = credential;
      if (payload.action !== 'voucher') return { status: 'invalid', reason: 'session_action_unsupported' };
      const descriptor = parseDescriptor(payload.descriptor);
      const channel = parseBytes32(payload.channelId);
      const signature = typeof payload.signature === 'string' ? fromHex(payload.signature) : undefined;
      if (descriptor === undefined || channel === undefined || signature === undefined || !isIntegerString(payload.cumulativeAmount)) {
        return { status: 'invalid', reason: 'invalid_payload' };
      }
      const cumulativeAmount = BigInt(payload.cumulativeAmount);
      if (cumulativeAmount > MAX_UINT96) return { status: 'invalid', reason: 'invalid_payload' };
      if (descriptor.payee !== recipient || descriptor.token !== token || descriptor.operator !== operator) {
        return { status: 'invalid', reason: 'channel_terms_mismatch' };
      }
      if (channelId(descriptor, escrow, options.chainId) !== channel) return { status: 'invalid', reason: 'channel_id_mismatch' };
      if (recoverAddress(voucherDigest(escrow, options.chainId, channel, cumulativeAmount), signature) !== voucherSigner(descriptor)) {
        return { status: 'invalid', reason: 'signature_invalid' };
      }

      const answer = await rpcCall(rpc, 'eth_call', [{ to: escrow, data: getChannelStateCall(channel) }, 'latest'], { signal: operation.signal, write: false });
      const state = answer.ok ? decodeChannelState(answer.result) : undefined;
      if (state === undefined) throw new TollstileError('PROVIDER_UNAVAILABLE', 'Tempo RPC could not read the channel state.');
      if (state.deposit === 0n) return { status: 'invalid', reason: 'channel_not_found' };
      // A payer who requested a forced close can withdraw what is not captured: serve nothing more.
      if (state.closeRequestedAt !== 0n) return { status: 'invalid', reason: 'channel_closing' };
      if (cumulativeAmount > state.deposit) return { status: 'invalid', reason: 'amount_exceeds_deposit' };
      if (cumulativeAmount < state.settled) return { status: 'invalid', reason: 'voucher_below_settled' };

      const expiresAt = Date.parse(credential.challenge.expires);
      vouchers.set(context.requestId, { channelId: channel, cumulativeAmount, signature: payload.signature as `0x${string}`, challengeId: credential.challenge.id, expiresAt });
      return {
        status: 'valid',
        proofId: channel,
        payer: `did:pkh:eip155:${String(options.chainId)}:${descriptor.payer}`,
        quote: resolved.quote,
        // The ledger stores the limit of the first verification; later deposits do not raise it.
        limit: money(options.denomination, state.deposit - state.settled),
        expiresAt: null,
        data: { channelId: channel, descriptor, baseline: state.settled.toString() },
      };
    },

    settle(authorization, charge) {
      const data = sessionData(authorization);
      const voucher = vouchers.get(charge.requestId);
      if (voucher?.channelId !== data.channelId) {
        return Promise.reject(
          new TollstileError('PROVIDER_UNAVAILABLE', `No voucher for ${charge.id} is held by this process. Reconciliation will release it.`),
        );
      }
      vouchers.delete(charge.requestId);

      // `reserved` includes this charge and every other in-flight charge on the channel. Requiring
      // the voucher to cover them all means concurrent charges can never share one voucher's value.
      const required = BigInt(data.baseline) + toAssetUnits(authorization.consumed, TOKEN_SCALE) + toAssetUnits(authorization.reserved, TOKEN_SCALE);
      if (voucher.cumulativeAmount < required) return Promise.resolve({ status: 'rejected', reason: 'voucher_insufficient' });
      return Promise.resolve({
        status: 'settled',
        reference: `${data.channelId}:${required.toString()}`,
        details: {
          channelId: data.channelId,
          challengeId: voucher.challengeId,
          cumulativeAmount: voucher.cumulativeAmount.toString(),
          signature: voucher.signature,
          required: required.toString(),
        },
      });
    },

    refund(_authorization, charge) {
      return Promise.resolve({ status: 'refunded', reference: `${charge.settlement?.reference ?? charge.id}:uncaptured` });
    },

    release(_authorization, charge) {
      vouchers.delete(charge.requestId);
      return Promise.resolve();
    },

    lookup(_authorization, charge) {
      // Neither settle nor refund has an effect outside the ledger, so there is nothing external to
      // find: an interrupted refund is complete, and an interrupted settlement never happened.
      return Promise.resolve(
        charge.pending === 'refund'
          ? { status: 'refunded', reference: `${charge.settlement?.reference ?? charge.id}:uncaptured` }
          : { status: 'none' },
      );
    },

    receipt(authorization, charge, context) {
      const data = sessionData(authorization);
      const details = isObject(charge.settlement?.details) ? charge.settlement.details : {};
      return paymentReceipt(context, {
        method: METHOD,
        reference: data.channelId,
        settledAt: charge.updatedAt,
        challengeId: typeof details.challengeId === 'string' ? details.challengeId : '',
        extra: {
          intent: INTENT,
          channelId: data.channelId,
          acceptedCumulative: stringOr(details.cumulativeAmount),
          spent: stringOr(details.required),
        },
      });
    },
  };
}

export type TempoSessionCloseInput = {
  /** The channel's authorization, from your ledger. */
  readonly authorization: Authorization;
  /** Settled charges on that authorization; the highest voucher among them is used. */
  readonly charges: readonly Charge[];
  /** The channel's current on-chain `settled`, if you read it. Capture never goes below it. */
  readonly settledOnChain?: bigint;
  /** Defaults to the TIP-20 channel escrow precompile. */
  readonly escrow?: string;
};

export type TempoSessionClose = {
  readonly channelId: string;
  /** The escrow address to call. */
  readonly to: Address;
  /** `close(descriptor, cumulativeAmount, captureAmount, signature)` calldata. */
  readonly data: `0x${string}`;
  /** Base units the payee receives in total: baseline plus what the ledger records as consumed. */
  readonly captureAmount: bigint;
  readonly cumulativeAmount: bigint;
};

/**
 * Builds the on-chain cooperative close for a session channel. It captures what the ledger records
 * as consumed — never the full voucher, which may include refunded or unused value — and refunds
 * the rest of the deposit to the payer. Submit the returned call from the payee account with your
 * own wallet tooling; this package never holds keys.
 *
 * @example
 * ```ts
 * const close = tempoSessionClose({ authorization, charges });
 * await walletClient.sendTransaction({ to: close.to, data: close.data });
 * ```
 */
export function tempoSessionClose(input: TempoSessionCloseInput): TempoSessionClose {
  const data = sessionData(input.authorization);
  const escrow = requireAddress(input.escrow ?? TEMPO_CHANNEL_ESCROW, 'escrow');
  const descriptor = parseDescriptor(data.descriptor);
  if (descriptor === undefined) throw new TollstileError('LEDGER_INCONSISTENT', `Authorization ${input.authorization.id} has no channel descriptor.`);

  const consumed = BigInt(data.baseline) + toAssetUnits(input.authorization.consumed, TOKEN_SCALE);
  const captureAmount = input.settledOnChain === undefined || input.settledOnChain < consumed ? consumed : input.settledOnChain;
  const voucher = input.charges
    .filter((charge) => charge.authorizationId === input.authorization.id)
    .map((charge) => (isObject(charge.settlement?.details) ? charge.settlement.details : {}))
    .flatMap((details) =>
      isIntegerString(details.cumulativeAmount) && typeof details.signature === 'string'
        ? [{ cumulativeAmount: BigInt(details.cumulativeAmount), signature: details.signature }]
        : [],
    )
    .reduce<{ cumulativeAmount: bigint; signature: string } | undefined>((best, next) => (best === undefined || next.cumulativeAmount > best.cumulativeAmount ? next : best), undefined);
  const signature = voucher === undefined ? undefined : fromHex(voucher.signature);
  if (voucher === undefined || signature === undefined || voucher.cumulativeAmount < captureAmount) {
    throw new TollstileError(
      'LEDGER_INCONSISTENT',
      `No voucher among the given charges covers the ${captureAmount.toString()} base units consumed on ${data.channelId}. Pass every settled charge of the authorization.`,
    );
  }
  return {
    channelId: data.channelId,
    to: escrow,
    data: closeCall(descriptor, voucher.cumulativeAmount, captureAmount, signature),
    captureAmount,
    cumulativeAmount: voucher.cumulativeAmount,
  };
}

function sessionData(authorization: Authorization): MppTempoSessionData {
  const { data } = authorization;
  const descriptor = isObject(data) ? parseDescriptor(data.descriptor) : undefined;
  if (!isObject(data) || typeof data.channelId !== 'string' || descriptor === undefined || !isIntegerString(data.baseline)) {
    throw new TollstileError('LEDGER_INCONSISTENT', `Authorization ${authorization.id} does not hold mpp-tempo-session data.`);
  }
  return { channelId: data.channelId, descriptor, baseline: data.baseline };
}

function stringOr(value: Json | undefined): string {
  return typeof value === 'string' ? value : '';
}
