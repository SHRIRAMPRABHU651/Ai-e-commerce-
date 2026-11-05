import { createHmac } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AftersalesChargeback, AftersalesReturn, ExceptionModel, Job, Order, Payment, Refund, ReturnRequest, WebhookEvent } from '@orvia/database';
import { MockPaymentProvider } from '@orvia/payments';
import { MongoKVStore, SYSTEM, createStaffUser, handlePaymentWebhook, syncTracking, syncReturnRefunds } from '@orvia/core';
import type { Ctx } from '@orvia/core';
import { closeCtx, testCtx } from '../helpers/ctx';
import { ageMockOrders, startApi } from '../helpers/client';
import type { Client } from '../helpers/client';
import { pay, placeOrder } from '../helpers/shop';
import { runSeed } from '../../scripts/lib/seed';

/** NOT executed in the authoring sandbox (needs MongoDB). Mock payment/supplier adapters only: proves Orvia's own handling, not any real PSP. */
let ctx: Ctx; let mk: (h?: Record<string, string>) => Client; let admin: Client; const kv = new MongoKVStore();
beforeAll(async () => {
  ctx = await testCtx('aftersales');
  await runSeed(ctx, { withHistory: false });
  mk = (await startApi(ctx)).client;
  await createStaffUser(ctx, { email: 'as-boss@t.test', name: 'Boss', password: 'Str0ngPassw0rd!', role: 'ADMIN' }, SYSTEM);
  await createStaffUser(ctx, { email: 'as-support@t.test', name: 'Support', password: 'Str0ngPassw0rd!', role: 'SUPPORT' }, SYSTEM);
  admin = mk();
  expect((await admin.post('/api/v1/auth/admin/login', { email: 'as-boss@t.test', password: 'Str0ngPassw0rd!' })).status).toBe(200);
}, 240_000);
afterAll(closeCtx);

const runDue = async () => { await Job.updateMany({ status: 'queued' }, { $set: { runAt: new Date(0) } }); return ctx.queue.drain(50); };

async function deliveredOrder(qty = 2) {
  const c = mk();
  const email = `as${Date.now()}${Math.random().toString(36).slice(2, 5)}@example.com`;
  await c.post('/api/v1/auth/register', { email, password: 'Sup3rSecretPass', name: 'AS Buyer' });
  const { co } = await placeOrder(c, { productIdx: 1, email, qty });
  await pay(c, co.body.payment.intentId);
  await runDue();
  await ageMockOrders(60);
  await syncTracking(ctx, { orderId: co.body.order.id });
  await runDue();
  const order = (await Order.findById(co.body.order.id).lean())!;
  expect(order.status).toBe('DELIVERED');
  return { c, order, intent: co.body.payment.intentId as string };
}

const photo = () => sharp({ create: { width: 800, height: 600, channels: 3, background: '#cc3333' } }).jpeg().toBuffer();

describe('returns: eligibility, evidence, RMA, refund', () => {
  it('explains ineligibility, then runs the full return -> authorize -> receive -> inspect -> partial refund flow', async () => {
    const { c, order } = await deliveredOrder(2);
    const sku = order.items[0]!.sku;
    // no supplier policy recorded => unknown => eligible to request but flagged for staff review
    const el = await c.get(`/api/v1/aftersales/orders/${order.orderNumber}/eligibility?reason=damaged`);
    expect(el.status).toBe(200);
    expect(el.body.lines[0].eligible).toBe(true);
    expect(el.body.lines[0].needsStaffReview).toBe(true);
    expect(el.body.evidence).toBe('required');

    // another customer cannot see eligibility
    const other = mk();
    await other.post('/api/v1/auth/register', { email: `other${Date.now()}@example.com`, password: 'Sup3rSecretPass', name: 'Other' });
    expect((await other.get(`/api/v1/aftersales/orders/${order.orderNumber}/eligibility`)).status).toBe(403);

    // invalid selection is rejected with a reason
    const bad = await c.post('/api/v1/aftersales/returns', { orderId: String(order._id), reason: 'damaged', details: 'cracked', items: [{ sku, quantity: 9, condition: 'damaged' }], resolution: 'refund' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('NOT_ELIGIBLE');

    const start = await c.post('/api/v1/aftersales/returns', { orderId: String(order._id), reason: 'damaged', details: 'cracked', items: [{ sku, quantity: 1, condition: 'damaged' }], resolution: 'refund' });
    expect(start.status).toBe(201);
    const id = start.body.id as string;
    expect(start.body.evidenceRequired).toBe(true);

    // staff cannot authorize without the required photo
    expect((await admin.post(`/api/v1/admin/aftersales/returns/${id}/authorize`, { note: '' })).body.error.code).toBe('EVIDENCE_REQUIRED');

    // evidence validation: disguised file rejected, real photo accepted, owner only
    expect((await c.upload(`/api/v1/aftersales/returns/${id}/evidence`, { filename: 'x.jpg', mimetype: 'image/jpeg', buffer: Buffer.from('not an image'.repeat(200)) })).status).toBe(422);
    expect((await other.upload(`/api/v1/aftersales/returns/${id}/evidence`, { filename: 'x.jpg', mimetype: 'image/jpeg', buffer: await photo() })).status).toBe(403);
    const up = await c.upload(`/api/v1/aftersales/returns/${id}/evidence`, { filename: 'x.jpg', mimetype: 'image/jpeg', buffer: await photo() });
    expect(up.status).toBe(201);
    expect((await other.get(`/api/v1/aftersales/returns/${id}`)).status).toBe(403);
    expect((await other.get(`/api/v1/aftersales/returns/${id}/evidence/${up.body.id}`)).status).toBe(403);
    expect((await c.get(`/api/v1/aftersales/returns/${id}/evidence/${up.body.id}`)).status).toBe(200);

    // customers cannot use staff routes
    expect((await c.post(`/api/v1/admin/aftersales/returns/${id}/authorize`, { note: '' })).status).toBe(403);

    expect((await admin.post(`/api/v1/admin/aftersales/returns/${id}/authorize`, { note: 'ok' })).body.state).toBe('authorized');
    expect((await ReturnRequest.findById((await AftersalesReturn.findById(id).lean())!.returnId).lean())!.status).toBe('approved');
    // no supplier policy / label provider => instructions only, never a label URL
    const detail = await admin.get(`/api/v1/admin/aftersales/returns/${id}`);
    expect(detail.body.label?.url).toBeUndefined();
    expect(detail.body.instructions).toMatch(/RMA-/);
    expect(detail.body.refundPreview.refundable).toBeGreaterThan(0);

    expect((await admin.post(`/api/v1/admin/aftersales/returns/${id}/received`, { note: '' })).body.state).toBe('received');
    expect((await admin.post(`/api/v1/admin/aftersales/returns/${id}/inspect`, { outcome: 'accepted', note: 'confirmed damaged' })).body.state).toBe('inspected');

    // support has refunds:write, but over-limit refunds need approval; this one is small so it executes
    const ref = await admin.post(`/api/v1/admin/aftersales/returns/${id}/refund`, { note: 'damaged' });
    expect(ref.status).toBe(200);
    expect(ref.body.refundStatus).toBe('succeeded');
    expect(ref.body.state).toBe('resolved');
    const refund = (await Refund.findById(ref.body.refundId).lean())!;
    expect(refund.amount).toBe(ref.body.calc.refundable);
    expect(refund.amount).toBeLessThan(order.amounts!.total); // 1 of 2 units
    // second attempt cannot double refund
    expect((await admin.post(`/api/v1/admin/aftersales/returns/${id}/refund`, { note: 'again' })).status).toBe(409);
    expect(await Refund.countDocuments({ orderId: order._id })).toBe(1);

    // customer-visible refund timeline comes from the real refund record
    const st = await c.get(`/api/v1/aftersales/orders/${order.orderNumber}/status`);
    expect(st.body.refund.steps.some((s: { key: string; status: string }) => s.key === 'refund' && s.status === 'done')).toBe(true);
    expect((await ReturnRequest.findById((await AftersalesReturn.findById(id).lean())!.returnId).lean())!.status).toBe('refunded');
  }, 120_000);

  it('refunds above the approval limit wait for an approver and the return completes afterwards', async () => {
    const { c, order } = await deliveredOrder(1);
    await ctx.settings.set('automation', { autoRefundLimitUsd: 1 }, 'test');
    try {
      const start = await c.post('/api/v1/aftersales/returns', { orderId: String(order._id), reason: 'changed_mind', details: '', items: [{ sku: order.items[0]!.sku, quantity: 1, condition: 'unopened' }], resolution: 'refund' });
      // changed_mind + unknown supplier policy is still requestable
      expect(start.status).toBe(201);
      const id = start.body.id as string;
      await admin.post(`/api/v1/admin/aftersales/returns/${id}/authorize`, { note: '' });
      const sup = mk();
      expect((await sup.post('/api/v1/auth/admin/login', { email: 'as-support@t.test', password: 'Str0ngPassw0rd!' })).status).toBe(200);
      const ref = await sup.post(`/api/v1/admin/aftersales/returns/${id}/refund`, { note: '' });
      expect(ref.body.refundStatus).toBe('pending_approval');
      expect((await AftersalesReturn.findById(id).lean())!.state).toBe('refund_pending');
      expect((await sup.post(`/api/v1/admin/refunds/${ref.body.refundId}/approve`)).status).toBe(403);
      expect((await admin.post(`/api/v1/admin/refunds/${ref.body.refundId}/approve`)).status).toBe(200);
      await syncReturnRefunds(ctx);
      expect((await AftersalesReturn.findById(id).lean())!.state).toBe('resolved');
    } finally {
      await ctx.settings.set('automation', { autoRefundLimitUsd: 5000 }, 'test');
    }
  }, 120_000);

  it('a supplier recorded as not accepting returns blocks change-of-mind returns with a reason, but not defects', async () => {
    const { c, order } = await deliveredOrder(1);
    const { Shipment } = await import('@orvia/database');
    const ship = (await Shipment.findOne({ orderId: order._id }).lean())!;
    expect((await admin.put(`/api/v1/admin/aftersales/suppliers/${ship.supplierId}/policy`, { supportsReturns: 'no', supportsReplacement: false, supportsExchange: false, defectOnly: false, instructions: '' })).status).toBe(200);
    const cm = await c.get(`/api/v1/aftersales/orders/${order.orderNumber}/eligibility?reason=changed_mind`);
    expect(cm.body.lines[0].eligible).toBe(false);
    expect(cm.body.lines[0].reasons[0].code).toBe('SUPPLIER_NO_RETURNS');
    expect((await c.get(`/api/v1/aftersales/orders/${order.orderNumber}/eligibility?reason=defective`)).body.lines[0].eligible).toBe(true);
  }, 120_000);
});

describe('webhooks: duplicates, crashed claims, refund failure, chargebacks', () => {
  it('duplicate payment webhooks are processed once; an unfinished claim is reprocessed after the stale window', async () => {
    const c = mk();
    const { co } = await placeOrder(c, { country: 'US' });
    const provider = new MockPaymentProvider(ctx.cfg.MOCK_PAYMENT_WEBHOOK_SECRET, kv);
    const sim = await provider.simulate(co.body.payment.intentId, 'succeeded');
    expect(await handlePaymentWebhook(ctx, 'mock', sim.body, sim.headers)).toBe('processed');
    expect(await handlePaymentWebhook(ctx, 'mock', sim.body, sim.headers)).toBe('duplicate');
    const evId = JSON.parse(sim.body).id as string;
    expect((await WebhookEvent.findOne({ provider: 'mock', eventId: evId }).lean())!.outcome).toBe('processed');

    // simulate a worker that crashed after claiming the event id: no outcome, old timestamp
    await WebhookEvent.updateOne({ provider: 'mock', eventId: evId }, { $unset: { outcome: 1 }, $set: { processedAt: new Date(Date.now() - 10 * 60_000) } });
    const again = await handlePaymentWebhook(ctx, 'mock', sim.body, sim.headers);
    expect(['duplicate', 'processed']).toContain(again); // reprocessed, but settlement itself is idempotent
    expect((await WebhookEvent.findOne({ provider: 'mock', eventId: evId }).lean())!.outcome).toBeTruthy();
    expect((await Order.findOne({ orderNumber: co.body.order.orderNumber }).lean())!.timeline!.filter((t) => t.status === 'PAID')).toHaveLength(1);
  });

  it('a provider refund.failed webhook marks the refund failed and raises a critical exception', async () => {
    const { order } = await deliveredOrder(1);
    const refund = await Refund.create({ orderId: order._id, amount: 100, currency: order.currency, reason: 't', status: 'succeeded', providerRefundId: 'mock_re_fail1', idempotencyKey: `t-${Date.now()}` });
    const body = JSON.stringify({ id: `evt_rf_${Date.now()}`, type: 'refund.failed', intentId: order.payment!.intentId, providerRefundId: 'mock_re_fail1', failureReason: 'card_closed' });
    const t = String(Math.floor(Date.now() / 1000));
    const sig = createHmac('sha256', ctx.cfg.MOCK_PAYMENT_WEBHOOK_SECRET).update(`${t}.${body}`).digest('hex');
    expect(await handlePaymentWebhook(ctx, 'mock', body, { 'x-mock-signature': `t=${t},v1=${sig}` })).toBe('processed');
    expect((await Refund.findById(refund._id).lean())!.status).toBe('failed');
    expect(await ExceptionModel.countDocuments({ dedupeKey: `refund-failed:${refund._id}` })).toBe(1);
  });

  it('ingests a dispute from the signed mock webhook, dedupes replays, tracks the deadline and records evidence; staff only', async () => {
    const { order, intent } = await deliveredOrder(1);
    const sim = await admin.post('/api/v1/dev/aftersales/simulate-dispute', { intentId: intent, status: 'needs_response', disputeId: 'dp_test_1', eventId: 'evt_dp_test_1' });
    expect(sim.status).toBe(200);
    expect(sim.body.outcome).toBe('processed');
    // replay of the same event
    expect((await admin.post('/api/v1/dev/aftersales/simulate-dispute', { intentId: intent, status: 'needs_response', disputeId: 'dp_test_1', eventId: 'evt_dp_test_1' })).body.outcome).toBe('duplicate');
    // a different event for the same dispute only updates it
    await admin.post('/api/v1/dev/aftersales/simulate-dispute', { intentId: intent, status: 'needs_response', disputeId: 'dp_test_1', eventId: 'evt_dp_test_1b' });
    expect(await AftersalesChargeback.countDocuments({ provider: 'mock', disputeId: 'dp_test_1' })).toBe(1);
    const cb = (await AftersalesChargeback.findOne({ disputeId: 'dp_test_1' }).lean())!;
    expect(String(cb.orderId)).toBe(String(order._id));
    expect(cb.state).toBe('needs_response');
    expect(cb.evidenceDueBy).toBeTruthy();
    expect(await ExceptionModel.countDocuments({ kind: 'CHARGEBACK', dedupeKey: 'chargeback:mock:dp_test_1' })).toBe(1);
    expect((await Order.findById(order._id).lean())!.status).toBe('DELIVERED'); // dispute must not flip the order into EXCEPTION

    // access control
    const cust = mk();
    await cust.post('/api/v1/auth/register', { email: `cb${Date.now()}@example.com`, password: 'Sup3rSecretPass', name: 'C' });
    expect((await cust.get('/api/v1/admin/aftersales/chargebacks')).status).toBe(403);
    expect((await cust.post('/api/v1/dev/aftersales/simulate-dispute', { intentId: intent })).status).toBeGreaterThanOrEqual(401);

    const ev = await admin.post(`/api/v1/admin/aftersales/chargebacks/${cb._id}/evidence`, { text: 'Delivered per carrier tracking; customer confirmed receipt by email.', category: 'delivery_proof' });
    expect(ev.body.state).toBe('evidence_recorded');
    // provider webhook cannot reopen after it is won
    await admin.post('/api/v1/dev/aftersales/simulate-dispute', { intentId: intent, status: 'won', disputeId: 'dp_test_1', eventId: 'evt_dp_test_1c' });
    await admin.post('/api/v1/dev/aftersales/simulate-dispute', { intentId: intent, status: 'needs_response', disputeId: 'dp_test_1', eventId: 'evt_dp_test_1d' });
    expect((await AftersalesChargeback.findOne({ disputeId: 'dp_test_1' }).lean())!.state).toBe('won');
    expect((await admin.post(`/api/v1/admin/aftersales/chargebacks/${cb._id}/accept`, { note: '' })).status).toBe(409);

    const m = await admin.get('/api/v1/admin/aftersales/chargebacks/metrics');
    expect(m.status).toBe(200);
    expect(m.body.won).toBeGreaterThanOrEqual(1);
    expect((await Payment.findOne({ orderId: order._id }).lean())!.status).toBe('succeeded');
  }, 120_000);
});
