import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExceptionModel, Order, Shipment } from '@orvia/database';
import { SYSTEM, changeSupplier, executeNow, fulfillOrder } from '@orvia/core';
import type { Ctx } from '@orvia/core';
import { closeCtx, testCtx } from '../helpers/ctx';
import { Client, startApi } from '../helpers/client';
import { pay, placeOrder } from '../helpers/shop';
import { runSeed } from '../../scripts/lib/seed';

/** The export-attestation gate is a LEGAL hold: no operator override, AI executor or retry path may create a supplier order past it. */
let ctx: Ctx; let admin: Client; let api: () => Client;
beforeAll(async () => {
  ctx = await testCtx('exportgate');
  await runSeed(ctx, { withHistory: false });
  const s = await startApi(ctx);
  api = s.client;
  admin = s.client();
  expect((await admin.post('/api/v1/auth/admin/login', { email: 'owner@orvia.test', password: 'Orvia-Demo-2026!' })).status).toBe(200);
}, 180_000);
afterAll(closeCtx);

const supplierOrders = (id: unknown) => Shipment.countDocuments({ orderId: id, status: { $nin: ['FAILED', 'CANCELLED'] } });
const heldOrder = async () => {
  const c = api();
  const { co } = await placeOrder(c, { country: 'US' });
  await pay(c, co.body.payment.intentId);
  await ctx.queue.drain(40);
  return (await Order.findOne({ orderNumber: co.body.order.orderNumber }).lean())!;
};

describe('export attestation cannot be bypassed', () => {
  it('forced retry, exception approval, direct force, AI executor and supplier change all leave zero supplier orders and keep the legal exception open', async () => {
    await ctx.settings.set('legal', { requireExportAttestation: true }, 'test');
    try {
      const o = await heldOrder();
      const id = String(o._id);
      expect(await supplierOrders(o._id)).toBe(0);
      const legalOpen = () => ExceptionModel.countDocuments({ orderId: o._id, kind: 'EXPORT_ATTESTATION', status: { $in: ['open', 'in_progress'] } });
      expect(await legalOpen()).toBe(1);

      // 1. staff forced retry
      expect((await admin.post(`/api/v1/admin/orders/${id}/retry-fulfillment`, { force: true })).status).toBe(200);
      await ctx.queue.drain(40);
      expect(await supplierOrders(o._id)).toBe(0);
      expect(await legalOpen()).toBe(1);
      expect((await Order.findById(o._id).lean())!.exceptionOpen).toBe(true);

      // 2. "approve fulfilment" on the exception
      const ex = (await ExceptionModel.findOne({ orderId: o._id, kind: 'EXPORT_ATTESTATION' }).lean())!;
      await admin.post(`/api/v1/admin/exceptions/${ex._id}/action`, { action: 'approve_fulfillment', note: 'owner insists' });
      await ctx.queue.drain(40);
      expect(await supplierOrders(o._id)).toBe(0);
      expect(await legalOpen()).toBe(1);

      // 3. direct forced fulfilment, 4. AI-decision executor, 5. change supplier (queues a forced fulfilment)
      expect((await fulfillOrder(ctx, id, { force: true })).state).toBe('held');
      await executeNow(ctx, 'approve_fulfillment', { orderId: id }, SYSTEM);
      await changeSupplier(ctx, id, o.items[0]!.lineKey, SYSTEM);
      await ctx.queue.drain(40);
      expect(await supplierOrders(o._id)).toBe(0);
      expect(await legalOpen()).toBe(1);

      // only recording the attestation releases it
      expect((await admin.put('/api/v1/admin/compliance/export/US', { reference: 'Adviser opinion 2026-10-24, ref EX-201' })).status).toBe(200);
      await ctx.queue.drain(40);
      expect(await legalOpen()).toBe(0);
      expect(await supplierOrders(o._id)).toBeGreaterThan(0);
    } finally {
      await ctx.settings.set('legal', { requireExportAttestation: false }, 'test');
    }
  });

  it('revoking the attestation stops the next fulfilment even for a forced run', async () => {
    await ctx.settings.set('legal', { requireExportAttestation: true }, 'test');
    try {
      expect((await admin.put('/api/v1/admin/compliance/export/US', { reference: 'Adviser opinion 2026-10-24, ref EX-202' })).status).toBe(200);
      const c = api();
      const { co } = await placeOrder(c, { country: 'US' });
      await admin.del('/api/v1/admin/compliance/export/US'); // revoked before the order is paid / fulfilled
      await pay(c, co.body.payment.intentId);
      const o = (await Order.findOne({ orderNumber: co.body.order.orderNumber }).lean())!;
      await ctx.queue.drain(40);
      expect((await fulfillOrder(ctx, String(o._id), { force: true })).state).toBe('held');
      expect(await supplierOrders(o._id)).toBe(0);
    } finally {
      await ctx.settings.set('legal', { requireExportAttestation: false }, 'test');
    }
  });
});
