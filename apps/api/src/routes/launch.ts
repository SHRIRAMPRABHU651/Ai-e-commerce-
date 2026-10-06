import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { can } from '@orvia/auth';
import { AD_CAPABILITIES, platformStatus } from '@orvia/ads';
import { DomainError, audit, launchReadiness } from '@orvia/core';
import type { Ctx } from '@orvia/core';
import { route } from '../http';

export function launchRoutes(app: FastifyInstance, ctx: Ctx): void {
  route(app, ctx, {
    method: 'GET', url: '/admin/launch-readiness', summary: 'Launch readiness: per-area PASS/WARN/FAIL, blockers, provider status (live=true runs read-only provider calls)', tags: ['Admin'], auth: 'staff', permission: 'launch:read',
    query: z.object({ live: z.enum(['true', 'false']).default('false') }),
    rateLimit: { max: 12, timeWindow: '1 minute' },
    handler: async ({ req, query }) => {
      if (query.live === 'true' && !can(req.user!.role, 'settings:write')) throw new DomainError('Running live provider checks needs settings:write', 'FORBIDDEN', 403);
      const r = await launchReadiness(ctx, { live: query.live === 'true' });
      if (query.live === 'true') await audit(ctx, req.actor, { action: 'launch.live_checks_run', resource: 'launch', newValue: { verdict: r.verdict, blockers: r.summary.blockers } });
      return r;
    },
  });
  route(app, ctx, {
    method: 'GET', url: '/admin/ads/capabilities', summary: 'Ad platform capability registry with honest status (NOT_CONFIGURED / UNVERIFIED / VERIFIED / ERROR)', tags: ['Admin'], auth: 'staff', permission: 'marketing:read',
    handler: async () => {
      const results = (await ctx.settings.get('launch')).results;
      const cfg = ctx.ads.status();
      return { mode: ctx.cfg.ADS_MODE, platforms: (Object.keys(AD_CAPABILITIES) as (keyof typeof AD_CAPABILITIES)[]).map((p) => ({ platform: p, status: platformStatus(cfg[p].configured, results[`ads:${p}`]), capabilities: AD_CAPABILITIES[p], lastCheck: results[`ads:${p}`] ?? null })), note: 'SUPPORTED = implemented in code. Only a successful live check makes a platform VERIFIED; conversion tracking is not implemented, so AI ad spend stays proposal-only.' };
    },
  });
  route(app, ctx, {
    method: 'PUT', url: '/admin/settings/legal', summary: 'Business details and legal-review confirmation (required before launch)', tags: ['Admin'], auth: 'staff', permission: 'settings:write',
    body: z.object({
      businessName: z.string().trim().min(2).max(120), registeredAddress: z.string().trim().min(8).max(300), supportEmail: z.string().email().max(200),
      reviewConfirmed: z.boolean(), emailDomainVerified: z.boolean().default(false), taxRegistrations: z.string().max(500).default(''),
    }),
    handler: async ({ req, body }) => {
      const prev = await ctx.settings.get('legal');
      const next = await ctx.settings.set('legal', { ...body, reviewedBy: body.reviewConfirmed ? req.actor.id : undefined, reviewedAt: body.reviewConfirmed ? new Date().toISOString() : undefined }, req.actor.id);
      await audit(ctx, req.actor, { action: 'settings.legal_updated', resource: 'settings', previousValue: prev, newValue: next });
      return next;
    },
  });
  route(app, ctx, {
    method: 'GET', url: '/admin/settings/legal', summary: 'Legal/business settings', tags: ['Admin'], auth: 'staff', permission: 'launch:read',
    handler: async () => ctx.settings.get('legal'),
  });
  // Machine-readable gate for CI/CD (bearer METRICS_TOKEN). 404 in production when no token is configured.
  app.get('/api/v1/launch-gate', { schema: { hide: true }, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const token = ctx.cfg.METRICS_TOKEN;
    if (!token) { if (ctx.cfg.isProduction) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } }); }
    else if (req.headers.authorization !== `Bearer ${token}`) return reply.status(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Bearer token required' } });
    const r = await launchReadiness(ctx);
    return reply.status(r.verdict === 'GO' ? 200 : 503).send({ verdict: r.verdict, summary: r.summary, blockers: r.blockers.map((b) => ({ id: b.id, area: b.area, title: b.title, detail: b.detail })) });
  });
}
