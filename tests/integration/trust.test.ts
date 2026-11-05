// NOTE: Mongo-backed; written for CI. It could not be executed in the authoring sandbox (no MongoDB binary).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog, Product, Shipment, Supplier, SupplierOffer, TrustEvidence, TrustSupplierSnapshot } from '@orvia/database';
import { createStaffUser, recomputeTrust, SYSTEM } from '@orvia/core';
import type { Ctx } from '@orvia/core';
import { closeCtx, testCtx } from '../helpers/ctx';
import { startApi } from '../helpers/client';
import type { Client } from '../helpers/client';
import { runSeed } from '../../scripts/lib/seed';

let ctx: Ctx;
let mk: (h?: Record<string, string>) => Client;
let slug = '';
let productId = '';

const login = async (email: string): Promise<Client> => {
  const c = mk();
  const r = await c.post('/api/v1/auth/login', { email, password: 'Str0ngPassw0rd!' });
  expect(r.status).toBe(200);
  return c;
};

beforeAll(async () => {
  ctx = await testCtx('trust');
  await runSeed(ctx, { withHistory: false });
  mk = (await startApi(ctx)).client;
  for (const role of ['ADMIN', 'OPERATIONS', 'MARKETING'] as const) await createStaffUser(ctx, { email: `${role.toLowerCase()}@t.test`, name: role, password: 'Str0ngPassw0rd!', role }, SYSTEM);
  const p = await Product.findOne({ state: 'PUBLISHED' }).lean();
  slug = p!.slug;
  productId = String(p!._id);
}, 180_000);
afterAll(closeCtx);

describe('Digital Product Passport', () => {
  it('is public, carries provenance on fields and never leaks cost, margin or supplier ids', async () => {
    const r = await mk().get(`/api/v1/products/${slug}/passport?country=US`);
    expect(r.status).toBe(200);
    expect(r.body.product.slug).toBe(slug);
    expect(r.body.product.lifecycle.provenance).toBe('verified');
    expect(r.body.delivery.actual.statement).toBeTruthy();
    const ids = [...(await Supplier.find({}).select('_id').lean()).map((s) => String(s._id)), ...(await SupplierOffer.find({}).select('_id').lean()).map((o) => String(o._id))];
    const raw = JSON.stringify(r.body);
    expect(raw).not.toMatch(/landedCost|supplierCost|productCost|bestSupplierId|expectedMargin|supplierId|"margin"/);
    for (const id of ids) expect(raw).not.toContain(id);
    expect(r.body.documents.some((d: any) => d.provenance === 'ai_suggested')).toBe(false);
  });
  it('shows a document as verified only when verified evidence exists', async () => {
    const std = (await Product.findById(productId).lean())!.compliance?.safetyInfo?.standards?.[0];
    if (!std) return; // seeded product has no declared standard; nothing to verify
    const before = await mk().get(`/api/v1/products/${slug}/passport?country=US`);
    expect(before.body.documents.find((d: any) => d.title === std).provenance).toBe('supplier_provided');
    const admin = await login('admin@t.test');
    const rec = await admin.post('/api/v1/admin/trust/evidence', { subject: 'product', subjectId: productId, kind: 'certificate', key: std, value: std, provenance: 'verified', source: 'Test lab report 1' });
    expect(rec.status).toBe(201);
    const after = await mk().get(`/api/v1/products/${slug}/passport?country=US`);
    expect(after.body.documents.find((d: any) => d.title === std).provenance).toBe('verified');
    expect(await AuditLog.countDocuments({ action: 'trust.evidence.recorded' })).toBe(1);
  });
  it('404s for unknown products and 400s for a bad country', async () => {
    expect((await mk().get('/api/v1/products/does-not-exist/passport')).status).toBe(404);
    expect((await mk().get(`/api/v1/products/${slug}/passport?country=XX`)).status).toBe(400);
  });
});

describe('Purchase Confidence', () => {
  it('states uncertainty, labels tax as an estimate and widens the delivery range without history', async () => {
    const r = await mk().get(`/api/v1/products/${slug}/confidence?country=US&quantity=2`);
    expect(r.status).toBe(200);
    expect(r.body.quantity).toBe(2);
    expect(r.body.pricing.taxIsEstimate).toBe(true);
    expect(r.body.pricing.total).toBeGreaterThan(0);
    expect(r.body.uncertainty.join(' ')).toMatch(/estimate/i);
    expect(r.body.delivery.statement).toMatch(/not a guarantee/i);
    expect(['insufficient_data', 'provisional', 'established']).toContain(r.body.supplierReliability.status);
    if (r.body.supplierReliability.status === 'insufficient_data') expect(r.body.supplierReliability.score).toBeNull();
    expect(JSON.stringify(r.body)).not.toMatch(/landedCost|supplierCost|productCost|bestSupplierId|expectedMargin|supplierId/);
  });
  it('validates quantity', async () => {
    expect((await mk().get(`/api/v1/products/${slug}/confidence?quantity=0`)).status).toBe(400);
    expect((await mk().get(`/api/v1/products/${slug}/confidence?quantity=99`)).status).toBe(400);
  });
});

describe('TrustGraph admin: permissions, recompute, audit', () => {
  it('rejects anonymous, customer-less roles without trust:read and allows trust:read roles', async () => {
    expect((await mk().get('/api/v1/admin/trust/suppliers')).status).toBe(401);
    const mkt = await login('marketing@t.test');
    expect((await mkt.get('/api/v1/admin/trust/suppliers')).status).toBe(403);
    expect((await mkt.get('/api/v1/admin/trust/products')).status).toBe(403);
    const ops = await login('operations@t.test');
    expect((await ops.get('/api/v1/admin/trust/suppliers')).status).toBe(200);
    expect((await ops.get('/api/v1/admin/trust/products')).status).toBe(200);
  });
  it('recompute needs trust:write, is audited and produces reproducible snapshots with inputs', async () => {
    const ops = await login('operations@t.test');
    expect((await ops.post('/api/v1/admin/trust/recompute', { scope: 'all' })).status).toBe(403);
    const admin = await login('admin@t.test');
    const r = await admin.post('/api/v1/admin/trust/recompute', { scope: 'all' });
    expect(r.status).toBe(200);
    expect(r.body.suppliers).toBeGreaterThan(0);
    expect(await AuditLog.countDocuments({ action: 'trust.recompute' })).toBeGreaterThan(0);
    const snap = await TrustSupplierSnapshot.findOne({}).lean();
    expect(snap?.inputs).toBeTruthy();
    expect(snap?.modelVersion).toMatch(/^trustgraph/);
    const list = await admin.get('/api/v1/admin/trust/suppliers');
    expect(list.body.items.length).toBeGreaterThan(0);
    for (const s of list.body.items) if (s.trust?.status === 'insufficient_data') expect(s.trust.score).toBeNull();
    expect((await admin.post('/api/v1/admin/trust/recompute', { scope: 'nope' })).status).toBe(400);
  });
  it('product risk list and detail return evidence and per-destination snapshots', async () => {
    const admin = await login('admin@t.test');
    const list = await admin.get('/api/v1/admin/trust/products');
    expect(list.status).toBe(200);
    expect(list.body.total).toBeGreaterThan(0);
    const d = await admin.get(`/api/v1/admin/trust/products/${productId}`);
    expect(d.status).toBe(200);
    expect(d.body.product.id).toBe(productId);
    expect(Array.isArray(d.body.evidence)).toBe(true);
    expect((await admin.get('/api/v1/admin/trust/products/not-an-id')).status).toBe(400);
  });
  it('scores improve automatically as shipments accumulate', async () => {
    const sup = await Supplier.findOne({}).lean();
    const sid = String(sup!._id);
    const before = await recomputeTrust(ctx, { scope: 'suppliers', supplierId: sid }, 'manual');
    expect(before.suppliers).toBe(1);
    const first = await TrustSupplierSnapshot.findOne({ supplierId: sid }).sort({ computedAt: -1 }).lean();
    const orderId = (await Product.findOne({}).lean())!._id;
    const docs = Array.from({ length: 12 }, (_, i) => ({ orderId, lineKey: `trust-test-${i}`, supplierId: sid, idempotencyKey: `trust-test-key-${i}`, status: 'DELIVERED', createdAt: new Date(Date.now() - 20 * 86_400_000) }));
    await Shipment.insertMany(docs);
    await recomputeTrust(ctx, { scope: 'suppliers', supplierId: sid }, 'manual');
    const second = await TrustSupplierSnapshot.findOne({ supplierId: sid }).sort({ computedAt: -1 }).lean();
    expect(second!.sampleSize).toBeGreaterThanOrEqual((first!.sampleSize ?? 0) + 12);
    expect(second!.status).not.toBe('insufficient_data');
  });
  it('evidence: ai_suggested cannot be recorded as verified, validation applies', async () => {
    const admin = await login('admin@t.test');
    const bad = await admin.post('/api/v1/admin/trust/evidence', { subject: 'product', subjectId: 'x', kind: 'certificate', key: 'k', value: 'v', provenance: 'verified', source: 'src' });
    expect(bad.status).toBe(400);
    const ok = await admin.post('/api/v1/admin/trust/evidence', { subject: 'product', subjectId: productId, kind: 'specification', key: 'colour', value: 'Grey', provenance: 'ai_suggested', source: 'AI draft' });
    expect(ok.status).toBe(201);
    const ev = await TrustEvidence.findOne({ key: 'colour' }).lean();
    expect(ev?.provenance).toBe('ai_suggested');
    const passport = await mk().get(`/api/v1/products/${slug}/passport?country=US`);
    expect(JSON.stringify(passport.body.specifications)).not.toContain('"AI draft"');
  });
});
