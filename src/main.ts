/** Local dev server (node, LocalStack backend). */

import { serve } from '@hono/node-server';
import { buildApp } from './app.ts';
import { wireAwsDeps } from './wire.ts';

const deps = await wireAwsDeps();
const app = buildApp(deps);

serve({ fetch: app.fetch, port: deps.config.port }, (info) => {
  console.log(`ente-serverless listening on :${info.port}`);
});
