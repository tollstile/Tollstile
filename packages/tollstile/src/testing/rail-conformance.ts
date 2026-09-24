import { canonicalJson } from '../core/codec';
import { isChargeTerminal } from '../core/states';
import { createTollstile } from '../core/tollstile';
import type { Authorization, Charge, ChallengeOffer, Clock, Denial, Entry, Json, Rail, TollstileEvent } from '../core/types';
import { memoryLedger } from '../ledgers/memory/memory-ledger';
import { httpContext } from './contexts';

export type RailHarness = {
  readonly rail: Rail;
  /** The clock the rail and its fake provider use. It must be advanceable. */
  readonly clock: Clock & { advance(ms: number): void };
  /** A fixed price the fake provider can pay. Defaults to `"$1"`, above common provider minimums. */
  readonly price?: string;
  /** Builds a request that pays `offer` from `denial`. Every call must create a new proof. */
  pay(input: { readonly denial: Denial; readonly offer: ChallengeOffer; readonly url: string }): Promise<Request>;
  /** Economic effects the fake provider has performed: settlements, or transfers. */
  settlements(): number | Promise<number>;
  /** The next settlement is performed, but its response is lost (the rail throws `PROVIDER_TIMEOUT`). */
  loseNextSettleResponse?(): void;
  /** The next settlement fails before any effect (the rail throws `PROVIDER_TIMEOUT` or `PROVIDER_UNAVAILABLE`). */
  failNextSettle?(): void;
  /** Returns a copy of a paying request whose proof the rail must reject. */
  tamper?(request: Request): Request;
  /** How long reconciliation must wait before the provider can answer lookups. Defaults to one hour. */
  readonly reconcileAfterMs?: number;
};

export type ConformanceCase = {
  readonly name: string;
  /** Set when the harness cannot exercise this case; report it as skipped. */
  readonly skip?: string | undefined;
  run(): Promise<void>;
};

const URL_UNDER_TEST = 'http://localhost/conformance';
const RESOURCE = 'GET /conformance';
// A second priced resource at the same price, for proofs presented where they were not bought.
const OTHER_URL = 'http://localhost/conformance/other';
const OTHER_RESOURCE = 'GET /conformance/other';

/**
 * The rail contract from SPEC.md, as cases a rail's own test suite runs against its fake provider.
 * `createHarness` is called once per case, so every case starts with a fresh rail and provider:
 *
 * ```ts
 * for (const test of railConformance(createHarness)) (test.skip ? it.skip : it)(test.name, () => test.run());
 * ```
 */
export function railConformance(createHarness: () => RailHarness): readonly ConformanceCase[] {
  const probe = createHarness();
  const { rail } = probe;
  const single = rail.capabilities.authorization === 'single';
  const noFault = 'the harness does not provide this fault';

  return [
    {
      name: `${rail.name}: declares a usable contract`,
      async run() {
        const harness = createHarness();
        const { rail } = harness;
        check(rail.name.length > 0 && !rail.name.startsWith('policy:'), 'name must be non-empty and not start with "policy:"');
        check(rail.capabilities.lookup, 'capabilities.lookup must be true');
        check(rail.capabilities.flows.length > 0, 'capabilities.flows must not be empty');
        check(!rail.capabilities.flows.includes('upfront') || rail.capabilities.refund, 'the upfront flow requires refund');
        check(!rail.capabilities.partialRefund || rail.capabilities.refund, 'partialRefund requires refund');
        const verification = await rail.verify(httpContext(new Request(URL_UNDER_TEST), { resource: RESOURCE }), {
          resource: RESOURCE,
          price: { currency: 'USD', micros: 1_000_000n },
          variable: false,
          flow: rail.capabilities.flows[0] ?? 'authorization',
          openQuote: () => Promise.resolve(undefined),
        }, operation('verify'));
        check(verification.status === 'absent', `a request without a proof must verify as absent, got ${verification.status}`);
      },
    },
    {
      name: `${rail.name}: challenges with an offer, pays, settles once, and attaches a receipt`,
      async run() {
        const harness = createHarness();
        const run = setup(harness);
        const { denial, offer } = await run.challenge();
        check(denial.error.code === 'payment_required', `an unpaid request must be payment_required, got ${denial.error.code}`);
        check(/^\d+$/.test(offer.offer.amount), 'offer.amount must be an integer string in asset units');
        check(Number.isInteger(offer.offer.asset.scale) && offer.offer.asset.scale >= 0, 'offer.asset.scale must be a non-negative integer');
        check(typeof offer.challenge.mcp.style === 'string', 'challenge.mcp.style must be a string');

        const entry = await run.enter(await harness.pay({ denial, offer, url: URL_UNDER_TEST }));
        const pass = admitted(entry);
        const completion = await pass.complete('succeeded');
        check(completion.settlement === 'settled', `a paid request must settle, got ${completion.settlement}`);
        check(completion.receipt.headers.length > 0 || Object.keys(completion.receipt.meta).length > 0, 'a settled request must carry a receipt');
        const charge = run.onlyCharge();
        check(charge.payment === 'settled' && charge.fulfillment === 'completed', `the charge must be settled/completed, got ${states(charge)}`);
        check((await harness.settlements()) === 1, 'the provider must have settled exactly once');
      },
    },
    {
      name: `${rail.name}: refuses a replayed single-use proof without a second effect`,
      skip: single ? undefined : 'reusable authorizations accept the same proof again',
      async run() {
        const harness = createHarness();
        const run = setup(harness);
        const { denial, offer } = await run.challenge();
        const paying = await harness.pay({ denial, offer, url: URL_UNDER_TEST });
        await admitted(await run.enter(paying.clone())).complete('succeeded');

        const replay = await run.enter(paying.clone());
        check(replay.kind === 'denied', 'a replayed proof must be denied');
        check((await harness.settlements()) === 1, 'a replay must not settle again');
      },
    },
    {
      // A proof that is not bound to what it was bought for can be spent by anyone who sees it: a
      // public payment presented by a bystander, or an old one never presented at all. The second
      // half matters as much as the first: refusing the stranger must not lock out the payer.
      name: `${rail.name}: a proof bought for one resource cannot pay for another, and still pays for its own`,
      skip: single ? undefined : 'reusable authorizations may pay for any resource the payer authorized',
      async run() {
        const harness = createHarness();
        const run = setup(harness);
        const { denial, offer } = await run.challenge();
        const paying = await harness.pay({ denial, offer, url: URL_UNDER_TEST });
        const before = await harness.settlements();

        const elsewhere = await run.enterOther(new Request(OTHER_URL, { headers: paying.headers }));
        check(elsewhere.kind === 'denied', 'a proof bought for one resource must not be admitted at another resource with the same price');
        check((await harness.settlements()) === before, 'a proof presented at the wrong resource must have no effect');

        const own = await run.enter(paying.clone());
        check(own.kind === 'admitted', 'the proof must still pay for the resource it was bought for after being refused elsewhere');
        if (own.kind === 'admitted') await own.pass.complete('succeeded');
      },
    },
    {
      name: `${rail.name}: rejects a tampered proof`,
      skip: probe.tamper === undefined ? 'the harness cannot tamper with a proof' : undefined,
      async run() {
        const harness = createHarness();
        const run = setup(harness);
        const { denial, offer } = await run.challenge();
        const tampered = harness.tamper?.(await harness.pay({ denial, offer, url: URL_UNDER_TEST }));
        if (tampered === undefined) return;
        const entry = await run.enter(tampered);
        check(entry.kind === 'denied', 'a tampered proof must be denied');
        if (entry.kind === 'denied') {
          check(['proof_invalid', 'quote_invalid', 'payment_required'].includes(entry.denial.error.code), `unexpected code ${entry.denial.error.code}`);
        }
        check((await harness.settlements()) === 0, 'a tampered proof must not settle');
      },
    },
    {
      name: `${rail.name}: a failed handler keeps no money`,
      async run() {
        const harness = createHarness();
        const run = setup(harness);
        const { denial, offer } = await run.challenge();
        const pass = admitted(await run.enter(await harness.pay({ denial, offer, url: URL_UNDER_TEST })));
        const completion = await pass.complete('failed');
        check(completion.settlement === 'none', `a failed handler must report none, got ${completion.settlement}`);
        const charge = run.onlyCharge();
        const settled = await harness.settlements();
        if (charge.flow === 'authorization') {
          check(charge.payment === 'released' && settled === 0, `nothing may settle in the authorization flow, got ${states(charge)} with ${String(settled)} settlements`);
        } else if (rail.capabilities.refund) {
          check(charge.payment === 'refunded', `an upfront charge must be refunded, got ${states(charge)}`);
        } else {
          // Paid at verification on a rail that cannot refund: kept, recorded as not delivered, and reported (SPEC §7).
          check(charge.payment === 'settled' && charge.fulfillment === 'failed', `a payment that cannot be refunded must stay settled/failed, got ${states(charge)}`);
        }
      },
    },
    {
      name: `${rail.name}: settling again with the same key has no second effect`,
      async run() {
        const harness = createHarness();
        const { rail } = harness;
        const run = setup(harness);
        const { denial, offer } = await run.challenge();
        await admitted(await run.enter(await harness.pay({ denial, offer, url: URL_UNDER_TEST }))).complete('succeeded');
        const { charge, authorization } = run.recorded();

        const again = await rail.settle(authorization, charge, operation(`${charge.id}:settle`));
        check((await harness.settlements()) === 1, 'a repeated settle with the same key must not settle again');
        check(
          again.status === 'rejected' || again.reference === charge.settlement?.reference,
          'a repeated settle must return the recorded settlement or a rejection',
        );
      },
    },
    {
      name: `${rail.name}: a lost settlement response is resolved by lookup, never guessed`,
      skip: probe.loseNextSettleResponse === undefined ? noFault : undefined,
      async run() {
        const harness = createHarness();
        const run = setup(harness);
        const { denial, offer } = await run.challenge();
        const paying = await harness.pay({ denial, offer, url: URL_UNDER_TEST });
        harness.loseNextSettleResponse?.();
        const entry = await run.enter(paying);
        if (entry.kind === 'admitted') {
          const completion = await entry.pass.complete('succeeded');
          check(completion.settlement === 'unknown', `a lost response must be unknown, got ${completion.settlement}`);
        } else {
          check(entry.denial.error.code === 'payment_outcome_unknown', `a lost upfront response must be payment_outcome_unknown, got ${entry.denial.error.code}`);
        }

        await run.reconcile();
        await run.assertLedgerMatchesProvider();
      },
    },
    {
      name: `${rail.name}: a settlement that failed before any effect is never recorded as paid`,
      skip: probe.failNextSettle === undefined ? noFault : undefined,
      async run() {
        const harness = createHarness();
        const run = setup(harness);
        const { denial, offer } = await run.challenge();
        const paying = await harness.pay({ denial, offer, url: URL_UNDER_TEST });
        harness.failNextSettle?.();
        const entry = await run.enter(paying);
        if (entry.kind === 'admitted') await entry.pass.complete('succeeded');

        await run.reconcile();
        await run.assertLedgerMatchesProvider();
      },
    },
    {
      name: `${rail.name}: redaction keeps what lookup needs`,
      skip: rail.redact === undefined || !single ? 'the rail does not redact single-use evidence' : undefined,
      async run() {
        const harness = createHarness();
        const { rail } = harness;
        const run = setup(harness);
        const { denial, offer } = await run.challenge();
        await admitted(await run.enter(await harness.pay({ denial, offer, url: URL_UNDER_TEST }))).complete('succeeded');
        const { charge, authorization } = run.recorded();
        const opened = run.openedData();
        const redact = rail.redact?.bind(rail);
        if (redact === undefined || opened === undefined) return;

        check(canonicalJson(authorization.data) === canonicalJson(redact(opened)), 'the stored data must be the redacted data');
        check(canonicalJson(redact(redact(opened))) === canonicalJson(redact(opened)), 'redact must be idempotent');
        const lookup = await rail.lookup(authorization, charge, operation(`${charge.id}:lookup`));
        check(lookup.status === 'settled', `lookup must still find the settlement after redaction, got ${lookup.status}`);
      },
    },
  ];
}

function setup(harness: RailHarness) {
  const ledger = memoryLedger({ clock: harness.clock });
  const events: TollstileEvent[] = [];
  const toll = createTollstile({
    rails: [harness.rail],
    ledger,
    clock: harness.clock,
    secret: 'conformance-secret-0123456789abcdef',
    onEvent: (event) => events.push(event),
  });
  const gate = toll.price(harness.price ?? '$1', { resource: RESOURCE });
  const other = toll.price(harness.price ?? '$1', { resource: OTHER_RESOURCE });
  const enter = (request: Request): Promise<Entry<readonly Rail[]>> => gate.enter(httpContext(request, { resource: RESOURCE }));

  return {
    enter,
    enterOther: (request: Request): Promise<Entry<readonly Rail[]>> => other.enter(httpContext(request, { resource: OTHER_RESOURCE })),
    async challenge() {
      const entry = await enter(new Request(URL_UNDER_TEST));
      if (entry.kind !== 'denied') throw new Error('Conformance: an unpaid request was admitted.');
      const offer = entry.denial.offers.find((candidate) => candidate.offer.rail === harness.rail.name);
      if (offer === undefined) throw new Error(`Conformance: the 402 has no offer from ${harness.rail.name} at ${harness.price ?? '$1'}.`);
      return { denial: entry.denial, offer };
    },
    onlyCharge(): Charge {
      const charges = ledger.charges();
      if (charges.length !== 1 || charges[0] === undefined) throw new Error(`Conformance: expected one charge, found ${String(charges.length)}.`);
      return charges[0];
    },
    recorded(): { charge: Charge; authorization: Authorization } {
      const [charge] = ledger.charges();
      const authorization = charge === undefined ? undefined : ledger.authorizations().find((candidate) => candidate.id === charge.authorizationId);
      if (charge === undefined || authorization === undefined) throw new Error('Conformance: no recorded charge.');
      return { charge, authorization };
    },
    openedData(): Json | undefined {
      for (const event of events) if (event.type === 'authorization.opened') return event.authorization.data;
      return undefined;
    },
    async reconcile() {
      // At least 1 ms past the last write: pending charges are those updated strictly before the window.
      harness.clock.advance(Math.max(1, harness.reconcileAfterMs ?? 60 * 60_000));
      await toll.reconcile({ olderThanMs: 0 });
      await toll.reconcile({ olderThanMs: 0 });
    },
    /** No duplicate effects, and no money recorded that did not move: the ledger and the provider agree. */
    async assertLedgerMatchesProvider() {
      const [charge] = ledger.charges();
      const settled = await harness.settlements();
      check(settled <= 1, `the provider settled ${String(settled)} times for one charge`);
      if (charge === undefined) return;
      const moved = charge.payment === 'settled' || charge.payment === 'refund_pending' || charge.payment === 'refunded';
      if (isChargeTerminal(charge)) {
        check(moved === (settled === 1), `the ledger says ${states(charge)} but the provider settled ${String(settled)} times`);
      } else {
        check(charge.payment === 'unknown', `an unresolved charge must be unknown, got ${states(charge)}`);
      }
    },
  };
}

function admitted(entry: Entry<readonly Rail[]>) {
  if (entry.kind !== 'admitted') {
    throw new Error(`Conformance: a paying request was denied with ${entry.denial.error.code}: ${entry.denial.error.message}`);
  }
  return entry.pass;
}

function operation(key: string) {
  return { key, signal: new AbortController().signal };
}

function states(charge: Charge): string {
  return `${charge.payment}/${charge.fulfillment}`;
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Conformance: ${message}.`);
}
