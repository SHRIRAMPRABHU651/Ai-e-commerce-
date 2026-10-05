import mongoose from 'mongoose';
import { AdMetric, AnalyticsEvent, Campaign, Customer, ExceptionModel, Inventory, Order, Payment, Product, Shipment, Supplier, SupplierOffer } from '@orvia/database';
import { summarizeFinancials } from '@orvia/analytics';
import type { FinancialSummary } from '@orvia/analytics';
import { convertMinor, DEFAULT_COUNTRIES } from '@orvia/types';
import type { CountryCode, Currency, FxTable } from '@orvia/types';
import type { Ctx } from '../infra/context';

export interface Range {
  from: Date;
  to: Date;
}

export function parseRange(preset: string | undefined, from?: string, to?: string, now = new Date()): Range {
  const end = new Date(now);
  if (preset === 'custom' && from && to) return { from: new Date(from), to: new Date(new Date(to).getTime() + 86_399_999) };
  const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  switch (preset) {
    case '7d': return { from: new Date(startOfToday.getTime() - 6 * 86_400_000), to: end };
    case '30d': return { from: new Date(startOfToday.getTime() - 29 * 86_400_000), to: end };
    case '90d': return { from: new Date(startOfToday.getTime() - 89 * 86_400_000), to: end };
    default: return { from: startOfToday, to: end };
  }
}
export const previousRange = (r: Range): Range => {
  const span = r.to.getTime() - r.from.getTime();
  return { from: new Date(r.from.getTime() - span), to: new Date(r.from.getTime() - 1) };
};

interface OrderAggRow {
  _id: { currency: string; country?: string; day?: string; productId?: mongoose.Types.ObjectId };
  orders: number;
  revenue: number; // subtotal + shipping (ex tax unless inclusive handled below)
  discounts: number;
  tax: number;
  refunds: number;
  supplierCost: number;
  shippingCost: number;
  duties: number;
  paymentFees: number;
  fulfilledRevenue: number;
  fulfilledOrders: number;
  deliveryMs: number;
  deliveredCount: number;
}

const PAID = { 'payment.paidAt': { $ne: null } };

async function orderAgg(range: Range, groupId: Record<string, unknown>): Promise<OrderAggRow[]> {
  return Order.aggregate<OrderAggRow>([
    { $match: { ...PAID, 'payment.paidAt': { $gte: range.from, $lte: range.to } } },
    {
      $group: {
        _id: groupId,
        orders: { $sum: 1 },
        // revenue excludes tax: for inclusive markets tax is embedded in total, for exclusive it was added on top
        revenue: { $sum: { $subtract: [{ $add: ['$amounts.subtotal', '$amounts.shipping'] }, { $cond: ['$amounts.taxInclusive', '$amounts.tax', 0] }] } },
        discounts: { $sum: '$amounts.discount' },
        tax: { $sum: '$amounts.tax' },
        refunds: { $sum: '$costs.refunded' },
        supplierCost: { $sum: '$costs.supplierCost' },
        shippingCost: { $sum: '$costs.shippingCost' },
        duties: { $sum: '$costs.duties' },
        paymentFees: { $sum: '$costs.paymentFee' },
        fulfilledRevenue: { $sum: { $cond: [{ $in: ['$fulfillment.state', ['placed', 'partial']] }, { $subtract: [{ $add: ['$amounts.subtotal', '$amounts.shipping'] }, { $cond: ['$amounts.taxInclusive', '$amounts.tax', 0] }] }, 0] } },
        fulfilledOrders: { $sum: { $cond: [{ $in: ['$fulfillment.state', ['placed', 'partial']] }, 1, 0] } },
        deliveryMs: { $sum: { $cond: ['$deliveredAt', { $subtract: ['$deliveredAt', '$payment.paidAt'] }, 0] } },
        deliveredCount: { $sum: { $cond: ['$deliveredAt', 1, 0] } },
      },
    },
    { $limit: 2000 },
  ]);
}

const usd = (fx: FxTable) => (minor: number, cur: string) => convertMinor(minor, cur as Currency, 'USD', fx);

async function adSpendUsd(range: Range, match: Record<string, unknown> = {}) {
  const [a] = await AdMetric.aggregate<{ spend: number; revenue: number; purchases: number; clicks: number; impressions: number }>([
    { $match: { date: { $gte: new Date(range.from.toISOString().slice(0, 10)), $lte: range.to, ...match } } },
    { $group: { _id: null, spend: { $sum: '$spend' }, revenue: { $sum: '$revenue' }, purchases: { $sum: '$purchases' }, clicks: { $sum: '$clicks' }, impressions: { $sum: '$impressions' } } },
  ]);
  return a ?? { spend: 0, revenue: 0, purchases: 0, clicks: 0, impressions: 0 };
}

export interface FinancialReport extends FinancialSummary {
  orders: number;
  fulfilledOrders: number;
  pendingCostOrders: number;
  customers: number;
  aov: number;
  conversionRate: number;
  sessions: number;
  refundRate: number;
  note: string;
  currency: 'USD';
}

/** All figures in USD minor units. Profit tiers are computed ONLY on fulfilled orders (known costs). */
export async function financials(ctx: Ctx, range: Range): Promise<FinancialReport> {
  const fx = (await ctx.settings.get('ops')).fx;
  const conv = usd(fx);
  const rows = await orderAgg(range, { currency: '$currency' });
  const sum = (k: keyof OrderAggRow) => rows.reduce((a, r) => a + conv(r[k] as number, r._id.currency), 0);
  const orders = rows.reduce((a, r) => a + r.orders, 0);
  const fulfilledOrders = rows.reduce((a, r) => a + r.fulfilledOrders, 0);
  const ad = await adSpendUsd(range);
  const grossRevenue = sum('revenue') + sum('discounts');
  const fulfilledShare = orders ? fulfilledOrders / orders : 0;
  const fin = summarizeFinancials({
    grossRevenue,
    discounts: sum('discounts'),
    refunds: sum('refunds'),
    supplierCost: sum('supplierCost'),
    shippingCost: sum('shippingCost'),
    duties: sum('duties'),
    paymentFees: sum('paymentFees'),
    adSpend: ad.spend,
  });
  const customers = (await Order.distinct('email', { ...PAID, 'payment.paidAt': { $gte: range.from, $lte: range.to } })).length;
  const sessions = (await AnalyticsEvent.distinct('sessionId', { ts: { $gte: range.from, $lte: range.to }, sessionId: { $ne: null } })).length;
  const net = fin.netRevenue;
  return {
    ...fin,
    orders,
    fulfilledOrders,
    pendingCostOrders: orders - fulfilledOrders,
    customers,
    aov: orders ? Math.round(sum('revenue') / orders) : 0,
    sessions,
    conversionRate: sessions ? orders / sessions : 0,
    refundRate: net + fin.refunds > 0 ? fin.refunds / (net + fin.refunds) : 0,
    currency: 'USD',
    note: fulfilledShare < 1 ? `Cost-based profit reflects orders whose supplier cost is known; ${orders - fulfilledOrders} paid order(s) are not yet fulfilled so their costs are not included.` : 'All paid orders in range have known costs.',
  };
}

export async function timeseries(ctx: Ctx, range: Range) {
  const fx = (await ctx.settings.get('ops')).fx;
  const conv = usd(fx);
  const rows = await orderAgg(range, { currency: '$currency', day: { $dateToString: { format: '%Y-%m-%d', date: '$payment.paidAt' } } });
  const ad = await AdMetric.aggregate<{ _id: string; spend: number; revenue: number }>([
    { $match: { date: { $gte: new Date(range.from.toISOString().slice(0, 10)), $lte: range.to } } },
    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$date' } }, spend: { $sum: '$spend' }, revenue: { $sum: '$revenue' } } },
  ]);
  const days = new Map<string, { date: string; revenue: number; orders: number; profit: number; adSpend: number }>();
  const ensure = (d: string) => days.get(d) ?? (days.set(d, { date: d, revenue: 0, orders: 0, profit: 0, adSpend: 0 }), days.get(d)!);
  for (let t = Date.parse(range.from.toISOString().slice(0, 10)); t <= range.to.getTime(); t += 86_400_000) ensure(new Date(t).toISOString().slice(0, 10));
  for (const r of rows) {
    const d = ensure(r._id.day!);
    d.revenue += conv(r.revenue, r._id.currency);
    d.orders += r.orders;
    d.profit += conv(r.fulfilledRevenue - r.supplierCost - r.shippingCost - r.duties - r.paymentFees - r.refunds, r._id.currency);
  }
  for (const a of ad) {
    const d = ensure(a._id);
    d.adSpend += a.spend;
    d.profit -= a.spend;
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export async function countryAnalytics(ctx: Ctx, range: Range) {
  const fx = (await ctx.settings.get('ops')).fx;
  const conv = usd(fx);
  const rows = await orderAgg(range, { currency: '$currency', country: '$country' });
  const ads = await AdMetric.aggregate<{ _id: string; spend: number; revenue: number }>([
    { $match: { date: { $gte: new Date(range.from.toISOString().slice(0, 10)), $lte: range.to } } },
    { $group: { _id: '$country', spend: { $sum: '$spend' }, revenue: { $sum: '$revenue' } } },
  ]);
  const sess = await AnalyticsEvent.aggregate<{ _id: string; n: number }>([
    { $match: { ts: { $gte: range.from, $lte: range.to }, sessionId: { $ne: null }, country: { $ne: null } } },
    { $group: { _id: { c: '$country', s: '$sessionId' } } },
    { $group: { _id: '$_id.c', n: { $sum: 1 } } },
  ]);
  const out = (Object.keys(DEFAULT_COUNTRIES) as CountryCode[]).map((code) => {
    const rs = rows.filter((r) => r._id.country === code);
    const orders = rs.reduce((a, r) => a + r.orders, 0);
    const revenue = rs.reduce((a, r) => a + conv(r.revenue, r._id.currency), 0);
    const profitBase = rs.reduce((a, r) => a + conv(r.fulfilledRevenue - r.supplierCost - r.shippingCost - r.duties - r.paymentFees - r.refunds, r._id.currency), 0);
    const ad = ads.find((a) => a._id === code);
    const delMs = rs.reduce((a, r) => a + r.deliveryMs, 0);
    const delN = rs.reduce((a, r) => a + r.deliveredCount, 0);
    const sessions = sess.find((s) => s._id === code)?.n ?? 0;
    const profit = profitBase - (ad?.spend ?? 0);
    return {
      country: code, name: DEFAULT_COUNTRIES[code].name, revenue, orders, profit, adSpend: ad?.spend ?? 0, roas: ad?.spend ? ad.revenue / ad.spend : 0,
      conversionRate: sessions ? orders / sessions : 0, sessions, avgDeliveryDays: delN ? Math.round((delMs / delN / 86_400_000) * 10) / 10 : null, profitPerOrder: orders ? Math.round(profit / orders) : 0,
    };
  });
  const ranked = [...out].filter((c) => c.orders > 0).sort((a, b) => b.profitPerOrder - a.profitPerOrder);
  const best = ranked[0];
  const recommendation = best && best.profit > 0
    ? `${best.name} has the best profit per order (${(best.profitPerOrder / 100).toFixed(2)} USD)${best.roas ? ` and ROAS ${best.roas.toFixed(2)}` : ''}. Consider shifting test budget there.`
    : out.every((c) => c.orders === 0) ? 'No orders in this period yet — nothing to base an expansion recommendation on.' : 'No market is profitable after ad spend yet; improve supplier mix or pricing before expanding.';
  return { countries: out, recommendation };
}

export async function productPerformance(ctx: Ctx, range: Range, limit = 20) {
  const fx = (await ctx.settings.get('ops')).fx;
  const conv = usd(fx);
  const rows = await Order.aggregate<{ _id: { productId: mongoose.Types.ObjectId; currency: string }; units: number; revenue: number; cost: number }>([
    { $match: { ...PAID, 'payment.paidAt': { $gte: range.from, $lte: range.to }, 'fulfillment.state': { $in: ['placed', 'partial'] } } },
    { $addFields: { itemCount: { $size: '$items' } } },
    { $unwind: '$items' },
    { $group: { _id: { productId: '$items.productId', currency: '$currency' }, units: { $sum: '$items.quantity' }, revenue: { $sum: { $multiply: ['$items.unitPrice', '$items.quantity'] } }, cost: { $sum: { $divide: [{ $add: ['$costs.supplierCost', '$costs.shippingCost', '$costs.duties', '$costs.paymentFee'] }, '$itemCount'] } } } },
    { $limit: 1000 },
  ]);
  const byProduct = new Map<string, { units: number; revenue: number; cost: number }>();
  for (const r of rows) {
    const k = String(r._id.productId);
    const cur = byProduct.get(k) ?? { units: 0, revenue: 0, cost: 0 };
    cur.units += r.units;
    cur.revenue += conv(r.revenue, r._id.currency);
    cur.cost += conv(r.cost, r._id.currency);
    byProduct.set(k, cur);
  }
  const ads = await AdMetric.aggregate<{ _id: mongoose.Types.ObjectId; spend: number }>([{ $match: { date: { $gte: new Date(range.from.toISOString().slice(0, 10)), $lte: range.to } } }, { $group: { _id: '$productId', spend: { $sum: '$spend' } } }]);
  const adMap = new Map(ads.map((a) => [String(a._id), a.spend]));
  const products = await Product.find({ _id: { $in: [...byProduct.keys(), ...adMap.keys()] } }).select('title slug state images').lean();
  const list = products.map((p) => {
    const v = byProduct.get(String(p._id)) ?? { units: 0, revenue: 0, cost: 0 };
    const spend = adMap.get(String(p._id)) ?? 0;
    return { productId: String(p._id), title: p.title, slug: p.slug, state: p.state, image: p.images?.[0]?.url, units: v.units, revenue: Math.round(v.revenue), adSpend: spend, profit: Math.round(v.revenue - v.cost - spend) };
  });
  list.sort((a, b) => b.profit - a.profit);
  return { winners: list.filter((p) => p.profit > 0).slice(0, limit), losers: list.filter((p) => p.profit < 0).sort((a, b) => a.profit - b.profit).slice(0, limit), all: list.slice(0, 100) };
}

export async function supplierHealth() {
  const sups = await Supplier.find({}).limit(100).lean();
  const offerCounts = await SupplierOffer.aggregate<{ _id: string; n: number; avail: number }>([{ $group: { _id: '$supplierId', n: { $sum: 1 }, avail: { $sum: { $cond: ['$available', 1, 0] } } } }]);
  const oc = new Map(offerCounts.map((o) => [String(o._id), o]));
  const delivered = await Shipment.aggregate<{ _id: mongoose.Types.ObjectId; avgMs: number; n: number }>([
    { $match: { status: 'DELIVERED' } }, { $group: { _id: '$supplierId', avgMs: { $avg: { $subtract: ['$updatedAt', '$createdAt'] } }, n: { $sum: 1 } } },
  ]);
  const dm = new Map(delivered.map((d) => [String(d._id), d]));
  return sups.map((s) => {
    const total = s.stats?.ordersTotal ?? 0;
    return {
      id: String(s._id), code: s.code, name: s.name, provider: s.provider, country: s.country ?? null, rating: s.rating, reliability: s.reliability, returnPolicyDays: s.returnPolicyDays, trackingAvailable: s.trackingAvailable,
      active: s.active, apiStatus: s.apiStatus, apiStatusMessage: s.apiStatusMessage ?? null, lastSyncAt: s.lastSyncAt ?? null, ordersTotal: total, failRate: total ? (s.stats?.ordersFailed ?? 0) / total : 0, lateRate: total ? (s.stats?.ordersLate ?? 0) / total : 0,
      offers: oc.get(String(s._id))?.n ?? 0, offersAvailable: oc.get(String(s._id))?.avail ?? 0, avgDeliveryDays: dm.get(String(s._id)) ? Math.round((dm.get(String(s._id))!.avgMs / 86_400_000) * 10) / 10 : null,
    };
  });
}

/** Reliability from our own shipment history, blended with the prior so small samples do not swing wildly. */
export async function refreshSupplierReliability(): Promise<number> {
  const sups = await Supplier.find({}).limit(100);
  let n = 0;
  for (const s of sups) {
    const total = s.stats?.ordersTotal ?? 0;
    if (total < 10) continue;
    const fail = (s.stats?.ordersFailed ?? 0) / total;
    const late = (s.stats?.ordersLate ?? 0) / total;
    const observed = Math.max(0, Math.min(100, 100 - fail * 100 * 1.5 - late * 100 * 0.7));
    const w = Math.min(0.8, total / 100);
    s.reliability = Math.round(s.reliability * (1 - w) + observed * w);
    await s.save();
    n++;
  }
  return n;
}

export async function liveStats(ctx: Ctx) {
  const now = ctx.now();
  const m5 = new Date(now.getTime() - 5 * 60_000);
  const h1 = new Date(now.getTime() - 3_600_000);
  const d1 = new Date(now.getTime() - 86_400_000);
  const [visitors, pending, awaitingSupplier, shippingIssues, lowStock, failedPayments, failedSupplier, adAlerts, openEx] = await Promise.all([
    AnalyticsEvent.distinct('sessionId', { ts: { $gte: m5 }, sessionId: { $ne: null } }).then((a) => a.length),
    Order.countDocuments({ status: 'PENDING_PAYMENT', createdAt: { $gte: h1 } }),
    Order.countDocuments({ status: { $in: ['PAID', 'SUPPLIER_PROCESSING'] }, 'fulfillment.state': { $in: ['none', 'queued', 'processing', 'failed'] } }),
    ExceptionModel.countDocuments({ kind: 'TRACKING', status: { $in: ['open', 'in_progress'] } }),
    Inventory.countDocuments({ status: { $in: ['LOW_STOCK', 'OUT_OF_STOCK', 'SUPPLIER_UNAVAILABLE'] } }),
    Payment.countDocuments({ status: 'failed', updatedAt: { $gte: d1 } }),
    ExceptionModel.countDocuments({ kind: 'SUPPLIER_FAILURE', status: { $in: ['open', 'in_progress'] } }),
    Campaign.countDocuments({ status: 'active', 'recommendation.action': { $in: ['PAUSE', 'REDUCE'] } }),
    ExceptionModel.countDocuments({ status: { $in: ['open', 'in_progress'] } }),
  ]);
  return { activeVisitors: visitors, currentOrders: pending, pendingSupplierOrders: awaitingSupplier, shippingIssues, lowStockProducts: lowStock, failedPayments, failedSupplierOrders: failedSupplier, adAlerts, openExceptions: openEx };
}

export interface Insight {
  id: string;
  severity: 'info' | 'positive' | 'warning' | 'critical';
  title: string;
  detail: string;
  action?: { label: string; href: string };
}

/** Deterministic insights computed from real data (no LLM, no invented numbers). */
export async function insights(ctx: Ctx): Promise<Insight[]> {
  const out: Insight[] = [];
  const range = parseRange('30d', undefined, undefined, ctx.now());
  const perf = await productPerformance(ctx, range, 5);
  for (const w of perf.winners.slice(0, 2)) out.push({ id: `win:${w.productId}`, severity: 'positive', title: `${w.title} should be scaled`, detail: `Contribution profit ${(w.profit / 100).toFixed(2)} USD on ${w.units} unit(s) in 30 days after ${(w.adSpend / 100).toFixed(2)} USD ad spend.`, action: { label: 'Open product', href: `/admin/products/${w.productId}` } });
  for (const l of perf.losers.slice(0, 2)) out.push({ id: `lose:${l.productId}`, severity: 'warning', title: `${l.title} is losing money`, detail: `Contribution ${(l.profit / 100).toFixed(2)} USD after ${(l.adSpend / 100).toFixed(2)} USD of ads in 30 days.`, action: { label: 'Review', href: `/admin/products/${l.productId}` } });
  const spikes = await SupplierOffer.find({ lastPriceChangePct: { $gte: 0.1 } }).sort({ lastPriceChangePct: -1 }).limit(3).lean();
  const sNames = new Map((await Supplier.find({ _id: { $in: spikes.map((s) => s.supplierId) } }).select('name').lean()).map((s) => [String(s._id), s.name]));
  for (const s of spikes) out.push({ id: `spike:${s._id}`, severity: 'warning', title: `${sNames.get(String(s.supplierId)) ?? 'A supplier'} increased price ${Math.round(s.lastPriceChangePct * 100)}%`, detail: `Destination ${s.destination}. Re-check pricing and supplier ranking.`, action: { label: 'Suppliers', href: '/admin/suppliers' } });
  const c = await countryAnalytics(ctx, range);
  for (const k of c.countries) if (k.orders >= 5 && k.profitPerOrder < 0) out.push({ id: `country:${k.country}`, severity: 'critical', title: `${k.name} is unprofitable`, detail: `Profit per order is ${(k.profitPerOrder / 100).toFixed(2)} USD over the last 30 days.`, action: { label: 'Country analytics', href: '/admin/countries' } });
  const camps = await Campaign.find({ status: 'active', 'recommendation.action': { $in: ['PAUSE', 'REDUCE', 'SCALE'] } }).limit(5).lean();
  for (const cm of camps) out.push({ id: `camp:${cm._id}`, severity: cm.recommendation?.action === 'SCALE' ? 'positive' : 'warning', title: `Campaign "${cm.name}": ${cm.recommendation?.action}`, detail: cm.recommendation?.reason ?? '', action: { label: 'Ads', href: '/admin/ads' } });
  const cust = await Customer.countDocuments({});
  if (!out.length) out.push({ id: 'none', severity: 'info', title: cust ? 'No notable changes' : 'Waiting for data', detail: 'Insights appear here once orders, ad metrics and supplier syncs produce signal.' });
  return out;
}
