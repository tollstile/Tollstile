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

// Read the price list before buying anything, the way a person reads a menu.
const menu = (await (await fetch(new URL('/.well-known/tollstile', url))).json()) as {
  offers: { call: string; price: string; plan: { pricing: string; access: string[]; rails: { rail: string; flow: string }[] } }[];
};
console.log('on sale here');
for (const offer of menu.offers) {
  const access = offer.plan.access.length === 0 ? 'everyone pays' : offer.plan.access.join(' → ');
  console.log(`  ${offer.call.padEnd(26)} ${offer.price.padEnd(34)} ${offer.plan.pricing} · ${access} · ${offer.plan.rails.map((r) => `${r.rail}/${r.flow}`).join(', ')}`);
}

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

  // The same proof and the same key every time: a retry is the same operation, never a second one.
  const meta = { 'tollstile/test-payment': `test quote=${required.quote}`, 'tollstile/idempotency-key': idempotencyKey };
  let paid = (await client.callTool({ name, arguments: args, _meta: meta })) as CallToolResult;
  for (let attempt = 0; attempt < 3 && bodyOf(paid)?.error?.action === 'retry_later'; attempt += 1) {
    console.log(`  ${denialOf(paid) ?? 'not yet'}`);
    await waitToRetry(bodyOf(paid) ?? {}, attempt);
    paid = (await client.callTool({ name, arguments: args, _meta: meta })) as CallToolResult;
  }

  if (paid.isError === true) {
    console.log(`  not charged: ${denialOf(paid) ?? textOf(paid)}`);
    return;
  }

  // The quoted price is the most this call can cost; `upTo` routes settle for what the handler used.
  spent = money('USD', spent.micros + price.micros);
  console.log(indent(textOf(paid)));
  console.log(`  receipt ${String(paid._meta?.['tollstile/test-receipt'])}`);

  const retry = (await client.callTool({ name, arguments: args, _meta: meta })) as CallToolResult;
  console.log(`  same call, same idempotency key → ${denialOf(retry) ?? (retry.isError === true ? 'refused' : 'charged again')}`);

  // A retry that lost its answer is told where the answer is, instead of paying for it again.
  const kept = bodyOf(retry)?.result;
  if (typeof kept === 'string') {
    const response = await fetch(new URL(`/v1/${kept}`, url));
    console.log(`  and where to find what it paid for: ${kept} → ${(await response.text()).trim()}`);
  }
}

/**
 * Waits the way a client should when a server says "later": the wait it asked for, doubled per
 * attempt, with the whole of it random. Retrying on the exact second every other client picked is
 * how a busy service is kept busy.
 */
async function waitToRetry(denial: { readonly retryAfter?: number }, attempt: number): Promise<void> {
  const asked = (denial.retryAfter ?? 5) * 1000;
  const ceiling = Math.min(asked * 2 ** attempt, 60_000);
  const wait = Math.round(asked + Math.random() * (ceiling - asked));
  console.log(`  waiting ${(wait / 1000).toFixed(1)}s before attempt ${String(attempt + 2)}`);
  await new Promise((resolve) => setTimeout(resolve, wait));
}

/** Tollstile's payment requirement, as every denial carries it. */
function challengeOf(result: CallToolResult): { readonly price: string; readonly quote: string } | undefined {
  const body = result._meta?.['tollstile/payment-required'];
  if (typeof body !== 'object' || body === null) return undefined;
  const { price, quote } = body as { price?: unknown; quote?: unknown };
  return typeof price === 'string' && typeof quote === 'string' ? { price, quote } : undefined;
}

function denialOf(result: CallToolResult): string | undefined {
  const body = bodyOf(result);
  if (body === undefined) return undefined;
  const { error } = body;
  if (typeof error?.code !== 'string') return undefined;
  return typeof error.detail === 'string' ? `${error.code} (${error.detail})` : error.code;
}

type DenialBody = {
  readonly error?: { code?: unknown; detail?: unknown; action?: unknown };
  readonly retryAfter?: number;
  /** Where the merchant kept what this charge already paid for. */
  readonly result?: unknown;
};

function bodyOf(result: CallToolResult): DenialBody | undefined {
  const body = result._meta?.['tollstile/payment-required'];
  return typeof body === 'object' && body !== null ? body : undefined;
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
