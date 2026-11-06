/**
 * Boot smoke check that needs NO database: builds the API with every route and job handler registered, so duplicate or
 * invalid route definitions, bad zod->JSON-schema conversions and duplicate job registrations fail here instead of at deploy.
 * It does not exercise handlers (those need MongoDB: run `npm test`).
 */
import { loadConfig } from '@orvia/config';
import { buildCtx } from '@orvia/core';
import { buildServer } from '../apps/api/src/server';

process.env.NODE_ENV ??= 'test';
const cfg = loadConfig();
const ctx = buildCtx({ cfg, service: 'api' });
const app = await buildServer(ctx, { withJobHandlers: true });
const routes = app.printRoutes({ commonPrefix: false }).split('\n').filter((l) => /\((GET|POST|PUT|PATCH|DELETE)/.test(l) || /^\s*[├└│ ]*\S+ \(/.test(l)).length;
console.warn(`boot-check ok: API built with all routes and jobs registered (~${routes} route lines)`);
await app.close();
process.exit(0);
