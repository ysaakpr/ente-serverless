/** Lambda entry — Function URL (auth NONE) behind CloudFront, hono adapter. */

import { handle } from 'hono/aws-lambda';
import { buildApp } from './app.ts';
import { wireAwsDeps } from './wire.ts';

const deps = await wireAwsDeps();
const app = buildApp(deps);

export const handler = handle(app);
