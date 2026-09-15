import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^tollstile\/testing$/, replacement: source('./packages/tollstile/src/testing/index.ts') },
      { find: /^tollstile$/, replacement: source('./packages/tollstile/src/index.ts') },
    ],
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
  },
});
