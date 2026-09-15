import { serve } from '@hono/node-server';
import { app } from './app';

serve({ fetch: app.fetch, port: 3000 }, ({ port }) => {
  console.log(`Paid API listening on http://localhost:${port}`);
  console.log('In another terminal, run: pnpm agent');
});
