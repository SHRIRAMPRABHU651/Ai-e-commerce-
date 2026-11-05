import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Product } from '@orvia/database';
import { DomainError, fairDealForProduct, getProductPassport, getPurchaseConfidence, latestSupplierTrust, listProductRisk, listSupplierTrust, productRiskDetail, recomputeTrust, recordEvidence } from '@orvia/core';
import type { Ctx } from '@orvia/core';
import { confidenceQuerySchema, countryQuerySchema, evidenceInputSchema, trustListQuerySchema, trustRecomputeSchema } from '@orvia/types';
import { route } from '../http';

const objectId = z.string().regex(/^[a-f\d]{24}$/i);
const idParam = (req: { params: unknown }): string => {
  const id = (req.params as { id: string }).id;
  if (!objectId.safeParse(id).success) throw new DomainError('Invalid id', 'VALIDATION', 400);
  return id;
};

/** trust workstream routes: Digital Product Passport, Purchase Confidence, TrustGraph admin. */
export function trustRoutes(app: FastifyInstance, ctx: Ctx): void {
  // ---- customer-facing (public, never exposes cost, margin or internal supplier ids)
  route(app, ctx, {
    method: 'GET', url: '/products/:slug/passport', summary: 'Digital Product Passport: structured product profile with provenance on every field', tags: ['Trust'],
    auth: 'none', query: countryQuerySchema, rateLimit: { max: 120, timeWindow: '1 minute' },
    handler: async ({ req, query }) => getProductPassport(ctx, (req.params as { slug: string }).slug, query.country ?? req.country),
  });
  route(app, ctx, {
    method: 'GET', url: '/products/:slug/confidence', summary: 'Purchase Confidence report: honest completeness, reliability, delivery band, total delivered price and uncertainty', tags: ['Trust'],
    auth: 'none', query: confidenceQuerySchema, rateLimit: { max: 120, timeWindow: '1 minute' },
    handler: async ({ req, query }) => getPurchaseConfidence(ctx, (req.params as { slug: string }).slug, query.country ?? req.country, query.quantity, query.region),
  });

  // ---- admin
  route(app, ctx, {
    method: 'GET', url: '/admin/trust/suppliers', summary: 'Supplier trust: score, status, confidence, sample sizes, components with evidence, destination breakdown', tags: ['Admin', 'Trust'],
    auth: 'staff', permission: 'trust:read', query: trustListQuerySchema,
    handler: async ({ query }) => listSupplierTrust(ctx, query),
  });
  route(app, ctx, {
    method: 'GET', url: '/admin/trust/suppliers/:id', summary: 'One supplier trust snapshot (recomputed if stale)', tags: ['Admin', 'Trust'],
    auth: 'staff', permission: 'trust:read',
    handler: async ({ req }) => latestSupplierTrust(ctx, idParam(req)),
  });
  route(app, ctx, {
    method: 'GET', url: '/admin/trust/products', summary: 'Product risk snapshots (overall), highest risk first', tags: ['Admin', 'Trust'],
    auth: 'staff', permission: 'trust:read', query: trustListQuerySchema,
    handler: async ({ query }) => listProductRisk(ctx, query),
  });
  route(app, ctx, {
    method: 'GET', url: '/admin/trust/products/:id', summary: 'Product risk detail with per-destination snapshots and the evidence behind them', tags: ['Admin', 'Trust'],
    auth: 'staff', permission: 'trust:read',
    handler: async ({ req }) => productRiskDetail(ctx, idParam(req)),
  });
  route(app, ctx, {
    method: 'GET', url: '/admin/trust/products/:id/fair-deal', summary: 'Fair Deal ranking of supplier offers for this product (same product only)', tags: ['Admin', 'Trust'],
    auth: 'staff', permission: 'trust:read',
    query: z.object({ country: z.enum(['US', 'CA', 'IN']), quantity: z.coerce.number().int().min(1).max(20).default(1), priceMode: z.enum(['landed_cost', 'customer']).default('landed_cost') }),
    handler: async ({ req, query }) => {
      const id = idParam(req);
      if (!(await Product.exists({ _id: id }))) throw new DomainError('Product not found', 'NOT_FOUND', 404);
      return fairDealForProduct(ctx, id, query.country, query.quantity, { priceMode: query.priceMode });
    },
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/trust/recompute', summary: 'Recompute supplier trust and product risk now (audited)', tags: ['Admin', 'Trust'],
    auth: 'staff', permission: 'trust:write', body: trustRecomputeSchema, rateLimit: { max: 6, timeWindow: '1 minute' },
    handler: async ({ req, body }) => recomputeTrust(ctx, body, 'manual', req.actor),
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/trust/evidence', summary: 'Record an item of product/supplier evidence with provenance (audited)', tags: ['Admin', 'Trust'],
    auth: 'staff', permission: 'trust:write', body: evidenceInputSchema,
    handler: async ({ req, body, reply }) => reply.status(201).send(await recordEvidence(ctx, body, req.actor)),
  });
}
