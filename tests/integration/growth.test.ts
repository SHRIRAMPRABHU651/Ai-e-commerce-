import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Notification, Order, Promotion, Referral } from '@orvia/database';
import { fulfillOrder, settleReferral, syncTracking } from '@orvia/core';
import type { Ctx } from '@orvia/core';
import { closeCtx, testCtx } from '../helpers/ctx';
import { ageMockOrders, startApi } from '../helpers/client';
import type { Client } from '../helpers/client';
import { pay, placeOrder } from '../helpers/shop';
import { runSeed } from '../../scripts/lib/seed';

let ctx: Ctx;
let mk: (h?: Record<string, string>) => Client;
beforeAll(async () => {
  ctx = await testCtx('growth');
  await runSeed(ctx, { withHistory: false });
  mk = (await startApi(ctx)).client;
}, 180_000);
afterAll(closeCtx);

const register = async (email: string) => {
  const c = mk();
  const r = await c.post('/api/v1/auth/register', { email, password: 'Sup3rSecretPass', name: 'Ref Erer' });
  expect(r.status).toBe(201);
  return c;
};

/** order placed with the cart's coupon, paid, fulfilled and delivered */
async function deliveredOrder(c: Client, email: string) {
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

describe('shop by need', () => {
  it('lists only needs that have sellable products and pages through them', async () => {
    const c = mk();
    const list = await c.get('/api/v1/needs?country=US');
    expect(list.status).toBe(200);
    expect(list.body.needs.length).toBeGreaterThan(0);
    for (const n of list.body.needs) {
      expect(n.count).toBeGreaterThan(0);
      const page = await c.get(`/api/v1/needs/${n.slug}?country=US&pageSize=6`);
      expect(page.status).toBe(200);
      expect(page.body.total).toBe(n.count);
      expect(page.body.items.length).toBeGreaterThan(0);
      expect(page.body.items.every((p: any) => p.available && p.images.length > 0)).toBe(true);
      expect(JSON.stringify(page.body)).not.toMatch(/landedCost|supplierCost|bestSupplierId|expectedMargin/);
    }
    expect((await c.get('/api/v1/needs/not-a-need')).status).toBe(404);
  });
});

describe('referral loop', () => {
  it('issues one stable code per customer and requires login', async () => {
    expect((await mk().get('/api/v1/account/referrals')).status).toBe(401);
    const a = await register('ref-a@example.com');
    const [r1, r2] = await Promise.all([a.get('/api/v1/account/referrals'), a.get('/api/v1/account/referrals')]);
    expect(r1.body.code).toMatch(/^FRIEND-[0-9A-F]{6}$/);
    expect(r2.body.code).toBe(r1.body.code);
    expect(await Promotion.countDocuments({ code: r1.body.code })).toBe(1);
    expect(r1.body.link).toContain(`ref=${r1.body.code}`);
  });

  it('attaches the friend code to the cart without overriding a chosen coupon, and rejects unknown codes', async () => {
    const a = await register('ref-b@example.com');
    const { code } = (await a.get('/api/v1/account/referrals')).body;
    const friend = mk();
    expect((await friend.post('/api/v1/referrals/claim', { code: 'FRIEND-NOPE00' })).body).toEqual({ valid: false, applied: false });
    const ok = await friend.post('/api/v1/referrals/claim', { code: code.toLowerCase() });
    expect(ok.body).toMatchObject({ valid: true, applied: true, percent: 0.1 });
    expect(JSON.stringify(ok.body)).not.toMatch(/ref-b@|userId|email/); // never reveals the referrer
    const other = mk();
    await other.get('/api/v1/cart');
    await other.post('/api/v1/cart/coupon', { code: 'WELCOME10' });
    expect((await other.post('/api/v1/referrals/claim', { code })).body.applied).toBe(false);
    expect((await other.get('/api/v1/cart')).body.couponCode).toBe('WELCOME10');
  });

  it('rewards the referrer once, only after delivery, and never for self-referral', async () => {
    const a = await register('ref-c@example.com');
    const { code } = (await a.get('/api/v1/account/referrals')).body;

    // friend buys with the code
    const friend = mk();
    await friend.post('/api/v1/referrals/claim', { code });
    const order = await deliveredOrder(friend, 'friend-c@example.com');
    expect(order.couponCode).toBe(code);
    expect(order.status).toBe('DELIVERED');
    expect(order.amounts!.discount).toBeGreaterThan(0);

    expect(await Referral.countDocuments({ refereeEmail: 'friend-c@example.com' })).toBe(0); // not before the settlement job
    await ctx.queue.drain(30);
    expect(await settleReferral(ctx, String(order._id))).toBe('skipped'); // already settled by the job, idempotent
    const row = (await Referral.findOne({ refereeEmail: 'friend-c@example.com' }).lean())!;
    expect(row.status).toBe('rewarded');
    const reward = (await Promotion.findOne({ code: row.rewardCode }).lean())!;
    expect(reward).toMatchObject({ usageLimit: 1, percent: 0.1 });
    expect(reward.endsAt!.getTime()).toBeGreaterThan(Date.now());
    const mail = await Notification.findOne({ to: 'ref-c@example.com', template: 'referral_reward' }).lean();
    expect(mail!.body).toContain(row.rewardCode!);
    const summary = (await a.get('/api/v1/account/referrals')).body;
    expect(summary).toMatchObject({ friendsOrdered: 1, rewardsEarned: 1 });
    expect(summary.rewards[0]).toMatchObject({ code: row.rewardCode, status: 'available' });

    // self-referral: same customer uses their own code -> discount works, no reward
    const self = await register('ref-d@example.com');
    const mine = (await self.get('/api/v1/account/referrals')).body.code;
    await self.post('/api/v1/referrals/claim', { code: mine });
    const own = await deliveredOrder(self, 'ref-d@example.com');
    expect(await settleReferral(ctx, String(own._id))).toBe('rejected');
    expect((await Referral.findOne({ refereeEmail: 'ref-d@example.com' }).lean())!.status).toBe('rejected');
    expect(await Promotion.countDocuments({ recommendedBy: 'referral-reward' })).toBe(1);
  }, 180_000);

  it('does not reward an order that was not delivered (e.g. refunded)', async () => {
    const a = await register('ref-e@example.com');
    const { code } = (await a.get('/api/v1/account/referrals')).body;
    const friend = mk();
    await friend.post('/api/v1/referrals/claim', { code });
    const { co } = await placeOrder(friend, { country: 'US', email: 'friend-e@example.com' });
    await pay(friend, co.body.payment.intentId);
    const order = (await Order.findOne({ orderNumber: co.body.order.orderNumber }))!;
    expect(await settleReferral(ctx, String(order._id))).toBe('skipped');
    expect(await Referral.countDocuments({ refereeEmail: 'friend-e@example.com' })).toBe(0);
  });
});
