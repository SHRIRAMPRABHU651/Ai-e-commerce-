import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExceptionModel, Order, Payment, Shipment } from '@orvia/database';
import { runReconciliation } from '@orvia/core';
import type { Ctx } from '@orvia/core';
import { closeCtx, testCtx } from '../helpers/ctx';
import { Client, startApi } from '../helpers/client';
import { pay, placeOrder } from '../helpers/shop';
import { runSeed } from '../../scripts/lib/seed';

let ctx: Ctx; let api: () => Client;
beforeAll(async () => {
  ctx = await testCtx('recon');
  await runSeed(ctx, { withHistory: false });
  api = (await startApi(ctx)).client;
}, 180_000);
afterAll(closeCtx);

const paidOrder = async () => {
  const c = api();
  const { co } = await placeOrder(c, { country: 'US' });
  await pay(c, co.body.payment.intentId);
  await ctx.queue.drain(40);
  return (await Order.findOne({ orderNumber: co.body.order.orderNumber }).lean())!;
};

describe('daily reconciliation', () => {
  it('finds nothing wrong in a healthy ledger', async () => {
    await paidOrder();
    const r = await runReconciliation(ctx);
    expect(r.findings, JSON.stringify(r.findings)).toEqual([]);
  });

  it('detects payment/order/supplier/refund/tracking discrepancies and raises one exception each, idempotently', async () => {
    const o1 = await paidOrder(); // paid, but supplier order disappears
    await Shipment.deleteMany({ orderId: o1._id });
    await Order.collection.updateOne({ _id: o1._id }, { $set: { createdAt: new Date(Date.now() - 6 * 3_600_000), exceptionOpen: false, status: 'PAID' } }); // bypass immutable createdAt
    const o2 = await paidOrder(); // refund ledger disagrees with the payment
    await Payment.updateOne({ orderId: o2._id }, { $set: { refundedAmount: 500 } });
    const o3 = await paidOrder(); // unpaid but has an active supplier order
    await Order.updateOne({ _id: o3._id }, { $set: { 'payment.status': 'pending', status: 'PENDING_PAYMENT' } });
    await Order.updateOne({ _id: o3._id }, { $set: { status: 'SUPPLIER_PROCESSING', 'payment.status': 'failed' } });
    await Payment.create({ orderId: new mongoose.Types.ObjectId(), provider: 'mock', intentId: 'orphan_1', amount: 1000, currency: 'USD', status: 'succeeded' });
    const r = await runReconciliation(ctx);
    const kinds = new Set(r.findings.map((f) => f.kind));
    for (const k of ['paid_order_without_supplier_order', 'refund_mismatch', 'supplier_order_without_paid_order', 'payment_without_order']) expect(kinds.has(k as never), k).toBe(true);
    const n = await ExceptionModel.countDocuments({ kind: 'RECONCILIATION', status: 'open' });
    expect(n).toBeGreaterThanOrEqual(4);
    await runReconciliation(ctx);
    expect(await ExceptionModel.countDocuments({ kind: 'RECONCILIATION', status: 'open' })).toBe(n); // no duplicates on re-run
  });
});
