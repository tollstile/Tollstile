import { McpError, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { TollstileError, type ChallengeOffer, type Denial, type JsonObject } from 'tollstile';
import { isJsonObject } from './json-object';

/**
 * MPP's JSON-RPC "Payment Required" code. McpServer (1.23+) sends an McpError with this code from a
 * tool callback to the client as a JSON-RPC error, because URL elicitation shares the code. Any
 * other error thrown from a tool callback becomes an `isError` tool result, which is why MPP's
 * `-32043` (verification failed) cannot be sent: a failed verification is `-32042` with `failure`.
 */
const PAYMENT_REQUIRED_CODE = -32042;

/** Where every denial rendered as a tool result carries Tollstile's full denial body. */
export const DENIAL_META = 'tollstile/payment-required';

/** A rail's `challenge.mcp`, read per the MCP challenge convention. */
type McpChallenge =
  | { readonly style: 'x402'; readonly paymentRequired: JsonObject }
  | { readonly style: 'mpp'; readonly challenge: JsonObject }
  | { readonly style: 'tollstile' };

export type Rendering =
  | { readonly kind: 'error'; readonly error: McpError }
  | { readonly kind: 'result'; readonly result: CallToolResult };

/**
 * Renders a denial in the richest form the client can use: MPP's JSON-RPC error when the client
 * declared `experimental.payment`, x402's payment-required tool result, or Tollstile's body.
 */
export function renderDenial(denial: Denial, clientAcceptsMpp: boolean): Rendering {
  const challenges = denial.offers.map(readChallenge);
  const reason = denial.error.code === 'payment_required' ? undefined : (denial.error.detail ?? denial.error.code);

  const mpp = challenges.flatMap((challenge) => (challenge.style === 'mpp' ? [challenge.challenge] : []));
  if (clientAcceptsMpp && mpp.length > 0) {
    const data = { httpStatus: denial.status, challenges: mpp, ...(reason === undefined ? {} : { failure: { reason } }) };
    return { kind: 'error', error: new McpError(PAYMENT_REQUIRED_CODE, 'Payment Required', data) };
  }

  const meta = { [DENIAL_META]: denial.body };
  const x402 = challenges.find((challenge) => challenge.style === 'x402');
  if (x402 !== undefined) {
    const paymentRequired = reason === undefined ? x402.paymentRequired : { ...x402.paymentRequired, error: reason };
    return {
      kind: 'result',
      result: {
        isError: true,
        structuredContent: paymentRequired,
        content: [{ type: 'text', text: JSON.stringify(paymentRequired) }],
        _meta: meta,
      },
    };
  }

  // No structuredContent: the client validates it against the tool's outputSchema, and the denial
  // body would fail that validation.
  return {
    kind: 'result',
    result: { isError: true, content: [{ type: 'text', text: JSON.stringify(denial.body) }], _meta: meta },
  };
}

function readChallenge({ offer, challenge }: ChallengeOffer): McpChallenge {
  const { mcp } = challenge;
  if (mcp.style === 'tollstile') return { style: 'tollstile' };
  if (mcp.style === 'x402') {
    const { paymentRequired } = mcp;
    if (paymentRequired === undefined || !isJsonObject(paymentRequired)) {
      throw conventionBroken(offer.rail, 'has style "x402" but no "paymentRequired" object');
    }
    return { style: 'x402', paymentRequired };
  }
  if (mcp.style === 'mpp') {
    const { challenge: mppChallenge } = mcp;
    if (mppChallenge === undefined || !isJsonObject(mppChallenge)) {
      throw conventionBroken(offer.rail, 'has style "mpp" but no "challenge" object');
    }
    return { style: 'mpp', challenge: mppChallenge };
  }
  // A convention this adapter does not know still reaches the client through Tollstile's `_meta` form.
  return { style: 'tollstile' };
}

function conventionBroken(rail: string, problem: string): TollstileError {
  return new TollstileError(
    'UNREACHABLE',
    `Rail "${rail}" returned an MCP challenge that ${problem}. Fix the rail's challenge() to follow the MCP challenge convention.`,
  );
}
