import { concat, fromHex, toHex } from './encoding';
import { keccak256, recoverAddress, type Address } from './evm';
import { decodeRlp, encodeRlp, rlpInteger, type RlpItem } from './rlp';

export const TEMPO_TX_TYPE = 0x76;

export type TempoCall = {
  readonly to: Address;
  readonly value: bigint;
  readonly data: Uint8Array;
};

/** A client-signed Tempo Transaction (EIP-2718 type `0x76`) with a secp256k1 sender signature. */
export type TempoTransaction = {
  readonly chainId: bigint;
  readonly calls: readonly TempoCall[];
  readonly nonceKey: bigint;
  readonly nonce: bigint;
  /** Unix seconds; `null` when unset. */
  readonly validBefore: bigint | null;
  readonly validAfter: bigint | null;
  readonly sender: Address;
  /** keccak256 of the signed envelope: the hash the network reports. */
  readonly hash: `0x${string}`;
};

export type Decoded = { readonly ok: true; readonly transaction: TempoTransaction } | { readonly ok: false; readonly reason: string };

/**
 * Field order: chainId, maxPriorityFeePerGas, maxFeePerGas, gas, calls, accessList, nonceKey, nonce,
 * validBefore, validAfter, feeToken, feePayerSignatureOrSender, authorizationList,
 * [keyAuthorization], signature.
 *
 * Only the shape a merchant can safely broadcast unmodified is accepted: no fee-payer marker (the
 * rail never co-signs), no key authorization or authorization list (they change what the sender
 * account is), and a plain secp256k1 signature.
 */
export function decodeTempoTransaction(serialized: string): Decoded {
  const bytes = fromHex(serialized);
  if (bytes === undefined || bytes[0] !== TEMPO_TX_TYPE) return fail('transaction_malformed');
  const fields = decodeRlp(bytes.subarray(1));
  if (fields instanceof Uint8Array || fields === undefined) return fail('transaction_malformed');
  if (fields.length !== 14) return fail('transaction_unsupported');

  const [chainId, , , , calls, , nonceKey, nonce, validBefore, validAfter, , feePayer, authorizationList, signature] = fields;
  const integers = [chainId, nonceKey, nonce, validBefore, validAfter].map(rlpInteger);
  const [chain, lane, sequence, before, after] = integers;
  if (chain === undefined || lane === undefined || sequence === undefined || before === undefined || after === undefined) {
    return fail('transaction_malformed');
  }
  if (!(feePayer instanceof Uint8Array) || feePayer.length !== 0) return fail('fee_payer_unsupported');
  if (!Array.isArray(authorizationList) || authorizationList.length !== 0) return fail('transaction_unsupported');
  if (!(signature instanceof Uint8Array)) return fail('transaction_malformed');

  const decodedCalls = decodeCalls(calls);
  if (decodedCalls === undefined) return fail('transaction_malformed');

  const unsigned = fields.slice(0, 13);
  const digest = keccak256(concat(Uint8Array.of(TEMPO_TX_TYPE), encodeRlp(unsigned)));
  const sender = recoverAddress(digest, signature);
  if (sender === undefined || signature.length !== 65) return fail('signature_invalid');

  return {
    ok: true,
    transaction: {
      chainId: chain,
      calls: decodedCalls,
      nonceKey: lane,
      nonce: sequence,
      validBefore: before === 0n ? null : before,
      validAfter: after === 0n ? null : after,
      sender,
      hash: toHex(keccak256(bytes)),
    },
  };
}

function decodeCalls(item: RlpItem | undefined): TempoCall[] | undefined {
  if (item === undefined || item instanceof Uint8Array) return undefined;
  const calls: TempoCall[] = [];
  for (const call of item) {
    if (call instanceof Uint8Array || call.length !== 3) return undefined;
    const [to, value, data] = call;
    const amount = rlpInteger(value);
    if (!(to instanceof Uint8Array) || to.length !== 20 || amount === undefined || !(data instanceof Uint8Array)) return undefined;
    calls.push({ to: toHex(to), value: amount, data });
  }
  return calls;
}

function fail(reason: string): Decoded {
  return { ok: false, reason };
}
