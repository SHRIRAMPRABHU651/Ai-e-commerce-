/** Bounded MongoDB loaders that turn existing collections into plain rows for the pure aggregation layer. */
import { ExceptionModel, Order, OrderItem, Refund, ReturnRequest, Review, Shipment, SupplierOffer } from '@orvia/database';
import { DISPUTE_KINDS } from './aggregate';
import type { OfferRow, ProductRows, RefundRow, ReturnRow, ReviewRow, ShipmentRow, SupplierRows } from './aggregate';

const WINDOW_DAYS = 365;
export const MAX_SHIPMENTS = 5000;
const CHUNK = 800;

async function chunked<T>(ids: string[], fn: (part: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) out.push(...(await fn(ids.slice(i, i + CHUNK))));
  return out;
}

interface ShipLean { orderId: unknown; productId?: unknown; sku?: string | null; status: string; estimatedDelivery?: Date | null; events?: { status?: string | null; at?: Date | null }[]; lastError?: string | null }
interface OrderLean { _id: unknown; country?: string | null; createdAt?: Date; deliveredAt?: Date | null }

async function shipmentRows(ships: ShipLean[]): Promise<ShipmentRow[]> {
  const ids = [...new Set(ships.map((s) => String(s.orderId)))];
  const orders = await chunked(ids, (part) => Order.find({ _id: { $in: part } }).select('country createdAt deliveredAt').lean() as unknown as Promise<OrderLean[]>);
  const byId = new Map(orders.map((o) => [String(o._id), o]));
  return ships.map((s) => {
    const o = byId.get(String(s.orderId));
    const ev = [...(s.events ?? [])].reverse().find((e) => e.status === 'DELIVERED' && e.at);
    const deliveredAt = s.status === 'DELIVERED' || s.status === 'RETURNED' ? (ev?.at ?? o?.deliveredAt ?? null) : null;
    return { orderId: String(s.orderId), productId: s.productId ? String(s.productId) : null, sku: s.sku ?? null, status: s.status, estimatedDelivery: s.estimatedDelivery ?? null, deliveredAt, lastError: s.lastError ?? null, destination: o?.country ?? null, orderCreatedAt: o?.createdAt ?? null };
  });
}

export async function loadSupplierRows(supplierId: string, now: Date): Promise<SupplierRows> {
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000);
  const ships = (await Shipment.find({ supplierId, createdAt: { $gte: since } }).sort({ createdAt: -1 }).limit(MAX_SHIPMENTS).select('orderId productId sku status estimatedDelivery events lastError').lean()) as unknown as ShipLean[];
  const shipments = await shipmentRows(ships);
  const orderIds = [...new Set(shipments.map((s) => s.orderId))];

  const [returnsL, refundsL, reviewsL, excL, offersL] = await Promise.all([
    chunked(orderIds, (p) => ReturnRequest.find({ orderId: { $in: p } }).select('orderId reason itemSkus status').lean() as unknown as Promise<{ orderId: unknown; reason?: string; itemSkus?: string[]; status?: string }[]>),
    chunked(orderIds, (p) => Refund.find({ orderId: { $in: p }, status: 'succeeded' }).select('orderId createdAt updatedAt').lean() as unknown as Promise<{ orderId: unknown; createdAt?: Date; updatedAt?: Date }[]>),
    chunked(orderIds, (p) => Review.find({ orderId: { $in: p }, status: 'published' }).select('orderId productId rating verifiedPurchase').lean() as unknown as Promise<{ orderId?: unknown; productId?: unknown; rating: number; verifiedPurchase?: boolean }[]>),
    chunked(orderIds, (p) => ExceptionModel.find({ orderId: { $in: p }, kind: { $in: [...DISPUTE_KINDS, 'STALE_STOCK'] } }).select('orderId kind').lean() as unknown as Promise<{ orderId?: unknown; kind: string }[]>),
    SupplierOffer.find({ supplierId }).limit(5000).select('destination syncedAt confirmedAt available stock').lean() as unknown as Promise<{ destination: string; syncedAt?: Date; confirmedAt?: Date; available?: boolean; stock?: number }[]>,
  ]);

  const returns: ReturnRow[] = returnsL.map((r) => ({ orderId: String(r.orderId), reason: r.reason ?? null, itemSkus: r.itemSkus ?? [], status: r.status }));
  const refunds: RefundRow[] = refundsL.filter((r) => r.createdAt && r.updatedAt).map((r) => ({ orderId: String(r.orderId), hours: Math.max(0, ((r.updatedAt as Date).getTime() - (r.createdAt as Date).getTime()) / 3_600_000) }));
  const reviews: ReviewRow[] = reviewsL.map((r) => ({ orderId: r.orderId ? String(r.orderId) : null, productId: r.productId ? String(r.productId) : null, rating: r.rating, verified: !!r.verifiedPurchase }));
  const offers: OfferRow[] = offersL.map((o) => ({ destination: o.destination, syncedAt: o.syncedAt ?? null, confirmedAt: o.confirmedAt ?? null, available: !!o.available && (o.stock ?? 0) > 0 }));
  return { shipments, returns, refunds, reviews, exceptions: excL.map((e) => ({ orderId: e.orderId ? String(e.orderId) : null, kind: e.kind })), offers };
}

export async function loadProductRows(productId: string): Promise<ProductRows> {
  const items = (await OrderItem.find({ productId }).sort({ createdAt: -1 }).limit(3000).select('orderId').lean()) as unknown as { orderId: unknown }[];
  const orderIds = [...new Set(items.map((i) => String(i.orderId)))];
  const ships = await chunked(orderIds, (p) => Shipment.find({ orderId: { $in: p }, productId }).select('orderId productId sku status estimatedDelivery events lastError').lean() as unknown as Promise<ShipLean[]>);
  const shipments = await shipmentRows(ships);
  const [returnsL, reviewsL] = await Promise.all([
    chunked(orderIds, (p) => ReturnRequest.find({ orderId: { $in: p } }).select('orderId reason itemSkus status').lean() as unknown as Promise<{ orderId: unknown; reason?: string; itemSkus?: string[]; status?: string }[]>),
    Review.find({ productId, status: 'published' }).sort({ createdAt: -1 }).limit(2000).select('orderId productId rating verifiedPurchase').lean() as unknown as Promise<{ orderId?: unknown; productId?: unknown; rating: number; verifiedPurchase?: boolean }[]>,
  ]);
  return {
    shipments,
    returns: returnsL.map((r) => ({ orderId: String(r.orderId), reason: r.reason ?? null, itemSkus: r.itemSkus ?? [], status: r.status })),
    reviews: reviewsL.map((r) => ({ orderId: r.orderId ? String(r.orderId) : null, productId: String(r.productId), rating: r.rating, verified: !!r.verifiedPurchase })),
  };
}
