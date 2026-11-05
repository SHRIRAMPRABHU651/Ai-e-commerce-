/**
 * Delivery Rescue: pure failure classifier. No IO, no mongoose, no clock (the caller passes `now`).
 * Given plain facts about an order and its shipments it says which lines are in trouble, why, and how badly.
 * Every claim in the evidence list carries its provenance; nothing is inferred silently.
 */
import { RESCUE_FAILURE_KINDS } from '@orvia/types';
import type { RescueEvidence, RescueFailureKind, RescuePolicy, RescueSeverity } from '@orvia/types';

export const SHIPMENT_LIVE = ['PENDING_CREATE', 'CREATED', 'SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'RETURNED'] as const;
const DISPATCHED = ['SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY'];
const DAY = 86_400_000;

export interface ClassifierShipment {
  id: string;
  lineKey: string;
  status: string;
  supplierId: string;
  supplierOrderId?: string | null;
  trackingNumber?: string | null;
  carrier?: string | null;
  estimatedDelivery?: Date | null;
  createdAt: Date;
  lastError?: string | null;
  attempts?: number;
  events: { status?: string; description?: string; at: Date }[];
}

export interface ClassifierOrder {
  orderId: string;
  orderNumber: string;
  status: string;
  paymentStatus?: string;
  paidAt?: Date | null;
  currency: string;
  country: string;
  exceptionOpen?: boolean;
  fulfillmentState?: string;
  fulfillmentLastError?: string | null;
  items: { lineKey: string; title: string; quantity: number; unitPrice: number; productId: string; sku: string }[];
  shipments: ClassifierShipment[];
  openExceptions?: { kind: string; issue: string }[];
}

export interface RescueDetection {
  orderId: string;
  orderNumber: string;
  lineKey: string;
  kind: RescueFailureKind;
  severity: RescueSeverity;
  evidence: RescueEvidence[];
  /** The shipment the signal was read from (null for acceptance failures). */
  shipmentId: string | null;
  /** Value of the affected line in minor units (unitPrice * quantity). */
  lineValue: number;
  daysOverdue: number;
  /** Other kinds that also fired for this line (lower priority; kept as evidence only). */
  alsoDetected: RescueFailureKind[];
}

const STOCK_RE = /out[\s_-]?of[\s_-]?stock|insufficient (stock|inventory)|sold[\s_-]?out|no stock|unavailable|stock mismatch|backorder/i;
const CARRIER_EXC_RE = /exception|customs (hold|delay)|held at|damaged|address (issue|problem)|clearance|security delay|rerouted|misrouted/i;
const FAILED_DELIVERY_RE = /delivery attempt (failed|unsuccessful)|failed delivery|undeliverable|unable to deliver|recipient (not available|refused)|returned to sender|refused by (recipient|customer)/i;
const CANCEL_RE = /cancel/i;

/** A tracking number we can trust to be a real carrier reference: not empty, not a placeholder, plausible length. */
export function isPlausibleTracking(t?: string | null): boolean {
  if (!t) return false;
  const v = t.trim();
  if (v.length < 8 || v.length > 40) return false;
  if (!/^[A-Za-z0-9-]+$/.test(v)) return false;
  if (/^(0+|1+|n\/?a|none|null|undefined|test|pending|tbd|unknown|123456\d*)$/i.test(v)) return false;
  if (new Set(v.toLowerCase().replace(/-/g, '')).size < 3) return false; // "AAAAAAAAAA"
  return true;
}

const lastEventAt = (s: ClassifierShipment): Date | null => (s.events.length ? s.events.reduce((m, e) => (e.at > m ? e.at : m), s.events[0]!.at) : null);
const newestEventText = (s: ClassifierShipment): string => {
  if (!s.events.length) return '';
  const e = [...s.events].sort((a, b) => b.at.getTime() - a.at.getTime())[0]!;
  return `${e.status ?? ''} ${e.description ?? ''}`.trim();
};
const fmtD = (d: Date) => d.toISOString().slice(0, 10);

/** Effective ETA promised to the customer for a shipment, and where the date came from. */
export function promisedEta(s: ClassifierShipment, policy: RescuePolicy): { at: Date; source: 'supplier_provided' | 'policy' } {
  if (s.estimatedDelivery) return { at: s.estimatedDelivery, source: 'supplier_provided' };
  return { at: new Date(s.createdAt.getTime() + policy.detection.fallbackPromiseDays * DAY), source: 'policy' };
}

/** Severity is a pure function of kind, lateness and order value. `valueUsd` is the line value in USD minor units. */
export function severityFor(kind: RescueFailureKind, daysOverdue: number, valueUsd: number): RescueSeverity {
  const base: Record<RescueFailureKind, number> = {
    supplier_cancellation: 2,
    supplier_acceptance_failure: 2,
    stock_shortage: 2,
    failed_delivery: 2,
    suspected_lost: 3,
    carrier_exception: 1,
    invalid_tracking: 1,
    shipment_delay: 0,
    unusual_delivery_pattern: 0,
  };
  let score = base[kind];
  if (daysOverdue >= 7) score += 1;
  if (daysOverdue >= 21) score += 1;
  if (valueUsd >= 15_000) score += 1; // $150+
  if (kind === 'unusual_delivery_pattern') score = Math.min(score, 1); // advisory by nature
  return (['low', 'medium', 'high', 'critical'] as const)[Math.max(0, Math.min(3, score))]!;
}

/**
 * Classify every line of an order. At most ONE detection per line (the highest-priority kind);
 * other kinds that fired are listed in `alsoDetected` and in the evidence.
 */
export function classifyOrder(o: ClassifierOrder, policy: RescuePolicy, now: Date, toUsd: (minor: number) => number = (n) => n): RescueDetection[] {
  if (['CANCELLED', 'REFUNDED', 'PENDING_PAYMENT', 'REFUND_REQUESTED'].includes(o.status)) return [];
  if (o.paymentStatus && o.paymentStatus !== 'succeeded' && o.paymentStatus !== 'partially_refunded') return [];
  const out: RescueDetection[] = [];
  for (const item of o.items) {
    const lineShips = o.shipments.filter((s) => s.lineKey === item.lineKey);
    const live = lineShips.find((s) => (SHIPMENT_LIVE as readonly string[]).includes(s.status));
    const found = new Map<RescueFailureKind, { evidence: RescueEvidence[]; shipmentId: string | null; daysOverdue: number }>();
    const add = (kind: RescueFailureKind, evidence: RescueEvidence[], shipmentId: string | null, daysOverdue = 0) => {
      const cur = found.get(kind);
      if (cur) cur.evidence.push(...evidence);
      else found.set(kind, { evidence, shipmentId, daysOverdue });
    };

    const paidAt = o.paidAt ?? null;
    const sinceMinutes = paidAt ? (now.getTime() - paidAt.getTime()) / 60_000 : 0;
    const exMatch = (re: RegExp) => (o.openExceptions ?? []).filter((e) => re.test(e.issue));
    const failedShips = lineShips.filter((s) => s.status === 'FAILED');

    // ---- supplier cancellation: the supplier order was cancelled but the customer order is still live
    const cancelled = lineShips.filter((s) => s.status === 'CANCELLED');
    if (!live && cancelled.length) {
      const c = cancelled[cancelled.length - 1]!;
      add('supplier_cancellation', [{ code: 'shipment_cancelled', detail: `Supplier order for "${item.title}" is CANCELLED while the customer order is ${o.status}.`, provenance: 'verified', at: c.createdAt.toISOString() }], c.id);
    }
    if (live && live.status !== 'DELIVERED' && live.events.some((e) => CANCEL_RE.test(`${e.status ?? ''} ${e.description ?? ''}`) && !/cancel(l)?ation (pending|requested by customer)/i.test(e.description ?? ''))) {
      add('supplier_cancellation', [{ code: 'tracking_event_cancel', detail: 'Tracking history reports a cancellation.', provenance: 'supplier_provided' }], live.id);
    }

    // ---- stock shortage
    const stockShips = [...failedShips, ...(live ? [live] : [])].filter((s) => s.lastError && STOCK_RE.test(s.lastError));
    for (const s of stockShips) add('stock_shortage', [{ code: 'supplier_error_stock', detail: `Supplier refused with a stock error: ${s.lastError}`, provenance: 'supplier_provided' }], s.id);
    for (const e of exMatch(STOCK_RE)) add('stock_shortage', [{ code: 'exception_stock', detail: `Open exception: ${e.issue}`, provenance: 'verified' }], null);
    if (o.fulfillmentLastError && STOCK_RE.test(o.fulfillmentLastError) && !live) add('stock_shortage', [{ code: 'fulfillment_error_stock', detail: `Fulfilment error: ${o.fulfillmentLastError}`, provenance: 'verified' }], null);

    // ---- supplier acceptance failure: nothing placed for a paid line after the grace window
    if (!live && !cancelled.length && sinceMinutes >= policy.detection.acceptanceGraceMinutes) {
      const exSup = (o.openExceptions ?? []).filter((e) => e.kind === 'SUPPLIER_FAILURE' || e.kind === 'MANUAL_FULFILLMENT');
      const pinned = lineShips.filter((s) => s.status === 'FAILED' || (s.lastError && s.status === 'PENDING_CREATE'));
      const fulfilmentFailed = o.fulfillmentState === 'failed';
      if (exSup.length || pinned.length || fulfilmentFailed) {
        const ev: RescueEvidence[] = [{ code: 'no_supplier_order', detail: `No supplier order exists for "${item.title}" ${Math.round(sinceMinutes)} minutes after payment.`, provenance: 'verified' }];
        for (const e of exSup) ev.push({ code: 'exception_open', detail: e.issue, provenance: 'verified' });
        for (const s of pinned) if (s.lastError) ev.push({ code: 'supplier_error', detail: s.lastError, provenance: 'supplier_provided' });
        if (fulfilmentFailed) ev.push({ code: 'fulfillment_failed', detail: o.fulfillmentLastError ?? 'Fulfilment state is failed.', provenance: 'verified' });
        add('supplier_acceptance_failure', ev, pinned[0]?.id ?? null);
      }
    }
    // placed row stuck without ever reaching the supplier
    if (live?.status === 'PENDING_CREATE' && (live.attempts ?? 0) >= 1 && live.lastError && (now.getTime() - live.createdAt.getTime()) / 60_000 >= policy.detection.acceptanceGraceMinutes) {
      add('supplier_acceptance_failure', [{ code: 'pending_create_stuck', detail: `Supplier order has been pending ${Math.round((now.getTime() - live.createdAt.getTime()) / 60_000)} min with error: ${live.lastError}`, provenance: 'supplier_provided' }], live.id);
    }

    if (live) {
      const text = newestEventText(live);
      const eta = promisedEta(live, policy);
      const idleBase = lastEventAt(live) ?? live.createdAt;
      const overdueDays = (now.getTime() - eta.at.getTime()) / DAY;
      const dispatched = DISPATCHED.includes(live.status);

      // ---- failed delivery
      if (live.status === 'RETURNED' || FAILED_DELIVERY_RE.test(text)) {
        add('failed_delivery', [{ code: live.status === 'RETURNED' ? 'status_returned' : 'event_failed_delivery', detail: live.status === 'RETURNED' ? 'Parcel was returned to the sender.' : `Latest tracking event: ${text}`, provenance: 'supplier_provided' }], live.id, Math.max(0, overdueDays));
      }
      // ---- carrier exception
      else if (live.status !== 'DELIVERED' && CARRIER_EXC_RE.test(text)) {
        add('carrier_exception', [{ code: 'event_exception', detail: `Latest tracking event: ${text}`, provenance: 'supplier_provided' }], live.id, Math.max(0, overdueDays));
      }

      // ---- suspected lost: dispatched, silent for N days or far past ETA
      if (dispatched) {
        const idleDays = (now.getTime() - idleBase.getTime()) / DAY;
        const ev: RescueEvidence[] = [];
        if (idleDays >= policy.detection.lostAfterIdleDays) ev.push({ code: 'no_tracking_updates', detail: `No tracking update for ${Math.floor(idleDays)} days (last: ${fmtD(idleBase)}).`, provenance: 'verified' });
        if (overdueDays >= policy.detection.lostAfterOverdueDays) ev.push({ code: 'far_past_eta', detail: `${Math.floor(overdueDays)} days past the ${eta.source === 'policy' ? 'policy-assumed' : 'supplier-provided'} ETA ${fmtD(eta.at)}.`, provenance: eta.source === 'policy' ? 'verified' : 'supplier_provided' });
        if (ev.length) add('suspected_lost', ev, live.id, Math.max(0, overdueDays));
      }

      // ---- invalid / missing tracking after dispatch
      if (live.status !== 'DELIVERED' && live.status !== 'PENDING_CREATE') {
        const ageDays = (now.getTime() - live.createdAt.getTime()) / DAY;
        const dispatchedOrOld = dispatched || ageDays >= policy.detection.trackingGraceDays;
        if (dispatchedOrOld && live.supplierOrderId && !isPlausibleTracking(live.trackingNumber)) {
          const why = live.trackingNumber ? `Tracking number "${live.trackingNumber.slice(0, 40)}" does not look like a valid carrier reference.` : `No tracking number ${Math.floor(ageDays)} days after the supplier order was placed.`;
          if (ageDays >= policy.detection.trackingGraceDays) add('invalid_tracking', [{ code: live.trackingNumber ? 'tracking_implausible' : 'tracking_missing', detail: why, provenance: 'verified' }], live.id, Math.max(0, overdueDays));
        }
      }

      // ---- shipment delay vs promise
      if (live.status !== 'DELIVERED' && live.status !== 'RETURNED' && overdueDays > policy.detection.delayGraceDays) {
        add('shipment_delay', [{ code: 'past_eta', detail: `${Math.floor(overdueDays)} days past the ${eta.source === 'policy' ? 'policy-assumed' : 'supplier-provided'} ETA ${fmtD(eta.at)} (grace ${policy.detection.delayGraceDays} days).`, provenance: eta.source === 'policy' ? 'verified' : 'supplier_provided' }], live.id, overdueDays);
      }

      // ---- unusual patterns (advisory)
      if (live.status === 'DELIVERED') {
        const ev: RescueEvidence[] = [];
        const hours = (lastEventAt(live)?.getTime() ?? now.getTime()) - live.createdAt.getTime();
        if (live.events.length && hours >= 0 && hours < 2 * 3_600_000) ev.push({ code: 'delivered_implausibly_fast', detail: `Marked delivered ${Math.round(hours / 60_000)} minutes after the supplier order was created.`, provenance: 'supplier_provided' });
        if (live.events.length <= 1) ev.push({ code: 'delivered_without_transit', detail: 'Delivered with no in-transit tracking history.', provenance: 'supplier_provided' });
        const sorted = [...live.events].sort((a, b) => a.at.getTime() - b.at.getTime());
        const di = sorted.findIndex((e) => /deliver/i.test(`${e.status ?? ''}`) && !/out_for/i.test(`${e.status ?? ''}`));
        if (di >= 0 && sorted.slice(di + 1).some((e) => /transit|shipped|out_for/i.test(`${e.status ?? ''}`))) ev.push({ code: 'activity_after_delivery', detail: 'Tracking shows movement after the delivered scan.', provenance: 'supplier_provided' });
        if (ev.length >= 2 || ev.some((e) => e.code === 'activity_after_delivery' || e.code === 'delivered_implausibly_fast')) add('unusual_delivery_pattern', ev, live.id);
      }
    }

    if (!found.size) continue;
    const kinds = RESCUE_FAILURE_KINDS.filter((k) => found.has(k));
    const top = kinds[0]!;
    const f = found.get(top)!;
    const others = kinds.slice(1);
    const evidence = [...f.evidence];
    for (const k of others) for (const e of found.get(k)!.evidence) evidence.push({ ...e, code: `${k}:${e.code}` });
    const lineValue = item.unitPrice * item.quantity;
    out.push({
      orderId: o.orderId,
      orderNumber: o.orderNumber,
      lineKey: item.lineKey,
      kind: top,
      severity: severityFor(top, f.daysOverdue, toUsd(lineValue)),
      evidence,
      shipmentId: f.shipmentId,
      lineValue,
      daysOverdue: Math.round(f.daysOverdue * 10) / 10,
      alsoDetected: others,
    });
  }
  return out;
}
