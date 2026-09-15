import type { JsonObject } from 'tollstile';
import type { PaymentRequirements, Scheme } from './payment-requirements';

/**
 * What the ledger stores for a verified x402 payment. Settlement and reconciliation, possibly in
 * another process, work from this record alone.
 *
 * It includes the payer's signed payload, because settling after a crash needs it. That signature
 * can only move `authorizedAmount` of `asset` to `payTo` before `validBefore`.
 */
export type X402Data = {
  readonly scheme: Scheme;
  readonly network: string;
  readonly asset: string;
  readonly payTo: string;
  readonly payer: string;
  /** exact: the EIP-3009 bytes32 nonce, lowercase hex. upto: the Permit2 uint256 nonce, decimal. */
  readonly nonce: string;
  /** Unix seconds: the EIP-3009 `validBefore`, or the Permit2 `deadline`. */
  readonly validBefore: string;
  /** Atomic units the payer signed for: the exact value, or the upto maximum. */
  readonly authorizedAmount: string;
  /** The price `authorizedAmount` covers, in micro-units. upto settles at this quoted ratio. */
  readonly limitMicros: string;
  /** The client's PaymentPayload, forwarded unchanged to `/settle`. */
  readonly paymentPayload: JsonObject;
  /** The requirements this server derived and verified against. */
  readonly paymentRequirements: PaymentRequirements;
};
