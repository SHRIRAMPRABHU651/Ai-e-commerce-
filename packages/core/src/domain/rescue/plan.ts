/**
 * Delivery Rescue planning (IO): gathers live facts for a case, calls the pure option generator and the pure
 * authorization policy, and freezes the result on the case. Nothing here moves money or places orders.
 */
import { liveFxTable } from '../finance/fxService';
import { Order, Product, ProductVariant, RescueCase, Shipment, Supplier, SupplierProduct, SupplierOffer } from '@orvia/database';
import { convertMinor, formatMoney } from '@orvia/types';
import type { Currency, RescuePolicy } from '@orvia/types';
import type { Ctx } from '../../infra/context';
import { fulfillmentModeOf } from '../supplierOps';
import { pickSupplierSku } from '../supplierAccess';
import { selectSupplierLive } from '../offers';
import { promisedEta } from './classifier';
import { caseDedupeKey, duplicateOrderGuard, supplierOrderKey } from './guard';
import { generateOptions } from './options';
import type { OptionSet, OriginalPlan, ReplacementCandidate, RescueOption } from './options';
import { authorize } from './policy';
import type { AuthDecision } from './policy';
import { getOfferRanker } from './ranker';
import type { AltOffer, RankedAlt } from './ranker';
import { autoUsageToday, getRescuePolicy } from './store';

const DAY = 86_400_000;
const LIVE_PRODUCT_STATES = ['PUBLISHED', 'TESTING', 'WINNER', 'SCALING'];

export type StoredOption = RescueOption & { auth: AuthDecision };

export const toUsd = (fx: Record<Currency, number>) => (minor: number, currency: string): number => convertMinor(minor, currency as Currency, 'USD', fx);
export const fmtMoney = (minor: number, currency: string): string => formatMoney(minor, currency as Currency);

const sumCost = (c?: { productCost?: number | null; shippingCost?: number | null; duties?: number | null } | null) => (c ? (c.productCost ?? 0) + (c.shippingCost ?? 0) + (c.duties ?? 0) : 0);

export interface PlanResult {
  set: OptionSet;
  options: StoredOption[];
  notes: string[];
}

/** Compute (but do not persist) the option set for a case. Safe to call repeatedly. */
export async function computePlan(ctx: Ctx, caseDoc: InstanceType<typeof RescueCase>, policy?: RescuePolicy): Promise<PlanResult> {
  const pol = policy ?? (await getRescuePolicy());
  const now = ctx.now();
  const notes: string[] = [];
  const order = await Order.findById(caseDoc.orderId).lean();
  if (!order) throw new Error('order missing');
  const item = order.items.find((i) => i.lineKey === caseDoc.lineKey);
  if (!item) throw new Error('order line missing');
  const fx = await liveFxTable(ctx);
  const toU = toUsd(fx);
  const country = order.country as 'US' | 'CA' | 'IN';
  const ships = await Shipment.find({ orderId: order._id, lineKey: item.lineKey }).lean();
  const isLive = (s: { status: string }) => !['FAILED', 'CANCELLED'].includes(s.status);
  const live = ships.find(isLive);
  const lastShip = [...ships].sort((a, b) => String(b._id).localeCompare(String(a._id)))[0];
  const variant = await ProductVariant.findOne({ sku: item.sku }).select('supplierSku label').lean();

  // ---- original plan (cost basis is always labelled: real shipment cost, else a stored quote, else unknown)
  let origCost = sumCost(live?.cost ?? lastShip?.cost);
  const costKnown = origCost > 0;
  if (!costKnown) {
    const offer = await SupplierOffer.findOne({ productId: item.productId, destination: country, ...(lastShip ? { supplierId: lastShip.supplierId } : {}) }).sort({ productCost: 1 }).lean();
    if (offer) {
      origCost = offer.productCost * item.quantity + offer.shippingCost + (offer.fulfillmentFee ?? 0);
      notes.push('Original cost estimated from the stored supplier quote (not a measured order cost).');
    } else notes.push('Original supplier cost is unknown; impact figures assume nothing is recovered.');
  }
  const dispatched = !!live && ['SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY'].includes(live.status);
  const original: OriginalPlan = {
    hasLiveShipment: !!live && live.status !== 'DELIVERED',
    status: live?.status ?? null,
    supplierId: live ? String(live.supplierId) : lastShip ? String(lastShip.supplierId) : null,
    cost: origCost,
    costKnown,
    cancelPath: !live ? 'not_placed' : dispatched ? 'dispatched' : 'cancellable',
  };

  const unitPrice = item.unitPrice;
  const excluded = [...new Set(ships.map((s) => String(s.supplierId)))];
  const needsSupply = ['supplier_cancellation', 'supplier_acceptance_failure', 'stock_shortage', 'suspected_lost', 'shipment_delay', 'carrier_exception', 'invalid_tracking'].includes(caseDoc.kind);

  // ---- same-product alternatives (approved, serving the destination, healthy, live-quoted by the existing machinery)
  let alternatives: RankedAlt[] = [];
  if (needsSupply) {
    try {
      const sel = await selectSupplierLive(ctx, { productId: String(item.productId), sku: variant?.supplierSku ?? item.sku, country, quantity: item.quantity, unitPrice, excludeSupplierIds: excluded });
      const offers: (AltOffer & { mode: string })[] = [];
      for (const r of sel.all) {
        const [sup, link] = await Promise.all([Supplier.findById(r.supplierId).lean(), SupplierProduct.findOne({ productId: item.productId, supplierId: r.supplierId }).select('externalId variants').lean()]);
        if (!sup || !link) continue;
        const mode = fulfillmentModeOf(sup);
        offers.push({
          supplierId: r.supplierId, supplierName: r.supplierName, supplierCode: sup.code, externalId: link.externalId,
          sku: pickSupplierSku(link.variants, variant) ?? link.variants?.[0]?.sku ?? undefined,
          landedCost: r.landedCost, minDays: r.minDays, maxDays: r.maxDays, stock: r.stock,
          available: !!r.available && ['HEALTHY', 'DEGRADED'].includes(sup.healthState ?? '') && sup.active !== false,
          reliability: r.reliability, rating: r.rating, trackingAvailable: r.trackingAvailable, mode,
        });
      }
      const modeOf = new Map(offers.map((o) => [o.supplierId, o.mode]));
      alternatives = getOfferRanker().rank(offers, { quantity: item.quantity, originalCost: origCost }).map((a) =>
        modeOf.get(a.supplierId) !== 'AUTOMATED' && a.eligible ? { ...a, eligible: false, ineligibleReason: `${a.supplierName} is in ${modeOf.get(a.supplierId)} mode: staff would have to place this order by hand` } : a,
      );
      for (const f of sel.failures) notes.push(`Supplier ${f.supplierCode} could not be quoted: ${f.error}`);
    } catch (e) {
      notes.push(`No alternative supplier quote available: ${(e as Error).message}`);
    }
  }

  // ---- equivalent replacements (a DIFFERENT product: always a material change)
  const replacements: ReplacementCandidate[] = [];
  const wantReplacement = ['supplier_cancellation', 'supplier_acceptance_failure', 'stock_shortage', 'suspected_lost'].includes(caseDoc.kind) && !alternatives.some((a) => a.eligible);
  if (wantReplacement) {
    const prod = await Product.findById(item.productId).select('category').lean();
    if (prod?.category) {
      const cands = await Product.find({
        _id: { $ne: item.productId }, category: prod.category, state: { $in: LIVE_PRODUCT_STATES },
        markets: { $elemMatch: { country, enabled: true, price: { $gte: Math.round(unitPrice * 0.6), $lte: Math.round(unitPrice * 1.4) } } },
      }).sort({ 'stats.soldCount': -1 }).limit(3).select('title sku category markets').lean();
      for (const c of cands) {
        const m = c.markets.find((x) => x.country === country);
        try {
          const sel = await selectSupplierLive(ctx, { productId: String(c._id), country, quantity: item.quantity, unitPrice: m?.price ?? unitPrice });
          const sup = await Supplier.findById(sel.best.supplierId).lean();
          if (!sup || fulfillmentModeOf(sup) !== 'AUTOMATED' || sel.best.stock < item.quantity) continue;
          replacements.push({ productId: String(c._id), title: c.title, sku: c.sku, supplierId: sel.best.supplierId, supplierName: sel.best.supplierName, externalId: sel.best.externalId, supplierSku: sel.best.sku, landedCost: sel.best.landedCost, unitPrice: m?.price ?? 0, minDays: sel.best.minDays, maxDays: sel.best.maxDays, stock: sel.best.stock, category: c.category ?? undefined });
        } catch {
          /* candidate cannot be quoted: skip */
        }
      }
    }
  }

  // ---- duplicate-order guard for this line (staff acknowledgement is applied at execution time, never assumed here)
  const rescueRows = ships.filter((s) => s.idempotencyKey.startsWith('rescue-ship:')).length;
  const guard = rescueRows >= 2
    ? ({ allow: false, code: 'already_reordered', reason: 'The automatic reorder limit for this line (2) has been reached.' } as const)
    : duplicateOrderGuard({ supplierOrderKeyForCase: supplierOrderKey(String(caseDoc._id), String(order._id), item.lineKey), shipments: ships.map((s) => ({ id: String(s._id), status: s.status, supplierOrderId: s.supplierOrderId, idempotencyKey: s.idempotencyKey })) });

  const paidAt = order.payment?.paidAt ? new Date(order.payment.paidAt) : new Date((order as unknown as { createdAt: Date }).createdAt);
  const promiseAt = live
    ? promisedEta({ id: String(live._id), lineKey: live.lineKey, status: live.status, supplierId: String(live.supplierId), createdAt: (live as unknown as { createdAt: Date }).createdAt, estimatedDelivery: live.estimatedDelivery ?? null, events: [] }, pol).at
    : new Date(paidAt.getTime() + pol.detection.fallbackPromiseDays * DAY);

  const set = generateOptions({
    kind: caseDoc.kind, severity: caseDoc.severity, currency: order.currency, title: item.title, quantity: item.quantity, lineValue: item.unitPrice * item.quantity,
    orderRefundable: Math.max(0, (order.amounts?.total ?? 0) - (order.costs?.refunded ?? 0)), orderIsSingleLine: order.items.length === 1,
    original, promiseAt, now, alternatives, replacements, guard, policy: pol, fmt: (n) => fmtMoney(n, order.currency),
  });
  const usage = await autoUsageToday(now);
  const options: StoredOption[] = set.options.map((o) => ({ ...o, auth: authorize({ option: o, policy: pol, usage, exposureUsd: toU(o.impact.exposure, order.currency), originalCost: costKnown ? origCost : 0 }) }));
  return { set, options, notes };
}

export { caseDedupeKey };
