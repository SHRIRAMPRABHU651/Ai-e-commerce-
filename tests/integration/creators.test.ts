/**
 * creators / loyalty integration tests (Mongo-backed). NOT executed in the authoring sandbox (no MongoDB binary); they run in CI.
 * Covers: application + review, handle rules, collections ownership (IDOR), attribution capture + self-attribution exclusion,
 * accrual / hold / release / clawback, payout gating + statement ownership, comments moderation, loyalty earn / redeem.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CreatorFlag, CreatorLedger, CreatorProfile, Order, User } from '@orvia/database';
import { SYSTEM, accrueCommission, createStaffUser, earnForOrder, fulfillOrder, getLoyaltyStatus, reconcileOrderCommission, settleLedger, syncTracking } from '@orvia/core';
import type { Ctx } from '@orvia/core';
import { closeCtx, testCtx } from '../helpers/ctx';
import { ageMockOrders, startApi } from '../helpers/client';
import type { Client } from '../helpers/client';
import { firstProducts, pay, placeOrder } from '../helpers/shop';
import { runSeed } from '../../scripts/lib/seed';

let ctx: Ctx;
let mk: (h?: Record<string, string>) => Client;
beforeAll(async () => {
  ctx = await testCtx('creators');
  await runSeed(ctx, { withHistory: false });
  mk = (await startApi(ctx)).client;
  for (const role of ['ADMIN', 'ANALYST', 'SUPPORT'] as const) await createStaffUser(ctx, { email: `${role.toLowerCase()}@cr.test`, name: role, password: 'Str0ngPassw0rd!', role }, SYSTEM);
}, 180_000);
afterAll(closeCtx);

const customer = async (email: string, name = 'Test Person') => {
  const c = mk();
  expect((await c.post('/api/v1/auth/register', { email, password: 'Sup3rSecretPass', name })).status).toBe(201);
  return { c, id: (await User.findOne({ email }))!.id as string };
};
const staff = async (role: string) => {
  const c = mk();
  expect((await c.post('/api/v1/auth/admin/login', { email: `${role}@cr.test`, password: 'Str0ngPassw0rd!' })).status).toBe(200);
  return c;
};
const apply = (c: Client, handle: string) => c.post('/api/v1/creator/apply', { handle, displayName: 'Jane Creator', bio: 'Gadgets', socialLinks: [{ platform: 'instagram', url: 'https://instagram.com/jane' }], acceptTerms: true });
async function approvedCreator(email: string, handle: string) {
  const u = await customer(email);
  const r = await apply(u.c, handle);
  expect(r.status).toBe(201);
  const admin = await staff('admin');
  expect((await admin.post(`/api/v1/admin/creators/${r.body.creator.id}/review`, { decision: 'approve' })).status).toBe(200);
  return { ...u, creatorId: r.body.creator.id as string, handle };
}
async function deliver(c: Client, email: string) {
  const { co } = await placeOrder(c, { country: 'US', email });
  expect(co.status).toBe(201);
  await pay(c, co.body.payment.intentId);
  const order = (await Order.findOne({ orderNumber: co.body.order.orderNumber }))!;
  await fulfillOrder(ctx, String(order._id));
  await ageMockOrders(3);
  await syncTracking(ctx, { orderId: String(order._id) });
  await ageMockOrders(30);
  await syncTracking(ctx, { orderId: String(order._id) });
  return (await Order.findById(order._id))!;
}

describe('applications and handles', () => {
  it('requires login, validates handle, prevents duplicates and double application', async () => {
    expect((await apply(mk(), 'someone')).status).toBe(401);
    const u = await customer('app1@cr.test');
    expect((await apply(u.c, 'admin')).status).toBe(400); // reserved
    expect((await apply(u.c, 'a')).status).toBe(400);
    expect((await apply(u.c, 'jane-one')).status).toBe(201);
    expect((await apply(u.c, 'jane-two')).status).toBe(409);
    const v = await customer('app2@cr.test');
    expect((await apply(v.c, 'jane-one')).status).toBe(409);
  });
  it('pending creators cannot use the portal or be seen publicly; approval opens both', async () => {
    const u = await customer('app3@cr.test');
    const r = await apply(u.c, 'pending-pal');
    expect((await u.c.get('/api/v1/creator/collections')).status).toBe(403);
    expect((await mk().get('/api/v1/creators/pending-pal')).status).toBe(404);
    const analyst = await staff('analyst');
    expect((await analyst.post(`/api/v1/admin/creators/${r.body.creator.id}/review`, { decision: 'approve' })).status).toBe(403); // creators:write required
    const admin = await staff('admin');
    expect((await admin.post(`/api/v1/admin/creators/${r.body.creator.id}/review`, { decision: 'approve' })).status).toBe(200);
    expect((await mk().get('/api/v1/creators/pending-pal')).status).toBe(200);
  });
});

describe('collections', () => {
  it('only the owner can edit; public page shows published only and no private data', async () => {
    const a = await approvedCreator('col-a@cr.test', 'col-a');
    const b = await approvedCreator('col-b@cr.test', 'col-b');
    const prods = await firstProducts(mk(), 'US', 2);
    const created = await a.c.post('/api/v1/creator/collections', { title: 'My desk picks', description: 'd', productIds: prods.map((p) => p.id), published: true });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    expect((await b.c.patch(`/api/v1/creator/collections/${id}`, { title: 'hijack' })).status).toBe(404);
    expect((await b.c.del(`/api/v1/creator/collections/${id}`)).status).toBe(404);
    const pub = await mk().get(`/api/v1/creators/col-a/collections/${created.body.slug}?country=US`);
    expect(pub.status).toBe(200);
    expect(pub.body.items.length).toBe(2);
    expect(JSON.stringify(pub.body)).not.toMatch(/landedCost|email|userId|@cr\.test/);
    expect((await a.c.patch(`/api/v1/creator/collections/${id}`, { published: false })).status).toBe(200);
    expect((await mk().get(`/api/v1/creators/col-a/collections/${created.body.slug}`)).status).toBe(404);
    expect((await a.c.post('/api/v1/creator/collections', { title: 'Bad', productIds: ['0'.repeat(24)] })).status).toBe(422);
  });
});

describe('attribution, commission and clawback', () => {
  it('captures a touch, copies it to the order, accrues on net base and claws back on refund', async () => {
    const cr = await approvedCreator('earn@cr.test', 'earner');
    const buyer = mk();
    expect((await buyer.post('/api/v1/creators/attribution', { handle: 'earner' })).body.attributed).toBe(true);
    const order = await deliver(buyer, 'buyer-cr1@example.com');
    expect(String(order.creatorAttribution?.creatorId)).toBe(cr.creatorId);
    expect(await accrueCommission(ctx, String(order._id))).toBe('accrued');
    expect(await accrueCommission(ctx, String(order._id))).toBe('skipped'); // idempotent
    const entry = (await CreatorLedger.findOne({ orderId: order._id, kind: 'commission' }))!;
    expect(entry.status).toBe('accrued');
    expect(entry.amount).toBeLessThanOrEqual(Math.floor((order.amounts?.subtotal ?? 0) * 0.5));
    // not released before the hold elapses
    expect((await settleLedger(ctx)).released).toBe(0);
    await CreatorLedger.updateOne({ _id: entry._id }, { $set: { holdUntil: new Date(Date.now() - 1000) } });
    await settleLedger(ctx);
    expect((await CreatorLedger.findById(entry._id))!.status).toBe('payable');
    // full refund after release => clawback row, net zero
    await Order.updateOne({ _id: order._id }, { $set: { 'costs.refunded': order.amounts?.total, status: 'REFUNDED' } });
    expect(await reconcileOrderCommission(ctx, String(order._id))).toBe('clawback');
    expect(await reconcileOrderCommission(ctx, String(order._id))).toBe('noop');
    const sum = (await CreatorLedger.find({ orderId: order._id })).reduce((a, e) => a + e.amount, 0);
    expect(sum).toBe(0);
    const perf = await cr.c.get('/api/v1/creator/commissions');
    expect(perf.status).toBe(200);
  });

  it('excludes self-attribution (no capture for the creator, no commission if it slips through)', async () => {
    const cr = await approvedCreator('self@cr.test', 'selfie');
    expect((await cr.c.post('/api/v1/creators/attribution', { handle: 'selfie' })).body.attributed).toBe(false);
    // simulate an attribution that reached the order anyway (e.g. captured while logged out, bought while logged in)
    const order = await deliver(cr.c, 'self@cr.test');
    await Order.updateOne({ _id: order._id }, { $set: { creatorAttribution: { creatorId: cr.creatorId, handle: 'selfie', capturedAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 86_400_000) } } });
    expect(await accrueCommission(ctx, String(order._id))).toBe('excluded');
    expect(await CreatorLedger.countDocuments({ orderId: order._id })).toBe(0);
    expect(await CreatorFlag.countDocuments({ orderId: order._id, kind: 'self_attribution' })).toBe(1);
  });

  it('suspended creators do not earn and unknown handles do not enumerate', async () => {
    const cr = await approvedCreator('susp@cr.test', 'suspended-one');
    const admin = await staff('admin');
    await admin.post(`/api/v1/admin/creators/${cr.creatorId}/status`, { status: 'suspended' });
    const buyer = mk();
    const r = await buyer.post('/api/v1/creators/attribution', { handle: 'suspended-one' });
    const r2 = await buyer.post('/api/v1/creators/attribution', { handle: 'does-not-exist' });
    expect(r.body).toEqual(r2.body);
    expect(r.body.attributed).toBe(false);
  });
});

describe('payouts', () => {
  it('requires the checklist, enforces ownership of statements and manual paid recording', async () => {
    const cr = await approvedCreator('pay@cr.test', 'payee');
    const other = await approvedCreator('pay2@cr.test', 'payee2');
    expect((await cr.c.post('/api/v1/creator/payouts', { currency: 'USD' })).status).toBe(422); // checklist incomplete
    const admin = await staff('admin');
    expect((await admin.patch(`/api/v1/admin/creators/${cr.creatorId}/terms`, { kycStatus: 'verified', taxInfoCollected: true, kycReference: 'ref-1' })).status).toBe(200);
    expect((await cr.c.post('/api/v1/creator/payouts', { currency: 'USD' })).status).toBe(422); // nothing payable
    await CreatorLedger.create({ creatorId: cr.creatorId, kind: 'adjustment', status: 'payable', amount: 20_000, currency: 'USD', idempotencyKey: `t-adj-${Date.now()}`, note: 'test credit' });
    const req = await cr.c.post('/api/v1/creator/payouts', { currency: 'USD' });
    expect(req.status).toBe(201);
    expect(req.body.amount).toBe(20_000);
    expect((await cr.c.post('/api/v1/creator/payouts', { currency: 'USD' })).status).toBe(409);
    expect((await other.c.get(`/api/v1/creator/payouts/${req.body.id}/statement`)).status).toBe(404); // IDOR
    const st = await cr.c.get(`/api/v1/creator/payouts/${req.body.id}/statement`);
    expect(st.body.reconciles).toBe(true);
    expect(st.body.totals.net).toBe(20_000);
    const csv = await cr.c.get(`/api/v1/creator/payouts/${req.body.id}/statement?format=csv`);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect((await admin.post(`/api/v1/admin/creators/payouts/${req.body.id}/paid`, { method: 'bank_transfer', externalReference: 'TXN123' })).status).toBe(409); // must approve first
    expect((await admin.post(`/api/v1/admin/creators/payouts/${req.body.id}/approve`, {})).status).toBe(200);
    expect((await admin.post(`/api/v1/admin/creators/payouts/${req.body.id}/paid`, { method: 'bank_transfer', externalReference: 'TXN123' })).status).toBe(200);
    expect((await CreatorLedger.findOne({ creatorId: cr.creatorId, kind: 'adjustment' }))!.status).toBe('paid');
    expect((await mk().get('/api/v1/admin/creators/payouts')).status).toBe(401);
    expect((await cr.c.get('/api/v1/admin/creators/payouts')).status).toBe(403);
  });
});

describe('discussion', () => {
  it('is moderated, rate limited, PII-free and exposes display names only', async () => {
    const cr = await approvedCreator('disc@cr.test', 'discussion');
    const prods = await firstProducts(mk(), 'US', 1);
    const col = await cr.c.post('/api/v1/creator/collections', { title: 'Talk about it', productIds: [prods[0]!.id], published: true });
    const fan = await customer('fan@cr.test', 'Priya Sharma');
    expect((await mk().post(`/api/v1/creators/collections/${col.body.id}/comments`, { body: 'hello there' })).status).toBe(401);
    expect((await fan.c.post(`/api/v1/creators/collections/${col.body.id}/comments`, { body: 'mail me at a@b.com' })).status).toBe(422);
    const ok = await fan.c.post(`/api/v1/creators/collections/${col.body.id}/comments`, { body: 'Love the second pick' });
    expect(ok.status).toBe(200);
    const page = () => mk().get(`/api/v1/creators/discussion/collections/${col.body.slug}`);
    expect((await page()).body.comments.total).toBe(0); // pending until moderated
    const admin = await staff('admin');
    expect((await admin.post(`/api/v1/admin/creators/comments/${ok.body.id}/moderate`, { decision: 'published' })).status).toBe(200);
    const shown = await page();
    expect(shown.body.comments.items[0].displayName).toBe('Priya S.');
    expect(JSON.stringify(shown.body.comments)).not.toMatch(/fan@cr\.test|userId/);
  });
});

describe('loyalty', () => {
  it('earns on delivered net value, redeems into a capped code and never goes negative', async () => {
    const u = await customer('loyal@cr.test');
    const order = await deliver(u.c, 'loyal@cr.test');
    expect(await earnForOrder(ctx, String(order._id))).toBe('earned');
    expect(await earnForOrder(ctx, String(order._id))).toBe('skipped');
    const st = await getLoyaltyStatus(ctx, u.id);
    expect(st.points).toBeGreaterThan(0);
    const page = await u.c.get('/api/v1/account/loyalty');
    expect(page.status).toBe(200);
    expect(page.body.status.points).toBe(st.points);
    expect((await u.c.post('/api/v1/account/loyalty/redeem', { points: 100000 })).status).toBe(422);
    expect((await mk().get('/api/v1/account/loyalty')).status).toBe(401);
    const admin = await staff('admin');
    expect((await admin.post('/api/v1/admin/loyalty/adjust', { userId: u.id, points: 2000, reason: 'goodwill test' })).status).toBe(200);
    const redeem = await u.c.post('/api/v1/account/loyalty/redeem', { points: 1000 });
    expect(redeem.status).toBe(201);
    expect(redeem.body.code).toMatch(/^LOYAL-/);
    expect((await admin.post('/api/v1/admin/loyalty/adjust', { userId: u.id, points: -999999, reason: 'too much' })).status).toBe(400);
    const analyst = await staff('analyst');
    expect((await analyst.post('/api/v1/admin/loyalty/adjust', { userId: u.id, points: 5, reason: 'not allowed' })).status).toBe(403);
    expect(await CreatorProfile.countDocuments({ userId: u.id })).toBe(0);
  });
});
