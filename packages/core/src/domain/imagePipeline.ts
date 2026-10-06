import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { Product, ProductAsset, SupplierProduct } from '@orvia/database';
import type { Ctx, Actor } from '../infra/context';
import { DomainError, notFound } from '../infra/context';
import { audit } from '../infra/audit';
import { FetchBlockedError, guardedFetch } from '../infra/ssrf';
import { raiseException } from './exceptions';
import { isOwned, usableImages } from './images';

export type ImageFormat = 'jpeg' | 'png' | 'webp' | 'avif';

/** Detect the real format from magic bytes — never trust the extension or the declared MIME type. */
export function sniffFormat(b: Buffer): ImageFormat | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (b.subarray(4, 8).toString('ascii') === 'ftyp' && /avif|avis/.test(b.subarray(8, 16).toString('ascii'))) return 'avif';
  return null;
}

export class ImageRejected extends DomainError {
  constructor(message: string, readonly reason: 'type' | 'size' | 'dimensions' | 'corrupt' | 'duplicate' | 'aspect' | 'animated') {
    super(message, 'IMAGE_REJECTED', 422, { reason });
  }
}

export interface InspectedImage {
  format: ImageFormat;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  dhash: string;
  hasAlpha: boolean;
}

const MAX_DIMENSION = 10_000;
const MAX_PIXELS = 50_000_000;

/** 64-bit difference hash (9x8 grayscale) for near-duplicate detection. */
async function dhash(buf: Buffer): Promise<string> {
  const { data } = await sharp(buf, { limitInputPixels: MAX_PIXELS }).rotate().grayscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  let bits = '';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += data[y * 9 + x]! > data[y * 9 + x + 1]! ? '1' : '0';
  return BigInt('0b' + bits).toString(16).padStart(16, '0');
}
export const hamming = (a: string, b: string): number => {
  let x = BigInt('0x' + a) ^ BigInt('0x' + b);
  let n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
};

export async function inspectImage(buf: Buffer, o: { maxBytes: number; minDimension: number }): Promise<InspectedImage> {
  if (buf.length > o.maxBytes) throw new ImageRejected(`Image is larger than ${Math.round(o.maxBytes / 1_000_000)} MB`, 'size');
  const format = sniffFormat(buf);
  if (!format) throw new ImageRejected('Unsupported or disguised file: only JPEG, PNG, WebP and AVIF images are accepted', 'type');
  let meta: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
  try {
    meta = await sharp(buf, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).metadata();
    await sharp(buf, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).resize(32, 32, { fit: 'inside' }).toBuffer(); // forces a real decode: catches truncated/corrupt data
  } catch {
    throw new ImageRejected('The image is corrupt or cannot be decoded', 'corrupt');
  }
  if ((meta.pages ?? 1) > 1) throw new ImageRejected('Animated images are not accepted', 'animated');
  const { width = 0, height = 0 } = meta;
  if (Math.min(width, height) < o.minDimension) throw new ImageRejected(`Image is too small (${width}×${height}); the shorter side must be at least ${o.minDimension}px`, 'dimensions');
  if (Math.max(width, height) > MAX_DIMENSION) throw new ImageRejected(`Image is too large (${width}×${height})`, 'dimensions');
  const ratio = width / height;
  if (ratio > 3 || ratio < 1 / 3) throw new ImageRejected('Extreme aspect ratio; use an image between 1:3 and 3:1', 'aspect');
  return { format, width, height, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), dhash: await dhash(buf), hasAlpha: !!meta.hasAlpha };
}

const VARIANTS = [
  ['thumb', 160],
  ['card', 480],
  ['page', 960],
  ['zoom', 1600],
] as const;

/** Resize/compress to WebP variants; EXIF/ICC metadata is dropped (sharp default) and EXIF orientation applied. */
export async function renderVariants(buf: Buffer): Promise<{ name: string; ext: string; contentType: string; body: Buffer }[]> {
  const base = () => sharp(buf, { limitInputPixels: MAX_PIXELS }).rotate().flatten({ background: '#ffffff' });
  const out: { name: string; ext: string; contentType: string; body: Buffer }[] = [];
  for (const [name, w] of VARIANTS) {
    out.push({ name, ext: 'webp', contentType: 'image/webp', body: await base().resize({ width: w, height: w, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82, effort: 4 }).toBuffer() });
  }
  out.push({ name: 'og', ext: 'jpg', contentType: 'image/jpeg', body: await base().resize(1200, 630, { fit: 'cover' }).jpeg({ quality: 82, mozjpeg: true }).toBuffer() });
  return out;
}

export interface IngestInput {
  productId: string;
  buffer: Buffer;
  source: 'supplier' | 'admin';
  sourceUrl?: string;
  supplierId?: string;
  alt?: string;
  createdBy: string;
  variantSku?: string;
  countries?: string[];
}

/** Validate → dedupe → process → store → record. Throws ImageRejected for anything unsafe or unusable. */
export async function ingestImage(ctx: Ctx, input: IngestInput) {
  const product = await Product.findById(input.productId).select('title').lean();
  if (!product) throw notFound('Product');
  const info = await inspectImage(input.buffer, { maxBytes: ctx.cfg.MEDIA_MAX_BYTES, minDimension: ctx.cfg.MEDIA_MIN_DIMENSION });
  const existing = await ProductAsset.find({ productId: input.productId, status: 'ready' }).select('sha256 dhash').lean();
  if (existing.some((a) => a.sha256 === info.sha256 || (a.dhash && hamming(a.dhash, info.dhash) <= 3))) throw new ImageRejected('This image (or a near-identical one) is already on the product', 'duplicate');
  const id = randomUUID();
  const rendered = await renderVariants(input.buffer);
  const base = `products/${input.productId}/${id}`;
  const keys: string[] = [];
  const urls: Record<string, string> = {};
  for (const v of rendered) {
    const key = `${base}/${v.name}.${v.ext}`;
    await ctx.storage.put(key, v.body, v.contentType);
    keys.push(key);
    urls[v.name] = ctx.storage.publicUrl(key);
  }
  const count = await ProductAsset.countDocuments({ productId: input.productId, status: 'ready' });
  const asset = await ProductAsset.create({
    _id: undefined, productId: input.productId, source: input.source, sourceUrl: input.sourceUrl, supplierId: input.supplierId, status: 'ready',
    sha256: info.sha256, dhash: info.dhash, width: info.width, height: info.height, bytes: info.bytes, format: info.format, hasAlpha: info.hasAlpha,
    variants: urls, keys, alt: input.alt ?? `${product.title} — image ${count + 1}`, position: count, isPrimary: count === 0, variantSku: input.variantSku, countries: input.countries ?? [],
    license: input.source === 'admin' ? 'owned' : 'unknown', createdBy: input.createdBy,
  });
  await syncProductImages(ctx, input.productId);
  return asset;
}

/** Rebuild Product.images / market images / imageStatus from the ready assets (single source of truth). */
export async function syncProductImages(ctx: Ctx, productId: string): Promise<{ status: string; count: number }> {
  const assets = await ProductAsset.find({ productId, status: 'ready' }).sort({ isPrimary: -1, position: 1, createdAt: 1 }).lean();
  const failedPending = await ProductAsset.countDocuments({ productId, status: 'failed' });
  const product = await Product.findById(productId);
  if (!product) throw notFound('Product');
  const hosted = assets.map((a) => ({
    url: a.variants?.page ?? '', card: a.variants?.card, thumb: a.variants?.thumb, zoom: a.variants?.zoom, alt: a.alt ?? undefined, assetId: String(a._id),
    source: a.source, license: a.license ?? 'unknown',
  })).filter((i) => i.url);
  if (hosted.length) {
    product.images = hosted as never;
  } else {
    // keep any still-acceptable external/demo URLs (dev hotlinks, demo art); drop everything else
    const keep = new Set(usableImages(product.images.map((i) => i.url)).filter((u) => !isOwned(u))); // hosted copies whose asset is gone are stale
    product.images = product.images.filter((i) => keep.has(i.url ?? '')) as never;
  }
  for (const m of product.markets) {
    const mine = assets.filter((a) => a.countries?.includes(m.country) || (a.supplierId && m.bestSupplierId && String(a.supplierId) === String(m.bestSupplierId) && !a.countries?.length));
    if (mine.length) m.images = mine.map((a) => a.variants?.page ?? '').filter(Boolean) as never;
  }
  const have = usableImages(product.images.map((i) => i.url)).length;
  product.imageStatus = have ? 'READY' : failedPending ? 'FAILED' : 'MISSING';
  await product.save();
  return { status: product.imageStatus, count: have };
}

const jpegOrPng = /^image\/(jpeg|png|webp|avif)/i;

/** Download supplier photos (SSRF-safe), validate, host copies on Orvia storage. Failures become one exception per product. */
export async function ingestSupplierImages(ctx: Ctx, productId: string): Promise<{ ingested: number; failed: number; skipped: number }> {
  const links = await SupplierProduct.find({ productId }).select('supplierId images').lean();
  const known = new Set((await ProductAsset.find({ productId }).select('sourceUrl').lean()).map((a) => a.sourceUrl));
  let ingested = 0, failed = 0, skipped = 0;
  const failures: string[] = [];
  for (const link of links) {
    for (const url of link.images ?? []) {
      if (!/^https?:\/\//i.test(url) || known.has(url)) { skipped++; continue; }
      try {
        const res = await guardedFetch(url, { allowPrivate: ctx.cfg.ALLOW_PRIVATE_FETCH, maxBytes: ctx.cfg.MEDIA_MAX_BYTES, headers: { accept: 'image/*', 'user-agent': 'OrviaImageFetcher/1.0' } });
        if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
        const ct = res.headers.get('content-type') ?? '';
        if (ct && !jpegOrPng.test(ct) && !/octet-stream/.test(ct)) throw new ImageRejected(`Unexpected content type ${ct}`, 'type');
        await ingestImage(ctx, { productId, buffer: res.body, source: 'supplier', sourceUrl: url, supplierId: String(link.supplierId), createdBy: 'image-ingestion' });
        ingested++;
        known.add(url);
      } catch (e) {
        if (e instanceof ImageRejected && e.reason === 'duplicate') { skipped++; known.add(url); continue; }
        failed++;
        failures.push(`${url} — ${(e as Error).message}`);
        await ProductAsset.updateOne({ productId, sourceUrl: url }, { $set: { productId, source: 'supplier', sourceUrl: url, supplierId: link.supplierId, status: 'failed', error: (e as Error).message.slice(0, 300) } }, { upsert: true });
        known.add(url);
        if (e instanceof FetchBlockedError && e.retryable) failed += 0;
      }
    }
  }
  const sync = await syncProductImages(ctx, productId);
  if (failures.length) {
    await raiseException(ctx, {
      kind: 'MISSING_IMAGE', priority: sync.count ? 'low' : 'high', productId, issue: `${failures.length} supplier image(s) could not be imported${sync.count ? '' : ' — the product has no usable image'}`,
      aiRecommendation: 'Upload product photos manually (Admin → Product → Images) or fix the supplier image URLs.', suggestedAction: 'Upload images', details: { failures: failures.slice(0, 5) }, dedupeKey: `imgfail:${productId}`,
    }).catch(() => undefined);
  }
  await syncProductStateForImages(ctx, productId);
  return { ingested, failed, skipped };
}

/** IMAGE_REQUIRED ⇄ READY bookkeeping so products without photos can never slip into a sellable state. */
export async function syncProductStateForImages(ctx: Ctx, productId: string, actor?: Actor): Promise<void> {
  const { transitionProduct } = await import('./catalog');
  const p = await Product.findById(productId).select('state imageStatus').lean();
  if (!p) return;
  if (p.imageStatus === 'READY' && p.state === 'IMAGE_REQUIRED') await transitionProduct(ctx, productId, 'READY', actor ?? { id: 'image-pipeline', type: 'system' }, 'product images are ready');
  if (p.imageStatus !== 'READY' && ['DISCOVERED', 'ANALYZING', 'APPROVED', 'DRAFT', 'READY'].includes(p.state)) await transitionProduct(ctx, productId, 'IMAGE_REQUIRED', actor ?? { id: 'image-pipeline', type: 'system' }, 'no usable product image');
}

export async function removeAsset(ctx: Ctx, productId: string, assetId: string, actor: Actor): Promise<void> {
  const a = await ProductAsset.findOne({ _id: assetId, productId });
  if (!a) throw notFound('Image');
  for (const k of a.keys ?? []) await ctx.storage.delete(k).catch(() => undefined);
  const wasPrimary = a.isPrimary;
  await a.deleteOne();
  if (wasPrimary) {
    const next = await ProductAsset.findOne({ productId, status: 'ready' }).sort({ position: 1 });
    if (next) await ProductAsset.updateOne({ _id: next._id }, { $set: { isPrimary: true } });
  }
  await audit(ctx, actor, { action: 'product.image_removed', resource: 'product', resourceId: productId, previousValue: { assetId, source: a.source } });
  await syncProductImages(ctx, productId);
  await syncProductStateForImages(ctx, productId, actor);
}

export async function updateAssets(ctx: Ctx, productId: string, actor: Actor, patch: { order?: string[]; primaryId?: string; alt?: { id: string; alt: string }; assign?: { id: string; variantSku?: string | null; countries?: string[] } }): Promise<void> {
  if (patch.order) {
    const ids = patch.order;
    const owned = await ProductAsset.find({ productId, _id: { $in: ids } }).select('_id').lean();
    if (owned.length !== ids.length) throw new DomainError('Unknown image in order', 'VALIDATION', 422);
    await Promise.all(ids.map((id, i) => ProductAsset.updateOne({ _id: id, productId }, { $set: { position: i } })));
  }
  if (patch.primaryId) {
    const a = await ProductAsset.findOne({ _id: patch.primaryId, productId, status: 'ready' });
    if (!a) throw notFound('Image');
    await ProductAsset.updateMany({ productId }, { $set: { isPrimary: false } });
    await ProductAsset.updateOne({ _id: a._id }, { $set: { isPrimary: true } });
  }
  if (patch.alt) await ProductAsset.updateOne({ _id: patch.alt.id, productId }, { $set: { alt: patch.alt.alt.slice(0, 200) } });
  if (patch.assign) await ProductAsset.updateOne({ _id: patch.assign.id, productId }, { $set: { ...(patch.assign.variantSku !== undefined ? { variantSku: patch.assign.variantSku ?? undefined } : {}), ...(patch.assign.countries ? { countries: patch.assign.countries } : {}) } });
  await audit(ctx, actor, { action: 'product.images_updated', resource: 'product', resourceId: productId, newValue: patch });
  await syncProductImages(ctx, productId);
}

/** Rotate / crop an existing hosted image (re-renders all variants from the stored zoom variant). */
export async function transformAsset(ctx: Ctx, productId: string, assetId: string, actor: Actor, t: { rotate?: 90 | 180 | 270; squareCrop?: boolean }) {
  const a = await ProductAsset.findOne({ _id: assetId, productId, status: 'ready' });
  if (!a) throw notFound('Image');
  const src = await ctx.storage.get(a.keys.find((k) => k.endsWith('/zoom.webp')) ?? a.keys[0]!);
  if (!src) throw new DomainError('Stored image is missing', 'NOT_FOUND', 404);
  let img = sharp(src.body);
  if (t.rotate) img = img.rotate(t.rotate);
  if (t.squareCrop) {
    const m = await sharp(await img.toBuffer()).metadata();
    const side = Math.min(m.width ?? 0, m.height ?? 0);
    img = sharp(await img.toBuffer()).extract({ left: Math.floor(((m.width ?? side) - side) / 2), top: Math.floor(((m.height ?? side) - side) / 2), width: side, height: side });
  }
  const buf = await img.png().toBuffer();
  const rendered = await renderVariants(buf);
  for (const v of rendered) await ctx.storage.put(`products/${productId}/${a._id}/${v.name}.${v.ext}`, v.body, v.contentType);
  const info = await inspectImage(buf, { maxBytes: 50_000_000, minDimension: 100 });
  await ProductAsset.updateOne({ _id: a._id }, { $set: { width: info.width, height: info.height, dhash: info.dhash, sha256: info.sha256 } });
  await audit(ctx, actor, { action: 'product.image_transformed', resource: 'product', resourceId: productId, newValue: { assetId, ...t } });
  await syncProductImages(ctx, productId);
}
