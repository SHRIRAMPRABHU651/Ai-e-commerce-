/**
 * customer360 integration tests (Mongo-backed). NOT executed in the authoring sandbox (no MongoDB binary); they run in CI.
 * Covers: ownership/IDOR on every customer route, consent + canContact, LifeGraph guard + recommendation boost,
 * memory switches/retention, export, staff audit + PII masking, deletion flow with anonymization.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog, C360DeletionRequest, C360LifeNode, C360Memory, Order, User } from '@orvia/database';
import { SYSTEM, canContactUser, createStaffUser, customer360Sweep, saveMemoryItem } from '@orvia/core';
import type { Ctx } from '@orvia/core';
import { closeCtx, testCtx } from '../helpers/ctx';
import { startApi } from '../helpers/client';
import type { Client } from '../helpers/client';
import { pay, placeOrder } from '../helpers/shop';

let ctx: Ctx;
let mk: (h?: Record<string, string>) => Client;
beforeAll(async () => {
  ctx = await testCtx('c360');
  mk = (await startApi(ctx)).client;
  for (const role of ['SUPPORT', 'ADMIN', 'MARKETING'] as const) await createStaffUser(ctx, { email: `${role.toLowerCase()}@c360.test`, name: role, password: 'Str0ngPassw0rd!', role }, SYSTEM);
}, 120_000);
afterAll(closeCtx);

const customer = async (email: string) => {
  const c = mk();
  const r = await c.post('/api/v1/auth/register', { email, password: 'Sup3rSecretPass', name: 'Test Person' });
  expect(r.status).toBe(201);
  return { c, id: (await User.findOne({ email }))!.id as string };
};
const staff = async (role: string) => {
  const c = mk();
  expect((await c.post('/api/v1/auth/admin/login', { email: `${role}@c360.test`, password: 'Str0ngPassw0rd!' })).status).toBe(200);
  return c;
};

describe('authentication on every customer route', () => {
  const routes: [string, string][] = [
    ['GET', '/api/v1/account/privacy'], ['GET', '/api/v1/account/privacy/export'], ['GET', '/api/v1/account/privacy/deletion'], ['GET', '/api/v1/account/preferences'],
    ['GET', '/api/v1/account/lifegraph'], ['GET', '/api/v1/account/lifegraph/export'], ['GET', '/api/v1/account/recommendations'], ['GET', '/api/v1/account/memory'], ['GET', '/api/v1/account/memory/export'],
    ['GET', '/api/v1/account/products'], ['GET', '/api/v1/account/aftercare'], ['DELETE', '/api/v1/account/memory'], ['DELETE', '/api/v1/account/lifegraph'],
  ];
  it('rejects anonymous callers with 401', async () => {
    for (const [m, u] of routes) expect((await mk().req(m as 'GET', u)).status, `${m} ${u}`).toBe(401);
  });
  it('rejects customers on staff routes and the wrong staff permission', async () => {
    const { c } = await customer('perm@c360.test');
    expect((await c.get('/api/v1/admin/customer-360?q=perm')).status).toBe(403);
    const marketing = await staff('marketing'); // no customer360:* permission
    expect((await marketing.get('/api/v1/admin/customer-360?q=perm')).status).toBe(403);
  });
});

describe('ownership / IDOR', () => {
  it('cannot read or change another customer\'s LifeGraph node, memory item or companion', async () => {
    const a = await customer('idor-a@c360.test');
    const b = await customer('idor-b@c360.test');
    await a.c.put('/api/v1/account/lifegraph/settings', { enabled: true });
    const node = await a.c.post('/api/v1/account/lifegraph/nodes', { kind: 'pet_type', value: 'dog' });
    expect(node.status).toBe(201);
    const mem = await a.c.post('/api/v1/account/memory', { kind: 'note', title: 'secret note', payload: { text: 'x' } });
    expect(mem.status).toBe(201);
    expect((await b.c.del(`/api/v1/account/lifegraph/nodes/${node.body.id}`)).status).toBe(404);
    expect((await b.c.patch(`/api/v1/account/memory/${mem.body.id}`, { title: 'hacked' })).status).toBe(404);
    expect((await b.c.del(`/api/v1/account/memory/${mem.body.id}`)).status).toBe(404);
    expect(await C360LifeNode.countDocuments({ userId: a.id })).toBe(1);
    expect(await C360Memory.countDocuments({ userId: a.id, title: 'secret note' })).toBe(1);
    // B's list never contains A's rows; a malformed id is a 404, not a 500
    expect(JSON.stringify((await b.c.get('/api/v1/account/memory')).body)).not.toContain('secret note');
    expect((await b.c.del('/api/v1/account/memory/not-an-id')).status).toBe(404);
    // B cannot attach a node to A's parent node
    await b.c.put('/api/v1/account/lifegraph/settings', { enabled: true });
    const rec = await a.c.post('/api/v1/account/lifegraph/nodes', { kind: 'gift_recipient', value: 'parent' });
    expect((await b.c.post('/api/v1/account/lifegraph/nodes', { kind: 'gift_occasion', value: 'birthday', parentId: rec.body.id })).status).toBe(404);
  });
  it('companion pages are only visible to the order owner and only for delivered orders', async () => {
    const owner = await customer('own@c360.test');
    const other = await customer('other@c360.test');
    const { co } = await placeOrder(owner.c, { email: 'own@c360.test' });
    await pay(owner.c, co.body.payment.intentId);
    const order = (await Order.findOne({ orderNumber: co.body.order.orderNumber }))!;
    await Order.updateOne({ _id: order._id }, { $set: { userId: owner.id } });
    const itemId = `${order._id}_0`;
    expect((await owner.c.get(`/api/v1/account/products/${itemId}`)).status).toBe(404); // not delivered yet
    await Order.updateOne({ _id: order._id }, { $set: { status: 'DELIVERED', deliveredAt: new Date() } });
    const ok = await owner.c.get(`/api/v1/account/products/${itemId}`);
    expect(ok.status).toBe(200);
    expect(ok.body.related.label).toBe('Related products');
    expect(['provided', 'not_provided']).toContain(ok.body.companion.care.status);
    expect((await other.c.get(`/api/v1/account/products/${itemId}`)).status).toBe(404);
    expect((await owner.c.get(`/api/v1/account/products/${order._id}_99`)).status).toBe(404);
    expect((await owner.c.get('/api/v1/account/products/..%2Fetc')).status).toBe(404);
    expect(JSON.stringify((await other.c.get('/api/v1/account/products')).body)).not.toContain(String(order._id));
  });
});

describe('consent, preferences and canContact', () => {
  it('is opt-in, records versioned consent, and withdrawal wins', async () => {
    const u = await customer('consent@c360.test');
    expect(await canContactUser({ userId: u.id }, 'promotions', 'email')).toBe(false);
    const g = await u.c.put('/api/v1/account/privacy/consents/marketing_email', { granted: true });
    expect(g.status).toBe(200);
    expect(g.body.policyVersion).toMatch(/marketing-email/);
    expect(await canContactUser({ userId: u.id }, 'promotions', 'email')).toBe(false); // topic not opted in
    await u.c.put('/api/v1/account/preferences', { topics: { promotions: { email: true }, order_updates: { email: false } } });
    expect(await canContactUser({ userId: u.id }, 'promotions', 'email')).toBe(true);
    expect(await canContactUser({ userId: u.id }, 'order_updates', 'email')).toBe(true); // cannot be switched off
    await u.c.put('/api/v1/account/privacy/consents/marketing_email', { granted: false });
    expect(await canContactUser({ userId: u.id }, 'promotions', 'email')).toBe(false);
    const p = await u.c.get('/api/v1/account/privacy');
    expect(p.body.history.length).toBeGreaterThanOrEqual(2);
    expect((await u.c.put('/api/v1/account/privacy/consents/bogus', { granted: true })).status).toBe(404);
    expect((await u.c.put('/api/v1/account/preferences', { topics: { not_a_topic: { email: true } } })).status).toBe(400);
  });
});

describe('LifeGraph', () => {
  it('rejects sensitive attributes, needs the switch, and boosts recommendations only with consent', async () => {
    const u = await customer('lg@c360.test');
    expect((await u.c.post('/api/v1/account/lifegraph/nodes', { kind: 'pet_type', value: 'dog' })).status).toBe(409); // off by default
    await u.c.put('/api/v1/account/lifegraph/settings', { enabled: true });
    for (const bad of [{ kind: 'religion', value: 'x' }, { kind: 'health_condition', value: 'x' }, { kind: 'category_interest', value: 'diabetes-supplies' }, { kind: 'child_age_band', value: '7' }]) {
      expect((await u.c.post('/api/v1/account/lifegraph/nodes', bad)).status, JSON.stringify(bad)).toBe(422);
    }
    expect((await u.c.post('/api/v1/account/lifegraph/nodes', { kind: 'pet_type', value: 'dog' })).status).toBe(201);
    expect((await u.c.post('/api/v1/account/lifegraph/nodes', { kind: 'pet_type', value: 'dog' })).status).toBe(409);
    const off = await u.c.get('/api/v1/account/recommendations');
    expect(off.body.personalized).toBe(false); // no personalization consent yet
    await u.c.put('/api/v1/account/privacy/consents/personalization', { granted: true });
    const on = await u.c.get('/api/v1/account/recommendations');
    expect(on.status).toBe(200);
    expect(on.body.personalized).toBe(true);
    const exp = await u.c.get('/api/v1/account/lifegraph/export');
    expect(exp.headers['content-disposition']).toMatch(/attachment/);
    expect(exp.body.nodes).toHaveLength(1);
    expect((await u.c.del('/api/v1/account/lifegraph')).body.removed).toBe(1);
    expect(await C360LifeNode.countDocuments({ userId: u.id })).toBe(0);
  });
});

describe('Commerce Memory', () => {
  it('honors the global switch, retention and saveMemoryItem for other workstreams', async () => {
    const u = await customer('mem@c360.test');
    expect((await saveMemoryItem(ctx, u.id, { kind: 'comparison', title: 'Compare A vs B', payload: { ids: ['a', 'b'] } }, 'find')).saved).toBe(true);
    await u.c.put('/api/v1/account/memory/settings', { enabled: false });
    expect(await saveMemoryItem(ctx, u.id, { kind: 'note', title: 'x' })).toEqual({ saved: false, reason: 'memory_off' });
    expect((await u.c.post('/api/v1/account/memory', { kind: 'note', title: 'x' })).status).toBe(409);
    await u.c.put('/api/v1/account/memory/settings', { enabled: true, retentionDays: 30 });
    const list = await u.c.get('/api/v1/account/memory');
    expect(list.body.items[0].expiresAt).toBeTruthy();
    await C360Memory.updateMany({ userId: u.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await customer360Sweep(ctx)).memoryExpired).toBeGreaterThanOrEqual(1);
    expect((await u.c.get('/api/v1/account/memory')).body.total).toBe(0);
  });
});

describe('export', () => {
  it('returns a machine-readable file with every section and no secrets', async () => {
    const u = await customer('export@c360.test');
    const r = await u.c.get('/api/v1/account/privacy/export');
    expect(r.status).toBe(200);
    expect(r.headers['content-disposition']).toMatch(/attachment/);
    expect(r.body.schema).toBe('orvia.data-export.v1');
    for (const k of ['account', 'orders', 'consents', 'lifeGraph', 'commerceMemory', 'loyalty']) expect(r.body).toHaveProperty(k);
    expect(r.raw).not.toMatch(/passwordHash|resetTokenHash|clientSecret/);
  });
});

describe('staff Customer 360: masking, audit, notes', () => {
  it('masks PII, audits every view, gates reveal, notes and consent withdrawal', async () => {
    const u = await customer('staffview@c360.test');
    await u.c.put('/api/v1/account/privacy/consents/marketing_email', { granted: true });
    const support = await staff('support');
    const admin = await staff('admin');
    const s = await support.get('/api/v1/admin/customer-360?q=staffview');
    expect(s.status).toBe(200);
    expect(s.body.items[0].email).not.toContain('staffview');
    expect((await support.get('/api/v1/admin/customer-360?q=x')).status).toBe(400); // too short
    const before = await AuditLog.countDocuments({ action: 'customer360.view', resourceId: u.id });
    const v = await support.get(`/api/v1/admin/customer-360/${u.id}`);
    expect(v.status).toBe(200);
    expect(v.body.identity.email).not.toContain('staffview');
    expect(JSON.stringify(v.body)).not.toMatch(/passwordHash|cardNumber/);
    expect(await AuditLog.countDocuments({ action: 'customer360.view', resourceId: u.id })).toBe(before + 1);
    // support has customer360:read only
    expect((await support.get(`/api/v1/admin/customer-360/${u.id}?reveal=email&reason=ticket%20123`)).status).toBe(403);
    expect((await support.post(`/api/v1/admin/customer-360/${u.id}/notes`, { body: 'hi' })).status).toBe(403);
    expect((await admin.get(`/api/v1/admin/customer-360/${u.id}?reveal=email`)).status).toBe(400); // reason required
    const rv = await admin.get(`/api/v1/admin/customer-360/${u.id}?reveal=email&reason=verifying%20ticket%20123`);
    expect(rv.body.identity.email).toBe('staffview@c360.test');
    expect(await AuditLog.countDocuments({ action: 'customer360.pii_reveal', resourceId: u.id })).toBe(1);
    expect((await admin.post(`/api/v1/admin/customer-360/${u.id}/notes`, { body: 'Called about delivery' })).status).toBe(201);
    expect(await AuditLog.countDocuments({ action: 'customer360.note_added', resourceId: u.id })).toBe(1);
    const w = await admin.post(`/api/v1/admin/customer-360/${u.id}/consents/withdraw`, { kind: 'marketing_email', reason: 'Customer asked by phone' });
    expect(w.status).toBe(200);
    expect(await canContactUser({ userId: u.id }, 'promotions', 'email')).toBe(false);
    expect(await AuditLog.countDocuments({ action: 'customer360.consent.changed', resourceId: u.id })).toBeGreaterThanOrEqual(2);
    expect((await admin.get('/api/v1/admin/customer-360/not-an-id')).status).toBe(404);
  });
});

describe('account deletion workflow', () => {
  it('request -> cooling-off -> staff execute -> anonymized, financial record retained, audited', async () => {
    const u = await customer('delete-me@c360.test');
    const { co } = await placeOrder(u.c, { email: 'delete-me@c360.test' });
    await pay(u.c, co.body.payment.intentId);
    const order = (await Order.findOne({ orderNumber: co.body.order.orderNumber }))!;
    await Order.updateOne({ _id: order._id }, { $set: { userId: u.id } });
    const total = order.amounts!.total;
    await u.c.post('/api/v1/account/memory', { kind: 'note', title: 'mine' });

    expect((await u.c.post('/api/v1/account/privacy/deletion', { confirm: false })).status).toBe(400);
    const req = await u.c.post('/api/v1/account/privacy/deletion', { confirm: true, reason: 'leaving' });
    expect(req.status).toBe(201);
    expect((await u.c.post('/api/v1/account/privacy/deletion', { confirm: true })).status).toBe(409); // already open
    const admin = await staff('admin');
    const dr = await C360DeletionRequest.findOne({ userId: u.id });
    // cooling-off blocks execution
    const early = await admin.post(`/api/v1/admin/customer-360/deletion-requests/${dr!._id}/process`, { action: 'execute', note: 'try early' });
    expect(early.status).toBe(409);
    expect((await (await staff('support')).post(`/api/v1/admin/customer-360/deletion-requests/${dr!._id}/process`, { action: 'execute', note: 'nope nope' })).status).toBe(403);
    // customer may cancel, then re-request
    expect((await u.c.del('/api/v1/account/privacy/deletion')).status).toBe(200);
    await u.c.post('/api/v1/account/privacy/deletion', { confirm: true });
    const dr2 = (await C360DeletionRequest.findOne({ userId: u.id, status: 'requested' }))!;
    await C360DeletionRequest.updateOne({ _id: dr2._id }, { $set: { requestedAt: new Date(Date.now() - 20 * 86_400_000), coolingOffUntil: new Date(Date.now() - 86_400_000) } });
    const done = await admin.post(`/api/v1/admin/customer-360/deletion-requests/${dr2._id}/process`, { action: 'execute', note: 'cooling-off elapsed' });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('completed');
    const user = (await User.findById(u.id))!;
    expect(user.email).toMatch(/@anonymized\.invalid$/);
    expect(user.name).toBe('Deleted customer');
    const kept = (await Order.findById(order._id))!;
    expect(kept.email).toMatch(/@anonymized\.invalid$/);
    expect(kept.address).toBeFalsy();
    expect(kept.amounts!.total).toBe(total); // financial record retained
    expect(await C360Memory.countDocuments({ userId: u.id })).toBe(0);
    expect(await AuditLog.countDocuments({ action: 'customer360.deletion.anonymized', resourceId: u.id })).toBe(1);
    expect((await mk().post('/api/v1/auth/login', { email: 'delete-me@c360.test', password: 'Sup3rSecretPass' })).status).toBeGreaterThanOrEqual(400);
    expect(await canContactUser({ userId: u.id }, 'order_updates', 'email')).toBe(false);
    // executing twice is rejected
    expect((await admin.post(`/api/v1/admin/customer-360/deletion-requests/${dr2._id}/process`, { action: 'execute', note: 'again please' })).status).toBe(409);
  });
});
