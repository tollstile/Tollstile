import { serve } from '@hono/node-server';
import { createApp } from './app';

const judge = process.env['JEV_API_KEY'] === undefined ? 'the rules (set JEV_API_KEY to let Jev price it)' : 'Jev, falling back to the rules';

serve({ fetch: createApp().fetch, port: 3000 }, ({ port }) => {
  console.log(`Research desk listening on http://localhost:${String(port)} · priced by ${judge}`);
  console.log('In another terminal, run: pnpm --filter @tollstile-examples/jev-pricing agent');
});
