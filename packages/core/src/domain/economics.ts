import mongoose from 'mongoose';
import { AdMetric, MeasuredCpa, MeasuredRefund, Order, Product, Shipment } from '@orvia/database';
import { SCENARIO_NAMES, breakEvenCacPct, evaluateCacScenarios, paymentFeeModelFor } from '@orvia/analytics';
import type { CpaSource, ScenarioReport } from '@orvia/analytics';
import { convertMinor } from '@orvia/types';
import type { CountryCode, Currency } from '@orvia/types';
import { audit } from '../infra/audit';
import { getCountry, getCountryConfigs } from '../infra/countries';
import { DomainError } from '../infra/context';
import type { Actor, Ctx } from '../infra/context';
import { compareSuppliers } from './offers';

const DAY = 86_400_000;
const oid = (id: string) => new mongoose.Types.ObjectId(id);

/* ------------------------------------------------------------------ */
/* Measured CPA: real ad spend ÷ attributed orders                     */
/* ------------------------------------------------------------------ */

export interface ResolvedCpa {
  /** CAC per order in the market currency (minor units), or null when only an assumption is available. */
  perOrder: number | null;
  source: CpaSource;
  sampleSize: number;
}

/**
 * Resolution order: this product → its category → the whole store → assumed.
 * A level is only used when it has at least `minCpaSample` attributed orders; thinner data falls through.
 */
export async function resolveCpa(ctx: Ctx, p: { productId: string; category?: string; country: CountryCode; currency: Currency }): Promise<ResolvedCpa> {
  const pricing = await ctx.settings.get('pricing');
  const fx = (await ctx.settings.get('ops')).fx;
  const levels: { scope: 'product' | 'category' | 'store'; key: string; country: string; source: CpaSource }[] = [
    { scope: 'product', key: p.productId, country: p.country, source: 'measured' },
    ...(p.category ? [{ scope: 'category' as const, key: p.category, country: p.country, source: 'category' as CpaSource }] : []),
    { scope: 'store', key: 'store', country: p.country, source: 'store' },
    { scope: 'store', key: 'store', country: '*', source: 'store' },
  ];
  for (const l of levels) {
    const doc = await MeasuredCpa.findOne({ scope: l.scope, key: l.key, country: l.country, channel: 'all' }).lean();
    if (doc && doc.orders >= pricing.minCpaSample && doc.spend > 0) {
      return { perOrder: Math.round(convertMinor(Math.round(doc.spend / doc.orders), 'USD', p.currency, fx)), source: l.source, sampleSize: doc.orders };
    }
  }
  return { perOrder: null, source: 'assumed', sampleSize: 0 };
}

interface Bucket { spend: number; orders: number }
const add = (m: Map<string, Bucket>, k: string, spend: number, orders: number) => {
  const b = m.get(k) ?? { spend: 0, orders: 0 };
  b.spend += spend;
  b.orders += orders;
  m.set(k, b);
};

/**
 * Rebuild the measured-CPA store from real (non-demo) ad metrics. Manual entries are never overwritten.
 * CPA is spend ÷ orders, where orders are the platform-reported purchases capped at real paid orders (see below):
 * with no real orders there is no measurement. Spend and purchase counts are platform-reported and attribution is not
 * deduplicated per customer beyond that cap (organic buyers can still be counted), so the blended CPA can UNDERSTATE the
 * true cost of a customer. Keep the measurement scope to one channel until a deduplicated attribution method exists.
 * Product → category → store roll-ups are computed here so resolution is a cheap indexed read.
 */
export async function refreshMeasuredCpa(ctx: Ctx): Promise<{ written: number; removed: number }> {
  const pricing = await ctx.settings.get('pricing');
  const started = ctx.now();
  const since = new Date(started.getTime() - pricing.cpaWindowDays * DAY);
  const rows = await AdMetric.aggregate<{ _id: { productId: mongoose.Types.ObjectId; country: string; platform: string }; spend: number; purchases: number }>([
    { $match: { isDemo: { $ne: true }, date: { $gte: since }, productId: { $exists: true, $ne: null } } },
    { $group: { _id: { productId: '$productId', country: '$country', platform: '$platform' }, spend: { $sum: '$spend' }, purchases: { $sum: '$purchases' } } },
  ]);
  const cats = new Map((await Product.find({ _id: { $in: [...new Set(rows.map((r) => r._id.productId))] } }).select('category').lean()).map((p) => [String(p._id), p.category ?? '']));
  // Ad platforms self-report purchases and several can claim the same customer. A customer can only be acquired once, so
  // attributed orders per product+country are capped at the REAL paid, non-demo orders for that product+country in the window.
  const real = await Order.aggregate<{ _id: { productId: mongoose.Types.ObjectId; country: string }; n: number }>([
    { $match: { isDemo: { $ne: true }, createdAt: { $gte: since }, 'payment.status': { $in: ['succeeded', 'partially_refunded', 'refunded'] } } },
    { $unwind: '$items' },
    { $group: { _id: { productId: '$items.productId', country: '$country', order: '$_id' } } },
    { $group: { _id: { productId: '$_id.productId', country: '$_id.country' }, n: { $sum: 1 } } },
  ]);
  const realOrders = new Map(real.map((r) => [`${r._id.productId}|${r._id.country}`, r.n]));
  const claimed = new Map<string, number>();
  for (const r of rows) claimed.set(`${r._id.productId}|${r._id.country}`, (claimed.get(`${r._id.productId}|${r._id.country}`) ?? 0) + r.purchases);
  const buckets = new Map<string, Bucket>();
  const key = (scope: string, k: string, country: string, channel: string) => [scope, k, country, channel].join('\u0000');
  for (const r of rows) {
    const pid = String(r._id.productId);
    const { country, platform } = r._id;
    const ch = platform || 'unknown';
    const cat = cats.get(pid);
    const total = claimed.get(`${pid}|${country}`) ?? 0;
    const cap = realOrders.get(`${pid}|${country}`) ?? 0;
    const orders = total > cap ? Math.floor((r.purchases * cap) / total) : r.purchases;
    for (const channel of [ch, 'all']) {
      add(buckets, key('product', pid, country, channel), r.spend, orders);
      if (cat) add(buckets, key('category', cat, country, channel), r.spend, orders);
      add(buckets, key('store', 'store', country, channel), r.spend, orders);
      add(buckets, key('store', 'store', '*', channel), r.spend, orders);
    }
  }
  const manual = new Set((await MeasuredCpa.find({ source: 'manual' }).select('scope key country channel').lean()).map((d) => key(d.scope, d.key, d.country, d.channel)));
  const ops = [];
  for (const [k, b] of buckets) {
    if (manual.has(k)) continue;
    const [scope, kk, country, channel] = k.split('\u0000') as [string, string, string, string];
    ops.push({ updateOne: { filter: { scope, key: kk, country, channel }, update: { $set: { spend: Math.round(b.spend), orders: b.orders, windowDays: pricing.cpaWindowDays, source: 'ad_metrics', computedAt: started } }, upsert: true } });
  }
  if (ops.length) await MeasuredCpa.bulkWrite(ops as never);
  const removed = await MeasuredCpa.deleteMany({ source: 'ad_metrics', computedAt: { $lt: started } });
  return { written: ops.length, removed: removed.deletedCount ?? 0 };
}

export interface ManualCpaInput {
  scope: 'product' | 'category' | 'store';
  key: string;
  country: CountryCode | '*';
  channel?: string;
  /** Total real ad spend, USD minor units. */
  spend: number;
  /** Real orders attributed to that spend. */
  orders: number;
  note?: string;
}

/** Record a measured CPA by hand (e.g. Phase 2 launch orders where spend is read from the ad platform UI). Audited. */
export async function recordManualCpa(ctx: Ctx, i: ManualCpaInput, actor: Actor): Promise<void> {
  if (!Number.isInteger(i.spend) || i.spend <= 0) throw new DomainError('spend must be a positive integer (USD minor units)', 'INVALID', 422);
  if (!Number.isInteger(i.orders) || i.orders <= 0) throw new DomainError('orders must be a positive integer', 'INVALID', 422);
  if (i.scope === 'product' && !mongoose.isValidObjectId(i.key)) throw new DomainError('product scope needs a product id', 'INVALID', 422);
  const channel = i.channel || 'all';
  await MeasuredCpa.updateOne(
    { scope: i.scope, key: i.scope === 'store' ? 'store' : i.key, country: i.country, channel },
    { $set: { spend: i.spend, orders: i.orders, source: 'manual', note: i.note, computedAt: ctx.now() } },
    { upsert: true },
  );
  await audit(ctx, actor, { action: 'economics.cpa.recorded', resource: 'measured_cpa', resourceId: `${i.scope}:${i.key}:${i.country}:${channel}`, newValue: { spend: i.spend, orders: i.orders }, reason: i.note ?? 'manual measured CPA' });
}

/* ------------------------------------------------------------------ */
/* Measured refund rate per product–supplier–destination               */
/* ------------------------------------------------------------------ */

/**
 * Rebuild measured refund rates from real (non-demo) paid orders. An order's total and refunded value are
 * split evenly across the distinct (product, supplier) pairs that fulfilled it, so a mixed order does not
 * charge one supplier for another's refund.
 */
export async function refreshMeasuredRefunds(ctx: Ctx): Promise<{ written: number }> {
  const pricing = await ctx.settings.get('pricing');
  const started = ctx.now();
  const since = new Date(started.getTime() - pricing.refundWindowDays * DAY);
  const orders = await Order.find({ isDemo: { $ne: true }, createdAt: { $gte: since }, 'payment.status': { $in: ['succeeded', 'refunded', 'partially_refunded'] } }).select('country amounts.total costs.refunded').lean();
  const ships = await Shipment.find({ orderId: { $in: orders.map((o) => o._id) }, status: { $nin: ['FAILED', 'CANCELLED'] }, productId: { $exists: true } }).select('orderId productId supplierId').lean();
  const byOrder = new Map<string, Set<string>>();
  for (const s of ships) {
    const set = byOrder.get(String(s.orderId)) ?? new Set<string>();
    set.add(`${s.productId}|${s.supplierId}`);
    byOrder.set(String(s.orderId), set);
  }
  const agg = new Map<string, { orders: number; value: number; refunded: number }>();
  for (const o of orders) {
    const pairs = byOrder.get(String(o._id));
    if (!pairs?.size) continue;
    for (const pair of pairs) {
      const k = `${pair}|${o.country}`;
      const a = agg.get(k) ?? { orders: 0, value: 0, refunded: 0 };
      a.orders += 1;
      a.value += (o.amounts?.total ?? 0) / pairs.size;
      a.refunded += Math.min(o.amounts?.total ?? 0, o.costs?.refunded ?? 0) / pairs.size;
      agg.set(k, a);
    }
  }
  const ops = [...agg].map(([k, a]) => {
    const [productId, supplierId, country] = k.split('|') as [string, string, string];
    return { updateOne: { filter: { productId: oid(productId), supplierId: oid(supplierId), country }, update: { $set: { orders: a.orders, orderValue: Math.round(a.value), refundedValue: Math.round(a.refunded), windowDays: pricing.refundWindowDays, computedAt: started } }, upsert: true } };
  });
  if (ops.length) await MeasuredRefund.bulkWrite(ops as never);
  await MeasuredRefund.deleteMany({ computedAt: { $lt: started } });
  return { written: ops.length };
}

/** supplierId → measured rate, only for pairs with at least `minRefundSample` orders. */
export async function measuredRefundRates(ctx: Ctx, productId: string, country: CountryCode): Promise<Map<string, { rate: number; sample: number }>> {
  const pricing = await ctx.settings.get('pricing');
  const docs = await MeasuredRefund.find({ productId, country, orders: { $gte: pricing.minRefundSample }, orderValue: { $gt: 0 } }).lean();
  return new Map(docs.map((d) => [String(d.supplierId), { rate: d.refundedValue / d.orderValue, sample: d.orders }]));
}

/* ------------------------------------------------------------------ */
/* Scenario evaluation for a stored market (used by the publish gate)  */
/* ------------------------------------------------------------------ */

export interface MarketEconomicsInput {
  country: string;
  price: number;
  landedCost: number;
  cpa?: number;
  cpaSource?: string;
  cpaSampleSize?: number;
  refundRate?: number;
  refundSource?: string;
  refundSampleSize?: number;
}

export interface MarketScenarioView {
  country: string;
  cpaSource: CpaSource;
  cpaSampleSize: number;
  refundSource: 'measured' | 'estimated';
  refundRate: number;
  scenarios: ScenarioReport;
  /** Highest CAC (fraction of price) that still clears minMarginPct. */
  breakEvenCacPct: number;
}

export async function evaluateMarket(ctx: Ctx, m: MarketEconomicsInput): Promise<MarketScenarioView> {
  const pricing = await ctx.settings.get('pricing');
  const cpaSource = (m.cpaSource && m.cpaSource !== 'assumed' && (m.cpa ?? 0) > 0 ? m.cpaSource : 'assumed') as CpaSource;
  // Provenance, not magnitude, decides "measured": a real 0% refund rate over enough orders is a measurement, not missing data.
  const refundMeasured = m.refundSource === 'measured' && (m.refundSampleSize ?? 0) > 0;
  const refundRate = refundMeasured ? Math.max(0, m.refundRate ?? 0) : (m.refundRate ?? 0) > 0 ? m.refundRate! : pricing.baseRefundRate;
  const input = { sellingPrice: m.price, landedCost: m.landedCost, paymentFee: paymentFeeModelFor(m.country), refundRate };
  return {
    country: m.country,
    cpaSource,
    cpaSampleSize: cpaSource === 'assumed' ? 0 : (m.cpaSampleSize ?? 0),
    refundSource: refundMeasured ? 'measured' : 'estimated',
    refundRate,
    scenarios: evaluateCacScenarios(input, pricing.cacScenarios, cpaSource === 'assumed' ? undefined : m.cpa),
    breakEvenCacPct: breakEvenCacPct(input, pricing.minMarginPct),
  };
}

/* ------------------------------------------------------------------ */
/* Decision sheet: one row per product × market                        */
/* ------------------------------------------------------------------ */

/**
 * measured  – realised from real orders / ad spend
 * quoted    – a current supplier quote or published rate card (real, but not a realised cost)
 * set       – an operator decision (the selling price)
 * estimated – a model or assumption
 */
export type Basis = 'measured' | 'quoted' | 'set' | 'estimated';
export interface Cell { value: number; basis: Basis; note?: string }

export interface EconomicsRow {
  productId: string;
  title: string;
  state: string;
  country: string;
  currency: string;
  supplier: string | null;
  cpaSource: CpaSource;
  cpaSampleSize: number;
  sellingPrice: Cell;
  productCost: Cell;
  shipping: Cell;
  duties: Cell;
  paymentFee: Cell;
  refundAllowance: Cell;
  cac: Record<'optimistic' | 'expected' | 'pessimistic', Cell>;
  contribution: Record<'optimistic' | 'expected' | 'pessimistic', Cell>;
  marginPct: Record<'optimistic' | 'expected' | 'pessimistic', Cell>;
  breakEvenCacPct: Cell;
  minMarginPct: number;
  verdict: 'CLEARS' | 'FAILS_EXPECTED' | 'PESSIMISTIC_RISK' | 'NO_SUPPLIER';
  needsHumanApproval: boolean;
}

export async function decisionSheet(ctx: Ctx, o: { limit?: number } = {}): Promise<EconomicsRow[]> {
  const pricing = await ctx.settings.get('pricing');
  const enabled = new Set(Object.values(await getCountryConfigs()).filter((c) => c.enabled).map((c) => c.code));
  const products = await Product.find({ state: { $nin: ['BANNED', 'REJECTED'] }, 'markets.0': { $exists: true } }).select('title state category markets').sort({ updatedAt: -1 }).limit(o.limit ?? 300).lean();
  const out: EconomicsRow[] = [];
  for (const p of products) {
    for (const m of p.markets) {
      if (!m.enabled || !m.price || !enabled.has(m.country as CountryCode)) continue;
      const country = m.country as CountryCode;
      const cfg = await getCountry(country);
      const cpa = await resolveCpa(ctx, { productId: String(p._id), category: p.category ?? undefined, country, currency: cfg.currency });
      const cmp = await compareSuppliers(ctx, String(p._id), country, { sellingPrice: m.price, adCostPerOrder: cpa.perOrder ?? Math.round(m.price * pricing.cacScenarios.expected) });
      const row = cmp.rows.find((r) => m.bestSupplierId && r.supplierId === String(m.bestSupplierId)) ?? cmp.rows.find((r) => r.eligible);
      const cellEst = (value: number, basis: Basis, note?: string): Cell => ({ value, basis, note });
      const zero = cellEst(0, 'estimated');
      if (!row) {
        out.push({ productId: String(p._id), title: p.title, state: p.state, country, currency: cfg.currency, supplier: null, cpaSource: cpa.source, cpaSampleSize: cpa.sampleSize, sellingPrice: cellEst(m.price, 'set'), productCost: zero, shipping: zero, duties: zero, paymentFee: zero, refundAllowance: zero, cac: { optimistic: zero, expected: zero, pessimistic: zero }, contribution: { optimistic: zero, expected: zero, pessimistic: zero }, marginPct: { optimistic: zero, expected: zero, pessimistic: zero }, breakEvenCacPct: zero, minMarginPct: pricing.minMarginPct, verdict: 'NO_SUPPLIER', needsHumanApproval: cpa.source === 'assumed' });
        continue;
      }
      const fee = paymentFeeModelFor(country);
      const view = await evaluateMarket(ctx, { country, price: m.price, landedCost: row.landedCost, cpa: cpa.perOrder ?? undefined, cpaSource: cpa.source, cpaSampleSize: cpa.sampleSize, refundRate: row.refundRate, refundSource: row.refundSource, refundSampleSize: row.refundSampleSize });
      const cpaBasis: Basis = cpa.source === 'assumed' ? 'estimated' : 'measured';
      const refundBasis: Basis = row.refundSource === 'measured' ? 'measured' : 'estimated';
      const dutyDomestic = row.warehouseCountry === country;
      const dutyBasis: Basis = dutyDomestic ? 'quoted' : 'estimated';
      const sc = view.scenarios;
      const feeAmount = Math.round(m.price * fee.pct + fee.fixed);
      // Derived figures are only "measured" when every input that is not a quote/decision is measured.
      const derived: Basis = cpaBasis === 'measured' && refundBasis === 'measured' && dutyBasis !== 'estimated' ? 'measured' : 'estimated';
      const cacCell = (n: 'optimistic' | 'expected' | 'pessimistic'): Cell => ({ value: sc[n].cac, basis: cpa.source !== 'assumed' && (n === 'expected' || sc[n].cac === sc.expected.cac) ? 'measured' : 'estimated', note: n === 'expected' && cpa.source !== 'assumed' ? `${cpa.source}, n=${cpa.sampleSize}` : undefined });
      const names = SCENARIO_NAMES as readonly ('optimistic' | 'expected' | 'pessimistic')[];
      const pick = <T,>(f: (n: 'optimistic' | 'expected' | 'pessimistic') => T) => Object.fromEntries(names.map((n) => [n, f(n)])) as Record<'optimistic' | 'expected' | 'pessimistic', T>;
      const clearsExpected = sc.expected.margin >= pricing.minMarginPct - 1e-9;
      const clearsPess = sc.pessimistic.margin >= pricing.minMarginPct - 1e-9;
      out.push({
        productId: String(p._id), title: p.title, state: p.state, country, currency: cfg.currency, supplier: row.supplierName, cpaSource: cpa.source, cpaSampleSize: cpa.sampleSize,
        sellingPrice: cellEst(m.price, 'set'),
        productCost: cellEst(row.productCost, 'quoted', row.stale ? 'stale quote' : undefined),
        shipping: cellEst(row.shippingCost + (row.fulfillmentFee ?? 0), 'quoted'),
        duties: cellEst(row.duties, dutyBasis, dutyDomestic ? 'domestic, none' : 'estimate: regional rate table'),
        paymentFee: cellEst(feeAmount, 'quoted', 'published rate card'),
        refundAllowance: cellEst(Math.round(m.price * view.refundRate), refundBasis, refundBasis === 'measured' ? `n=${row.refundSampleSize}` : 'estimate'),
        cac: pick(cacCell),
        contribution: pick((n) => ({ value: sc[n].profit, basis: n === 'expected' ? derived : 'estimated' as Basis })),
        marginPct: pick((n) => ({ value: Math.round(sc[n].margin * 10_000) / 10_000, basis: n === 'expected' ? derived : 'estimated' as Basis })),
        breakEvenCacPct: cellEst(Math.round(view.breakEvenCacPct * 10_000) / 10_000, derived === 'measured' ? 'measured' : 'estimated'),
        minMarginPct: pricing.minMarginPct,
        verdict: !clearsExpected ? 'FAILS_EXPECTED' : !clearsPess ? 'PESSIMISTIC_RISK' : 'CLEARS',
        needsHumanApproval: cpa.source === 'assumed',
      });
    }
  }
  return out;
}

const csvCell = (v: unknown): string => {
  const s = String(v ?? '');
  // Neutralise spreadsheet formula injection from product titles.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** CSV of the decision sheet. Money in major units; every figure is followed by its basis (measured/quoted/set/estimated). */
export function economicsCsv(rows: EconomicsRow[]): string {
  const major = (n: number) => (n / 100).toFixed(2);
  const head = ['product', 'state', 'country', 'currency', 'supplier', 'verdict', 'needs_human_approval', 'cpa_source', 'cpa_sample'];
  const money: [string, (r: EconomicsRow) => Cell][] = [
    ['selling_price', (r) => r.sellingPrice], ['product_cost', (r) => r.productCost], ['shipping', (r) => r.shipping], ['duties', (r) => r.duties], ['payment_fee', (r) => r.paymentFee], ['refund_allowance', (r) => r.refundAllowance],
    ['cac_optimistic', (r) => r.cac.optimistic], ['cac_expected', (r) => r.cac.expected], ['cac_pessimistic', (r) => r.cac.pessimistic],
    ['contribution_optimistic', (r) => r.contribution.optimistic], ['contribution_expected', (r) => r.contribution.expected], ['contribution_pessimistic', (r) => r.contribution.pessimistic],
  ];
  const pct: [string, (r: EconomicsRow) => Cell][] = [
    ['margin_optimistic_pct', (r) => r.marginPct.optimistic], ['margin_expected_pct', (r) => r.marginPct.expected], ['margin_pessimistic_pct', (r) => r.marginPct.pessimistic], ['break_even_cac_pct', (r) => r.breakEvenCacPct],
  ];
  const header = [...head, ...money.flatMap(([n]) => [n, `${n}_basis`]), ...pct.flatMap(([n]) => [n, `${n}_basis`]), 'min_margin_pct'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      r.title, r.state, r.country, r.currency, r.supplier ?? '', r.verdict, r.needsHumanApproval, r.cpaSource, r.cpaSampleSize,
      ...money.flatMap(([, f]) => [major(f(r).value), f(r).basis]),
      ...pct.flatMap(([, f]) => [(f(r).value * 100).toFixed(2), f(r).basis]),
      (r.minMarginPct * 100).toFixed(2),
    ].map(csvCell).join(','));
  }
  return lines.join('\n') + '\n';
}
