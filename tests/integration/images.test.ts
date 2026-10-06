import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Product } from '@orvia/database';
import { canPublish, listableImageFilter, setImagePolicy, usableImages, invalidateSearchIndex } from '@orvia/core';
import { extractImages } from '@orvia/suppliers';
import type { Ctx } from '@orvia/core';
import { closeCtx, testCtx } from '../helpers/ctx';
import { Client, startApi } from '../helpers/client';
import { runSeed } from '../../scripts/lib/seed';

let ctx: Ctx;
let client: Client;
beforeAll(async () => {
  ctx = await testCtx('images');
  await runSeed(ctx, { withHistory: false });
  client = (await startApi(ctx)).client();
}, 180_000);
afterAll(closeCtx);

describe('product images come from the supplier', () => {
  it('extracts photos from every CJ field shape and keeps https URLs only', () => {
    expect(extractImages({ productImage: '["http://cf.cj.com/a.jpg","https://cf.cj.com/b.jpg"]', productImageSet: ['https://cf.cj.com/c.jpg', 'javascript:alert(1)'], bigImage: 'https://cf.cj.com/a.jpg'.replace('a', 'd') })).toEqual([
      'https://cf.cj.com/c.jpg', 'https://cf.cj.com/a.jpg', 'https://cf.cj.com/b.jpg', 'https://cf.cj.com/d.jpg',
    ]);
    expect(extractImages({ productImage: 'not a url' })).toEqual([]);
  });

  it('demo art counts only under the mock-supplier policy; live policy requires real supplier URLs', () => {
    setImagePolicy({ allowDemoArt: true });
    expect(usableImages(['/art/x?v=1', 'https://cdn.example/p.jpg', ''])).toHaveLength(2);
    setImagePolicy({ allowDemoArt: false });
    expect(usableImages(['/art/x?v=1', 'https://cdn.example/p.jpg', ''])).toEqual(['https://cdn.example/p.jpg']);
    expect(JSON.stringify(listableImageFilter())).toContain('https?://');
    setImagePolicy({ allowDemoArt: true });
  });

  it('a product with no usable image cannot be published, listed or added to a cart', async () => {
    const p = await Product.findOne({ state: 'PUBLISHED' });
    const original = p!.images;
    const c = client;
    await Product.updateOne({ _id: p!._id }, { $set: { images: [] } });
    invalidateSearchIndex();
    const gate = await canPublish(ctx, String(p!._id));
    expect(gate.ok).toBe(false);
    expect(gate.problems.join(' ')).toMatch(/product image/i);
    const add = await c.post('/api/v1/cart/items?country=US', { productId: String(p!._id), quantity: 1 });
    expect(add.status).toBe(409);
    const list = await c.get('/api/v1/products?pageSize=48&country=US');
    expect(list.body.items.some((x: { id: string }) => x.id === String(p!._id))).toBe(false);
    await Product.updateOne({ _id: p!._id }, { $set: { images: original } });
    invalidateSearchIndex();
    const ok = await c.post('/api/v1/cart/items?country=US', { productId: String(p!._id), quantity: 1 });
    expect(ok.status).toBe(200);
  });
});
