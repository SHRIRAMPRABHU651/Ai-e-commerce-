import { ExceptionModel, Order } from '@orvia/database';
import type { ExceptionKind } from '@orvia/types';
import { audit } from '../infra/audit';
import { notFound, SYSTEM } from '../infra/context';
import type { Actor, Ctx } from '../infra/context';
import { metrics } from '@orvia/config';

export interface RaiseInput {
  kind: ExceptionKind;
  priority?: 'low' | 'medium' | 'high' | 'critical';
  issue: string;
  orderId?: string;
  productId?: string;
  customerEmail?: string;
  aiRecommendation?: string;
  suggestedAction?: string;
  /** machine-readable action the admin UI can execute: retry_supplier_order | approve_fulfillment | cancel_order | refund_order | pause_product | review_product | dismiss */
  actionCode?: string;
  details?: unknown;
  /** Re-raising the same open issue is a no-op. */
  dedupeKey?: string;
}

/** Never silent: every unrecoverable failure becomes a visible, deduplicated exception. */
export async function raiseException(ctx: Ctx, i: RaiseInput, actor: Actor = SYSTEM) {
  let doc;
  try {
    doc = await ExceptionModel.create({ ...i, status: 'open', priority: i.priority ?? 'medium' });
  } catch (e) {
    if ((e as { code?: number }).code === 11000 && i.dedupeKey) {
      return ExceptionModel.findOne({ dedupeKey: i.dedupeKey, status: { $in: ['open', 'in_progress'] } });
    }
    throw e;
  }
  metrics.inc('orvia_exceptions_total', { kind: i.kind });
  if (i.orderId) await Order.updateOne({ _id: i.orderId }, { $set: { exceptionOpen: true, status: 'EXCEPTION' }, $push: { timeline: { status: 'EXCEPTION', at: new Date(), note: i.issue, actor: actor.id } } });
  await audit(ctx, actor, { action: 'exception.raised', resource: 'exception', resourceId: String(doc._id), newValue: { kind: i.kind, issue: i.issue }, reason: i.issue });
  ctx.log.warn({ channel: 'order', exception: String(doc._id), kind: i.kind, orderId: i.orderId }, i.issue);
  return doc;
}

/** Resolve every open exception carrying this dedupe key (system-initiated, e.g. the supplier recovered). */
export async function resolveExceptionsFor(ctx: Ctx, dedupeKey: string, resolution = 'Resolved automatically'): Promise<number> {
  const open = await ExceptionModel.find({ dedupeKey, status: { $in: ['open', 'in_progress'] } }).select('_id').lean();
  for (const e of open) await resolveException(ctx, String(e._id), SYSTEM, resolution);
  return open.length;
}

export async function resolveException(ctx: Ctx, id: string, actor: Actor, resolution: string, status: 'resolved' | 'dismissed' = 'resolved') {
  const ex = await ExceptionModel.findById(id);
  if (!ex) throw notFound('Exception');
  ex.status = status;
  ex.resolution = resolution;
  ex.resolvedBy = actor.id;
  ex.resolvedAt = new Date();
  await ex.save();
  if (ex.orderId) {
    const stillOpen = await ExceptionModel.countDocuments({ orderId: ex.orderId, status: { $in: ['open', 'in_progress'] } });
    if (!stillOpen) {
      // lazy import avoids a cycle (orders -> exceptions -> orders)
      const { recomputeOrderStatus } = await import('./orderStatus');
      await Order.updateOne({ _id: ex.orderId }, { $set: { exceptionOpen: false } });
      await recomputeOrderStatus(String(ex.orderId));
    }
  }
  await audit(ctx, actor, { action: `exception.${status}`, resource: 'exception', resourceId: id, reason: resolution });
  return ex;
}
