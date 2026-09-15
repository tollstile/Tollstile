import type { Context, JsonObject } from 'tollstile';
import { isAddress } from './networks';
import { decodeBase64Json, isObject, objectField, textField } from './wire';

export const PAYMENT_SIGNATURE_HEADER = 'payment-signature';
export const PAYMENT_META = 'x402/payment';

export type Proof =
  | { readonly status: 'absent' }
  | { readonly status: 'invalid'; readonly reason: string }
  | {
      readonly status: 'present';
      /** The client's PaymentPayload, forwarded unchanged to the facilitator. */
      readonly paymentPayload: JsonObject;
      readonly accepted: JsonObject;
      readonly payload: JsonObject;
    };

/** The signed EIP-3009 `transferWithAuthorization` parameters of an `exact` payment. */
export type Eip3009Authorization = {
  readonly from: string;
  readonly to: string;
  readonly value: bigint;
  readonly validAfter: bigint;
  readonly validBefore: bigint;
  /** bytes32, lowercase hex. */
  readonly nonce: string;
};

/** The signed Permit2 `permitWitnessTransferFrom` parameters of an `upto` payment. */
export type Permit2Authorization = {
  readonly from: string;
  readonly token: string;
  /** The maximum the payer authorized. */
  readonly amount: bigint;
  readonly spender: string;
  readonly nonce: bigint;
  readonly deadline: bigint;
  readonly to: string;
  readonly facilitator: string;
  readonly validAfter: bigint;
};

const UINT = /^\d{1,78}$/;
const HEX_UINT = /^0x[0-9a-fA-F]{1,64}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const MAX_UINT256 = 2n ** 256n - 1n;

export function readProof(context: Context): Proof {
  const value = context.transport === 'mcp' ? readMeta(context) : readHeader(context);
  if (value === 'absent') return { status: 'absent' };
  if (value === 'malformed') return { status: 'invalid', reason: 'payload_malformed' };
  if (value.x402Version !== 2) return { status: 'invalid', reason: 'unsupported_x402_version' };

  const accepted = objectField(value, 'accepted');
  const payload = objectField(value, 'payload');
  if (accepted === undefined || payload === undefined) return { status: 'invalid', reason: 'payload_malformed' };
  return { status: 'present', paymentPayload: value, accepted, payload };
}

function readHeader(context: Context): JsonObject | 'absent' | 'malformed' {
  const header = context.request?.headers.get(PAYMENT_SIGNATURE_HEADER);
  if (header === null || header === undefined) return 'absent';
  const decoded = decodeBase64Json(header.trim());
  return decoded.ok && isObject(decoded.value) ? decoded.value : 'malformed';
}

function readMeta(context: Context): JsonObject | 'absent' | 'malformed' {
  const value = context.mcp?.meta[PAYMENT_META];
  if (value === undefined) return 'absent';
  return isObject(value) ? value : 'malformed';
}

export function parseEip3009(payload: JsonObject): Eip3009Authorization | undefined {
  const authorization = objectField(payload, 'authorization');
  if (authorization === undefined || textField(payload, 'signature') === undefined) return undefined;

  const from = address(authorization, 'from');
  const to = address(authorization, 'to');
  const value = uint(authorization, 'value');
  const validAfter = uint(authorization, 'validAfter');
  const validBefore = uint(authorization, 'validBefore');
  const nonce = textField(authorization, 'nonce');
  if (
    from === undefined ||
    to === undefined ||
    value === undefined ||
    validAfter === undefined ||
    validBefore === undefined ||
    nonce === undefined ||
    !BYTES32.test(nonce)
  ) {
    return undefined;
  }
  return { from, to, value, validAfter, validBefore, nonce: nonce.toLowerCase() };
}

export function parsePermit2(payload: JsonObject): Permit2Authorization | undefined {
  const authorization = objectField(payload, 'permit2Authorization');
  if (authorization === undefined || textField(payload, 'signature') === undefined) return undefined;
  const permitted = objectField(authorization, 'permitted');
  const witness = objectField(authorization, 'witness');
  if (permitted === undefined || witness === undefined) return undefined;

  const from = address(authorization, 'from');
  const token = address(permitted, 'token');
  const amount = uint(permitted, 'amount');
  const spender = address(authorization, 'spender');
  const nonce = uint(authorization, 'nonce');
  const deadline = uint(authorization, 'deadline');
  const to = address(witness, 'to');
  const facilitator = address(witness, 'facilitator');
  const validAfter = uint(witness, 'validAfter');
  if (
    from === undefined ||
    token === undefined ||
    amount === undefined ||
    spender === undefined ||
    nonce === undefined ||
    deadline === undefined ||
    to === undefined ||
    facilitator === undefined ||
    validAfter === undefined
  ) {
    return undefined;
  }
  return { from, token, amount, spender, nonce, deadline, to, facilitator, validAfter };
}

function address(record: JsonObject, key: string): string | undefined {
  const value = textField(record, key);
  return value !== undefined && isAddress(value) ? value : undefined;
}

/** Decimal strings, and hex for Permit2 nonces, which reference clients emit as bytes32 hex. */
function uint(record: JsonObject, key: string): bigint | undefined {
  const value = textField(record, key);
  if (value === undefined || !(UINT.test(value) || HEX_UINT.test(value))) return undefined;
  const parsed = BigInt(value);
  return parsed <= MAX_UINT256 ? parsed : undefined;
}
