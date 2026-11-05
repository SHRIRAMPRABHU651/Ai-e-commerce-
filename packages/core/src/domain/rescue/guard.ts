/**
 * Idempotency-key derivation and the duplicate-supplier-order guard. Pure.
 * The guard is the last line of defence against ordering the same unit twice.
 */
import { createHash } from 'node:crypto';

const h = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/** Unique per (case, action kind, target). The DB has a unique index on it, so two workers can never both act. */
export function actionKey(caseId: string, kind: string, target = ''): string {
  return `rescue:${caseId}:${kind}:${target ? h(target) : '-'}`;
}
/** Idempotency key sent to the SUPPLIER and stored on the Shipment row (unique there too). One reorder per case + line. */
export function supplierOrderKey(caseId: string, orderId: string, lineKey: string): string {
  return `rescue-ship:${orderId}:${lineKey}:${caseId}`;
}
/** One ACTIVE case per order line. */
export function caseDedupeKey(orderId: string, lineKey: string): string {
  return `rescue:${orderId}:${lineKey}`;
}
export function refundKeyHint(caseId: string, kind: string): string {
  return `rescue-${caseId}-${kind}`;
}

export interface GuardShipment {
  id: string;
  status: string;
  supplierOrderId?: string | null;
  idempotencyKey?: string;
}

export type GuardDecision =
  | { allow: true; cancelFirst: GuardShipment | null; overrideUsed: boolean; reason: string }
  | { allow: false; code: 'already_reordered' | 'maybe_with_supplier' | 'goods_in_transit' | 'delivered' | 'unconfirmed'; reason: string };

/**
 * Decide whether a replacement supplier order may be placed for a line.
 * - nothing live / only FAILED|CANCELLED rows: allow.
 * - a row already created by this case: never again.
 * - PENDING_CREATE without a supplier order id: the supplier may already hold the order (a crash can happen after the call), so refuse.
 * - CREATED with a supplier order id: must be cancelled and the cancellation CONFIRMED first.
 * - dispatched: goods may still arrive; only with explicit staff acknowledgement of the duplicate risk.
 * - DELIVERED: never.
 */
export function duplicateOrderGuard(p: { supplierOrderKeyForCase: string; shipments: GuardShipment[]; staffAcknowledgedDuplicateRisk?: boolean }): GuardDecision {
  if (p.shipments.some((s) => s.idempotencyKey === p.supplierOrderKeyForCase && !['FAILED', 'CANCELLED'].includes(s.status))) {
    return { allow: false, code: 'already_reordered', reason: 'A replacement supplier order for this case already exists.' };
  }
  const live = p.shipments.filter((s) => !['FAILED', 'CANCELLED'].includes(s.status));
  if (!live.length) return { allow: true, cancelFirst: null, overrideUsed: false, reason: 'No active supplier order exists for this line.' };
  if (live.length > 1) return { allow: false, code: 'unconfirmed', reason: 'More than one active supplier order exists for this line; a human must reconcile them first.' };
  const s = live[0]!;
  if (s.status === 'DELIVERED') return { allow: false, code: 'delivered', reason: 'The original shipment is marked delivered.' };
  if (s.status === 'RETURNED') return { allow: true, cancelFirst: null, overrideUsed: false, reason: 'The parcel was returned to the supplier.' };
  if (s.status === 'PENDING_CREATE') {
    return s.supplierOrderId
      ? { allow: true, cancelFirst: s, overrideUsed: false, reason: 'Pending row carries a supplier order id: cancel it first.' }
      : { allow: false, code: 'maybe_with_supplier', reason: 'A supplier order is pending creation and the supplier may already hold it; refusing to order again.' };
  }
  if (['SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY'].includes(s.status)) {
    return p.staffAcknowledgedDuplicateRisk
      ? { allow: true, cancelFirst: null, overrideUsed: true, reason: 'Staff acknowledged the original parcel may still arrive.' }
      : { allow: false, code: 'goods_in_transit', reason: 'The original parcel is dispatched and may still arrive; a human must acknowledge the duplicate risk.' };
  }
  if (!s.supplierOrderId) return { allow: false, code: 'maybe_with_supplier', reason: 'Active row without a supplier order id; ownership unclear.' };
  return { allow: true, cancelFirst: s, overrideUsed: false, reason: 'The original supplier order must be cancelled (and confirmed) first.' };
}
