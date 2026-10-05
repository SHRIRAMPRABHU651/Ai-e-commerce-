import { Order, ReturnRequest } from '@orvia/database';
import { getCountry } from '../infra/countries';
import { audit } from '../infra/audit';
import { conflict, DomainError, forbidden, notFound } from '../infra/context';
import type { Actor, Ctx } from '../infra/context';
import { notify } from './notify';
import { refundOrder } from './orders';

export async function requestReturn(ctx: Ctx, input: { orderId: string; reason: string; details: string; itemSkus: string[] }, who: { userId?: string; email?: string; actor: Actor }) {
  const order = await Order.findById(input.orderId);
  if (!order) throw notFound('Order');
  if ((who.userId && String(order.userId) !== who.userId) && who.email !== order.email) throw forbidden();
  if (!who.userId && who.email !== order.email) throw forbidden();
  if (order.payment?.status !== 'succeeded' && order.payment?.status !== 'partially_refunded') throw new DomainError('Order was not paid', 'NOT_PAID', 409);
  const cfg = await getCountry(order.country);
  const basis = order.deliveredAt ?? null;
  // Not delivered: a "not delivered" claim is allowed; physical returns need delivery first.
  if (!basis && input.reason !== 'not_delivered') throw new DomainError('Returns can be requested after delivery', 'NOT_DELIVERED', 409);
  if (basis && ctx.now().getTime() - basis.getTime() > cfg.returnWindowDays * 86_400_000) throw new DomainError(`The ${cfg.returnWindowDays}-day return window has passed`, 'WINDOW_PASSED', 409);
  const skus = new Set(order.items.map((i) => i.sku));
  if (!input.itemSkus.every((s) => skus.has(s))) throw new DomainError('Unknown item in return', 'BAD_ITEMS', 422);
  const open = await ReturnRequest.findOne({ orderId: order._id, status: { $in: ['requested', 'approved', 'received'] } });
  if (open) throw conflict('A return is already in progress for this order');
  const r = await ReturnRequest.create({ orderId: order._id, userId: order.userId, email: order.email, reason: input.reason, details: input.details, itemSkus: input.itemSkus, status: 'requested' });
  await Order.updateOne({ _id: order._id }, { $set: { status: 'REFUND_REQUESTED' }, $push: { timeline: { status: 'REFUND_REQUESTED', at: ctx.now(), note: `return requested: ${input.reason}`, actor: who.actor.id } } });
  await audit(ctx, who.actor, { action: 'return.requested', resource: 'return', resourceId: String(r._id), reason: input.reason });
  return r;
}

export async function decideReturn(ctx: Ctx, id: string, decision: 'approve' | 'reject' | 'refund', actor: Actor, note = '') {
  const r = await ReturnRequest.findById(id);
  if (!r) throw notFound('Return');
  const order = await Order.findById(r.orderId);
  if (!order) throw notFound('Order');
  if (decision === 'reject') {
    if (r.status !== 'requested') throw conflict(`Return is ${r.status}`);
    r.status = 'rejected';
    r.resolutionNote = note;
    await r.save();
    await Order.updateOne({ _id: order._id }, { $set: { status: order.deliveredAt ? 'DELIVERED' : 'IN_TRANSIT' } });
  } else if (decision === 'approve') {
    if (r.status !== 'requested') throw conflict(`Return is ${r.status}`);
    r.status = 'approved';
    r.resolutionNote = note;
    await r.save();
  } else {
    if (!['requested', 'approved', 'received'].includes(r.status)) throw conflict(`Return is ${r.status}`);
    const lines = order.items.filter((i) => r.itemSkus.includes(i.sku));
    const itemsSubtotal = lines.reduce((a, i) => a + i.unitPrice * i.quantity, 0);
    const subtotal = order.amounts?.subtotal || 1;
    const total = order.amounts?.total ?? 0;
    const full = lines.length === order.items.length;
    const amount = full ? undefined : Math.round((total * itemsSubtotal) / subtotal);
    const refund = await refundOrder(ctx, String(order._id), { actor, amount, reason: `return ${id}: ${r.reason}`, keyHint: `ret-${id}` });
    r.status = 'refunded';
    r.refundId = refund._id;
    r.resolutionNote = note;
    await r.save();
  }
  await audit(ctx, actor, { action: `return.${decision}`, resource: 'return', resourceId: id, reason: note });
  if (decision !== 'refund') {
    await notify(ctx, { template: 'promotion', to: order.email, data: { name: order.address?.fullName ?? undefined, discount: undefined, productTitle: `Return ${decision === 'approve' ? 'approved' : 'update'} for ${order.orderNumber}` }, dedupeKey: `return-mail:${id}:${decision}` }).catch(() => undefined);
  }
  return r;
}
