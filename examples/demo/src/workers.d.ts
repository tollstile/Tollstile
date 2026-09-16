// The few Cloudflare Workers types this demo uses. Declared here instead of pulling in
// @cloudflare/workers-types, whose global Request would replace the Web-standard one the
// library is written against.

export {};

declare global {
  type D1Result<T = Record<string, unknown>> = { readonly results: T[]; readonly success: boolean };

  type D1PreparedStatement = {
    bind(...values: readonly (string | number | null)[]): D1PreparedStatement;
    all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  };

  type D1Database = {
    prepare(sql: string): D1PreparedStatement;
    batch<T = Record<string, unknown>>(statements: readonly D1PreparedStatement[]): Promise<D1Result<T>[]>;
  };

  type ScheduledController = { readonly scheduledTime: number; readonly cron: string };
  type ExecutionContext = { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void };
}
