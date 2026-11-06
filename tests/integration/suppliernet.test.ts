import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '@orvia/auth';
import { Shipment, Supplier, SuppliernetCatalogItem, SuppliernetDispute, SuppliernetStatement, User } from '@orvia/database';
import { openDispute } from '@orvia/core';
import type { Ctx } from '@orvia/core';
import { Types } from 'mongoose';
import { closeCtx, testCtx } from '../helpers/ctx';
import { Client, startApi } from '../helpers/client';
import { runSeed } from '../../scripts/lib/seed';

const FEED = 'sku,name,price,qty,ean\nF1,Feed Bowl,12.50,40,4006381333931\nF2,Feed Mug,5.00,3,\n';
let feedServer: Server;
let ctx: Ctx; let admin: Client; let mk: () => Client;
let supA = ''; let supB = ''; let a: Client; let b: Client;
const PASS = 'Supplier-Pass-1!';
const oid = () => new Types.ObjectId();

async function invite(code: string, email: string, provider = 'manual') {
  const r = await admin.post('/api/v1/admin/supplier-network/suppliers', { code, name: `Supplier ${code}`, email, supplierType: 'wholesaler', provider, servesCountries: ['US'] });
  expect(r.status).toBe(201);
  await User.updateOne({ email }, { $set: { passwordHash: await hashPassword(PASS, { fast: true }) } });
  const c = mk();
  expect((await c.post('/api/v1/auth/login', { email, password: PASS })).status).toBe(200);
  return { id: r.body.supplierId as string, client: c };
}

beforeAll(async () => {
  feedServer = createServer((_req, res) => { res.setHeader('content-type', 'text/csv'); res.end(FEED); });
  await new Promise<void>((r) => feedServer.listen(47821, r));
  ctx = await testCtx('suppliernet', { ALLOW_PRIVATE_FETCH: 'true' });
  await runSeed(ctx, { withHistory: false });
  const { client } = await startApi(ctx);
  mk = client;
  admin = client();
  expect((await admin.post('/api/v1/auth/admin/login', { email: 'owner@orvia.test', password: 'Orvia-Demo-2026!' })).status).toBe(200);
  ({ id: supA, client: a } = await invite('supplier-a', 'a@supplier-a.test'));
  ({ id: supB, client: b } = await invite('supplier-b', 'b@supplier-b.test'));
}, 180_000);
afterAll(async () => { await new Promise((r) => feedServer.close(r)); await closeCtx(); });

describe('role separation', () => {
  it('supplier users cannot use staff routes and staff cannot use the portal', async () => {
    expect((await a.get('/api/v1/admin/supplier-network/overview')).status).toBe(403);
    expect((await a.get('/api/v1/admin/orders')).status).toBe(403);
    expect((await a.post('/api/v1/auth/admin/login', { email: 'a@supplier-a.test', password: PASS })).status).toBe(401);
    expect((await admin.get('/api/v1/supplier/dashboard')).status).toBe(403);
    expect((await mk().get('/api/v1/supplier/dashboard')).status).toBe(401);
  });
  it('invited suppliers start at "invited", inactive and never production ready', async () => {
    const s = await Supplier.findById(supA).lean();
    expect(s).toMatchObject({ active: false, network: { state: 'invited', productionReady: false } });
    expect(JSON.stringify((await admin.get(`/api/v1/admin/supplier-network/suppliers/${supA}`)).body)).not.toMatch(/credentialsEnc|passwordHash/);
  });
});

describe('tenant isolation (cross-supplier IDOR attempts)', () => {
  let shipA = ''; let shipB = ''; let docB = ''; let dispB = '';
  beforeAll(async () => {
    const mkShip = async (supplierId: string, n: string) => String((await Shipment.create({ orderId: oid(), lineKey: `L-${n}`, supplierId, idempotencyKey: `idem-${n}`, status: 'CREATED', supplierOrderId: `SO-${n}`, quantity: 1, cost: { productCost: 1000, shippingCost: 200, duties: 0, currency: 'USD' } }))._id);
    shipA = await mkShip(supA, 'A'); shipB = await mkShip(supB, 'B');
    dispB = String((await openDispute(ctx, { supplierId: supB, type: 'late', amountMinor: 100, currency: 'USD', summary: 'late delivery for order B' }, { id: 'system', type: 'system' }))._id);
    const up = await admin.upload(`/api/v1/admin/supplier-network/suppliers/${supB}/documents`, { filename: 'reg.pdf', mimetype: 'application/pdf', buffer: Buffer.from('%PDF-1.4 test') }, { kind: 'business_registration', title: 'Registration B' });
    expect(up.status).toBe(201);
    docB = up.body.id;
  });

  it('lists only the caller’s own orders', async () => {
    const r = await a.get('/api/v1/supplier/orders');
    expect(r.status).toBe(200);
    expect(r.body.items.map((i: { shipmentId: string }) => i.shipmentId)).toEqual([shipA]);
    expect(JSON.stringify(r.body)).not.toContain(shipB);
  });
  it('cannot select another supplier by id (404, same as a non-existent id)', async () => {
    expect((await a.get(`/api/v1/supplier/dashboard?supplierId=${supB}`)).status).toBe(404);
    expect((await a.get(`/api/v1/supplier/orders?supplierId=${supB}`)).status).toBe(404);
    expect((await a.get(`/api/v1/supplier/dashboard?supplierId=${oid()}`)).status).toBe(404);
  });
  it('cannot ship, read documents of, or respond to disputes of another supplier', async () => {
    expect((await a.post(`/api/v1/supplier/shipments/${shipB}/ship`, { trackingNumber: 'TRACK12345', carrier: 'DHL' })).status).toBe(404);
    expect((await a.post(`/api/v1/supplier/shipments/${shipB}/ship`, { supplierId: supB, trackingNumber: 'TRACK12345', carrier: 'DHL' })).status).toBe(404);
    expect((await Shipment.findById(shipB).lean())!.status).toBe('CREATED');
    expect((await a.get(`/api/v1/supplier/documents/${docB}/file`)).status).toBe(404);
    expect((await a.get(`/api/v1/supplier/documents/${docB}/file?supplierId=${supB}`)).status).toBe(404);
    expect((await a.post(`/api/v1/supplier/disputes/${dispB}/respond`, { note: 'not mine to answer' })).status).toBe(404);
    expect((await SuppliernetDispute.findById(dispB).lean())!.evidence).toHaveLength(0);
    expect((await a.get('/api/v1/supplier/documents')).body.items).toHaveLength(0);
    expect((await a.get('/api/v1/supplier/disputes')).body.items).toHaveLength(0);
    expect((await b.get('/api/v1/supplier/disputes')).body.items).toHaveLength(1);
  });
  it('B sees B’s document; the file is served with attachment + nosniff', async () => {
    const r = await b.get(`/api/v1/supplier/documents/${docB}/file`);
    expect(r.status).toBe(200);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(String(r.headers['content-disposition'])).toMatch(/attachment/);
  });
  it('validates tracking numbers and lets a supplier ship its own order', async () => {
    expect((await a.post(`/api/v1/supplier/shipments/${shipA}/ship`, { trackingNumber: '<script>', carrier: 'DHL' })).status).toBeGreaterThanOrEqual(400);
    expect((await a.post(`/api/v1/supplier/shipments/${shipA}/ship`, { trackingNumber: 'ab cd ef gh', carrier: 'DHL' })).status).toBe(422);
    const ok = await a.post(`/api/v1/supplier/shipments/${shipA}/ship`, { trackingNumber: '1Z999AA10123456784', carrier: 'UPS' });
    expect(ok.status).toBe(200);
    expect(await Shipment.findById(shipA).lean()).toMatchObject({ status: 'SHIPPED', trackingNumber: '1Z999AA10123456784' });
  });
  it('statements are tenant-scoped and reconciled against recorded supplier order costs', async () => {
    const csv = 'supplier_order_id,amount\nSO-A,12.00\nSO-X,3.00\n';
    const r = await a.post('/api/v1/supplier/statements', { number: 'STM-1', currency: 'USD', csv });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('discrepancies');
    const st = await SuppliernetStatement.findOne({ supplierId: supA, number: 'STM-1' }).lean();
    expect(st!.lines.map((l) => l.match)).toEqual(['matched', 'unknown_order']);
    expect((await b.get('/api/v1/supplier/statements')).body.items).toHaveLength(0);
    expect((await a.get('/api/v1/supplier/statements')).body.items).toHaveLength(1);
    // record-only settlement is refused while differences are unresolved
    expect((await admin.post(`/api/v1/admin/supplier-network/statements/${st!._id}/settle`, { reference: 'WIRE-1', amountMinor: 1200 })).status).toBe(409);
    expect((await admin.post(`/api/v1/admin/supplier-network/statements/${st!._id}/dispute`, { summary: 'Unknown order SO-X billed' })).status).toBe(200);
  });
  it('supplier cannot grant itself access or read internals', async () => {
    expect((await a.post(`/api/v1/admin/supplier-network/suppliers/${supA}/users`, { email: 'b@supplier-b.test' })).status).toBe(403);
    const dash = await a.get('/api/v1/supplier/dashboard');
    expect(JSON.stringify(dash.body)).not.toMatch(/credentialsEnc|passwordHash|reliability/);
  });
});

describe('verification gating', () => {
  it('manual attestation without a concrete reference is refused', async () => {
    const r = await admin.post(`/api/v1/admin/supplier-network/suppliers/${supA}/verification/catalogue_availability/attest`, { summary: 'The catalogue looked fine to me', outcome: 'pass' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('EVIDENCE_REQUIRED');
  });
  it('cannot enter probation or approval without passing, evidenced steps', async () => {
    const r = await admin.post(`/api/v1/admin/supplier-network/suppliers/${supA}/transition`, { to: 'probation' });
    expect(r.status).toBe(409);
    const v = await admin.get(`/api/v1/admin/supplier-network/suppliers/${supA}/verification`);
    expect(v.body.readiness.ready).toBe(false);
    expect((await Supplier.findById(supA).lean())!.network!.productionReady).toBe(false);
  });
  it('order-creating probes need typed confirmation (manual suppliers cannot be probed)', async () => {
    const r = await admin.post(`/api/v1/admin/supplier-network/suppliers/${supA}/verification/test_order_placement/probe`, {});
    expect([409, 422]).toContain(r.status);
  });
});

describe('feed adapter', () => {
  it('ingests a CSV feed through the SSRF-guarded fetcher; ordering is not possible', async () => {
    const f = await invite('feed-supplier', 'f@feed.test', 'feed');
    const cfg = { url: 'http://localhost:47821/feed.csv', format: 'csv', currency: 'USD', fields: { id: 'sku', title: 'name', price: 'price', stock: 'qty', gtin: 'ean' } };
    expect((await admin.put(`/api/v1/admin/supplier-network/suppliers/${f.id}/feed-config`, cfg)).status).toBe(200);
    const r = await admin.post(`/api/v1/admin/supplier-network/suppliers/${f.id}/ingest`, {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ seen: 2, created: 2 });
    expect(await SuppliernetCatalogItem.countDocuments({ supplierId: f.id, gtin: '04006381333931' })).toBe(1);
    const { providerFor } = await import('@orvia/core');
    const sup = await Supplier.findById(f.id);
    await expect((await providerFor(ctx, sup!)).createOrder({} as never)).rejects.toThrow(/read-only/);
  });
  it('a feed pointing at a private address is refused when private fetch is not allowed', async () => {
    const strict = await testCtx('suppliernet_strict');
    const { Supplier: S } = await import('@orvia/database');
    await S.create({ code: 'bad-feed', name: 'Bad', provider: 'feed', config: { url: 'http://127.0.0.1:47821/feed.csv', format: 'csv' } });
    const { providerFor } = await import('@orvia/core');
    const p = await providerFor(strict, (await S.findOne({ code: 'bad-feed' }))!);
    expect((await p.healthCheck()).ok).toBe(false);
  });
});

describe('production routing guard', () => {
  it('only approved + production_ready suppliers pass the guard when enforcement is on', async () => {
    const { supplierRoutable } = await import('@orvia/core');
    const strict = await testCtx('suppliernet_guard', { SUPPLIER_ENFORCE_VERIFICATION: 'true' });
    expect(supplierRoutable(strict, {}).ok).toBe(false);
    expect(supplierRoutable(strict, { network: { state: 'approved', productionReady: true, productionReadyUntil: new Date(Date.now() + 86_400_000) } }).ok).toBe(true);
    expect(supplierRoutable(ctx, {}).ok).toBe(true); // default outside production: unchanged
  });
});
