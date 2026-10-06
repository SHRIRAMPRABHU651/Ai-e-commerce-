import { createServer } from 'node:http';
import type { Server } from 'node:http';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExceptionModel, Product, ProductAsset, Supplier, SupplierProduct } from '@orvia/database';
import { guardedFetch, ingestSupplierImages, isPrivateAddress, setImagePolicy, sniffFormat, usableImages, canPublish, FetchBlockedError } from '@orvia/core';
import type { Ctx } from '@orvia/core';
import { closeCtx, testCtx } from '../helpers/ctx';
import { Client, startApi } from '../helpers/client';
import { runSeed } from '../../scripts/lib/seed';

const png = (w = 900, h = 900, color = '#3366cc') => sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer();
/** A photo-like image (noise) so near-duplicate hashing sees different pictures. */
const noisy = async (seed: number, w = 900, h = 700) => {
  const raw = Buffer.alloc(w * h * 3);
  let x = seed * 2654435761 >>> 0;
  for (let i = 0; i < raw.length; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; raw[i] = x & 255; }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
};

let ctx: Ctx; let admin: Client; let fake: Server; const fakePort = 47821;
const served = new Map<string, Buffer>();
beforeAll(async () => {
  fake = createServer((req, res) => {
    const b = served.get(req.url!);
    if (!b) { res.statusCode = 404; return res.end(); }
    res.setHeader('content-type', req.url!.endsWith('.txt') ? 'text/plain' : 'image/jpeg'); res.end(b);
  });
  await new Promise<void>((r) => fake.listen(fakePort, r));
  ctx = await testCtx('imgpipe', { ALLOW_PRIVATE_FETCH: 'true', LOCAL_MEDIA_DIR: `/tmp/orvia-media-${process.pid}` });
  await runSeed(ctx, { withHistory: false });
  const { client } = await startApi(ctx);
  admin = client();
  expect((await admin.post('/api/v1/auth/admin/login', { email: 'owner@orvia.test', password: 'Orvia-Demo-2026!' })).status).toBe(200);
}, 180_000);
afterAll(async () => { await new Promise((r) => fake.close(r)); await closeCtx(); });

async function bareProduct(title: string, images: string[] = []) {
  const sup = await Supplier.findOne({ provider: 'mock' });
  const p = await Product.create({ slug: `t-${Math.random().toString(36).slice(2, 8)}`, sku: `T-${Math.random().toString(36).slice(2, 8)}`, title, description: 'A test product with a sufficiently long description.', state: 'DRAFT', images: images.map((url) => ({ url })), imageStatus: images.length ? 'READY' : 'MISSING', compliance: { status: 'passed', flags: [] }, markets: [{ country: 'US', enabled: true, currency: 'USD', price: 3000, stock: 50, expectedMargin: 0.4 }] });
  return { p, sup: sup! };
}

describe('upload validation', () => {
  let productId = '';
  beforeAll(async () => { productId = String((await bareProduct('Upload target')).p._id); });

  it('accepts a real image, hosts resized WebP variants and updates the product', async () => {
    const r = await admin.upload(`/api/v1/admin/products/${productId}/images`, { filename: 'bowl.png', mimetype: 'image/png', buffer: await png() }, { alt: 'A blue bowl' });
    expect(r.status).toBe(201);
    expect(r.body.isPrimary).toBe(true);
    const p = await Product.findById(productId).lean();
    expect(p!.imageStatus).toBe('READY');
    expect(p!.images[0]!.url).toMatch(/^\/api\/v1\/media\/products\//);
    expect(p!.images[0]!.alt).toBe('A blue bowl');
    const served = await admin.get(p!.images[0]!.card!);
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toBe('image/webp');
    expect(sniffFormat(served.buffer)).toBe('webp');
    const meta = await sharp(served.buffer).metadata();
    expect(meta.width).toBeLessThanOrEqual(480);
  });

  it('rejects executables disguised as images, corrupt files, tiny images, text and duplicates', async () => {
    const up = (filename: string, mimetype: string, buffer: Buffer) => admin.upload(`/api/v1/admin/products/${productId}/images`, { filename, mimetype, buffer });
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(2000, 7)]);
    expect((await up('logo.png', 'image/png', exe)).status).toBe(422);
    expect((await up('notes.txt', 'text/plain', Buffer.from('hello'))).status).toBe(422);
    const good = await noisy(1);
    expect((await up('trunc.jpg', 'image/jpeg', good.subarray(0, Math.floor(good.length / 2)))).body.error.details.reason).toBe('corrupt');
    expect((await up('tiny.png', 'image/png', await png(100, 100))).body.error.details.reason).toBe('dimensions');
    expect((await up('banner.png', 'image/png', await png(3600, 1000))).body.error.details.reason).toBe('aspect');
    expect((await up('a.jpg', 'image/jpeg', good)).status).toBe(201);
    const dup = await up('a-again.jpg', 'image/jpeg', good);
    expect(dup.status).toBe(422);
    expect(dup.body.error.details.reason).toBe('duplicate');
    const list = await admin.get(`/api/v1/admin/products/${productId}/images`);
    expect(list.body.items.filter((i: { status: string }) => i.status === 'ready').length).toBe(2);
  });

  it('manages order, primary image, alt text, rotate/crop and deletion with resource-level checks', async () => {
    const list = (await admin.get(`/api/v1/admin/products/${productId}/images`)).body.items as { id: string; isPrimary: boolean }[];
    const second = list.find((i) => !i.isPrimary)!;
    expect((await admin.patch(`/api/v1/admin/products/${productId}/images`, { primaryId: second.id })).status).toBe(200);
    expect((await Product.findById(productId).lean())!.images[0]!.assetId).toBe(second.id);
    expect((await admin.post(`/api/v1/admin/products/${productId}/images/${second.id}/transform`, { rotate: 90, squareCrop: true })).status).toBe(200);
    const other = await bareProduct('Someone else’s product');
    // IDOR: an asset id from another product must not be editable through this product
    expect((await admin.del(`/api/v1/admin/products/${String(other.p._id)}/images/${second.id}`)).status).toBe(404);
    expect((await admin.del(`/api/v1/admin/products/${productId}/images/${second.id}`)).status).toBe(200);
    expect((await Product.findById(productId).lean())!.images.length).toBe(1);
  });

  it('requires authentication and the products:write permission', async () => {
    const anon = (await startApi(ctx)).client();
    expect((await anon.upload(`/api/v1/admin/products/${productId}/images`, { filename: 'x.png', mimetype: 'image/png', buffer: await png() })).status).toBe(401);
    const analyst = (await startApi(ctx)).client();
    await analyst.post('/api/v1/auth/admin/login', { email: 'analyst@orvia.test', password: 'Orvia-Demo-2026!' });
    expect((await analyst.upload(`/api/v1/admin/products/${productId}/images`, { filename: 'x.png', mimetype: 'image/png', buffer: await png() })).status).toBe(403);
  });
});

describe('products without images are blocked until an image exists', () => {
  it('IMAGE_REQUIRED → upload → READY, and the publish gate agrees', async () => {
    const { p } = await bareProduct('Needs a photo');
    expect((await canPublish(ctx, String(p._id))).ok).toBe(false);
    await Product.updateOne({ _id: p._id }, { $set: { state: 'IMAGE_REQUIRED' } });
    const r = await admin.upload(`/api/v1/admin/products/${String(p._id)}/images`, { filename: 'p.jpg', mimetype: 'image/jpeg', buffer: await noisy(7) });
    expect(r.status).toBe(201);
    const after = await Product.findById(p._id).lean();
    expect(after!.state).toBe('READY');
    expect(after!.imageStatus).toBe('READY');
    expect((await canPublish(ctx, String(p._id))).ok).toBe(true);
    // removing the last image sends it back
    const asset = await ProductAsset.findOne({ productId: p._id });
    expect((await admin.del(`/api/v1/admin/products/${String(p._id)}/images/${String(asset!._id)}`)).status).toBe(200);
    expect((await Product.findById(p._id).lean())!.state).toBe('IMAGE_REQUIRED');
  });
});

describe('supplier image ingestion', () => {
  it('downloads supplier photos, hosts Orvia copies, keeps the source URL as provenance, and flags failures', async () => {
    served.set('/ok-1.jpg', await noisy(11)); served.set('/ok-2.jpg', await noisy(12)); served.set('/fake.jpg', Buffer.from('<html>not an image</html>'));
    const { p, sup } = await bareProduct('Supplier photos');
    await SupplierProduct.create({ supplierId: sup._id, externalId: 'E-1', productId: p._id, title: 'x', images: [`http://127.0.0.1:${fakePort}/ok-1.jpg`, `http://127.0.0.1:${fakePort}/ok-2.jpg`, `http://127.0.0.1:${fakePort}/fake.jpg`, `http://127.0.0.1:${fakePort}/missing.jpg`] });
    const r = await ingestSupplierImages(ctx, String(p._id));
    expect(r).toMatchObject({ ingested: 2, failed: 2 });
    const assets = await ProductAsset.find({ productId: p._id }).lean();
    expect(assets.filter((a) => a.status === 'ready').every((a) => a.sourceUrl?.includes('/ok-') && a.source === 'supplier' && a.license === 'unknown')).toBe(true);
    const prod = await Product.findById(p._id).lean();
    expect(prod!.images.every((i) => i.url!.startsWith('/api/v1/media/'))).toBe(true);
    expect(await ExceptionModel.countDocuments({ productId: p._id, kind: 'MISSING_IMAGE' })).toBe(1);
    // idempotent: re-running does not duplicate
    expect((await ingestSupplierImages(ctx, String(p._id))).ingested).toBe(0);
  });

  it('SSRF guard blocks loopback, private and metadata addresses and non-http schemes', async () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.9.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', '::ffff:10.0.0.1']) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
    for (const url of ['http://127.0.0.1/x.jpg', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/x', 'file:///etc/passwd', 'ftp://example.com/x', 'http://user:pw@example.com/x', 'http://localhost:6379/']) {
      await expect(guardedFetch(url, { allowPrivate: false }), url).rejects.toBeInstanceOf(FetchBlockedError);
    }
  });

  it('production policy serves only Orvia-hosted images (supplier hotlinks and demo art are unusable)', () => {
    setImagePolicy({ allowDemoArt: false, allowHotlinks: false, ownedPrefixes: ['https://cdn.orvia.example/'] });
    expect(usableImages(['https://supplier.example/a.jpg', '/art/x?v=1', 'https://cdn.orvia.example/products/1/a/page.webp'])).toEqual(['https://cdn.orvia.example/products/1/a/page.webp']);
    setImagePolicy({ allowDemoArt: true, allowHotlinks: true, ownedPrefixes: ['/api/v1/media/'] });
  });
});
