import type { DynamicPrice, PriceInput, PriceOptions } from 'tollstile';

type Priced = Omit<PriceOptions, 'resource'> & {
  readonly price: PriceInput | DynamicPrice;
  /** Overrides the resource name, e.g. to group routes. Defaults to `"<METHOD> <path>"` or `"tool:<name>"`. */
  readonly resource?: string;
};

/** A priced HTTP route on the upstream. `path` supports `:param` segments and a trailing `*`. */
export type HttpRoute = Priced & {
  /** Any method when omitted. */
  readonly method?: string;
  readonly path: string;
};

/** A priced MCP tool on the upstream's MCP endpoint. */
export type ToolRoute = Priced & {
  readonly tool: string;
};

export type ProxyRoute = HttpRoute | ToolRoute;

export type CompiledHttpRoute = {
  readonly kind: 'http';
  readonly method: string | undefined;
  readonly pattern: RegExp;
  readonly route: HttpRoute;
  readonly resource: string;
};

/** Compiles a path pattern: `/users/:id` matches one segment, a trailing `/*` matches the rest. */
export function compileHttpRoute(route: HttpRoute): CompiledHttpRoute {
  if (!route.path.startsWith('/')) throw new TypeError(`Proxy route path "${route.path}" must start with "/".`);
  const method = route.method?.toUpperCase();
  const segments = route.path.split('/').slice(1);
  const source = segments
    .map((segment, i) => {
      if (segment === '*' && i === segments.length - 1) return '(?:/.*)?';
      if (segment.startsWith(':')) return '/[^/]+';
      return `/${segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
    })
    .join('');
  return {
    kind: 'http',
    method,
    pattern: new RegExp(`^${source === '' ? '/' : source}/?$`),
    route,
    resource: route.resource ?? `${method ?? 'ANY'} ${route.path}`,
  };
}

export function matchHttpRoute(routes: readonly CompiledHttpRoute[], method: string, pathname: string): CompiledHttpRoute | undefined {
  return routes.find((candidate) => (candidate.method === undefined || candidate.method === method) && candidate.pattern.test(pathname));
}

/**
 * The path the proxy prices and forwards, so an alias can never reach the upstream unpriced:
 * percent-encoding is decoded (an encoded `/` stays encoded), repeated slashes collapse, and dot
 * segments were already resolved by the URL parser. `match` also ignores a trailing slash.
 * Returns `undefined` for malformed percent-encoding, and for a segment that decodes to a separator
 * (`%2F`, `%5C`) or carries a `;` parameter: upstreams disagree about those, so nothing is forwarded.
 */
export function canonicalPath(pathname: string): { readonly forward: string; readonly match: string } | undefined {
  const segments: string[] = [];
  for (const segment of pathname.split('/')) {
    const decoded = decodeSegment(segment);
    if (decoded === undefined) return undefined;
    // An encoded separator, or a `;` parameter, is a path some upstreams re-split and this matcher
    // does not. Whatever a route would say about it here could differ from what is served there.
    if (/[/\\;]/.test(decoded)) return undefined;
    segments.push(encodeURIComponent(decoded).replace(/%(?:40|3A|24|2C|3B|3D|2B|21|2A|27|28|29)/gi, (encoded) => decodeURIComponent(encoded)));
  }
  const forward = segments.join('/').replace(/\/{2,}/g, '/') || '/';
  const match = forward.length > 1 ? forward.replace(/\/+$/, '') : forward;
  return { forward, match };
}

function decodeSegment(segment: string): string | undefined {
  // catch-reason: a malformed percent-encoding in a client path is an expected, refusable input.
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}
