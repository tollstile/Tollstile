import { createInterface } from 'node:readline/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ElicitRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { compare, formatMoney, money, parseMoney } from 'tollstile';

/**
 * An agent that pays for MCP tools, with the two consents that belong on this side of the wire:
 * a spending cap it enforces itself, and a person it asks when the server wants one.
 *
 *   pnpm --filter @tollstile-examples/demo agent -- --budget '$0.25'
 *   pnpm --filter @tollstile-examples/demo agent -- --url http://localhost:8787/mcp --yes
 *
 * `--yes` and `--no` answer for the person, so the run needs nobody at the keyboard.
 */
const url = flag('--url') ?? 'https://demo.tollstile.com/mcp';
const budget = parseMoney(flag('--budget') ?? '$0.25');
const answerForThem = process.argv.includes('--yes') ? 'accept' : process.argv.includes('--no') ? 'decline' : undefined;

let spent = money('USD', 0n);
const left = () => money('USD', budget.micros - spent.micros);

const terminal = createInterface({ input: process.stdin, output: process.stdout });
const client = new Client({ name: 'tollstile-demo-agent', version: '1.0.0' }, { capabilities: { elicitation: { form: {} } } });

// The model never sees this: the client decides, within limits its owner set, whether to pay.
client.setRequestHandler(ElicitRequestSchema, async ({ params }) => {
  console.log(`\n  the server is asking a person: ${params.message}`);
  if (answerForThem !== undefined) {
    console.log(`  --${answerForThem === 'accept' ? 'yes' : 'no'} was passed, so the client answers for them: ${answerForThem}`);
    return { action: answerForThem };
  }
  const answer = await terminal.question('  approve? [y/N] ');
  return { action: answer.trim().toLowerCase().startsWith('y') ? 'accept' : 'decline' };
});

// The SDK's client transports type `sessionId` as `string | undefined`, which this repository's
// `exactOptionalPropertyTypes` rejects against `Transport`'s optional field of the same name.
await client.connect(new StreamableHTTPClientTransport(new URL(url)) as Transport);
console.log(`connected to ${url}, budget ${formatMoney(budget)}\n`);

console.log('pricing (free)');
console.log(indent(textOf((await client.callTool({ name: 'pricing' })) as CallToolResult)));

console.log('\nforecast');
await pay('forecast', {});

console.log('\nsummarize');
await pay('summarize', { text: 'Tollstile prices the call. The handler reports what it used. Only that is charged, and only after someone says yes.' });

console.log(`\nspent ${formatMoney(spent)} of ${formatMoney(budget)}`);
await client.close();
terminal.close();

/** Calls a tool, pays what it asks for if the budget covers it, and reports what came back. */
async function pay(name: string, args: Record<string, unknown>): Promise<void> {
  const idempotencyKey = crypto.randomUUID();
  const unpaid = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const required = challengeOf(unpaid);
  if (required === undefined) {
    console.log(indent(textOf(unpaid)));
    return;
  }

  const price = parseMoney(required.price);
  console.log(`  ${required.price} — ${formatMoney(left())} of the budget left`);
  if (compare(price, left()) > 0) {
    console.log('  over budget: not paying, and nothing was charged');
    return;
  }

  const paid = (await client.callTool({
    name,
    arguments: args,
    _meta: { 'tollstile/test-payment': `test quote=${required.quote}`, 'tollstile/idempotency-key': idempotencyKey },
  })) as CallToolResult;

  if (paid.isError === true) {
    console.log(`  not charged: ${denialOf(paid) ?? textOf(paid)}`);
    return;
  }

  // The quoted price is the most this call can cost; `upTo` routes settle for what the handler used.
  spent = money('USD', spent.micros + price.micros);
  console.log(indent(textOf(paid)));
  console.log(`  receipt ${String(paid._meta?.['tollstile/test-receipt'])}`);

  const retry = (await client.callTool({
    name,
    arguments: args,
    _meta: { 'tollstile/test-payment': `test quote=${required.quote}`, 'tollstile/idempotency-key': idempotencyKey },
  })) as CallToolResult;
  console.log(`  same call, same idempotency key → ${denialOf(retry) ?? (retry.isError === true ? 'refused' : 'charged again')}`);
}

/** Tollstile's payment requirement, as every denial carries it. */
function challengeOf(result: CallToolResult): { readonly price: string; readonly quote: string } | undefined {
  const body = result._meta?.['tollstile/payment-required'];
  if (typeof body !== 'object' || body === null) return undefined;
  const { price, quote } = body as { price?: unknown; quote?: unknown };
  return typeof price === 'string' && typeof quote === 'string' ? { price, quote } : undefined;
}

function denialOf(result: CallToolResult): string | undefined {
  const body = result._meta?.['tollstile/payment-required'];
  if (typeof body !== 'object' || body === null) return undefined;
  const { error } = body as { error?: { code?: unknown; detail?: unknown } };
  if (typeof error?.code !== 'string') return undefined;
  return typeof error.detail === 'string' ? `${error.code} (${error.detail})` : error.code;
}

function textOf(result: CallToolResult): string {
  return result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
}

function indent(text: string): string {
  return text.replace(/^/gm, '  ');
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}
