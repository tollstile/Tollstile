import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ProxyConfig } from './config';
import { serve } from './node';
import { createProxy } from './proxy';

const args = process.argv.slice(2);
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`tollstile-proxy — a paid gateway in front of any HTTP API or MCP server

Usage: tollstile-proxy [--config tollstile.proxy.mjs] [--port 8402]

The config file default-exports defineProxyConfig({ toll, upstream, routes, mcp? }).
Docs: https://tollstile.com/docs/adapters/proxy`);
  process.exit(0);
}

const configPath = resolve(flag('--config') ?? 'tollstile.proxy.mjs');
const loaded = (await import(pathToFileURL(configPath).href)) as { default?: ProxyConfig | (() => ProxyConfig | Promise<ProxyConfig>) };
if (loaded.default === undefined) {
  console.error(`${configPath} must default-export a proxy config (defineProxyConfig({ ... })).`);
  process.exit(1);
}
const config = typeof loaded.default === 'function' ? await loaded.default() : loaded.default;
const port = Number(flag('--port') ?? config.port ?? process.env.PORT ?? 8402);

const handler = createProxy(config);
await serve(handler, { port, ...(config.hostname === undefined ? {} : { hostname: config.hostname }) });

console.log(`Tollstile proxy on http://localhost:${String(port)} → ${config.upstream}`);
for (const route of config.routes) {
  const name = 'tool' in route ? `tool ${route.tool}` : `${route.method ?? 'ANY'} ${route.path}`;
  const price = typeof route.price === 'function' ? 'computed price' : typeof route.price === 'string' ? route.price : `up to ${route.price.amount}`;
  console.log(`  ${name}: ${price}`);
}
console.log(`  everything else: ${config.unmatched === 'deny' ? 'refused' : 'forwarded free'}`);
