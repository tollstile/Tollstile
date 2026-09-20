import { serve } from '@hono/node-server';
import { createApp } from './app';

const key = process.env['AI_GATEWAY_API_KEY'] ?? process.env['JEV_API_KEY'];

serve({ fetch: createApp().fetch, port: 3100 }, ({ port }) => {
  console.log(`Detection desk on http://localhost:${String(port)} · verified by ${key === undefined ? 'the rules (set AI_GATEWAY_API_KEY for a model)' : 'a vision model, falling back to the rules'}`);
  console.log('In another terminal: pnpm --filter @tollstile-examples/detection-pricing agent');
});
