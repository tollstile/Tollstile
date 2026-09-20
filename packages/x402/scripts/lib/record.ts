import { readFileSync, writeFileSync } from 'node:fs';

/**
 * The run record, and the only place a run writes to disk.
 *
 * Every field is listed here by hand. Nothing is spread, merged, or serialized from a rail object,
 * a charge, or an HTTP exchange, so a payload, a signature, or a key cannot reach the file later
 * by someone adding a property somewhere else.
 */

export type ScenarioName = 'success' | 'replay' | 'retry' | 'lost-settle' | 'dropped-settle';

export type ScenarioStatus = 'pending' | 'waiting' | 'passed' | 'failed';

export type ScenarioRecord = {
  readonly name: ScenarioName;
  readonly title: string;
  status: ScenarioStatus;
  /** Set while a scenario waits for finality, so a resumed run continues instead of paying again. */
  chargeId: string | null;
  chargeState: string | null;
  httpStatus: number | null;
  denialCode: string | null;
  transaction: string | null;
  /** Atomic units of the asset, as the chain reports them. */
  transferred: string | null;
  authorizedCap: string | null;
  blockNumber: string | null;
  settlements: number;
  startedAt: string | null;
  finishedAt: string | null;
  failure: string | null;
};

export type RunRecord = {
  readonly startedAt: string;
  readonly network: string;
  readonly asset: string;
  readonly payTo: string;
  readonly payer: string;
  readonly facilitator: string;
  readonly scenarios: readonly ScenarioRecord[];
};

const SCENARIOS: readonly (readonly [ScenarioName, string])[] = [
  ['success', 'upto payment below the authorization cap'],
  ['replay', 'replayed signature rejected, no second transfer'],
  ['retry', 'handler failure, then retry with one settlement'],
  ['lost-settle', 'lost /settle response reconciled from the chain'],
  ['dropped-settle', 'dropped /settle request expires without a transfer'],
];

export class Recorder {
  private constructor(
    private readonly path: string,
    readonly run: RunRecord,
  ) {}

  static begin(path: string, about: { network: string; asset: string; payTo: string; payer: string; facilitator: string }): Recorder {
    const run: RunRecord = {
      startedAt: new Date().toISOString(),
      network: about.network,
      asset: about.asset,
      payTo: about.payTo,
      payer: about.payer,
      facilitator: about.facilitator,
      scenarios: SCENARIOS.map(([name, title]) => blank(name, title)),
    };
    return new Recorder(path, run);
  }

  /** Reopens a record written by an earlier run of the same wallets, network, and facilitator. */
  static resume(path: string, about: { network: string; payTo: string; payer: string; facilitator: string }): Recorder | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return undefined;
    }
    const run = parsed as RunRecord;
    if (run.network !== about.network || run.payTo !== about.payTo || run.payer !== about.payer || run.facilitator !== about.facilitator) {
      throw new Error(`${path} records a run against different wallets or a different network. Move it aside or pass --record with another path.`);
    }
    return new Recorder(path, run);
  }

  scenario(name: ScenarioName): ScenarioRecord {
    const found = this.run.scenarios.find((scenario) => scenario.name === name);
    if (found === undefined) throw new Error(`No scenario named ${name}.`);
    return found;
  }

  save(): void {
    writeFileSync(this.path, `${JSON.stringify(this.run, null, 2)}\n`);
  }
}

function blank(name: ScenarioName, title: string): ScenarioRecord {
  return {
    name,
    title,
    status: 'pending',
    chargeId: null,
    chargeState: null,
    httpStatus: null,
    denialCode: null,
    transaction: null,
    transferred: null,
    authorizedCap: null,
    blockNumber: null,
    settlements: 0,
    startedAt: null,
    finishedAt: null,
    failure: null,
  };
}
