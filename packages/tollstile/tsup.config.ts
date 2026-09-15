import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts', 'testing/index': 'src/testing/index.ts' },
    format: ['esm'],
    dts: true,
    clean: true,
    target: 'es2022',
  },
  {
    // `npx tollstile reconcile`: a Node CLI, kept out of the Web-standard library entry points.
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    dts: false,
    target: 'node22',
    banner: { js: '#!/usr/bin/env node' },
  },
]);
