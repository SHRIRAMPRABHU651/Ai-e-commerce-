/**
 * Row -> scoring-input aggregation (pure). service.ts loads bounded rows from MongoDB and hands them here,
 * so the attribution rules (which return/refund/review belongs to which supplier) are unit-testable.
 */
import type { ProductRiskInputs, SupplierTrustInputs } from './scoring';
import { daysBetween } from './delivery';
import { quantile } from './stats';

export const RESOLVED_STATUSES = ['DELIVERED', 'FAILED', 'CANCELLED', 'RETURNED'] as const;
/** Customer reasons that point at the product/supplier (not at the customer or the carrier). */
export const DEFECT_REASONS = ['damaged', 'not_as_described', 'wrong_item'] as const;
/** Exception kinds counted as disputes. */
export const DISPUTE_KINDS = ['CHARGEBACK', 'SAFETY', 'AUTHENTICITY'] as const;
/** On-time grace (days) after the supplier's estimated delivery. */
export const ON_TIME_GRACE_DAYS = 1;
const STOCK_ERROR = /(out of stock|stock|unavailable|sold out|inventory)/i;

export interface ShipmentRow {
  orderId: string;
  productId?: string | null;
  sku?: string | null;
  status: string;
  estimatedDelivery?: Date | null;
  deliveredAt?: Date | null;
  lastError?: string | null;
  destination?: string | null;
  orderCreatedAt?: Date | null;
}
export interface ReturnRow { orderId: string; reason?: string | null; itemSkus?: string[]; status?: string }
export interface RefundRow { orderId: string; hours: number }
export interface ReviewRow { orderId?: string | null; productId?: string | null; rating: number; verified?: boolean }
export interface ExceptionRow { orderId?: string | null; kind: string }
export interface OfferRow { destination: string; syncedAt?: Date | null; confirmedAt?: Date | null; available: boolean }

export interface SupplierRows {
  shipments: ShipmentRow[];
  returns: ReturnRow[];
  refunds: RefundRow[];
  reviews: ReviewRow[];
  exceptions: ExceptionRow[];
  offers: OfferRow[];
}

const isDelivered = (s: string) => s === 'DELIVERED' || s === 'RETURNED';

/** Aggregate into scoring inputs, optionally scoped to one destination. */
export function aggregateSupplierInputs(rows: SupplierRows, now: Date, destination: string | null): SupplierTrustInputs {
  const ships = destination ? rows.shipments.filter((s) => s.destination === destination) : rows.shipments;
  const orderIds = new Set(ships.map((s) => s.orderId));
  const resolved = ships.filter((s) => (RESOLVED_STATUSES as readonly string[]).includes(s.status));
  const count = (st: string) => resolved.filter((s) => s.status === st).length;

  const eligible = resolved.filter((s) => s.status === 'DELIVERED' && s.estimatedDelivery && s.deliveredAt);
  const onTime = eligible.filter((s) => (s.deliveredAt as Date).getTime() <= (s.estimatedDelivery as Date).getTime() + ON_TIME_GRACE_DAYS * 86_400_000).length;

  const stockOrders = new Set<string>();
  for (const s of ships) if (s.status === 'FAILED' && s.lastError && STOCK_ERROR.test(s.lastError)) stockOrders.add(s.orderId);
  for (const e of rows.exceptions) if (e.kind === 'STALE_STOCK' && e.orderId && orderIds.has(e.orderId)) stockOrders.add(e.orderId);

  // A return belongs to this supplier if its SKUs match one of the supplier's shipments on that order (or the order has no SKU info).
  const skusByOrder = new Map<string, Set<string>>();
  for (const s of ships) { if (!skusByOrder.has(s.orderId)) skusByOrder.set(s.orderId, new Set()); if (s.sku) skusByOrder.get(s.orderId)!.add(s.sku); }
  const ours = (r: ReturnRow) => {
    if (!orderIds.has(r.orderId)) return false;
    const skus = skusByOrder.get(r.orderId);
    if (!skus || !skus.size || !r.itemSkus?.length) return true;
    return r.itemSkus.some((x) => skus.has(x));
  };
  const deliveredShipments = ships.filter((s) => isDelivered(s.status));
  const supplierReturns = rows.returns.filter((r) => r.status !== 'rejected' && r.reason !== 'not_delivered' && ours(r));
  const returnOrders = new Set(supplierReturns.map((r) => r.orderId));
  const defectOrders = new Set(supplierReturns.filter((r) => (DEFECT_REASONS as readonly string[]).includes(r.reason ?? '')).map((r) => r.orderId));

  const refunds = rows.refunds.filter((r) => orderIds.has(r.orderId)).map((r) => r.hours);
  const reviews = rows.reviews.filter((r) => r.orderId && orderIds.has(r.orderId));
  const disputes = new Set(rows.exceptions.filter((e) => (DISPUTE_KINDS as readonly string[]).includes(e.kind) && e.orderId && orderIds.has(e.orderId)).map((e) => e.orderId as string));

  const offers = destination ? rows.offers.filter((o) => o.destination === destination) : rows.offers;
  const stamps = offers.map((o) => o.confirmedAt ?? o.syncedAt).filter((d): d is Date => !!d);
  const newest = stamps.length ? new Date(Math.max(...stamps.map((d) => d.getTime()))) : null;

  return {
    now, destination,
    shipments: { resolved: resolved.length, delivered: count('DELIVERED'), failed: count('FAILED'), cancelled: count('CANCELLED'), returned: count('RETURNED') },
    onTime: { eligible: eligible.length, onTime },
    stock: { orders: orderIds.size, issues: stockOrders.size },
    returns: { delivered: deliveredShipments.length, returns: returnOrders.size, defects: defectOrders.size },
    refunds: { count: refunds.length, medianHours: refunds.length ? (quantile(refunds, 0.5) ?? null) : null },
    satisfaction: { ratings: reviews.length, positive: reviews.filter((r) => r.rating >= 4).length },
    disputes: { orders: orderIds.size, disputes: disputes.size },
    offers: { count: offers.length, newestSyncAt: newest, availableCount: offers.filter((o) => o.available).length },
  };
}

export const destinationsOf = (rows: SupplierRows): string[] => [...new Set([...rows.shipments.map((s) => s.destination), ...rows.offers.map((o) => o.destination)].filter((x): x is string => !!x))].sort();

/* ------------------------------ product ------------------------------ */

export interface ProductRows {
  shipments: ShipmentRow[];
  returns: ReturnRow[];
  reviews: ReviewRow[];
}

export interface ProductHistory {
  shipping: ProductRiskInputs['shipping'];
  feedback: ProductRiskInputs['feedback'];
  history: { deliveredDays: number[]; resolved: number; delivered: number; failed: number; returns: number; defects: number };
  reviewSummary: { avg: number | null; count: number; verified: number; distribution: Record<string, number> };
}

export function aggregateProductRows(rows: ProductRows, destination: string | null): ProductHistory {
  const ships = destination ? rows.shipments.filter((s) => s.destination === destination) : rows.shipments;
  const orderIds = new Set(ships.map((s) => s.orderId));
  const resolved = ships.filter((s) => (RESOLVED_STATUSES as readonly string[]).includes(s.status));
  const delivered = resolved.filter((s) => isDelivered(s.status));
  const failed = resolved.filter((s) => s.status === 'FAILED' || s.status === 'CANCELLED');
  const eligible = resolved.filter((s) => s.status === 'DELIVERED' && s.estimatedDelivery && s.deliveredAt);
  const onTime = eligible.filter((s) => (s.deliveredAt as Date).getTime() <= (s.estimatedDelivery as Date).getTime() + ON_TIME_GRACE_DAYS * 86_400_000).length;
  const deliveredDays = delivered.filter((s) => s.deliveredAt && s.orderCreatedAt).map((s) => daysBetween(s.orderCreatedAt as Date, s.deliveredAt as Date));

  const skusByOrder = new Map<string, Set<string>>();
  for (const s of ships) { if (!skusByOrder.has(s.orderId)) skusByOrder.set(s.orderId, new Set()); if (s.sku) skusByOrder.get(s.orderId)!.add(s.sku); }
  const forProduct = (r: ReturnRow) => { const skus = skusByOrder.get(r.orderId); return !skus || !skus.size || !r.itemSkus?.length || r.itemSkus.some((x) => skus.has(x)); };
  const rets = rows.returns.filter((r) => r.status !== 'rejected' && r.reason !== 'not_delivered' && orderIds.has(r.orderId) && forProduct(r));
  const returnOrders = new Set(rets.map((r) => r.orderId));
  const defectOrders = new Set(rets.filter((r) => (DEFECT_REASONS as readonly string[]).includes(r.reason ?? '')).map((r) => r.orderId));
  const reviews = rows.reviews; // reviews are product-level feedback; not destination-scoped
  const dist: Record<string, number> = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
  for (const r of reviews) dist[String(Math.min(5, Math.max(1, Math.round(r.rating))))]! += 1;

  return {
    shipping: { resolved: resolved.length, delivered: delivered.length, failed: failed.length, onTimeEligible: eligible.length, onTime },
    feedback: { ratings: reviews.length, positive: reviews.filter((r) => r.rating >= 4).length, delivered: delivered.length, returns: returnOrders.size, defects: defectOrders.size },
    history: { deliveredDays, resolved: resolved.length, delivered: delivered.length, failed: failed.length, returns: returnOrders.size, defects: defectOrders.size },
    reviewSummary: { avg: reviews.length ? Math.round((reviews.reduce((a, r) => a + r.rating, 0) / reviews.length) * 10) / 10 : null, count: reviews.length, verified: reviews.filter((r) => r.verified).length, distribution: dist },
  };
}
