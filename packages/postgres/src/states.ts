import {
  isChargeTerminal,
  type AuthorizationKind,
  type Flow,
  type FulfillmentState,
  type PaymentState,
  type PendingOperation,
} from 'tollstile';

// Mapped over core's unions so a value added to core fails to compile here until the schema handles it.
const paymentNames: { readonly [State in PaymentState]: State } = {
  reserved: 'reserved',
  settling: 'settling',
  settled: 'settled',
  failed: 'failed',
  unknown: 'unknown',
  released: 'released',
  refund_pending: 'refund_pending',
  refunded: 'refunded',
};
const fulfillmentNames: { readonly [State in FulfillmentState]: State } = {
  pending: 'pending',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
};
const pendingNames: { readonly [Operation in PendingOperation]: Operation } = { settle: 'settle', refund: 'refund' };
const flowNames: { readonly [Name in Flow]: Name } = { authorization: 'authorization', upfront: 'upfront', escrow: 'escrow' };
const kindNames: { readonly [Kind in AuthorizationKind]: Kind } = { single: 'single', reusable: 'reusable' };

export const paymentStates = Object.values(paymentNames);
export const fulfillmentStates = Object.values(fulfillmentNames);
export const pendingOperations = Object.values(pendingNames);
export const flows = Object.values(flowNames);
export const authorizationKinds = Object.values(kindNames);

/** The payment states `spendSince` leaves out: nothing moved, or it went back. */
export const excludedFromSpend = ['released', 'failed', 'refunded'] as const satisfies readonly PaymentState[];

export const list = (values: readonly string[]): string => values.map((value) => `'${value}'`).join(', ');

const openFulfillment = (payment: PaymentState) =>
  fulfillmentStates.filter((fulfillment) => !isChargeTerminal({ payment, fulfillment }));
const alwaysOpen = paymentStates.filter((payment) => openFulfillment(payment).length === fulfillmentStates.length);
const sometimesOpen = paymentStates.filter((payment) => ![0, fulfillmentStates.length].includes(openFulfillment(payment).length));

/**
 * Charges core's `isChargeTerminal` considers unfinished. The partial index and `pendingCharges`
 * use this exact text so the planner can prove the query is covered by the index.
 */
export const nonTerminalCondition = `(${[
  `payment IN (${list(alwaysOpen)})`,
  ...sometimesOpen.map((payment) => `(payment = '${payment}' AND fulfillment IN (${list(openFulfillment(payment))}))`),
].join(' OR ')})`;
