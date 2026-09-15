import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^tollstile\/testing$/, replacement: source('./packages/tollstile/src/testing/index.ts') },
      { find: /^tollstile$/, replacement: source('./packages/tollstile/src/index.ts') },
      // Examples import adapters by package name; test them against source, not a build.
      { find: /^@tollstile\/([a-z0-9-]+)$/, replacement: source('./packages/$1/src/index.ts') },
    ],
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'examples/*/test/**/*.test.ts'],
  },
});
