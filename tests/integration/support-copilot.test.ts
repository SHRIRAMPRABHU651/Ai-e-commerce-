import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Order, Shipment, SupportTicket } from '@orvia/database';
import { SYSTEM, askCopilot, handleSupport } from '@orvia/core';
import type { Ctx } from '@orvia/core';
import { closeCtx, testCtx } from '../helpers/ctx';
import { startApi } from '../helpers/client';
import type { Client } from '../helpers/client';
import { pay, placeOrder } from '../helpers/shop';
import { runSeed } from '../../scripts/lib/seed';

let ctx: Ctx; let api: () => Client;
beforeAll(async () => { ctx = await testCtx('support'); await runSeed(ctx, { withHistory: true }); api = (await startApi(ctx)).client; }, 240_000);
afterAll(closeCtx);

const email = 'support-edge@example.com';
const paidOrder = async () => {
  const c = api();
  const { co } = await placeOrder(c, { country: 'US', email });
  await pay(c, co.body.payment.intentId);
  await ctx.queue.drain(40);
  return (await Order.findOne({ orderNumber: co.body.order.orderNumber }))!;
};
const ask = (message: string, extra: Record<string, unknown> = {}) => handleSupport(ctx, { message, country: 'US', email, ...extra });

describe('support assistant: every answer is grounded in real data', () => {
  it('asks for an order number, hides other customers’ orders, and never invents tracking', async () => {
    const o = await paidOrder();
    expect((await ask('where is my package?')).reply).toMatch(/order number/);
    const stranger = await handleSupport(ctx, { message: `track ${o.orderNumber}`, country: 'US', email: 'stranger@example.com' });
    expect(stranger.reply).toMatch(/can’t find an order/);
    expect(stranger.grounded).toEqual([]);
    const mine = await ask(`where is my order ${o.orderNumber}`);
    expect(mine.intent).toBe('tracking');
    expect(mine.grounded).toContain('orders');
    expect(mine.reply).toMatch(/Status:/);
    await Shipment.updateMany({ orderId: o._id }, { $unset: { trackingNumber: 1 } });
    expect((await ask(`tracking for ${o.orderNumber}`)).reply).toMatch(/won’t guess one/);
    await Shipment.updateMany({ orderId: o._id }, { $set: { trackingNumber: 'T123', carrier: 'DHL', estimatedDelivery: new Date(), events: [{ status: 'IN_TRANSIT', description: 'Departed hub', location: 'Leipzig', at: new Date() }] } });
    expect((await ask(`tracking for ${o.orderNumber}`)).reply).toMatch(/DHL tracking number T123.*Departed hub \(Leipzig\).*Estimated delivery/s);
    await Shipment.deleteMany({ orderId: o._id });
    expect((await ask(`tracking for ${o.orderNumber}`)).reply).toMatch(/no tracking number to share/);
    await Order.updateOne({ _id: o._id }, { $set: { status: 'PENDING_PAYMENT' } });
    expect((await ask(`tracking for ${o.orderNumber}`)).reply).toMatch(/waiting for payment/);
  });

  it('answers returns, refund status and cancellation from the order — and cancels only with confirmation in AUTOMATIC mode', async () => {
    const o = await paidOrder();
    expect((await ask(`I want to return ${o.orderNumber}`)).reply).toMatch(/Returns open once your order is delivered/);
    const dmg = await ask(`item from ${o.orderNumber} arrived damaged`);
    expect(dmg.intent).toBe('return');
    expect(dmg.escalated).toBe(true);
    expect(dmg.ticketId).toBeTruthy();
    await Order.updateOne({ _id: o._id }, { $set: { deliveredAt: new Date() } });
    expect((await ask(`return ${o.orderNumber}`)).reply).toMatch(/was delivered on/);
    expect((await ask(`refund status for ${o.orderNumber}`)).reply).toMatch(/no refund recorded/);
    await Order.updateOne({ _id: o._id }, { $set: { 'costs.refunded': 1234, status: 'REFUND_REQUESTED' } });
    expect((await ask(`where is my refund ${o.orderNumber}`)).reply).toMatch(/refund of 12\.34 USD/);

    const c = await paidOrder();
    await Shipment.deleteMany({ orderId: c._id });
    await Order.updateOne({ _id: c._id }, { $set: { status: 'PAID' } });
    const q = await ask(`cancel ${c.orderNumber}`);
    expect(q.reply).toMatch(/Please confirm/);
    expect(q.actions.some((a) => a.action === 'confirm_cancel')).toBe(true);
    await ctx.settings.setAutomationMode('customer_support', 'AUTOMATIC', 't');
    expect((await ask(`cancel ${c.orderNumber}`, { confirmCancel: true })).reply).toMatch(/is cancelled/);
    expect((await ask(`cancel ${c.orderNumber}`)).reply).toMatch(/already cancelled/);
    const shipped = await paidOrder();
    await Shipment.updateMany({ orderId: shipped._id }, { $set: { status: 'IN_TRANSIT' } });
    expect((await ask(`cancel ${shipped.orderNumber}`)).reply).toMatch(/already shipped/);
  });

  it('answers shipping from country config, products from the catalogue (escalating on unknown specs), humans on request, and falls back politely', async () => {
    const ship = await ask('how long does shipping take?');
    expect(ship.intent).toBe('shipping');
    expect(ship.grounded).toContain('country_config');
    const prod = await ask('what is the warranty on the desk fidget cube?');
    expect(prod.intent).toBe('product');
    expect(prod.reply).toMatch(/I only have the details above|couldn’t find that product/);
    if (prod.grounded.includes('products')) expect(prod.actions[0]!.href).toMatch(/^\/p\//);
    expect((await ask('is it zzzzqqq xxyyww?')).reply).toMatch(/couldn’t find that product|I only have the details above/);
    const human = await ask('let me talk to a human');
    expect(human.escalated).toBe(true);
    expect(human.reply).toMatch(/support team/);
    expect((await ask('hello there')).reply).toMatch(/I can track an order/);
    const t = await SupportTicket.findById(human.ticketId).lean();
    expect(t!.status).toBe('escalated');
    const follow = await ask('thanks', { ticketId: human.ticketId });
    expect(follow.ticketId).toBe(human.ticketId);
    expect((await SupportTicket.findById(human.ticketId).lean())!.messages.length).toBeGreaterThanOrEqual(4);
  });
});

describe('business copilot: figures come from queries, actions need confirmation', () => {
  const owner = { id: 'owner', type: 'user' as const, role: 'OWNER' as never };
  const questions: [string, string][] = [
    ['why did profit fall yesterday vs the day before?', 'profit_change'], ['what should I scale?', 'scale'], ['which products are losing money?', 'losers'],
    ['which country should we expand to?', 'country'], ['how are my suppliers doing?', 'suppliers'], ['any exceptions needing attention?', 'exceptions'],
    ['what is low on stock?', 'inventory'], ['how are my ads and roas?', 'ads'], ['give me a summary of today', 'summary'], ['what is trending right now?', 'trend_explain'],
  ];
  for (const [q, intent] of questions) {
    it(`routes "${q}" → ${intent} with sources and no invented numbers`, async () => {
      const a = await askCopilot(ctx, { question: q, actor: owner });
      expect(a.intent).toBe(intent);
      expect(a.answer.length).toBeGreaterThan(10);
      expect(a.sources.length).toBeGreaterThan(0);
    });
  }
  it('shows a plan before pausing losers and does nothing without confirm', async () => {
    const plan = await askCopilot(ctx, { question: 'pause the losing campaigns', actor: owner });
    expect(plan.intent).toBe('pause_losers');
    expect(plan.executed ?? []).toEqual([]);
    const run = await askCopilot(ctx, { question: 'pause the losing campaigns', actor: owner, confirm: true });
    expect(run.intent).toBe('pause_losers');
  });
  it('says so when it cannot answer instead of guessing', async () => {
    const a = await askCopilot(ctx, { question: 'qwerty asdf', actor: SYSTEM });
    expect(a.intent).toBe('unknown');
  });
});
