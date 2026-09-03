import { serve } from '@hono/node-server';
import { Hono } from 'hono';

import sync from './routes/sync';

const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));
app.route('/sync', sync);

const port = Number(process.env.PORT ?? 8787);

// Bound to 0.0.0.0, not localhost: a physical phone syncing over the LAN has
// to be able to reach this from another device.
serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
  console.log(`FieldNote server listening on http://0.0.0.0:${info.port}`);
});
