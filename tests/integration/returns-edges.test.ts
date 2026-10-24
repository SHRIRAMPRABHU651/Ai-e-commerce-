import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Order, Refund, ReturnRequest } from '@orvia/database';
import { SYSTEM, decideReturn, requestReturn } from '@orvia/core';
import type { Ctx } from '@orvia/core';
import { closeCtx, testCtx } from '../helpers/ctx';
import { startApi } from '../helpers/client';
import type { Client } from '../helpers/client';
import { pay, placeOrder } from '../helpers/shop';
import { runSeed } from '../../scripts/lib/seed';

let ctx: Ctx; let api: () => Client;
beforeAll(async () => { ctx = await testCtx('returns'); await runSeed(ctx, { withHistory: false }); api = (await startApi(ctx)).client; }, 180_000);
afterAll(closeCtx);

const paid = async (email: string, qty = 1) => {
  const c = api();
  const { co } = await placeOrder(c, { country: 'US', email, qty });
  await pay(c, co.body.payment.intentId);
  await ctx.queue.drain(40);
  return (await Order.findOne({ orderNumber: co.body.order.orderNumber }))!;
};
const who = (o: { email: string }) => ({ email: o.email, actor: { id: o.email, type: 'user' as const } });

describe('returns: eligibility and decisions', () => {
  it('enforces ownership, payment, delivery, window and item checks', async () => {
    const o = await paid('ret1@example.com');
    const base = { orderId: String(o._id), reason: 'damaged', details: 'cracked', itemSkus: [o.items[0]!.sku] };
    await expect(requestReturn(ctx, base, { email: 'other@example.com', actor: SYSTEM })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(requestReturn(ctx, { ...base, orderId: '64b000000000000000000000' }, who(o))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(requestReturn(ctx, base, who(o))).rejects.toMatchObject({ code: 'NOT_DELIVERED' }); // physical returns need delivery first
    await Order.updateOne({ _id: o._id }, { $set: { deliveredAt: new Date(Date.now() - 400 * 86_400_000) } });
    await expect(requestReturn(ctx, base, who(o))).rejects.toMatchObject({ code: 'WINDOW_PASSED' });
    await Order.updateOne({ _id: o._id }, { $set: { deliveredAt: new Date() } });
    await expect(requestReturn(ctx, { ...base, itemSkus: ['NOPE'] }, who(o))).rejects.toMatchObject({ code: 'BAD_ITEMS' });
    const unpaid = await Order.findOneAndUpdate({ _id: o._id }, { $set: { 'payment.status': 'pending' } });
    await expect(requestReturn(ctx, base, who(unpaid!))).rejects.toMatchObject({ code: 'NOT_PAID' });
    await Order.updateOne({ _id: o._id }, { $set: { 'payment.status': 'succeeded' } });
  });

  it('a "not delivered" claim is allowed before delivery, only one return can be open, reject restores the order, and approve → refund pays once', async () => {
    const o = await paid('ret2@example.com');
    const r = await requestReturn(ctx, { orderId: String(o._id), reason: 'not_delivered', details: 'never came', itemSkus: [o.items[0]!.sku] }, who(o));
    expect(r.status).toBe('requested');
    expect((await Order.findById(o._id).lean())!.status).toBe('REFUND_REQUESTED');
    await expect(requestReturn(ctx, { orderId: String(o._id), reason: 'not_delivered', details: 'again', itemSkus: [o.items[0]!.sku] }, who(o))).rejects.toMatchObject({ code: 'CONFLICT' });
    await decideReturn(ctx, String(r._id), 'reject', SYSTEM, 'tracking shows in transit');
    expect((await ReturnRequest.findById(r._id).lean())!.status).toBe('rejected');
    expect((await Order.findById(o._id).lean())!.status).toBe('IN_TRANSIT');
    await expect(decideReturn(ctx, String(r._id), 'approve', SYSTEM)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(decideReturn(ctx, String(r._id), 'refund', SYSTEM)).rejects.toMatchObject({ code: 'CONFLICT' });

    const r2 = await requestReturn(ctx, { orderId: String(o._id), reason: 'not_delivered', details: 'lost', itemSkus: [o.items[0]!.sku] }, who(o));
    expect((await decideReturn(ctx, String(r2._id), 'approve', SYSTEM, 'ok')).status).toBe('approved');
    await expect(decideReturn(ctx, String(r2._id), 'reject', SYSTEM)).rejects.toMatchObject({ code: 'CONFLICT' });
    const done = await decideReturn(ctx, String(r2._id), 'refund', { id: 'owner', type: 'user' }, 'refunded');
    expect(done.status).toBe('refunded');
    expect(await Refund.countDocuments({ orderId: o._id })).toBe(1);
    await expect(decideReturn(ctx, '64b000000000000000000000', 'approve', SYSTEM)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
