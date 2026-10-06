import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ProductAsset, Product } from '@orvia/database';
import { DomainError, ImageRejected, ingestImage, mimeForKey, notFound, removeAsset, syncProductStateForImages, transformAsset, updateAssets } from '@orvia/core';
import type { Ctx } from '@orvia/core';
import { objectId } from '@orvia/types';
import { route } from '../http';

const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;
const ALLOWED_UPLOAD = /^image\/(jpeg|png|webp|avif)$/i;

export function mediaRoutes(app: FastifyInstance, ctx: Ctx): void {
  // Local development storage is served through the API (production serves from the CDN/object store directly).
  if (ctx.storage.provider === 'local') {
    app.get('/api/v1/media/*', { schema: { hide: true } }, async (req, reply) => {
      const key = (req.params as { '*': string })['*'];
      let obj;
      try {
        obj = await ctx.storage.get(key);
      } catch {
        throw new DomainError('Not found', 'NOT_FOUND', 404);
      }
      if (!obj) throw new DomainError('Not found', 'NOT_FOUND', 404);
      return reply.header('content-type', mimeForKey(key)).header('x-content-type-options', 'nosniff').header('cache-control', 'public, max-age=31536000, immutable').send(obj.body);
    });
  }

  route(app, ctx, {
    method: 'GET', url: '/admin/products/:id/images', summary: 'Images and image status for a product', tags: ['Admin'], auth: 'staff', permission: 'products:read',
    handler: async ({ req }) => {
      const p = await Product.findById(idOf(req)).select('imageStatus state title').lean();
      if (!p) throw notFound('Product');
      const assets = await ProductAsset.find({ productId: idOf(req) }).sort({ isPrimary: -1, position: 1, createdAt: 1 }).lean();
      return {
        imageStatus: p.imageStatus, state: p.state, limits: { maxBytes: ctx.cfg.MEDIA_MAX_BYTES, minDimension: ctx.cfg.MEDIA_MIN_DIMENSION, formats: ['JPEG', 'PNG', 'WebP', 'AVIF'] },
        items: assets.map((a) => ({
          id: String(a._id), status: a.status, error: a.error, source: a.source, sourceUrl: a.sourceUrl, license: a.license, alt: a.alt, position: a.position, isPrimary: a.isPrimary,
          width: a.width, height: a.height, bytes: a.bytes, hasAlpha: a.hasAlpha, variantSku: a.variantSku, countries: a.countries ?? [], url: a.variants?.card ?? a.variants?.page, pageUrl: a.variants?.page,
        })),
      };
    },
  });

  route(app, ctx, {
    method: 'POST', url: '/admin/products/:id/images', summary: 'Upload a product image (multipart, field "file")', tags: ['Admin'], auth: 'staff', permission: 'products:write',
    rateLimit: { max: 40, timeWindow: '1 minute' },
    handler: async ({ req, reply }) => {
      const exists = await Product.exists({ _id: idOf(req) });
      if (!exists) throw notFound('Product');
      if (!req.isMultipart()) throw new DomainError('Send the image as multipart/form-data', 'VALIDATION', 415);
      let alt: string | undefined;
      let file: { buffer: Buffer; mimetype: string } | undefined;
      try {
        for await (const part of req.parts()) {
          if (part.type === 'file') {
            if (file) { part.file.resume(); continue; }
            const buffer = await part.toBuffer();
            if (part.file.truncated) throw new ImageRejected(`Image is larger than ${Math.round(ctx.cfg.MEDIA_MAX_BYTES / 1_000_000)} MB`, 'size');
            file = { buffer, mimetype: part.mimetype };
          } else if (part.fieldname === 'alt') alt = String(part.value).slice(0, 200);
        }
      } catch (e) {
        if (e instanceof DomainError) throw e;
        throw new ImageRejected(/limit/i.test((e as Error).message) ? 'Image is too large' : 'Invalid upload', 'size');
      }
      if (!file) throw new DomainError('No image file received', 'VALIDATION', 400);
      if (!ALLOWED_UPLOAD.test(file.mimetype)) throw new ImageRejected('Unsupported file type: only JPEG, PNG, WebP and AVIF images are accepted', 'type');
      const asset = await ingestImage(ctx, { productId: idOf(req), buffer: file.buffer, source: 'admin', alt, createdBy: req.actor.id });
      await syncProductStateForImages(ctx, idOf(req), req.actor);
      const { audit } = await import('@orvia/core');
      await audit(ctx, req.actor, { action: 'product.image_uploaded', resource: 'product', resourceId: idOf(req), newValue: { assetId: String(asset._id), bytes: asset.bytes, width: asset.width, height: asset.height } });
      return reply.status(201).send({ id: String(asset._id), width: asset.width, height: asset.height, bytes: asset.bytes, isPrimary: asset.isPrimary });
    },
  });

  route(app, ctx, {
    method: 'PATCH', url: '/admin/products/:id/images', summary: 'Reorder, set primary, edit alt text, assign to variant/country', tags: ['Admin'], auth: 'staff', permission: 'products:write',
    body: z.object({
      order: z.array(objectId).max(50).optional(),
      primaryId: objectId.optional(),
      alt: z.object({ id: objectId, alt: z.string().max(200) }).optional(),
      assign: z.object({ id: objectId, variantSku: z.string().max(80).nullable().optional(), countries: z.array(z.enum(['US', 'CA', 'IN'])).max(10).optional() }).optional(),
    }),
    handler: async ({ req, body }) => { await updateAssets(ctx, idOf(req), req.actor, body); return { ok: true }; },
  });

  route(app, ctx, {
    method: 'POST', url: '/admin/products/:id/images/:assetId/transform', summary: 'Rotate or square-crop a hosted image', tags: ['Admin'], auth: 'staff', permission: 'products:write',
    body: z.object({ rotate: z.union([z.literal(90), z.literal(180), z.literal(270)]).optional(), squareCrop: z.boolean().optional() }),
    handler: async ({ req, body }) => { await transformAsset(ctx, idOf(req), (req.params as { assetId: string }).assetId, req.actor, body); return { ok: true }; },
  });

  route(app, ctx, {
    method: 'DELETE', url: '/admin/products/:id/images/:assetId', summary: 'Delete a product image', tags: ['Admin'], auth: 'staff', permission: 'products:write',
    handler: async ({ req }) => { await removeAsset(ctx, idOf(req), (req.params as { assetId: string }).assetId, req.actor); return { ok: true }; },
  });

  route(app, ctx, {
    method: 'POST', url: '/admin/products/:id/images/ingest', summary: 'Re-run supplier image ingestion', tags: ['Admin'], auth: 'staff', permission: 'products:write',
    handler: async ({ req }) => {
      if (!(await Product.exists({ _id: idOf(req) }))) throw notFound('Product');
      await ctx.queue.enqueue('image_ingestion', { productId: idOf(req) }, { dedupeKey: `images:${idOf(req)}:${Date.now()}` });
      return { queued: true };
    },
  });
}
