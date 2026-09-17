import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { ElicitResultSchema, type ServerNotification, type ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { compare, formatMoney, type Money, type Payment, type Rail } from 'tollstile';

/**
 * Asks the person at the client before a tool call is charged, over MCP elicitation. Nothing is
 * charged unless they accept: a declined call releases its reservation, or refunds it on a rail
 * that takes payment upfront.
 *
 * @example
 * ```ts
 * paidTool(server, 'summarize', {}, toll.price(upTo('$0.50')), summarize, { approval: { above: '$0.05' } });
 * ```
 */
export type Approval = {
  /** Charge without asking when the amount is at or below this, e.g. `'$0.05'`. Omit to ask for every charge. */
  readonly above?: string;
  /** What the person is asked. Default: `Approve $0.05 for "summarize"?`. */
  readonly message?: (payment: Payment<readonly Rail[]>) => string;
  /** When the client cannot ask anyone: `'deny'` (the default) refuses the call, `'charge'` charges without asking. */
  readonly unsupported?: 'deny' | 'charge';
};

/** Why a call was not charged, when it was not approved. */
export type ApprovalDecision = 'approved' | 'declined' | 'cancelled' | 'unavailable';

/** A confirmation asks for no fields: the client shows the message and the person accepts or declines. */
const CONFIRMATION = { type: 'object' as const, properties: {} };

export type ApprovalRequest = {
  readonly extra: RequestHandlerExtra<ServerRequest, ServerNotification>;
  readonly payment: Payment<readonly Rail[]>;
  readonly tool: string;
  /** The amount `Approval.above` was parsed into at registration, or `null` when every charge is asked about. */
  readonly above: Money | null;
  /** Whether the client declared `capabilities.elicitation.form`: a client that can only open a URL cannot be asked a question. */
  readonly canAsk: boolean;
  readonly approval: Approval;
};

export async function approve({ extra, payment, tool, above, canAsk, approval }: ApprovalRequest): Promise<ApprovalDecision> {
  if (above !== null && compare(payment.amount, above) <= 0) return 'approved';
  if (!canAsk) return approval.unsupported === 'charge' ? 'approved' : 'unavailable';

  const message = approval.message === undefined ? `Approve ${formatMoney(payment.amount)} for "${tool}"?` : approval.message(payment);
  // The request carries this tool call's id, so transports that multiplex deliver it on the caller's stream.
  const { action } = await extra.sendRequest(
    { method: 'elicitation/create', params: { mode: 'form', message, requestedSchema: CONFIRMATION } },
    ElicitResultSchema,
    { signal: extra.signal },
  );
  if (action === 'accept') return 'approved';
  return action === 'decline' ? 'declined' : 'cancelled';
}
