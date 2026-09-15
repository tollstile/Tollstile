import { TollstileError } from './errors';
import type { Flow } from './states';
import type { AuthorizationKind, Rail } from './types';

/** How one rail serves a route. Compiled once, when the route is defined. */
export type RailPlan = {
  readonly rail: string;
  readonly flow: 'authorization' | 'upfront';
  /** When money moves relative to the handler. */
  readonly settles: 'after_handler' | 'before_handler';
  readonly authorization: AuthorizationKind;
  /** `up_to`: the rail can settle less than it authorized, so `upTo()` prices work. */
  readonly amounts: 'fixed' | 'up_to';
  readonly onHandlerFailure: 'release' | 'refund';
};

export type ExcludedRail = {
  readonly rail: string;
  /** The capability the route needs and the rail lacks. */
  readonly needs: string;
  readonly reason: string;
};

/**
 * What a route declares, compiled against the configured rails: which rails can serve it, how each
 * one will run a paid request, and why the others cannot. See `toll.explain(gate)`.
 */
export type ExecutionPlan = {
  readonly route: string;
  readonly pricing: 'fixed' | 'up_to' | 'computed';
  readonly commitment: 'route' | 'request' | 'custom';
  /** Access policies in the order they are tried; empty when everyone pays. */
  readonly access: readonly string[];
  readonly requirements: readonly string[];
  readonly rails: readonly RailPlan[];
  readonly excluded: readonly ExcludedRail[];
};

export type RouteShape = {
  readonly name: string;
  readonly flow: Flow | undefined;
  readonly pricing: ExecutionPlan['pricing'];
  readonly commitment: ExecutionPlan['commitment'];
  readonly access: readonly string[];
  readonly requirements: readonly string[];
};

/**
 * Compiles a route against the rails. A rail that is broken for every route (no lookup, upfront
 * without refunds) is a configuration error. A rail that cannot serve this route is excluded with
 * its reason, and a route no rail can serve is refused.
 */
export function compilePlan(rails: readonly Rail[], route: RouteShape): ExecutionPlan {
  if (route.flow === 'escrow') {
    throw new TollstileError('CONFIG_INVALID', `Route "${route.name}": the escrow flow is part of the model but not implemented in this version.`);
  }
  const planned: RailPlan[] = [];
  const excluded: ExcludedRail[] = [];
  for (const rail of rails) {
    assertUsable(rail, route.name);
    const plan = planRail(rail, route);
    if ('needs' in plan) excluded.push(plan);
    else planned.push(plan);
  }

  if (planned.length === 0) {
    const reasons = excluded.map((rail) => `  - ${rail.rail}: needs ${rail.needs}. ${rail.reason}`).join('\n');
    throw new TollstileError('CAPABILITY_MISSING', `No configured rail can serve route "${route.name}".\n${reasons}\n\n  Fix: change the route's price or flow, or add a rail that supports it.`);
  }
  return { route: route.name, pricing: route.pricing, commitment: route.commitment, access: route.access, requirements: route.requirements, rails: planned, excluded };
}

function planRail(rail: Rail, route: RouteShape): RailPlan | ExcludedRail {
  const { capabilities } = rail;
  const exclude = (needs: string, reason: string): ExcludedRail => ({ rail: rail.name, needs, reason });

  if (route.pricing === 'computed' && !capabilities.quotes) {
    return exclude('quotes', 'A computed price is fixed by the quote the payer saw, and this rail cannot carry one.');
  }
  const flow = route.flow ?? (route.pricing === 'up_to' ? 'authorization' : preferredFlow(capabilities.flows));
  if (flow === undefined || !capabilities.flows.includes(flow)) {
    return exclude(`the ${flow ?? 'authorization or upfront'} flow`, `The rail supports: ${capabilities.flows.join(', ')}.`);
  }
  if (flow === 'escrow') return exclude('the escrow flow', 'Escrow is not implemented in this version.');

  const upTo = flow === 'authorization' && capabilities.variableAmount;
  if (route.pricing === 'up_to' && !upTo) {
    return exclude('variable amounts in the authorization flow', 'An upTo() price settles the fulfilled amount after the handler runs.');
  }
  return {
    rail: rail.name,
    flow,
    settles: flow === 'authorization' ? 'after_handler' : 'before_handler',
    authorization: capabilities.authorization,
    amounts: upTo ? 'up_to' : 'fixed',
    onHandlerFailure: flow === 'authorization' ? 'release' : 'refund',
  };
}

/** Prefers `authorization`, where the payer is charged only for work that ran. */
function preferredFlow(flows: readonly Flow[]): 'authorization' | 'upfront' | undefined {
  return (['authorization', 'upfront'] as const).find((candidate) => flows.includes(candidate));
}

/** Declarations no route could work with are rail bugs, not route mismatches. */
function assertUsable(rail: Rail, route: string): void {
  const { capabilities } = rail;
  if (!capabilities.lookup) {
    throw capabilityError(route, rail.name, 'lookup', 'Without it, an unknown settlement outcome cannot be resolved without guessing.', 'Use a rail that can look up charges.');
  }
  if (capabilities.flows.includes('upfront') && !capabilities.refund) {
    throw capabilityError(route, rail.name, 'refunds', 'The rail declares the upfront flow, which settles before the handler and must refund when it fails.', 'Fix the rail: declare refund, or drop the upfront flow.');
  }
}

function capabilityError(route: string, rail: string, capability: string, why: string, fix: string): TollstileError {
  return new TollstileError(
    'CAPABILITY_MISSING',
    `Route "${route}" needs ${capability}, but rail "${rail}" does not support it.\n  ${why}\n\n  Fix: ${fix}`,
  );
}

/** Renders a plan for people: what runs, and why rails were left out. */
export function formatPlan(plan: ExecutionPlan): string {
  const lines = [
    `Route ${plan.route}`,
    `  pricing: ${plan.pricing}, quote bound to: ${plan.commitment}`,
    `  access: ${plan.access.length === 0 ? 'everyone pays' : plan.access.join(' → ')}`,
    `  requirements: ${plan.requirements.length === 0 ? 'none' : plan.requirements.join(', ')}`,
    '  rails:',
    ...plan.rails.map(
      (rail) =>
        `    ${rail.rail}: ${rail.flow} flow, settles ${rail.settles.replace('_', ' ')}, ${rail.authorization} authorization, ${rail.amounts === 'up_to' ? 'up-to amounts' : 'fixed amounts'}, ${rail.onHandlerFailure} on handler failure`,
    ),
  ];
  if (plan.excluded.length > 0) {
    lines.push('  excluded:', ...plan.excluded.map((rail) => `    ${rail.rail}: needs ${rail.needs}. ${rail.reason}`));
  }
  return lines.join('\n');
}
