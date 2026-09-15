import {
  TollstileError,
  toAssetUnits,
  type Authorization,
  type Clock,
  type JsonObject,
  type LookupResult,
  type Quote,
  type Rail,
  type SettleResult,
} from 'tollstile';
import { asciiRealm, challengeSecrets, quoteChallenge } from './challenge';
import { chargeTerms, readCredential, rejected, sameRequest } from './credential';
import { isIntegerString, isObject } from './encoding';
import { parseAddress, parseBytes32, type Address } from './evm';
import { paymentReceipt } from './receipt';
import { decodeTempoTransaction } from './tempo-transaction';
import { getReceipt, parseReceipt, rpcCall, type RpcConfig, type TransactionReceipt } from './tempo-rpc';
import { callsPay, challengeMemo, logsPay, requestTransfersJson, requiredTransfers, type Transfer } from './tip20';

export type TempoMode = 'pull' | 'push';

/** A TIP-20 token. TIP-20 tokens have 6 decimals. */
export type TempoToken = {
  /** Token address, e.g. pathUSD `0x20c0000000000000000000000000000000000000`. */
  readonly address: string;
  /** Asset code recorded on offers, e.g. `"pathUSD"`. */
  readonly code: string;
};

export type TempoSplit = {
  readonly recipient: string;
  /** In token base units. */
  readonly amount: bigint;
  readonly memo?: string;
};

export type MppTempoOptions = {
  /** The protection space advertised in challenges, e.g. `"api.example.com"`. ASCII. */
  readonly realm: string;
  /** Binds challenge ids (HMAC-SHA256). At least 32 characters. Pass a list to rotate: the first signs, all verify. */
  readonly secret: string | readonly string[];
  /** JSON-RPC endpoint, e.g. `https://rpc.tempo.xyz` or Moderato testnet `https://rpc.moderato.tempo.xyz`. */
  readonly rpcUrl: string;
  /** `4217` for mainnet, `42431` for Moderato testnet. Must match `rpcUrl`. */
  readonly chainId: number;
  /** The address that receives payments. */
  readonly recipient: string;
  readonly token: TempoToken;
  /**
   * The price currency the token is worth at par, e.g. `"USD"` for a USD stablecoin. Prices in
   * any other currency get no offer: Tollstile never converts.
   */
  readonly denomination: string;
  /**
   * `pull` (default): the payer signs a transaction and the rail broadcasts it after the handler.
   * `push`: the payer broadcasts first and sends the hash. Push payments have already moved when
   * the handler runs, and this rail cannot refund them; see the README before enabling it.
   */
  readonly modes?: readonly TempoMode[];
  /** Additional recipients per charge, computed from the total in base units. Their sum must stay below the total. */
  readonly splits?: (amount: bigint) => readonly TempoSplit[];
  /**
   * How long after a signed transaction's `validBefore` a missing receipt is trusted as final,
   * covering block-timestamp skew. Defaults to 60 seconds.
   */
  readonly validityMarginMs?: number;
  readonly fetch?: typeof fetch;
  readonly clock?: Clock;
};

export type MppTempoData = {
  readonly challengeId: string;
  readonly mode: TempoMode;
  readonly hash: string;
  /**
   * The signed transaction to broadcast (pull), kept so settlement survives a crash. `null` for push,
   * and dropped by `redact` once a charge on the authorization is final.
   */
  readonly transaction: string | null;
  /** Unix seconds (pull). */
  readonly validBefore: string | null;
};

export type MppTempoRail = Rail<'mpp-tempo', MppTempoData>;

const NAME = 'mpp-tempo';
const METHOD = 'tempo';
const INTENT = 'charge';
const TOKEN_SCALE = 6;

/**
 * MPP `tempo` `charge`: a one-time TIP-20 transfer on Tempo. In pull mode the payer signs a
 * transaction that this rail verifies offline and broadcasts only after the handler succeeds, so a
 * failed handler costs the payer nothing.
 *
 * @example
 * ```ts
 * const toll = createTollstile({
 *   rails: [
 *     mppTempo({
 *       realm: 'api.example.com',
 *       secret: process.env.MPP_SECRET,
 *       rpcUrl: 'https://rpc.moderato.tempo.xyz',
 *       chainId: 42431,
 *       recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
 *       token: { address: '0x20c0000000000000000000000000000000000000', code: 'pathUSD' },
 *       denomination: 'USD',
 *     }),
 *   ],
 *   ledger,
 *   secret: process.env.TOLLSTILE_SECRET,
 * });
 * ```
 */
export function mppTempo(options: MppTempoOptions): MppTempoRail {
  const secrets = challengeSecrets(options.secret, NAME);
  const realm = asciiRealm(options.realm);
  const recipient = requireAddress(options.recipient, 'recipient');
  const token = requireAddress(options.token.address, 'token.address');
  const modes = options.modes ?? ['pull'];
  if (modes.length === 0) {
    throw new TollstileError('CONFIG_INVALID', 'mppTempo() `modes` must list "pull", "push", or both.');
  }
  if (!Number.isSafeInteger(options.chainId) || options.chainId <= 0) {
    throw new TollstileError('CONFIG_INVALID', `mppTempo() \`chainId\` must be a positive integer, got ${String(options.chainId)}.`);
  }
  const clock = options.clock ?? { now: () => new Date() };
  const marginMs = options.validityMarginMs ?? 60_000;
  const rpc: RpcConfig = { url: options.rpcUrl, fetch: options.fetch ?? ((input, init) => fetch(input, init)) };

  const splitsFor = (amount: bigint): readonly Transfer[] | undefined => {
    const splits = (options.splits?.(amount) ?? []).map((split) => ({
      recipient: requireAddress(split.recipient, 'splits[].recipient'),
      amount: split.amount,
      memo: split.memo === undefined ? null : requireBytes32(split.memo),
    }));
    const total = splits.reduce((sum, split) => sum + split.amount, 0n);
    return splits.some((split) => split.amount <= 0n) || total >= amount ? undefined : splits;
  };

  const request = (amount: bigint, quote: Quote, splits: readonly Transfer[]): JsonObject => ({
    amount: amount.toString(),
    currency: token,
    recipient,
    methodDetails: {
      chainId: options.chainId,
      memo: challengeMemo(realm, quote),
      // The spec requires listing the modes only when not both are supported.
      ...(modes.includes('pull') && modes.includes('push') ? {} : { supportedModes: [...modes] }),
      ...(splits.length === 0 ? {} : { splits: requestTransfersJson(splits) }),
    },
  });

  /** A transaction that can no longer be included: past `validBefore` plus the skew margin. */
  const expired = (data: MppTempoData) =>
    data.validBefore !== null && clock.now().getTime() > Number(data.validBefore) * 1000 + marginMs;

  const fromReceipt = (receipt: TransactionReceipt, data: MppTempoData): SettleResult =>
    receipt.success
      ? { status: 'settled', reference: receipt.transactionHash, details: { mode: data.mode, blockNumber: receipt.blockNumber } }
      : { status: 'rejected', reason: 'transaction_reverted' };

  return {
    name: NAME,
    livemode: true,
    capabilities: {
      flows: ['authorization'],
      authorization: 'single',
      variableAmount: false,
      quotes: true,
      refund: false,
      partialRefund: false,
      lookup: true,
    },

    offer({ price }) {
      if (price.currency !== options.denomination) return Promise.resolve(null);
      const amount = toAssetUnits(price, TOKEN_SCALE);
      if (splitsFor(amount) === undefined) return Promise.resolve(null);
      return Promise.resolve({
        rail: NAME,
        asset: { code: options.token.code, network: `eip155:${String(options.chainId)}`, scale: TOKEN_SCALE },
        amount: amount.toString(),
        basis: 'par',
        details: { method: METHOD, intent: INTENT, token, recipient },
      });
    },

    challenge(quote, quoteToken, offer) {
      const amount = BigInt(offer.amount);
      const splits = splitsFor(amount) ?? [];
      return quoteChallenge(secrets, { realm, method: METHOD, intent: INTENT, request: request(amount, quote, splits) }, quote, quoteToken);
    },

    async verify(context, terms, operation) {
      const now = clock.now();
      const read = await readCredential(context, { realm, method: METHOD, intent: INTENT, secrets, now });
      if (read.status === 'absent') return read;
      if (read.status === 'invalid') return rejected(read);
      const { credential } = read;

      const resolved = await chargeTerms(credential, terms, NAME);
      if (resolved.status === 'invalid') return rejected(resolved);
      // The challenge memo is derived from the quote; without one no transfer can be tied to this challenge.
      if (resolved.quote === null || resolved.offer === null) return { status: 'invalid', reason: 'quote_required' };
      const { quote } = resolved;
      const amount = BigInt(resolved.offer.amount);
      const splits = splitsFor(amount);
      if (splits === undefined || !sameRequest(credential, request(amount, quote, splits))) {
        return { status: 'invalid', reason: 'challenge_terms_mismatch' };
      }
      const transfers = requiredTransfers(amount, recipient, challengeMemo(realm, quote), splits);
      const challengeId = credential.challenge.id;
      const challengeExpires = new Date(Date.parse(credential.challenge.expires));
      const { payload } = credential;

      if (payload.type === 'transaction' && modes.includes('pull')) {
        if (typeof payload.signature !== 'string') return { status: 'invalid', reason: 'invalid_payload' };
        const decoded = decodeTempoTransaction(payload.signature);
        if (!decoded.ok) return { status: 'invalid', reason: decoded.reason };
        const { transaction } = decoded;
        if (transaction.chainId !== BigInt(options.chainId)) return { status: 'invalid', reason: 'chain_mismatch' };
        // The server may broadcast only until `validBefore`, and must not hold a payment past the challenge.
        if (transaction.validBefore === null) return { status: 'invalid', reason: 'valid_before_required' };
        const validBeforeMs = Number(transaction.validBefore) * 1000;
        if (validBeforeMs > challengeExpires.getTime()) return { status: 'invalid', reason: 'valid_before_after_expiry' };
        // Well-formed and for this challenge, but no longer broadcastable: it may already have paid.
        if (validBeforeMs <= now.getTime()) return { status: 'invalid', reason: 'transaction_expired', proofId: challengeId };
        if (transaction.validAfter !== null && Number(transaction.validAfter) * 1000 > now.getTime()) {
          return { status: 'invalid', reason: 'transaction_not_yet_valid' };
        }
        if (!callsPay(transaction.calls, token, transfers)) return { status: 'invalid', reason: 'transfer_mismatch' };

        return {
          status: 'valid',
          proofId: challengeId,
          payer: `did:pkh:eip155:${String(options.chainId)}:${transaction.sender}`,
          quote,
          limit: resolved.price,
          expiresAt: new Date(validBeforeMs),
          data: {
            challengeId,
            mode: 'pull',
            hash: transaction.hash,
            transaction: payload.signature,
            validBefore: transaction.validBefore.toString(),
          },
          idempotencyKey: challengeId,
        };
      }

      if (payload.type === 'hash' && modes.includes('push')) {
        const hash = parseBytes32(payload.hash);
        if (hash === undefined) return { status: 'invalid', reason: 'invalid_payload' };
        const receipt = await getReceipt(rpc, hash, operation.signal);
        if (receipt === null) return { status: 'invalid', reason: 'transaction_not_found' };
        if (!receipt.success) return { status: 'invalid', reason: 'transaction_reverted' };
        const sender = logsPay(receipt.logs, token, transfers);
        if (sender === undefined) return { status: 'invalid', reason: 'transfer_mismatch' };
        // The transfer is final on-chain: core records the charge as settled before the handler, and
        // because this rail cannot refund, a failed handler leaves it settled and reported.
        return {
          status: 'valid',
          proofId: challengeId,
          payer: `did:pkh:eip155:${String(options.chainId)}:${sender}`,
          quote,
          limit: resolved.price,
          expiresAt: challengeExpires,
          data: { challengeId, mode: 'push', hash, transaction: null, validBefore: null },
          settled: { reference: receipt.transactionHash, details: { mode: 'push', blockNumber: receipt.blockNumber } },
          idempotencyKey: challengeId,
        };
      }

      return { status: 'invalid', reason: 'mode_unsupported' };
    },

    async settle(authorization, _charge, operation) {
      const data = tempoData(authorization);
      if (data.mode === 'push') {
        // Push charges are recorded as settled at verification, so core never asks; the transfer is final.
        return { status: 'settled', reference: data.hash, details: { mode: 'push' } };
      }
      const { transaction } = data;
      // Redacted: a charge on this authorization is final, so the chain already has the answer.
      if (transaction === null || expired(data)) {
        const receipt = await getReceipt(rpc, data.hash, operation.signal);
        if (receipt !== null) return fromReceipt(receipt, data);
        return { status: 'rejected', reason: transaction === null ? 'transaction_not_included' : 'transaction_expired' };
      }

      // Rebroadcasting the same signed bytes is idempotent: the network includes one transaction per nonce.
      const answer = await rpcCall(rpc, 'eth_sendRawTransactionSync', [transaction], { signal: operation.signal, write: true });
      const receipt = answer.ok ? parseReceipt(answer.result) : await getReceipt(rpc, data.hash, operation.signal);
      if (receipt === undefined) throw new TollstileError('PROVIDER_TIMEOUT', 'Tempo RPC returned a malformed receipt from eth_sendRawTransactionSync.');
      if (receipt !== null) {
        if (receipt.transactionHash !== data.hash) throw new TollstileError('PROVIDER_TIMEOUT', 'Tempo RPC returned a receipt for another transaction.');
        return fromReceipt(receipt, data);
      }
      // The node refused the transaction, but an earlier broadcast may still be pending. Only
      // `validBefore` makes "never included" certain, so until then the outcome stays unknown.
      if (expired(data)) return { status: 'rejected', reason: `rpc_error_${String(answer.ok ? 0 : answer.code)}` };
      throw new TollstileError('PROVIDER_TIMEOUT', `Tempo RPC refused the transaction (${answer.ok ? 'no receipt' : String(answer.code)}); it may still be included before it expires.`);
    },

    refund() {
      return Promise.resolve({ status: 'rejected', reason: 'refund_unsupported' });
    },

    release() {
      // The signed transaction is simply never broadcast.
      return Promise.resolve();
    },

    redact(data) {
      // Everything lookup needs (hash, validBefore) stays; the signed payment itself goes.
      return { ...data, transaction: null };
    },

    async lookup(authorization, _charge, operation): Promise<LookupResult> {
      const data = tempoData(authorization);
      const receipt = await getReceipt(rpc, data.hash, operation.signal);
      if (receipt !== null) {
        return receipt.success
          ? { status: 'settled', reference: receipt.transactionHash, details: { mode: data.mode, blockNumber: receipt.blockNumber } }
          : { status: 'none' };
      }
      // Pull: not included means not settled. Reconciliation then settles again, which rebroadcasts
      // the same signed bytes — one nonce, so never a second transfer — and `settle` rejects only
      // once `validBefore` makes inclusion impossible.
      if (data.mode === 'pull') return { status: 'none' };
      throw new TollstileError('PROVIDER_TIMEOUT', `Push transaction for ${authorization.id} was verified on-chain but has no receipt now.`);
    },

    receipt(authorization, charge, context) {
      const data = tempoData(authorization);
      return paymentReceipt(context, { method: METHOD, reference: charge.settlement?.reference ?? data.hash, settledAt: charge.updatedAt, challengeId: data.challengeId });
    },
  };
}

function tempoData(authorization: Authorization): MppTempoData {
  const { data } = authorization;
  if (
    !isObject(data) ||
    typeof data.challengeId !== 'string' ||
    (data.mode !== 'pull' && data.mode !== 'push') ||
    typeof data.hash !== 'string' ||
    !(typeof data.transaction === 'string' || data.transaction === null) ||
    !(isIntegerString(data.validBefore) || data.validBefore === null)
  ) {
    throw inconsistent(authorization);
  }
  return { challengeId: data.challengeId, mode: data.mode, hash: data.hash, transaction: data.transaction, validBefore: data.validBefore };
}

function inconsistent(authorization: Authorization): TollstileError {
  return new TollstileError('LEDGER_INCONSISTENT', `Authorization ${authorization.id} does not hold mpp-tempo data.`);
}

export function requireAddress(value: string, name: string): Address {
  const address = parseAddress(value);
  if (address === undefined) throw new TollstileError('CONFIG_INVALID', `\`${name}\` must be a 0x-prefixed 20-byte address, got "${value}".`);
  return address;
}

function requireBytes32(value: string): `0x${string}` {
  const bytes = parseBytes32(value);
  if (bytes === undefined) throw new TollstileError('CONFIG_INVALID', `Split memo must be a 0x-prefixed bytes32, got "${value}".`);
  return bytes;
}
