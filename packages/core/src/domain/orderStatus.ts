import { Order, Shipment } from '@orvia/database';
import type { OrderStatus } from '@orvia/types';

/** Derive the order status from payment + shipment facts (single source of truth for status). */
export async function recomputeOrderStatus(orderId: string, note?: string): Promise<OrderStatus | null> {
  const order = await Order.findById(orderId);
  if (!order) return null;
  if (['CANCELLED', 'REFUNDED', 'REFUND_REQUESTED'].includes(order.status) && !order.exceptionOpen) return order.status as OrderStatus;
  let next: OrderStatus;
  if (order.exceptionOpen) next = 'EXCEPTION';
  else if (order.payment?.status !== 'succeeded' && order.payment?.status !== 'partially_refunded') next = 'PENDING_PAYMENT';
  else {
    const ships = await Shipment.find({ orderId: order._id }).select('status').lean();
    const live = ships.filter((s) => s.status !== 'CANCELLED' && s.status !== 'FAILED');
    if (!live.length) next = 'PAID';
    else if (live.every((s) => s.status === 'DELIVERED')) next = 'DELIVERED';
    else if (live.some((s) => ['IN_TRANSIT', 'OUT_FOR_DELIVERY'].includes(s.status))) next = 'IN_TRANSIT';
    else if (live.some((s) => ['SHIPPED', 'DELIVERED'].includes(s.status))) next = 'SHIPPED';
    else next = 'SUPPLIER_PROCESSING';
  }
  if (next !== order.status) {
    order.status = next;
    order.timeline.push({ status: next, at: new Date(), note: note ?? 'status recomputed', actor: 'system' });
    if (next === 'DELIVERED') order.deliveredAt = new Date();
    await order.save();
  }
  return next;
}
