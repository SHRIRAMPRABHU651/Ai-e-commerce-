import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { registerJobs } from '@orvia/core';
import type { Ctx } from '@orvia/core';
import { registerPlugins } from './plugins';
import { adminCommerceRoutes } from './routes/adminCommerce';
import { adminOpsRoutes } from './routes/adminOps';
import { authRoutes } from './routes/auth';
import { publicRoutes } from './routes/public';
import { shopRoutes } from './routes/shop';
import { systemRoutes } from './routes/system';

export interface ServerOptions {
  redis?: Redis | null;
  /** Register job handlers in-process so `dev/jobs/drain` and inline processing work (dev/test only). */
  withJobHandlers?: boolean;
}

export async function buildServer(ctx: Ctx, opts: ServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: ctx.cfg.TRUST_PROXY, bodyLimit: 1_000_000, routerOptions: { maxParamLength: 200 } });
  await registerPlugins(app, ctx, { redis: opts.redis });
  if (opts.withJobHandlers) registerJobs(ctx);
  systemRoutes(app, ctx, opts.redis ?? null);
  publicRoutes(app, ctx);
  authRoutes(app, ctx);
  shopRoutes(app, ctx);
  adminCommerceRoutes(app, ctx);
  adminOpsRoutes(app, ctx);
  await app.ready();
  return app;
}
