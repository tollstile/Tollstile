import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatMoney } from './core/money';
import type { ReconcileReport } from './core/reconcile';

type Reconciler = { reconcile(options?: { readonly olderThanMs?: number; readonly limit?: number }): Promise<ReconcileReport> };

/** Runs past this many full pages are left for the next invocation, so a cron cannot run forever. */
const MAX_ROUNDS = 20;

const USAGE = `Usage: tollstile reconcile [options]

Resolves charges left mid-lifecycle by crashes or unknown provider outcomes. Run it on a schedule.

Options:
  --config <file>     Module whose default export is your Tollstile instance, { toll }, or a
                      function returning either (default: tollstile.config.mjs)
  --older-than <age>  Only charges last updated before this long ago: 90s, 15m, 2h, 1d (default: 15m)
  --json              Print the report as JSON
  --fail-on-pending   Exit 2 when charges remain unresolved, e.g. for alerting from cron

Exit codes: 0 done · 1 errors were reported · 2 charges still pending (with --fail-on-pending)
Docs: https://tollstile.com/docs/guides/reconciliation`;

const args = process.argv.slice(2);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

if (args[0] !== 'reconcile' || args.includes('--help') || args.includes('-h')) {
  console.log(USAGE);
  process.exit(args[0] === undefined || args.includes('--help') || args.includes('-h') ? 0 : 1);
}

const olderThan = option('--older-than') ?? '15m';
const olderThanMs = parseDuration(olderThan);
if (olderThanMs === undefined) {
  console.error(`--older-than ${olderThan} is not a duration. Use a number with s, m, h, or d, e.g. 15m.`);
  process.exit(1);
}

const configPath = resolve(option('--config') ?? 'tollstile.config.mjs');
const toll = await loadReconciler(configPath);
const rounds: ReconcileReport[] = [];
do rounds.push(await toll.reconcile({ olderThanMs }));
while (rounds.length < MAX_ROUNDS && (rounds.at(-1)?.truncated ?? false));
const report: ReconcileReport = {
  examined: rounds.reduce((sum, round) => sum + round.examined, 0),
  resolved: rounds.reduce((sum, round) => sum + round.resolved, 0),
  pending: rounds.reduce((sum, round) => sum + round.pending, 0),
  charges: rounds.flatMap((round) => round.charges),
  errors: rounds.flatMap((round) => round.errors),
  truncated: rounds.at(-1)?.truncated ?? false,
};

if (args.includes('--json')) {
  console.log(JSON.stringify(report, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value), 2));
} else {
  console.log(`Reconciled ${String(report.examined)} charge${report.examined === 1 ? '' : 's'} last updated more than ${olderThan} ago`);
  for (const charge of report.charges) {
    const after = charge.after === null ? 'missing' : `${charge.after.payment}/${charge.after.fulfillment}`;
    const mark = charge.after !== null && after !== `${charge.before.payment}/${charge.before.fulfillment}` ? '→' : '·';
    console.log(`  ${charge.id}  ${charge.resource}  ${formatMoney(charge.amount)}  ${charge.before.payment}/${charge.before.fulfillment} ${mark} ${after}`);
  }
  console.log(`  ${String(report.resolved)} resolved · ${String(report.pending)} pending · ${String(report.errors.length)} error${report.errors.length === 1 ? '' : 's'}${report.truncated ? ' · more remain: run again' : ''}`);
  for (const error of report.errors) console.log(`  ! ${error.code}${error.chargeId === null ? '' : ` ${error.chargeId}`}: ${error.message}`);
}

process.exit(report.errors.length > 0 ? 1 : args.includes('--fail-on-pending') && report.pending > 0 ? 2 : 0);

async function loadReconciler(path: string): Promise<Reconciler> {
  const module = (await import(pathToFileURL(path).href)) as { default?: unknown };
  const loaded = typeof module.default === 'function' ? await (module.default as () => unknown)() : module.default;
  const candidate = isReconciler(loaded) ? loaded : typeof loaded === 'object' && loaded !== null && 'toll' in loaded ? loaded.toll : undefined;
  if (!isReconciler(candidate)) {
    console.error(`${path} must default-export your Tollstile instance (createTollstile(...)), { toll }, or a function returning either.`);
    process.exit(1);
  }
  return candidate;
}

function isReconciler(value: unknown): value is Reconciler {
  return typeof value === 'object' && value !== null && 'reconcile' in value && typeof value.reconcile === 'function';
}

function parseDuration(text: string): number | undefined {
  const match = /^(\d+)(ms|s|m|h|d)?$/.exec(text.trim());
  if (match === null) return undefined;
  const unit = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[(match[2] ?? 'ms') as 'ms' | 's' | 'm' | 'h' | 'd'];
  return Number(match[1]) * unit;
}
