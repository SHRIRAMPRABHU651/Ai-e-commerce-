import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Product, Supplier, SupplierOffer } from '@orvia/database';
import { refreshProductMarkets, syncProductOffers, invalidateSearchIndex } from '@orvia/core';
import type { Ctx } from '@orvia/core';
import { closeCtx, testCtx } from '../helpers/ctx';
import { Client, startApi } from '../helpers/client';
import { runSeed } from '../../scripts/lib/seed';
import { pay, placeOrder } from '../helpers/shop';

/** Two independent "suppliers" with their own API keys, countries and photo CDNs. */
function fakeSupplier(key: string, cdn: string, port: number, ship: { cost: number; min: number; max: number }) {
  const orders = new Map<string, unknown>();
  const seen: string[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url!, `http://localhost:${port}`);
    seen.push(`${req.method} ${url.pathname}`);
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== `Bearer ${key}`) { res.statusCode = 401; return res.end('{"error":"bad key"}'); }
    const product = (id: string) => ({ id, title: 'Spiral Slow Feeder Dog Bowl', description: 'A durable bowl with a spiral maze that slows down fast eaters.', category: 'Pet', price: 4.5, stock: 120, images: [`${cdn}/${id}/1.jpg`, `${cdn}/${id}/2.jpg`], shipping: { cost: ship.cost, minDays: ship.min, maxDays: ship.max } });
    if (req.method === 'GET' && url.pathname === '/products') return res.end(JSON.stringify({ items: [product('P100')] }));
    const m = /^\/products\/(\w+)$/.exec(url.pathname);
    if (req.method === 'GET' && m) return res.end(JSON.stringify(product(m[1]!)));
    if (req.method === 'POST' && url.pathname === '/orders') {
      let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
        const j = JSON.parse(body) as { ref: string };
        const id = `ORD-${key}-${j.ref}`; orders.set(id, j);
        res.end(JSON.stringify({ id, status: 'pending' }));
      }); return;
    }
    res.statusCode = 404; res.end('{}');
  });
  return { server, seen, start: () => new Promise<void>((r) => server.listen(port, r)), stop: () => new Promise<void>((r) => server.close(() => r())) };
}

const mapping = (base: string, warehouse: string) => ({
  baseUrl: base, auth: { type: 'bearer' }, currency: 'USD', warehouseCountry: warehouse,
  endpoints: {
    search: { path: '/products', query: { q: '{query}' } },
    product: { path: '/products/{id}' },
    quote: { path: '/products/{id}', query: { country: '{country}', qty: '{qty}' } },
    createOrder: { method: 'POST', path: '/orders', body: { ref: '{idempotencyKey}', sku: '{sku}', qty: '{qty}', to: '{address.fullName}' } },
    order: { path: '/orders/{id}' },
  },
});

let ctx: Ctx; let admin: Client; let startApiClient: () => Client;
const A = fakeSupplier('keyA', 'https://cdn.supplier-a.example', 47811, { cost: 3.5, min: 6, max: 10 });
const B = fakeSupplier('keyB', 'https://img.supplier-b.example', 47812, { cost: 2.5, min: 4, max: 7 });
beforeAll(async () => {
  await A.start(); await B.start();
  ctx = await testCtx('multisup');
  await runSeed(ctx, { withHistory: false });
  const { client } = await startApi(ctx);
  startApiClient = client;
  admin = client();
  expect((await admin.post('/api/v1/auth/admin/login', { email: 'owner@orvia.test', password: 'Orvia-Demo-2026!' })).status).toBe(200);
}, 180_000);
afterAll(async () => { await A.stop(); await B.stop(); await closeCtx(); });

describe('different suppliers for different countries', () => {
  let productId = '';
  let supA = ''; let supB = '';

  it('onboards two REST suppliers with their own keys and countries; secrets are never returned', async () => {
    const a = await admin.post('/api/v1/admin/suppliers', { code: 'north-america-supply', name: 'North America Supply', provider: 'rest', servesCountries: ['US', 'CA'], country: 'US', priority: 10, credentials: { apiKey: 'keyA' }, config: mapping('http://localhost:47811', 'US') });
    expect(a.status).toBe(201);
    const b = await admin.post('/api/v1/admin/suppliers', { code: 'india-supply', name: 'India Supply', provider: 'rest', servesCountries: ['IN'], country: 'IN', priority: 10, credentials: { apiKey: 'keyB' }, config: mapping('http://localhost:47812', 'IN') });
    expect(b.status).toBe(201);
    supA = a.body.id; supB = b.body.id;
    const bad = await admin.post('/api/v1/admin/suppliers', { code: 'broken-supply', name: 'Broken', provider: 'rest', servesCountries: ['US'], credentials: { apiKey: 'xxxx' }, config: { baseUrl: 'not a url' } });
    expect(bad.status).toBe(422);
    const list = await admin.get('/api/v1/admin/suppliers');
    expect(JSON.stringify(list.body)).not.toMatch(/keyA|keyB|credentialsEnc/);
    const row = list.body.items.find((i: { code: string }) => i.code === 'india-supply');
    expect(row).toMatchObject({ servesCountries: ['IN'], credentialsSet: true, mappingSet: true });
    expect((await admin.post(`/api/v1/admin/suppliers/${supA}/check`)).body.apiStatus).toBe('ok');
    expect((await Supplier.findById(supA).select('+credentialsEnc').lean())!.credentialsEnc).not.toContain('keyA'); // encrypted at rest
  });

  it("imports from supplier A (photos from A's CDN) and links the same product to supplier B for India", async () => {
    const cat = await admin.get(`/api/v1/admin/suppliers/${supA}/catalog?q=bowl`);
    expect(cat.body.items[0].image).toBe('https://cdn.supplier-a.example/P100/1.jpg');
    const imp = await admin.post('/api/v1/admin/products/import', { supplierId: supA, externalId: 'P100' });
    expect(imp.status).toBe(201);
    productId = imp.body.productId;
    const link = await admin.post(`/api/v1/admin/products/${productId}/link-supplier`, { supplierId: supB, externalId: 'P100' });
    expect(link.status).toBe(200);
    expect(link.body.images).toBe(2);
    await syncProductOffers(ctx, productId);
    await refreshProductMarkets(ctx, productId);
    invalidateSearchIndex();
  });

  it('each country is served only by its own suppliers, and shows that supplier\'s photos', async () => {
    const offers = await SupplierOffer.find({ productId }).lean();
    const by = (id: string) => offers.filter((o) => String(o.supplierId) === id).map((o) => o.destination).sort();
    expect(by(supA)).toEqual(['CA', 'US']);
    expect(by(supB)).toEqual(['IN']);
    const p = await Product.findById(productId).lean();
    const img = (c: string) => p!.markets.find((m) => m.country === c)?.images?.[0];
    expect(img('US')).toBe('https://cdn.supplier-a.example/P100/1.jpg');
    expect(img('IN')).toBe('https://img.supplier-b.example/P100/1.jpg');
    expect(String(p!.markets.find((m) => m.country === 'IN')!.bestSupplierId)).toBe(supB);
    expect(String(p!.markets.find((m) => m.country === 'US')!.bestSupplierId)).toBe(supA);
  });

  it('keys are per supplier: a wrong key fails only that supplier', async () => {
    await Supplier.updateOne({ _id: supB }, { $set: { apiStatus: 'ok' } });
    const r = await admin.patch(`/api/v1/admin/suppliers/${supB}`, { credentials: { apiKey: 'wrong-key' } });
    expect(r.status).toBe(200);
    expect((await admin.post(`/api/v1/admin/suppliers/${supB}/check`)).body.apiStatus).toBe('down');
    expect((await admin.post(`/api/v1/admin/suppliers/${supA}/check`)).body.apiStatus).toBe('ok');
    await admin.patch(`/api/v1/admin/suppliers/${supB}`, { credentials: { apiKey: 'keyB' } });
    expect((await admin.post(`/api/v1/admin/suppliers/${supB}/check`)).body.apiStatus).toBe('ok');
  });

  it('reports which suppliers cover each country', async () => {
    const list = await admin.get('/api/v1/admin/suppliers');
    const cov = (c: string) => list.body.coverage.find((x: { country: string }) => x.country === c).suppliers;
    expect(cov('IN')).toContain('india-supply');
    expect(cov('IN')).not.toContain('north-america-supply');
    expect(cov('US')).toContain('north-america-supply');
  });

  it('routes each order to the supplier that serves the destination, using that supplier\'s own key', async () => {
    const pub = await admin.post(`/api/v1/admin/products/${productId}/publish`, {});
    expect(pub.status).toBe(200);
    // price comfortably above landed cost so the negative-margin guard doesn't hold these test orders
    await Product.updateOne({ _id: productId }, { $set: { 'markets.$[].price': 400000, 'markets.$[].compareAtPrice': 0 } });
    invalidateSearchIndex();
    const p = await Product.findById(productId).lean();
    const slug = p!.slug;
    for (const [country, sup, other] of [['IN', B, A], ['US', A, B]] as const) {
      const before = sup.seen.filter((x) => x === 'POST /orders').length;
      const otherBefore = other.seen.filter((x) => x === 'POST /orders').length;
      const c = startApiClient();
      const { co } = await placeOrder(c, { country, products: [{ id: productId, slug }] });
      expect(co.status).toBe(201);
      await pay(c, co.body.payment.intentId);
      await ctx.queue.drain(40);
      expect(sup.seen.filter((x) => x === 'POST /orders').length).toBe(before + 1);
      expect(other.seen.filter((x) => x === 'POST /orders').length).toBe(otherBefore);
    }
  });
});
