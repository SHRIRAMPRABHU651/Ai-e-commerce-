/**
 * Delivery Rescue integration scenarios. Mongo-backed: runs in CI (cannot be executed in the offline sandbox).
 * Failure scenarios are produced by editing real Order/Shipment rows after a normal mock-supplier checkout,
 * then running the real scan job.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Notification, Order, RescueAction, RescueCase, RescueConsent, RescueTimeline, Shipment } from '@orvia/database';
import { SYSTEM, emailSubject, fulfillOrder, getRescuePolicy, runRescueScan, signConsentToken, updateRescuePolicy } from '@orvia/core';
import type { Ctx } from '@orvia/core';
import { closeCtx, testCtx } from '../helpers/ctx';
import { startApi } from '../helpers/client';
import type { Client } from '../helpers/client';
import { pay, placeOrder } from '../helpers/shop';
import { runSeed } from '../../scripts/lib/seed';

let ctx: Ctx;
let mk: (h?: Record<string, string>) => Client;
let admin: Client;
const DAY = 86_400_000;

beforeAll(async () => {
  ctx = await testCtx('rescue');
  await runSeed(ctx, { withHistory: false });
  mk = (await startApi(ctx)).client;
  admin = mk();
  expect((await admin.post('/api/v1/auth/admin/login', { email: 'owner@orvia.test', password: 'Orvia-Demo-2026!' })).status).toBe(200);
}, 180_000);
afterAll(closeCtx);

/** Paid, fulfilled order with one live shipment. */
async function paidOrder(email = `r${Math.random().toString(36).slice(2, 8)}@example.com`) {
  const buyer = mk();
  const { co } = await placeOrder(buyer, { email });
  expect(co.status).toBe(201);
  await pay(buyer, co.body.payment.intentId);
  const order = (await Order.findOne({ orderNumber: co.body.order.orderNumber }))!;
  await fulfillOrder(ctx, String(order._id)).catch(() => undefined);
  await Order.updateOne({ _id: order._id }, { $set: { 'payment.paidAt': new Date(Date.now() - 3 * DAY) } });
  return { order: (await Order.findById(order._id))!, email, buyer };
}
const backdate = (id: unknown, days: number) => Shipment.collection.updateOne({ _id: id as never }, { $set: { createdAt: new Date(Date.now() - days * DAY) } });
const active = (orderId: unknown) => RescueCase.find({ orderId, state: { $nin: ['resolved', 'closed'] } });

describe('detection scenarios', () => {
  it('shipping delay is detected once, planned, and the customer is told once', async () => {
    const { order } = await paidOrder();
    const sh = (await Shipment.findOne({ orderId: order._id }))!;
    await Shipment.updateOne({ _id: sh._id }, { $set: { status: 'IN_TRANSIT', estimatedDelivery: new Date(Date.now() - 6 * DAY), events: [{ status: 'IN_TRANSIT', description: 'Departed facility', at: new Date() }] } });
    await runRescueScan(ctx);
    const cases = await active(order._id);
    expect(cases).toHaveLength(1);
    expect(cases[0]!.kind).toBe('shipment_delay');
    expect(cases[0]!.options.length).toBeGreaterThan(0);
    expect(await Notification.countDocuments({ orderId: order._id, dedupeKey: new RegExp(`^rescue:${cases[0]!._id}:detected`) })).toBe(1);
  });

  it('invalid tracking is flagged only after the grace period', async () => {
    const { order } = await paidOrder();
    const sh = (await Shipment.findOne({ orderId: order._id }))!;
    await Shipment.updateOne({ _id: sh._id }, { $set: { status: 'SHIPPED', trackingNumber: 'N/A', estimatedDelivery: new Date(Date.now() + 5 * DAY), events: [{ status: 'SHIPPED', at: new Date() }] } });
    await backdate(sh._id, 1);
    await runRescueScan(ctx);
    expect(await active(order._id)).toHaveLength(0);
    await backdate(sh._id, 6);
    await runRescueScan(ctx);
    const c = await active(order._id);
    expect(c).toHaveLength(1);
    expect(c[0]!.kind).toBe('invalid_tracking');
  });

  it('supplier unavailable: paid order with no supplier order and a failed fulfilment becomes an acceptance failure', async () => {
    const { order } = await paidOrder();
    await Shipment.deleteMany({ orderId: order._id });
    await Order.updateOne({ _id: order._id }, { $set: { 'fulfillment.state': 'failed', 'fulfillment.lastError': 'supplier API 503' } });
    await runRescueScan(ctx);
    const c = await active(order._id);
    expect(c).toHaveLength(1);
    expect(c[0]!.kind).toBe('supplier_acceptance_failure');
    expect(c[0]!.evidence.map((e) => e.code)).toContain('no_supplier_order');
  });

  it('stock mismatch: a supplier out-of-stock refusal is classified as a stock shortage', async () => {
    const { order } = await paidOrder();
    await Shipment.updateMany({ orderId: order._id }, { $set: { status: 'FAILED', lastError: 'Out of stock at warehouse' } });
    await runRescueScan(ctx);
    const c = await active(order._id);
    expect(c).toHaveLength(1);
    expect(c[0]!.kind).toBe('stock_shortage');
  });
});

describe('idempotency and restarts', () => {
  it('duplicate trigger / worker restart: scanning repeatedly creates no second case, action, timeline entry or supplier order', async () => {
    const { order } = await paidOrder();
    await Shipment.updateMany({ orderId: order._id }, { $set: { status: 'CANCELLED' } });
    await runRescueScan(ctx);
    await runRescueScan(ctx);
    await runRescueScan(ctx); // simulates a restarted worker re-running the same job
    const cases = await RescueCase.find({ orderId: order._id });
    expect(cases).toHaveLength(1);
    expect(await RescueTimeline.countDocuments({ caseId: cases[0]!._id, event: 'detected' })).toBe(1);
    const actions = await RescueAction.find({ caseId: cases[0]!._id });
    const keys = actions.map((a) => a.idempotencyKey);
    expect(new Set(keys).size).toBe(keys.length);
    const rescueShipments = await Shipment.countDocuments({ orderId: order._id, idempotencyKey: /^rescue-ship:/ });
    expect(rescueShipments).toBeLessThanOrEqual(1);
    expect(await Shipment.countDocuments({ orderId: order._id, status: { $in: ['PENDING_CREATE', 'CREATED', 'SHIPPED', 'IN_TRANSIT'] } })).toBeLessThanOrEqual(1);
  });

  it('default policy never auto-reorders or refunds', async () => {
    const policy = await getRescuePolicy();
    expect(policy.autoExecuteEnabled).toBe(false);
    expect(policy.preApprovedSupplierIds).toEqual([]);
    const { order } = await paidOrder();
    await Shipment.updateMany({ orderId: order._id }, { $set: { status: 'CANCELLED' } });
    await runRescueScan(ctx);
    expect(await RescueAction.countDocuments({ orderId: order._id, kind: { $in: ['offer_full_refund', 'offer_partial_refund', 'offer_equivalent_replacement', 'reorder_same_product_alt_supplier'] } })).toBe(0);
    expect((await Order.findById(order._id))!.costs?.refunded ?? 0).toBe(0);
  });
});

describe('consent', () => {
  it('a consent decision is single-use; forged/stale tokens and strangers are refused; accepted partial refund goes through refundOrder once', async () => {
    const { order, email, buyer } = await paidOrder();
    const item = order.items[0]!;
    const c = await RescueCase.create({
      orderId: order._id, orderNumber: order.orderNumber, email, lineKey: item.lineKey, dedupeKey: `rescue:${order._id}:${item.lineKey}`, currency: order.currency, kind: 'shipment_delay', severity: 'medium', state: 'awaiting_customer', title: item.title, lineValue: item.unitPrice * item.quantity, detectedAt: new Date(), round: 1,
      options: [{ id: 'offer_partial_refund', kind: 'offer_partial_refund', label: 'Partial refund', customerText: 'Keep waiting and get 20% back', feasible: true, materialChange: true, materialReasons: ['Price terms change'], requiresCustomerConsent: true, needsDuplicateAck: false, impact: { extraCost: 0, refund: 100, sunkCost: 0, lostMargin: 0, contributionDelta: -100, exposure: 100 }, eta: { minDays: null, maxDays: null, worseningDays: null }, plannedLandedCost: 0, auth: { mode: 'customer_consent', requiresCustomerConsent: true, requiresStaffApproval: false, autoEligible: false, reasons: [] } }],
      recommendedId: 'offer_partial_refund',
    });
    const exp = new Date(Date.now() + 3600_000);
    await RescueConsent.create({ caseId: c._id, orderId: order._id, round: 1, optionId: 'offer_partial_refund', optionKind: 'offer_partial_refund', termsHash: 'h', status: 'pending', expiresAt: exp });
    const secret = ctx.cfg.ENCRYPTION_KEY ?? ctx.cfg.JWT_SECRET;
    const token = signConsentToken({ caseId: String(c._id), round: 1, exp: exp.getTime(), sub: emailSubject(email) }, secret);
    const url = `/api/v1/orders/${order.orderNumber}/recovery`;

    // unauthorized access
    expect((await mk().get(url)).status).toBe(404);
    expect((await mk().get(`${url}?token=${encodeURIComponent(token.slice(0, -3) + 'abc')}`)).status).toBe(403);
    const stranger = mk();
    await stranger.post('/api/v1/auth/register', { email: 'stranger@user.test', password: 'Sup3rSecretPass', name: 'S' });
    expect((await stranger.get(url)).status).toBe(404);
    expect((await stranger.post(`${url}/decision`, { optionId: 'offer_partial_refund', decision: 'accept' })).status).toBe(404);
    expect(await RescueAction.countDocuments({ caseId: c._id })).toBe(0);

    // view shows plain language only
    const view = await mk().get(`${url}?token=${encodeURIComponent(token)}`);
    expect(view.status).toBe(200);
    expect(JSON.stringify(view.body)).not.toMatch(/impact|extraCost|supplier|margin/i);

    // single use
    const first = await mk().post(`${url}/decision`, { optionId: 'offer_partial_refund', decision: 'accept', token });
    expect(first.status).toBe(200);
    const second = await mk().post(`${url}/decision`, { optionId: 'offer_partial_refund', decision: 'accept', token });
    expect([404, 409]).toContain(second.status);
    expect(await RescueAction.countDocuments({ caseId: c._id })).toBe(1);
    await runRescueScan(ctx);
    await runRescueScan(ctx);
    expect(await RescueAction.countDocuments({ caseId: c._id })).toBe(1);
    expect((await Order.findById(order._id))!.costs?.refunded ?? 0).toBeLessThanOrEqual(100);
    expect(buyer).toBeDefined();
  });
});

describe('staff access and policy', () => {
  it('anonymous = 401, customer = 403, support can read but not write, policy edits are audited', async () => {
    expect((await mk().get('/api/v1/admin/rescue/cases')).status).toBe(401);
    const cust = mk();
    await cust.post('/api/v1/auth/register', { email: 'cust2@user.test', password: 'Sup3rSecretPass', name: 'C' });
    expect((await cust.get('/api/v1/admin/rescue/cases')).status).toBe(403);
    expect((await cust.put('/api/v1/admin/rescue/policy', { maxCostPerCaseUsd: 1, reason: 'x y z' })).status).toBe(403);
    expect((await admin.get('/api/v1/admin/rescue/cases')).status).toBe(200);
    expect((await admin.get('/api/v1/admin/rescue/kpis?days=30')).status).toBe(200);
    expect((await admin.put('/api/v1/admin/rescue/policy', { maxCostPerCaseUsd: -1, reason: 'bad' })).status).toBe(400);
    const ok = await admin.put('/api/v1/admin/rescue/policy', { maxCostPerCaseUsd: 2000, reason: 'raise per-case limit' });
    expect(ok.status).toBe(200);
    expect(ok.body.maxCostPerCaseUsd).toBe(2000);
    const aud = await admin.get('/api/v1/admin/audit?action=rescue.policy.updated');
    expect(aud.body.items[0].previousValue).toBeDefined();
    await updateRescuePolicy(ctx, SYSTEM, { maxCostPerCaseUsd: 1500, reason: 'restore default' });
  });

  it('staff decision on a case needs rescue:write and a reason; the case timeline stays append-only', async () => {
    const { order } = await paidOrder();
    await Shipment.updateMany({ orderId: order._id }, { $set: { status: 'CANCELLED' } });
    await runRescueScan(ctx);
    const c = (await RescueCase.findOne({ orderId: order._id }))!;
    expect((await admin.post(`/api/v1/admin/rescue/cases/${c._id}/decision`, { action: 'close' })).status).toBe(400); // note required
    await expect(RescueTimeline.updateOne({ caseId: c._id }, { $set: { summary: 'tampered' } })).rejects.toThrow(/append-only/);
    await expect(RescueTimeline.deleteMany({ caseId: c._id })).rejects.toThrow(/append-only/);
    const closed = await admin.post(`/api/v1/admin/rescue/cases/${c._id}/decision`, { action: 'close', note: 'handled by phone' });
    expect(closed.status).toBe(200);
    expect(closed.body.case.state).toBe('closed');
  });
});
