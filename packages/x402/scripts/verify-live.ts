import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { paid } from '@tollstile/fetch';
import { sqliteLedger, sqliteSchema, type SqliteValue } from '@tollstile/sqlite';
import { UptoEvmScheme } from '@x402/evm/upto/client';
import { wrapFetchWithPayment, x402Client } from '@x402/fetch';
import { createTollstile, parseMoney, toAssetUnits, upTo, type Charge, type Ledger } from 'tollstile';
import { privateKeyToAccount } from 'viem/accounts';
import { x402 } from '../src/index';
import { proxyFacilitator, serve, type Served } from './lib/http';
import { preflight } from './lib/preflight';
import { Recorder, type ScenarioName, type ScenarioRecord } from './lib/record';
import { Rpc, sameAddress } from './lib/rpc';

/**
 * Live verification of the `upto` scheme on a testnet, against a real facilitator and a real chain.
 *
 *   TOLLSTILE_SECRET=… PAYER_KEY=0x… PAY_TO=0x… pnpm --filter @tollstile/x402 verify-live
 *
 * Five scenarios, each ending in a state the README claims: a payment below the authorization cap,
 * a replay that moves nothing, a handler failure that releases and then settles once on retry, a
 * settlement whose answer is lost and is recovered from the chain, and a settlement that never
 * happened and expires. The run stops on the first failure, writes a record of public facts, and
 * exits non-zero.
 *
 * It signs real payments. It refuses to run on a mainnet, spends a few cents, and prints nothing
 * but amounts, states, and transaction hashes.
 */

const CAP = '$0.05';
const SPENT_ON_SUCCESS = '$0.03';
const SPENT_ON_RETRY = '$0.02';
const SPENT_ON_LOST = '$0.02';
/** Enough headroom that the five scenarios never stop halfway for want of a cent. */
const REQUIRED_BALANCE = '$0.50';
const BODY = JSON.stringify({ prompt: 'verify' });

async function main(): Promise<number> {
  const network = caip2(env('NETWORK') ?? 'eip155:84532');
  const rpcUrl = env('RPC_URL') ?? 'https://sepolia.base.org';
  const facilitatorUrl = env('FACILITATOR_URL') ?? 'https://x402.org/facilitator';
  const payTo = required('PAY_TO');
  const secret = required('TOLLSTILE_SECRET');
  const account = privateKeyToAccount(payerKey());
  const only = flag('--scenario');
  const deadlineMs = Number(flag('--timeout') ?? '15') * 60_000;
  const recordPath = resolve(flag('--record') ?? `x402-live-${network.replace(':', '-')}.json`);
  mkdirSync(dirname(recordPath), { recursive: true });

  const { asset, facilitatorAddress } = await preflight({
    network,
    rpcUrl,
    facilitatorUrl,
    payer: account.address,
    payTo,
    spend: parseMoney(REQUIRED_BALANCE),
  });
  console.log(`payer ${account.address} · receiver ${payTo} · ${asset.code} on ${network}`);
  console.log(`facilitator ${facilitatorUrl}, upto spender ${facilitatorAddress}`);
  if (process.argv.includes('--preflight')) {
    console.log('preflight only: nothing was signed.');
    return 0;
  }

  const about = { network, payTo, payer: account.address, facilitator: facilitatorUrl };
  const recorder = Recorder.resume(recordPath, about) ?? Recorder.begin(recordPath, { ...about, asset: asset.code });
  const rpc = new Rpc(rpcUrl);
  const ledger = openLedger(`${recordPath.replace(/\.json$/, '')}.db`);

  const client = new x402Client().register(network, new UptoEvmScheme(account, { rpcUrl }));
  const signatures: string[] = [];
  const pay = wrapFetchWithPayment(capturing(signatures), client);

  const context: Context = {
    network,
    rpcUrl,
    payTo,
    secret,
    facilitatorAddress,
    ledger,
    rpc,
    asset: { code: asset.code, address: asset.address, decimals: asset.decimals },
    pay,
    signatures,
    deadline: () => Date.now() + deadlineMs,
    payer: account.address,
  };

  const scenarios: readonly (readonly [ScenarioName, (context: Context, record: ScenarioRecord) => Promise<void>])[] = [
    ['success', success],
    ['replay', replay],
    ['retry', retry],
    ['lost-settle', lostSettle],
    ['dropped-settle', droppedSettle],
  ];

  let failed = false;
  for (const [name, run] of scenarios) {
    const record = recorder.scenario(name);
    if (record.status === 'passed') {
      console.log(`· ${name}: already passed in an earlier run`);
      continue;
    }
    if (only !== undefined && only !== name) continue;
    record.status = 'pending';
    record.startedAt ??= new Date().toISOString();
    record.failure = null;
    console.log(`▸ ${name}: ${record.title}`);
    try {
      await run(context, record);
      record.status = 'passed';
      record.finishedAt = new Date().toISOString();
      console.log(`  passed${record.transaction === null ? '' : ` · ${record.transaction}`}`);
    } catch (error) {
      record.status = 'failed';
      record.finishedAt = new Date().toISOString();
      record.failure = error instanceof Error ? error.message : String(error);
      console.log(`  FAILED · ${record.failure}`);
      failed = true;
      recorder.save();
      break;
    }
    recorder.save();
  }

  recorder.save();
  console.log(`record written to ${recordPath}`);
  return failed ? 1 : 0;
}

type Context = {
  readonly network: string;
  readonly rpcUrl: string;
  readonly payTo: string;
  readonly secret: string;
  readonly facilitatorAddress: string;
  readonly ledger: Ledger;
  readonly rpc: Rpc;
  readonly asset: { readonly code: string; readonly address: string; readonly decimals: number };
  readonly pay: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** Every `PAYMENT-SIGNATURE` the reference client has sent, so a replay can resend one. */
  readonly signatures: string[];
  readonly deadline: () => number;
  readonly payer: string;
};

// ─── Scenarios ────────────────────────────────────────────────────────────────

/** A payment below the cap settles for what the handler used, not for what it authorized. */
async function success(context: Context, record: ScenarioRecord): Promise<void> {
  const stand = await start(context, { facilitator: null });
  try {
    const response = await context.pay(`${stand.url}/pay`, post());
    record.httpStatus = response.status;
    record.authorizedCap = CAP;
    if (response.status !== 200) throw new Error(`expected 200, got ${String(response.status)}: ${(await response.text()).slice(0, 200)}`);
    if (response.headers.get('payment-response') === null) throw new Error('the paid response carried no payment-response header.');

    const charge = stand.only();
    record.chargeId = charge.id;
    record.chargeState = charge.payment;
    if (charge.payment !== 'settled') throw new Error(`the charge is ${charge.payment}, not settled.`);
    record.settlements = stand.settlements(charge.id);
    await confirm(context, record, charge, SPENT_ON_SUCCESS);
  } finally {
    await stand.close();
  }
}

/** The same signature, sent again, is refused and moves nothing. */
async function replay(context: Context, record: ScenarioRecord): Promise<void> {
  const signature = context.signatures.at(-1);
  if (signature === undefined) throw new Error('no signature was captured; run the success scenario in the same run.');
  const stand = await start(context, { facilitator: null });
  try {
    const response = await fetch(`${stand.url}/pay`, post({ 'payment-signature': signature }));
    record.httpStatus = response.status;
    const body: unknown = await response.json();
    const code = (body as { error?: { code?: unknown } }).error?.code;
    record.denialCode = typeof code === 'string' ? code : null;
    if (response.status !== 409 || record.denialCode !== 'proof_already_used') {
      throw new Error(`expected 409 proof_already_used, got ${String(response.status)} ${String(record.denialCode)}.`);
    }
    if (stand.charges().length > 0) throw new Error('a replay created a charge.');
  } finally {
    await stand.close();
  }
}

/** A handler that fails releases the reservation; the same signature then pays exactly once. */
async function retry(context: Context, record: ScenarioRecord): Promise<void> {
  const stand = await start(context, { facilitator: null, failFirst: true });
  try {
    const failure = await context.pay(`${stand.url}/flaky`, post());
    if (failure.status !== 500) throw new Error(`expected the handler's 500, got ${String(failure.status)}.`);
    const released = stand.only();
    if (released.payment !== 'released') throw new Error(`after the handler failed the charge is ${released.payment}, not released.`);

    const signature = context.signatures.at(-1);
    if (signature === undefined) throw new Error('the reference client sent no signature.');
    const response = await fetch(`${stand.url}/flaky`, post({ 'payment-signature': signature }));
    record.httpStatus = response.status;
    if (response.status !== 200) throw new Error(`the retry expected 200, got ${String(response.status)}: ${(await response.text()).slice(0, 200)}`);

    const settled = stand.charges().find((charge) => charge.payment === 'settled');
    if (settled === undefined) throw new Error('the retry settled nothing.');
    record.chargeId = settled.id;
    record.chargeState = settled.payment;
    record.authorizedCap = CAP;
    record.settlements = stand.settlements(settled.id);
    if (record.settlements !== 1) throw new Error(`the charge settled ${String(record.settlements)} times.`);
    await confirm(context, record, settled, SPENT_ON_RETRY);
  } finally {
    await stand.close();
  }
}

/** The facilitator settles and the answer is lost: reconciliation finds the transfer on the chain. */
async function lostSettle(context: Context, record: ScenarioRecord): Promise<void> {
  const proxy = await proxyFacilitator(env('FACILITATOR_URL') ?? 'https://x402.org/facilitator', { settle: 'forward-then-fail' });
  const stand = await start(context, { facilitator: proxy.url });
  try {
    if (record.chargeId === null) {
      const response = await context.pay(`${stand.url}/pay`, post());
      record.httpStatus = response.status;
      record.authorizedCap = CAP;
      if (response.status !== 200) throw new Error(`expected the handler's 200, got ${String(response.status)}.`);
      if (response.headers.get('payment-response') !== null) throw new Error('an unresolved settlement still produced a receipt.');
      const charge = stand.only();
      if (charge.payment !== 'unknown') throw new Error(`losing the answer left the charge ${charge.payment}, not unknown.`);
      record.chargeId = charge.id;
      record.chargeState = charge.payment;
      record.status = 'waiting';
    }
    const chargeId = record.chargeId;
    const resolved = await settleByReconciling(context, stand, chargeId, record);
    if (resolved.payment !== 'settled') throw new Error(`reconciliation left the charge ${resolved.payment}, not settled.`);
    if (proxy.forwarded() !== 1) throw new Error(`the facilitator saw ${String(proxy.forwarded())} settle requests; reconciliation must not send another.`);
    record.settlements = stand.settlements(chargeId);
    await confirm(context, record, resolved, SPENT_ON_LOST);
  } finally {
    await stand.close();
    await proxy.close();
  }
}

/** The facilitator never sees the request: the authorization expires and nothing moves. */
async function droppedSettle(context: Context, record: ScenarioRecord): Promise<void> {
  const proxy = await proxyFacilitator(env('FACILITATOR_URL') ?? 'https://x402.org/facilitator', { settle: 'drop' });
  const stand = await start(context, { facilitator: proxy.url });
  try {
    if (record.chargeId === null) {
      const response = await context.pay(`${stand.url}/pay`, post());
      record.httpStatus = response.status;
      record.authorizedCap = CAP;
      const charge = stand.only();
      if (charge.payment !== 'unknown') throw new Error(`dropping the request left the charge ${charge.payment}, not unknown.`);
      record.chargeId = charge.id;
      record.chargeState = charge.payment;
      record.status = 'waiting';
    }
    const resolved = await settleByReconciling(context, stand, record.chargeId, record);
    if (resolved.payment !== 'failed') throw new Error(`an authorization that was never settled ended as ${resolved.payment}, not failed.`);
    if (proxy.forwarded() !== 0) throw new Error('the facilitator was contacted for a settlement this scenario drops.');
    if (resolved.settlement !== null) throw new Error('a charge that moved no money carries a settlement.');
    record.transaction = null;
    record.transferred = '0';
  } finally {
    await stand.close();
    await proxy.close();
  }
}

// ─── The stand a scenario runs against ────────────────────────────────────────

type Stand = Served & {
  reconcile(): Promise<void>;
  charges(): readonly Charge[];
  /** The single charge this scenario created; throws when there is not exactly one. */
  only(): Charge;
  settlements(chargeId: string): number;
};

async function start(context: Context, options: { facilitator: string | null; failFirst?: boolean }): Promise<Stand> {
  const seen = new Map<string, Charge>();
  const settled = new Map<string, number>();
  const toll = createTollstile({
    rails: [
      x402({
        network: context.network,
        payTo: context.payTo,
        denomination: 'USD',
        rpcUrl: context.rpcUrl,
        upto: { facilitatorAddress: context.facilitatorAddress },
        ...(options.facilitator === null ? {} : { facilitator: { url: options.facilitator } }),
      }),
    ],
    ledger: context.ledger,
    secret: context.secret,
    onEvent: (event) => {
      if (event.type !== 'charge.moved') return;
      seen.set(event.charge.id, event.charge);
      if (event.charge.payment === 'settled' && event.from.payment !== 'settled') settled.set(event.charge.id, (settled.get(event.charge.id) ?? 0) + 1);
    },
  });

  let failed = options.failFirst !== true;
  const routes: Record<string, (request: Request) => Promise<Response>> = {
    '/pay': paid(toll.price(upTo(CAP), { resource: 'POST /pay' }), async (_request, { payment }) => {
      await payment.fulfill({ amount: SPENT_ON_SUCCESS });
      return Response.json({ ok: true });
    }),
    '/flaky': paid(toll.price(upTo(CAP), { resource: 'POST /flaky' }), async (_request, { payment }) => {
      if (!failed) {
        failed = true;
        return new Response('the handler failed on purpose', { status: 500 });
      }
      await payment.fulfill({ amount: SPENT_ON_RETRY });
      return Response.json({ ok: true });
    }),
  };

  const served = await serve(async (request) => {
    const route = routes[new URL(request.url).pathname];
    return route === undefined ? new Response('not found', { status: 404 }) : route(request);
  });

  return {
    url: served.url,
    close: () => served.close(),
    reconcile: async () => {
      await toll.reconcile({ olderThanMs: 0 });
    },
    charges: () => [...seen.values()],
    only: () => {
      const charges = [...seen.values()];
      const one = charges[0];
      if (charges.length !== 1 || one === undefined) throw new Error(`expected one charge, saw ${String(charges.length)}.`);
      return one;
    },
    settlements: (chargeId) => settled.get(chargeId) ?? 0,
  };
}

// ─── Waiting, and what the chain says ─────────────────────────────────────────

/**
 * Reconciles until the charge is final. On Base Sepolia this is minutes: the rail reads at the
 * finalized block, and the expiry case has to wait for finality to pass the authorization's
 * deadline. The record keeps the charge id, so a run that times out resumes instead of paying again.
 */
async function settleByReconciling(context: Context, stand: Stand, chargeId: string, record: ScenarioRecord): Promise<Charge> {
  const until = context.deadline();
  for (;;) {
    await stand.reconcile();
    const charge = await context.ledger.getCharge(chargeId);
    if (charge === undefined) throw new Error(`${chargeId} is not in the ledger.`);
    record.chargeState = charge.payment;
    if (charge.payment === 'settled' || charge.payment === 'failed') return charge;
    if (Date.now() > until) {
      throw new Error(`${chargeId} was still ${charge.payment} when the timeout ran out. Run again with the same --record to keep waiting.`);
    }
    console.log(`  ${charge.payment}; waiting for the chain`);
    await sleep(30_000);
  }
}

/** Reads the transfer out of the settlement's own receipt, and refuses anything above the cap. */
async function confirm(context: Context, record: ScenarioRecord, charge: Charge, spent: string): Promise<void> {
  const transaction = charge.settlement?.reference;
  if (transaction === undefined) throw new Error('the settled charge carries no transaction.');
  record.transaction = transaction;

  const until = context.deadline();
  for (;;) {
    const receipt = await context.rpc.receipt(transaction, context.asset.address);
    if (receipt !== undefined) {
      if (receipt.status !== 'success') throw new Error(`${transaction} reverted.`);
      record.blockNumber = receipt.blockNumber.toString();
      const mine = receipt.transfers.filter((transfer) => sameAddress(transfer.from, context.payer) && sameAddress(transfer.to, context.payTo));
      const one = mine[0];
      if (mine.length !== 1 || one === undefined) throw new Error(`${transaction} holds ${String(mine.length)} transfers from the payer to the receiver.`);
      record.transferred = one.amount.toString();
      const cap = units(context, CAP);
      if (one.amount > cap) throw new Error(`the transfer of ${one.amount.toString()} is above the authorized ${cap.toString()}.`);
      const expected = units(context, spent);
      if (one.amount !== expected) throw new Error(`the transfer of ${one.amount.toString()} is not the fulfilled ${expected.toString()}.`);
      return;
    }
    if (Date.now() > until) throw new Error(`${transaction} had not been mined when the timeout ran out.`);
    await sleep(5_000);
  }
}

function units(context: Context, amount: string): bigint {
  return toAssetUnits(parseMoney(amount), context.asset.decimals);
}

// ─── Plumbing ─────────────────────────────────────────────────────────────────

function post(headers: Record<string, string> = {}): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: BODY };
}

/** Keeps every `PAYMENT-SIGNATURE` the client sends, so replay and retry can resend one. */
function capturing(signatures: string[]): typeof globalThis.fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const signature = request.headers.get('payment-signature');
    if (signature !== null) signatures.push(signature);
    return fetch(request);
  };
}

function openLedger(path: string): Ledger {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(sqliteSchema);
  const all = (sql: string, params: readonly SqliteValue[]) => db.prepare(sql).all(...params);
  return sqliteLedger({
    execute: all,
    transaction: (statements) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const rows = statements.map((statement) => all(statement.sql, statement.params));
        db.exec('COMMIT');
        return rows;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The reference client types a network as `namespace:reference`; this keeps that check at the edge. */
function caip2(value: string): `${string}:${string}` {
  const [namespace, reference] = value.split(':');
  if (namespace === undefined || reference === undefined || reference === '') throw new Error(`NETWORK must be a CAIP-2 id such as eip155:84532, not ${value}.`);
  return `${namespace}:${reference}`;
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

function required(name: string): string {
  const value = env(name);
  if (value === undefined) throw new Error(`${name} is not set. See scripts/README.md.`);
  return value;
}

/** Read once, never printed, never recorded. */
function payerKey(): `0x${string}` {
  const key = required('PAYER_KEY');
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('PAYER_KEY is not a 32-byte hex private key.');
  return key as `0x${string}`;
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

process.exitCode = await main().catch((error: unknown) => {
  // A run that stops has to say why in a way a person can act on. A stack trace is not that.
  console.error(error instanceof Error ? error.message : String(error));
  return 1;
});
