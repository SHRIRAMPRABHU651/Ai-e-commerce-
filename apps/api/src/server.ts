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
import { growthRoutes } from './routes/growth';
import { systemRoutes } from './routes/system';
import { mediaRoutes } from './routes/media';
import { marketRoutes } from './routes/market';
import { launchRoutes } from './routes/launch';
import { economicsRoutes } from './routes/economics';
import { trustRoutes } from './routes/trust';
import { rescueRoutes } from './routes/rescue';
import { customer360Routes } from './routes/customer360';
import { findRoutes } from './routes/find';
import { financeRoutes } from './routes/finance';
import { creatorsRoutes } from './routes/creators';
import { eventsRoutes } from './routes/events';
import { suppliernetRoutes } from './routes/suppliernet';
import multipart from '@fastify/multipart';

export interface ServerOptions {
  redis?: Redis | null;
  /** Register job handlers in-process so `dev/jobs/drain` and inline processing work (dev/test only). */
  withJobHandlers?: boolean;
}

export async function buildServer(ctx: Ctx, opts: ServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: ctx.cfg.TRUST_PROXY, bodyLimit: 1_000_000, routerOptions: { maxParamLength: 200 } });
  await registerPlugins(app, ctx, { redis: opts.redis });
  await app.register(multipart, { limits: { fileSize: ctx.cfg.MEDIA_MAX_BYTES, files: 1, fields: 5, parts: 8 } });
  if (opts.withJobHandlers) registerJobs(ctx);
  systemRoutes(app, ctx, opts.redis ?? null);
  publicRoutes(app, ctx);
  authRoutes(app, ctx);
  shopRoutes(app, ctx);
  growthRoutes(app, ctx);
  adminCommerceRoutes(app, ctx);
  adminOpsRoutes(app, ctx);
  mediaRoutes(app, ctx);
  marketRoutes(app, ctx);
  launchRoutes(app, ctx);
  economicsRoutes(app, ctx);
  trustRoutes(app, ctx);
  rescueRoutes(app, ctx);
  customer360Routes(app, ctx);
  findRoutes(app, ctx);
  financeRoutes(app, ctx);
  creatorsRoutes(app, ctx);
  eventsRoutes(app, ctx);
  suppliernetRoutes(app, ctx);
  await app.ready();
  return app;
}
