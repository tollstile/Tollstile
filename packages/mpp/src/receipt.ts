import type { Context, JsonObject, Receipt } from 'tollstile';
import { rfc3339 } from './challenge';
import { base64url, utf8 } from './encoding';
import { canonicalize } from './jcs';

export const RECEIPT_META = 'org.paymentauth/receipt';

export type ReceiptFields = {
  readonly method: string;
  readonly reference: string;
  readonly settledAt: Date;
  readonly challengeId: string;
  /** Method- or intent-specific fields, e.g. the session's `channelId`. */
  readonly extra?: JsonObject;
};

/**
 * `Payment-Receipt` with `Cache-Control: private` on HTTP, `_meta["org.paymentauth/receipt"]` on
 * MCP. Only called for settled charges, so `status` is always `success`.
 */
export function paymentReceipt(context: Context, fields: ReceiptFields): Receipt {
  const receipt: JsonObject = {
    ...fields.extra,
    status: 'success',
    method: fields.method,
    timestamp: rfc3339(fields.settledAt),
    reference: fields.reference,
    challengeId: fields.challengeId,
  };
  if (context.transport === 'mcp') return { headers: [], meta: { [RECEIPT_META]: receipt } };
  return {
    headers: [
      ['payment-receipt', base64url(utf8(canonicalize(receipt)))],
      ['cache-control', 'private'],
    ],
    meta: {},
  };
}
