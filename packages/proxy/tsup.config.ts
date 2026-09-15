import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts', node: 'src/node.ts' },
    format: ['esm'],
    dts: true,
    clean: true,
    target: 'es2022',
    external: ['tollstile'],
  },
  {
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    dts: false,
    target: 'node22',
    external: ['tollstile'],
    banner: { js: '#!/usr/bin/env node' },
  },
]);
