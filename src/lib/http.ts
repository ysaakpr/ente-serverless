/**
 * Handler wrapper: converts our error model into museum's wire behaviour —
 * ApiError -> {"code","message"} with its status; SentinelError -> bare {}
 * with the mapped status; zod/shape failures -> 400 {} (gin binding errors
 * also render as bare status).
 */

import type { Context } from 'hono';
import { ZodError } from 'zod';
import { ApiError, SentinelError } from './errors.ts';
import { ConditionFailedError } from '../ports/db.ts';

type HandlerFn = (c: Context) => Promise<Response>;

export const handler = (fn: HandlerFn): HandlerFn => {
  return async (c) => {
    try {
      return await fn(c);
    } catch (err) {
      if (err instanceof ApiError) return c.json(err.body(), err.httpStatus as 400);
      if (err instanceof SentinelError) return c.json({}, err.httpStatus as 400);
      if (err instanceof ZodError) return c.json({}, 400);
      if (err instanceof SyntaxError) return c.json({}, 400); // malformed JSON body
      if (err instanceof ConditionFailedError) return c.json({}, 500);
      console.error('unhandled', err);
      return c.json({}, 500);
    }
  };
};
