import { TollstileError } from './errors';
import type { Flow } from './states';
import type { Rail } from './types';

type RouteShape = {
  readonly name: string;
  readonly flow: Flow | undefined;
  /** `undefined` on dynamic routes, where it is known only per request. */
  readonly variable: boolean | undefined;
  readonly dynamic: boolean;
};

/** Validates a route against a rail at definition time. */
export function assertRailServesRoute(rail: Rail, route: RouteShape): void {
  const { capabilities } = rail;
  if (!capabilities.lookup) {
    throw capabilityError(route.name, rail.name, 'lookup', 'Without it, an unknown settlement outcome cannot be resolved without guessing.', 'Use a rail that can look up charges.');
  }
  if (route.flow === 'escrow' || (route.flow === undefined && capabilities.flows.length === 1 && capabilities.flows[0] === 'escrow')) {
    throw new TollstileError('CONFIG_INVALID', `Route "${route.name}": the escrow flow is part of the model but not implemented in this version.`);
  }
  if (route.dynamic && !capabilities.quotes) {
    throw capabilityError(route.name, rail.name, 'quotes', 'A dynamic price is fixed by the quote the payer saw; this rail cannot carry one.', 'Use a fixed price for this route, or remove the rail.');
  }
  if (route.variable !== undefined) flowFor(rail, route.flow, route.variable, route.name);
}

/** The flow a charge on `rail` uses. Prefers `authorization`, where the payer is charged only for work that ran. */
export function flowFor(rail: Rail, requested: Flow | undefined, variable: boolean, name: string): Flow {
  const { capabilities } = rail;
  const flow = requested ?? (['authorization', 'upfront'] as const).find((candidate) => capabilities.flows.includes(candidate));

  if (flow === undefined || !capabilities.flows.includes(flow)) {
    throw capabilityError(name, rail.name, `the ${requested ?? 'authorization or upfront'} flow`, `The rail supports: ${capabilities.flows.join(', ')}.`, 'Choose a supported flow, or remove the rail.');
  }
  if (flow === 'escrow') {
    throw new TollstileError('CONFIG_INVALID', `Route "${name}": the escrow flow is part of the model but not implemented in this version.`);
  }
  if (flow === 'upfront' && !capabilities.refund) {
    throw capabilityError(name, rail.name, 'refunds', 'The upfront flow settles before the handler and must refund when it fails.', 'Use the authorization flow, or remove the rail.');
  }
  if (variable && (flow !== 'authorization' || !capabilities.variableAmount)) {
    throw capabilityError(name, rail.name, 'variable amounts in the authorization flow', 'An upTo() price settles the fulfilled amount after the handler runs.', 'Use a fixed price for this route, or remove the rail.');
  }
  return flow;
}

function capabilityError(route: string, rail: string, capability: string, why: string, fix: string): TollstileError {
  return new TollstileError(
    'CAPABILITY_MISSING',
    `Route "${route}" needs ${capability}, but rail "${rail}" does not support it.\n  ${why}\n\n  Fix: ${fix}`,
  );
}
