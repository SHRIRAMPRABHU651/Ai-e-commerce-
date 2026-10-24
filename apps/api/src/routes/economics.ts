import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MeasuredCpa } from '@orvia/database';
import { attestExport, decisionSheet, economicsCsv, exportGate, recordManualCpa, refreshMeasuredCpa, refreshMeasuredRefunds, revokeExportAttestation, getCountryConfigs } from '@orvia/core';
import type { Ctx } from '@orvia/core';
import { countrySchema } from '@orvia/types';
import { route } from '../http';

export function economicsRoutes(app: FastifyInstance, ctx: Ctx): void {
  route(app, ctx, {
    method: 'GET', url: '/admin/economics', summary: 'Decision sheet: per product × market cost lines and contribution at three CAC scenarios; every figure carries its basis (measured / quoted / set / estimated)', tags: ['Admin'], auth: 'staff', permission: 'products:read',
    query: z.object({ limit: z.coerce.number().int().min(1).max(500).default(200) }),
    handler: async ({ query }) => {
      const rows = await decisionSheet(ctx, { limit: query.limit });
      const pricing = await ctx.settings.get('pricing');
      return { rows, minMarginPct: pricing.minMarginPct, cacScenarios: pricing.cacScenarios, legend: { measured: 'realised from real orders / ad spend', quoted: 'current supplier quote or published rate card', set: 'operator decision', estimated: 'model or assumption' } };
    },
  });
  route(app, ctx, {
    method: 'GET', url: '/admin/economics/export', summary: 'Decision sheet as CSV (each figure followed by its basis column)', tags: ['Admin'], auth: 'staff', permission: 'products:read',
    handler: async () => ({ filename: `orvia-economics-${ctx.now().toISOString().slice(0, 10)}.csv`, csv: economicsCsv(await decisionSheet(ctx, { limit: 500 })) }),
  });
  route(app, ctx, {
    method: 'GET', url: '/admin/economics/cpa', summary: 'Measured CPA store', tags: ['Admin'], auth: 'staff', permission: 'products:read',
    handler: async () => ({ items: await MeasuredCpa.find({}).sort({ scope: 1, computedAt: -1 }).limit(500).lean() }),
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/economics/cpa', summary: 'Record a measured CPA by hand (real ad spend ÷ real attributed orders)', tags: ['Admin'], auth: 'staff', permission: 'settings:write',
    body: z.object({ scope: z.enum(['product', 'category', 'store']), key: z.string().trim().min(1).max(120), country: z.union([countrySchema, z.literal('*')]), channel: z.string().trim().max(40).optional(), spend: z.number().int().positive(), orders: z.number().int().positive(), note: z.string().max(300).optional() }),
    handler: async ({ req, body }) => { await recordManualCpa(ctx, body, req.actor); return { ok: true }; },
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/economics/refresh', summary: 'Rebuild measured CPA and refund rates from real ad metrics and orders', tags: ['Admin'], auth: 'staff', permission: 'settings:write',
    handler: async () => ({ cpa: await refreshMeasuredCpa(ctx), refunds: await refreshMeasuredRefunds(ctx) }),
  });

  // ---- export / destination-market attestation (legal gate for publishing and fulfilment)
  route(app, ctx, {
    method: 'GET', url: '/admin/compliance/export', summary: 'Export attestation status per destination', tags: ['Admin'], auth: 'staff', permission: 'settings:read',
    handler: async () => {
      const countries = Object.values(await getCountryConfigs());
      return { items: await Promise.all(countries.map(async (c) => ({ country: c.code, enabled: c.enabled, ...(await exportGate(ctx, c.code)) }))) };
    },
  });
  route(app, ctx, {
    method: 'PUT', url: '/admin/compliance/export/:country', summary: 'Record that a qualified adviser established export + destination obligations for a country', tags: ['Admin'], auth: 'staff', permission: 'settings:write',
    body: z.object({ reference: z.string().trim().min(5).max(300) }),
    handler: async ({ req, body }) => { await attestExport(ctx, countrySchema.parse((req.params as { country: string }).country), body.reference, req.actor); return { ok: true }; },
  });
  route(app, ctx, {
    method: 'DELETE', url: '/admin/compliance/export/:country', summary: 'Revoke an export attestation', tags: ['Admin'], auth: 'staff', permission: 'settings:write',
    handler: async ({ req }) => { await revokeExportAttestation(ctx, countrySchema.parse((req.params as { country: string }).country), req.actor); return { ok: true }; },
  });
}
