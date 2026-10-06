import { Order, Payment, Refund, Shipment } from '@orvia/database';
import type { Ctx } from '../infra/context';
import { raiseException } from './exceptions';

export interface ReconciliationFinding {
  kind: 'payment_without_order' | 'order_without_payment' | 'paid_order_without_supplier_order' | 'supplier_order_without_paid_order' | 'duplicate_supplier_order' | 'refund_mismatch' | 'tracking_mismatch';
  orderId?: string;
  detail: string;
}

const ACTIVE = ['PENDING_CREATE', 'CREATED', 'SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED'];

/**
 * Daily money/order consistency check. Read-only against providers (it only compares our own ledgers),
 * every discrepancy becomes a deduplicated RECONCILIATION exception. Safe to run repeatedly.
 */
export async function runReconciliation(ctx: Ctx, opts: { sinceDays?: number; graceMinutes?: number } = {}): Promise<{ checked: number; findings: ReconciliationFinding[] }> {
  const since = new Date(ctx.now().getTime() - (opts.sinceDays ?? 14) * 86_400_000);
  const grace = new Date(ctx.now().getTime() - (opts.graceMinutes ?? 120) * 60_000);
  const findings: ReconciliationFinding[] = [];
  const add = (f: ReconciliationFinding) => findings.push(f);

  // 1. successful payments whose order is missing
  const pays = await Payment.find({ status: { $in: ['succeeded', 'partially_refunded', 'refunded'] }, createdAt: { $gte: since } }).select('orderId amount').limit(5000).lean();
  const orderIds = new Set((await Order.find({ _id: { $in: pays.map((p) => p.orderId) } }).select('_id').lean()).map((o) => String(o._id)));
  for (const p of pays) if (!orderIds.has(String(p.orderId))) add({ kind: 'payment_without_order', orderId: String(p.orderId), detail: `Payment ${String(p._id)} succeeded but its order does not exist` });

  const orders = await Order.find({ createdAt: { $gte: since }, status: { $nin: ['PENDING_PAYMENT'] } }).select('orderNumber status payment items amounts exceptionOpen createdAt').limit(5000).lean();
  const ordIds = orders.map((o) => o._id);
  const payByOrder = new Map<string, { status: string; refunded: number }>();
  for (const p of await Payment.find({ orderId: { $in: ordIds } }).select('orderId status refundedAmount').lean()) payByOrder.set(String(p.orderId), { status: p.status, refunded: p.refundedAmount ?? 0 });
  const ships = await Shipment.find({ orderId: { $in: ordIds } }).select('orderId lineKey status supplierOrderId supplierId').lean();
  const shipsByOrder = new Map<string, typeof ships>();
  for (const s of ships) shipsByOrder.set(String(s.orderId), [...(shipsByOrder.get(String(s.orderId)) ?? []), s]);
  const refunds = await Refund.aggregate<{ _id: unknown; total: number }>([{ $match: { orderId: { $in: ordIds }, status: 'succeeded' } }, { $group: { _id: '$orderId', total: { $sum: '$amount' } } }]);
  const refundByOrder = new Map(refunds.map((r) => [String(r._id), r.total]));

  const seenSupplierOrders = new Map<string, string>();
  for (const o of orders) {
    const id = String(o._id);
    const pay = payByOrder.get(id);
    const paid = o.payment?.status === 'succeeded' || o.payment?.status === 'partially_refunded' || o.payment?.status === 'refunded';
    const cancelled = ['CANCELLED', 'REFUNDED'].includes(o.status);
    if (paid && !pay) add({ kind: 'order_without_payment', orderId: id, detail: `${o.orderNumber} is marked paid but has no payment record` });
    if (!paid && !cancelled && o.status !== 'EXCEPTION') add({ kind: 'order_without_payment', orderId: id, detail: `${o.orderNumber} is ${o.status} but payment is ${o.payment?.status}` });
    const mine = shipsByOrder.get(id) ?? [];
    const active = mine.filter((s) => ACTIVE.includes(s.status));
    if (paid && !cancelled && new Date(o.createdAt) < grace && !active.length && !o.exceptionOpen) add({ kind: 'paid_order_without_supplier_order', orderId: id, detail: `${o.orderNumber} was paid more than ${opts.graceMinutes ?? 120} minutes ago but has no supplier order and no open exception` });
    if ((!paid || cancelled) && active.length) add({ kind: 'supplier_order_without_paid_order', orderId: id, detail: `${o.orderNumber} has ${active.length} active supplier order(s) but is ${cancelled ? o.status : 'not paid'}` });
    const perLine = new Map<string, number>();
    for (const s of active) {
      perLine.set(s.lineKey, (perLine.get(s.lineKey) ?? 0) + 1);
      if (s.supplierOrderId) {
        const k = `${String(s.supplierId)}:${s.supplierOrderId}`;
        if (seenSupplierOrders.has(k) && seenSupplierOrders.get(k) !== `${id}:${s.lineKey}`) add({ kind: 'duplicate_supplier_order', orderId: id, detail: `Supplier order ${s.supplierOrderId} is attached to more than one order line` });
        seenSupplierOrders.set(k, `${id}:${s.lineKey}`);
      }
    }
    for (const [line, n] of perLine) if (n > 1) add({ kind: 'duplicate_supplier_order', orderId: id, detail: `${o.orderNumber} line ${line} has ${n} active supplier orders` });
    const refunded = refundByOrder.get(id) ?? 0;
    if (pay && Math.abs((pay.refunded ?? 0) - refunded) > 1) add({ kind: 'refund_mismatch', orderId: id, detail: `${o.orderNumber}: payment shows ${pay.refunded} refunded, refund ledger totals ${refunded}` });
    if (mine.length && mine.every((s) => s.status === 'DELIVERED') && o.status !== 'DELIVERED' && !cancelled) add({ kind: 'tracking_mismatch', orderId: id, detail: `${o.orderNumber}: every shipment is delivered but the order is ${o.status}` });
  }

  for (const f of findings) {
    await raiseException(ctx, { kind: 'RECONCILIATION', priority: f.kind === 'duplicate_supplier_order' || f.kind === 'supplier_order_without_paid_order' ? 'critical' : 'high', orderId: f.orderId, issue: `Reconciliation: ${f.detail}`, aiRecommendation: 'Investigate before money or stock moves further.', suggestedAction: 'Review', dedupeKey: `recon:${f.kind}:${f.orderId ?? f.detail}` });
  }
  return { checked: orders.length + pays.length, findings };
}
