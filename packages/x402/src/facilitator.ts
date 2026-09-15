import { TollstileError, type JsonObject, type Operation } from 'tollstile';
import type { X402FacilitatorOptions } from './options';
import type { PaymentRequirements } from './payment-requirements';
import { postJson, type Fetch } from './provider-fetch';
import { isObject, textField } from './wire';

export type FacilitatorRequest = {
  readonly x402Version: 2;
  readonly paymentPayload: JsonObject;
  readonly paymentRequirements: PaymentRequirements;
};

export type VerifyResponse =
  | { readonly isValid: true; readonly payer: string | undefined }
  | { readonly isValid: false; readonly invalidReason: string };

export type SettleResponse =
  | { readonly success: true; readonly transaction: string }
  | { readonly success: false; readonly errorReason: string };

export type Facilitator = {
  verify(request: FacilitatorRequest, operation: Operation): Promise<VerifyResponse>;
  settle(request: FacilitatorRequest, operation: Operation): Promise<SettleResponse>;
};

const LABEL = 'x402 facilitator';
// Reason codes are open-ended strings that reach the 402 body. Anything outside this shape is
// replaced, so a facilitator cannot inject arbitrary text into responses.
const REASON = /^[a-z0-9_]{1,80}$/;
const TRANSACTION = /^0x[0-9a-fA-F]{64}$/;
// The facilitator could not decide, so they say nothing about the proof or about whether a
// transaction was broadcast (x402 V2 §9).
const UNEXPECTED_VERIFY = 'unexpected_verify_error';
const AMBIGUOUS_SETTLE = new Set(['settlement_pending', 'unexpected_settle_error']);

export function facilitatorClient(options: X402FacilitatorOptions, fetcher: Fetch): Facilitator {
  const base = options.url.replace(/\/+$/, '');

  const post = async (path: 'verify' | 'settle', request: FacilitatorRequest, operation: Operation) =>
    postJson(fetcher, {
      url: `${base}/${path}`,
      body: request,
      headers: options.headers === undefined ? {} : await options.headers(),
      signal: operation.signal,
      label: `${LABEL} /${path}`,
    });

  return {
    async verify(request, operation) {
      // Facilitators report rejections both as 200 and as non-2xx statuses with the same body.
      const { status, body } = await post('verify', request, operation);
      if (!isObject(body) || typeof body.isValid !== 'boolean' || (body.isValid && !ok(status))) {
        throw new TollstileError('PROVIDER_UNAVAILABLE', `${LABEL} /verify answered HTTP ${String(status)} without a VerifyResponse.`);
      }
      if (body.isValid) return { isValid: true, payer: textField(body, 'payer') };

      const invalidReason = reason(textField(body, 'invalidReason'), 'verification_failed');
      if (invalidReason === UNEXPECTED_VERIFY) {
        throw new TollstileError('PROVIDER_UNAVAILABLE', `${LABEL} /verify reported ${UNEXPECTED_VERIFY}.`);
      }
      return { isValid: false, invalidReason };
    },

    async settle(request, operation) {
      const { status, body } = await post('settle', request, operation);
      if (!isObject(body) || typeof body.success !== 'boolean' || (body.success && !ok(status))) {
        throw new TollstileError(
          'PROVIDER_TIMEOUT',
          `${LABEL} /settle answered HTTP ${String(status)} without a SettleResponse, so whether it broadcast a transfer is unknown.`,
        );
      }

      if (!body.success) {
        const errorReason = reason(textField(body, 'errorReason'), 'settlement_failed');
        if (AMBIGUOUS_SETTLE.has(errorReason)) {
          throw new TollstileError('PROVIDER_TIMEOUT', `${LABEL} /settle reported ${errorReason}; the transfer may still confirm on chain.`);
        }
        return { success: false, errorReason };
      }

      const transaction = textField(body, 'transaction');
      if (transaction === undefined || !TRANSACTION.test(transaction)) {
        throw new TollstileError('PROVIDER_TIMEOUT', `${LABEL} /settle reported success without a transaction hash.`);
      }
      return { success: true, transaction };
    },
  };
}

function ok(status: number): boolean {
  return status >= 200 && status < 300;
}

function reason(value: string | undefined, fallback: string): string {
  return value !== undefined && REASON.test(value) ? value : fallback;
}
