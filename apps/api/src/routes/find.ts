import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DomainError, alertStatus, alternativesFor, betterOfferFor, createPriceAlert, createSavedSearch, deletePriceAlert, deleteSavedSearch, getPriceHistory, listPresets, listPriceAlerts,
  listSavedSearches, runCompare, runFind, runImageFind, updatePriceAlert, updateSavedSearch,
} from '@orvia/core';
import type { Ctx } from '@orvia/core';
import { compareRequestSchema, countrySchema, findRequestSchema, objectId, priceAlertInput, priceAlertPatch, savedSearchInput, savedSearchPatch } from '@orvia/types';
import { route } from '../http';

const idParam = (req: { params: unknown }, k = 'id') => {
  const v = (req.params as Record<string, string>)[k] ?? '';
  const r = objectId.safeParse(v);
  if (!r.success) throw new DomainError('Invalid id', 'VALIDATION', 400);
  return r.data;
};

/** ORVIA Find (AI product discovery, comparison) and Price Guard (alerts, price history, saved searches). */
export function findRoutes(app: FastifyInstance, ctx: Ctx): void {
  route(app, ctx, {
    method: 'POST', url: '/find', summary: 'Natural-language product search (deterministic intent parser, optional AI refinement)', tags: ['Find'], auth: 'optional',
    body: findRequestSchema, rateLimit: { max: 30, timeWindow: '1 minute' },
    handler: async ({ req, body }) => runFind(ctx, body.country ?? req.country, body),
  });

  route(app, ctx, {
    method: 'POST', url: '/find/image', summary: 'Image search (multipart "file" + optional "query"). Needs an AI vision provider; 503 not_configured otherwise', tags: ['Find'], auth: 'optional',
    rateLimit: { max: 8, timeWindow: '1 minute' },
    handler: async ({ req }) => {
      if (!ctx.ai.visionConfigured) throw new DomainError('Image search needs an AI vision provider (GEMINI_API_KEY) that is not configured on this server.', 'not_configured', 503);
      if (!req.isMultipart()) throw new DomainError('Send the image as multipart/form-data', 'VALIDATION', 415);
      let file: { buffer: Buffer; mimetype: string } | undefined;
      let text = '';
      try {
        for await (const part of req.parts()) {
          if (part.type === 'file') {
            if (file) { part.file.resume(); continue; }
            const buffer = await part.toBuffer();
            if (part.file.truncated) throw new DomainError(`Image is larger than ${Math.round(ctx.cfg.MEDIA_MAX_BYTES / 1_000_000)} MB`, 'VALIDATION', 413);
            file = { buffer, mimetype: part.mimetype };
          } else if (part.fieldname === 'query') text = String(part.value).slice(0, 300);
        }
      } catch (e) {
        if (e instanceof DomainError) throw e;
        throw new DomainError(/limit/i.test((e as Error).message) ? 'Image is too large' : 'Invalid upload', 'VALIDATION', 400);
      }
      if (!file) throw new DomainError('No image file received', 'VALIDATION', 400);
      return runImageFind(ctx, req.country, file, text); // the image lives in memory for this request only
    },
  });

  route(app, ctx, {
    method: 'POST', url: '/compare', summary: 'Side-by-side comparison of 2-4 products', tags: ['Find'], auth: 'none', body: compareRequestSchema, rateLimit: { max: 60, timeWindow: '1 minute' },
    handler: async ({ req, body }) => runCompare(ctx, body.country ?? req.country, body.ids),
  });

  route(app, ctx, {
    method: 'GET', url: '/find/presets', summary: 'Gift / budget / need discovery presets that currently have results', tags: ['Find'], auth: 'none', rateLimit: { max: 60, timeWindow: '1 minute' },
    handler: async ({ req }) => ({ items: await listPresets(ctx, req.country) }),
  });

  route(app, ctx, {
    method: 'GET', url: '/find/alternatives/:productId', summary: 'Alternatives for an unavailable product', tags: ['Find'], auth: 'none', rateLimit: { max: 60, timeWindow: '1 minute' },
    handler: async ({ req }) => alternativesFor(ctx, req.country, idParam(req, 'productId')),
  });

  route(app, ctx, {
    method: 'GET', url: '/find/better-offer/:productId', summary: 'A cheaper equivalent product with comparable ratings, if one exists', tags: ['Find'], auth: 'none', rateLimit: { max: 60, timeWindow: '1 minute' },
    handler: async ({ req }) => betterOfferFor(ctx, req.country, idParam(req, 'productId')),
  });

  route(app, ctx, {
    method: 'GET', url: '/find/price-history/:productId', summary: 'Observed price history (only where we have snapshots)', tags: ['Find'], auth: 'none', query: z.object({ days: z.coerce.number().int().min(7).max(365).default(30), country: countrySchema.optional() }),
    rateLimit: { max: 60, timeWindow: '1 minute' },
    handler: async ({ req, query }) => getPriceHistory(ctx, query.country ?? req.country, idParam(req, 'productId'), query.days),
  });

  /* ---------------- saved searches (owner only) ---------------- */
  route(app, ctx, { method: 'GET', url: '/account/saved-searches', summary: 'My saved searches', tags: ['Find'], auth: 'user', handler: async ({ user }) => ({ items: await listSavedSearches(user.id) }) });
  route(app, ctx, {
    method: 'POST', url: '/account/saved-searches', summary: 'Save a search', tags: ['Find'], auth: 'user', body: savedSearchInput, rateLimit: { max: 20, timeWindow: '1 minute' },
    handler: async ({ req, reply, user, body }) => reply.status(201).send(await createSavedSearch(ctx, user.id, req.country, body)),
  });
  route(app, ctx, {
    method: 'PATCH', url: '/account/saved-searches/:id', summary: 'Rename a saved search or toggle its new-match alert', tags: ['Find'], auth: 'user', body: savedSearchPatch,
    handler: async ({ req, user, body }) => updateSavedSearch(user.id, idParam(req), body),
  });
  route(app, ctx, { method: 'DELETE', url: '/account/saved-searches/:id', summary: 'Delete a saved search', tags: ['Find'], auth: 'user', handler: async ({ req, user }) => deleteSavedSearch(user.id, idParam(req)) });

  /* ---------------- Price Guard (owner only) ---------------- */
  route(app, ctx, { method: 'GET', url: '/account/price-guard/alerts', summary: 'My price alerts', tags: ['Price Guard'], auth: 'user', handler: async ({ user }) => listPriceAlerts(user.id) });
  route(app, ctx, {
    method: 'GET', url: '/account/price-guard/status', summary: 'Am I tracking this product?', tags: ['Price Guard'], auth: 'user', query: z.object({ productId: objectId, country: countrySchema.optional() }),
    handler: async ({ req, user, query }) => alertStatus(user.id, query.productId, query.country ?? req.country),
  });
  route(app, ctx, {
    method: 'POST', url: '/account/price-guard/alerts', summary: 'Track a product (target price, drops, stock, better offers)', tags: ['Price Guard'], auth: 'user', body: priceAlertInput, rateLimit: { max: 30, timeWindow: '1 minute' },
    handler: async ({ req, reply, user, body }) => reply.status(201).send(await createPriceAlert(ctx, user.id, req.country, body)),
  });
  route(app, ctx, {
    method: 'PATCH', url: '/account/price-guard/alerts/:id', summary: 'Change or pause a price alert', tags: ['Price Guard'], auth: 'user', body: priceAlertPatch,
    handler: async ({ req, user, body }) => updatePriceAlert(user.id, idParam(req), body),
  });
  route(app, ctx, { method: 'DELETE', url: '/account/price-guard/alerts/:id', summary: 'Stop tracking', tags: ['Price Guard'], auth: 'user', handler: async ({ req, user }) => deletePriceAlert(user.id, idParam(req)) });
}
