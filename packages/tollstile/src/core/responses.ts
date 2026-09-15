import type { Denial } from './types';

/** Renders a denial as an HTTP response, with every rail's challenge headers. */
export function toResponse(denial: Denial): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const [name, value] of [...denial.headers, ...denial.offers.flatMap((offer) => offer.challenge.headers)]) {
    headers.append(name, value);
  }
  return new Response(JSON.stringify(denial.body), { status: denial.status, headers });
}
