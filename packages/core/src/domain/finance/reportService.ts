/**
 * Read-only finance reporting over real data (Orders, Shipments, AdMetric, MeasuredCpa, ledger). Nothing here writes
 * to existing collections. Amounts are converted to the reporting currency at the CURRENT stored FX rate (labelled).
 */
import mongoose from 'mongoose';
import { AdMetric, FinanceLedgerEntry, MeasuredCpa, Order, Payment, Product, Refund, Shipment, Supplier } from '@orvia/database';
import type { Currency, LedgerAccount } from '@orvia/types';
import type { Ctx } from '../../infra/context';
import { buildCohorts, buildPnl, computeKpis, costChangeAlerts, forecastCashFlow, observedLtv, openPayables, profitability } from './analytics';
import type { CostObservation, OrderFact, Receivable } from './analytics';
import { crossRate, fxStaleness } from './fx';
import { currentFx, fxPolicy } from './fxService';
import { ledgerBalances } from './ledgerService';
import { applyMeasured, runAll, sensitivity } from './scenario';
import type { MeasuredInputs } from './scenario';
import { getFinanceSettings, getScenarioSets } from './settings';

const DAY = 86_400_000;
const PAID = ['succeeded', 'partially_refunded', 'refunded'];
export interface FinanceRange { from: Date; to: Date }

async function converter(ctx: Ctx, reporting: Currency) {
  const snap = await currentFx(ctx);
  const policy = await fxPolicy(ctx);
  const staleness = fxStaleness(snap.fetchedAt, ctx.now(), policy);
  const conv = (minor: number, from: string): number => (from === reporting ? Math.round(minor) : Math.round(minor * crossRate(snap.rates, from as Currency, reporting)));
  return { conv, fx: { source: snap.source, asOf: snap.fetchedAt.toISOString(), staleness, stale: staleness !== 'fresh', rates: snap.rates, reporting } };
}

type OrderDoc = {
  _id: mongoose.Types.ObjectId; orderNumber: string; email: string; country: string; currency: string; items?: { productId?: mongoose.Types.ObjectId; title?: string; quantity?: number; unitPrice?: number }[];
  amounts?: { total?: number; tax?: number; discount?: number; shipping?: number; subtotal?: number }; payment?: { paidAt?: Date; provider?: string };
  costs?: { supplierCost?: number; shippingCost?: number; duties?: number; paymentFee?: number; refunded?: number }; fulfillment?: { state?: string }; deliveredAt?: Date; attribution?: { campaignId?: unknown };
};

/** Paid, non-demo orders in range as plain facts in the reporting currency. */
export async function loadFacts(ctx: Ctx, range: FinanceRange, reporting: Currency, cap = 5000): Promise<{ facts: OrderFact[]; truncated: boolean; fx: Awaited<ReturnType<typeof converter>>['fx'] }> {
  const { conv, fx } = await converter(ctx, reporting);
  const docs = (await Order.find({ 'payment.paidAt': { $gte: range.from, $lte: range.to }, isDemo: { $ne: true } }).sort({ 'payment.paidAt': -1 }).limit(cap + 1).select('orderNumber email country currency items amounts payment.paidAt payment.provider costs fulfillment.state deliveredAt attribution.campaignId').lean()) as unknown as OrderDoc[];
  const truncated = docs.length > cap;
  const list = docs.slice(0, cap);
  const ships = await Shipment.find({ orderId: { $in: list.map((o) => o._id) }, status: { $nin: ['FAILED', 'CANCELLED'] } }).select('orderId productId supplierId').lean();
  const supNames = new Map((await Supplier.find({ _id: { $in: [...new Set(ships.map((s) => String(s.supplierId)))] } }).select('name').lean()).map((s) => [String(s._id), s.name as string]));
  const supByOrderProduct = new Map(ships.map((s) => [`${s.orderId}|${s.productId}`, String(s.supplierId)]));
  const facts: OrderFact[] = list.map((o) => {
    const c = o.currency;
    const total = o.amounts?.total ?? 0;
    const tax = o.amounts?.tax ?? 0;
    const itemsTotal = (o.items ?? []).reduce((a, i) => a + (i.unitPrice ?? 0) * (i.quantity ?? 1), 0) || 1;
    const costKnown = ['placed', 'partial'].includes(o.fulfillment?.state ?? '') && ((o.costs?.supplierCost ?? 0) > 0);
    return {
      id: String(o._id), orderNumber: o.orderNumber, email: o.email, country: o.country, paidAt: o.payment?.paidAt as Date,
      total: conv(total, c), tax: conv(tax, c), discount: conv(o.amounts?.discount ?? 0, c), shipping: conv(o.amounts?.shipping ?? 0, c), refunded: conv(o.costs?.refunded ?? 0, c),
      costKnown, supplierCost: conv(o.costs?.supplierCost ?? 0, c), shippingCost: conv(o.costs?.shippingCost ?? 0, c), duties: conv(o.costs?.duties ?? 0, c), paymentFee: conv(o.costs?.paymentFee ?? 0, c),
      delivered: !!o.deliveredAt, fulfilled: ['placed', 'partial'].includes(o.fulfillment?.state ?? ''), attributed: !!o.attribution?.campaignId,
      lines: (o.items ?? []).map((i) => {
        const sid = supByOrderProduct.get(`${o._id}|${i.productId}`);
        return { productId: String(i.productId ?? 'unknown'), title: i.title, supplierId: sid, supplierName: sid ? supNames.get(sid) : undefined, value: conv(Math.round(((i.unitPrice ?? 0) * (i.quantity ?? 1) / itemsTotal) * (total - tax)), c) };
      }),
    };
  });
  return { facts, truncated, fx };
}

async function adSpendReporting(ctx: Ctx, range: FinanceRange, reporting: Currency): Promise<number | null> {
  const [a] = await AdMetric.aggregate<{ spend: number }>([{ $match: { isDemo: { $ne: true }, date: { $gte: new Date(range.from.toISOString().slice(0, 10)), $lte: range.to } } }, { $group: { _id: null, spend: { $sum: '$spend' } } }]);
  if (!a || a.spend <= 0) return null;
  const { conv } = await converter(ctx, reporting);
  return conv(a.spend, 'USD'); // AdMetric.spend is USD minor units
}

async function chargebackTotals(range: FinanceRange, reporting: Currency, conv: (m: number, c: string) => number) {
  const rows = await FinanceLedgerEntry.find({ kind: 'chargeback', postedAt: { $gte: range.from, $lte: range.to } }).select('currency lines').lean();
  const any = (await FinanceLedgerEntry.countDocuments({ kind: 'chargeback' })) > 0;
  let amount = 0;
  for (const r of rows) amount += conv(r.lines.filter((l) => l.account === 'chargebacks').reduce((a, l) => a + l.amount, 0), r.currency);
  void reporting;
  return { amount, count: rows.length, recorded: any };
}

export async function overview(ctx: Ctx, range: FinanceRange) {
  const s = await getFinanceSettings(ctx);
  const { facts, truncated, fx } = await loadFacts(ctx, range, s.reportingCurrency);
  const { conv } = await converter(ctx, s.reportingCurrency);
  const prior = new Set((await Order.distinct('email', { 'payment.paidAt': { $lt: range.from, $ne: null }, isDemo: { $ne: true } })).map((e) => String(e).toLowerCase()));
  const cb = await chargebackTotals(range, s.reportingCurrency, conv);
  const adSpend = await adSpendReporting(ctx, range, s.reportingCurrency);
  const cpa = await MeasuredCpa.findOne({ scope: 'store', key: 'store', country: '*', channel: 'all' }).lean();
  const rangeDays = Math.max(1, (range.to.getTime() - range.from.getTime()) / DAY);
  const kpis = computeKpis({
    facts, priorCustomers: prior, rangeDays, adSpend,
    measuredCpa: cpa && cpa.orders > 0 ? { spend: conv(cpa.spend, 'USD'), orders: cpa.orders } : null,
    chargebacks: cb,
    settings: { csCostPerOrder: s.csCostPerOrder, otherVariablePerOrder: s.otherVariablePerOrder, monthlyOpex: s.monthlyOpex, assumedChargebackRate: s.assumedChargebackRate },
  });
  const opex = Math.round((s.monthlyOpex * rangeDays) / 30.4375);
  return {
    range: { from: range.from.toISOString(), to: range.to.toISOString() },
    currency: s.reportingCurrency, fx, truncated,
    definitions: { gmv: 'what customers were charged (incl. tax, after discounts)', netSales: 'ex-tax revenue after refunds and chargebacks', contribution: 'net sales minus variable costs (supplier, shipping, duties, fees, acquisition, reserves)', netProfit: 'contribution minus operating expenses: an ESTIMATE, opex is an admin assumption' },
    kpis,
    pnl: buildPnl(kpis, { opex, opexNote: s.monthlyOpex > 0 ? 'monthly operating expenses set in finance settings, pro-rated to the range' : 'no operating expenses configured' }),
  };
}

export async function profitabilityReport(ctx: Ctx, range: FinanceRange, by: 'product' | 'supplier' | 'country' | 'order', limit = 100) {
  const s = await getFinanceSettings(ctx);
  const { facts, truncated, fx } = await loadFacts(ctx, range, s.reportingCurrency);
  return { currency: s.reportingCurrency, fx, truncated, by, note: 'Cost-known orders only; order costs are allocated to lines by value; before advertising and operating costs.', rows: profitability(facts, by).slice(0, limit) };
}

export async function cohortReport(ctx: Ctx, months = 12) {
  const s = await getFinanceSettings(ctx);
  const now = ctx.now();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, 1));
  const { facts, truncated, fx } = await loadFacts(ctx, { from, to: now }, s.reportingCurrency, 20_000);
  const { conv } = await converter(ctx, s.reportingCurrency);
  const ad = await AdMetric.aggregate<{ _id: string; spend: number }>([{ $match: { isDemo: { $ne: true }, date: { $gte: from } } }, { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$date' } }, spend: { $sum: '$spend' } } }]);
  const adByMonth = new Map(ad.map((a) => [a._id, conv(a.spend, 'USD')]));
  const cohorts = buildCohorts(facts, { now, adSpendByMonth: adByMonth });
  return { currency: s.reportingCurrency, fx, truncated, cohorts, ltv3: observedLtv(cohorts, 3), ltv6: observedLtv(cohorts, 6), note: 'Observed contribution per customer by cohort (cost-known orders, before ads). Not a forecast; empty until cohorts have history.' };
}

export async function cashFlowReport(ctx: Ctx, horizonDays = 56) {
  const s = await getFinanceSettings(ctx);
  const now = ctx.now();
  const { conv, fx } = await converter(ctx, s.reportingCurrency);
  const maxDelay = Math.max(s.pspSettlementDaysDefault, ...Object.values(s.pspSettlementDays));
  const orders = await Order.find({ 'payment.paidAt': { $gte: new Date(now.getTime() - maxDelay * DAY), $lte: now }, isDemo: { $ne: true } }).select('currency amounts.total costs.paymentFee costs.refunded payment.provider payment.paidAt').limit(5000).lean();
  const receivables: Receivable[] = orders.map((o) => ({ amount: conv(Math.max(0, (o.amounts?.total ?? 0) - (o.costs?.paymentFee ?? 0) - (o.costs?.refunded ?? 0)), o.currency), paidAt: o.payment?.paidAt as Date, provider: o.payment?.provider ?? undefined }));
  // payables from the ledger
  const costs = await FinanceLedgerEntry.find({ kind: 'supplier_cost', 'refs.supplierId': { $exists: true } }).select('currency lines refs.supplierId postedAt').limit(20_000).lean();
  const pays = await FinanceLedgerEntry.find({ kind: 'supplier_settlement' }).select('currency lines refs.supplierId').limit(20_000).lean();
  const amt = (e: { currency: string; lines: { account: string; amount: number }[] }, acc: string) => conv(e.lines.filter((l) => l.account === acc).reduce((a, l) => a + l.amount, 0), e.currency);
  const payables = openPayables(costs.map((c) => ({ supplierId: String(c.refs?.supplierId), amount: amt(c, 'supplier_payable'), postedAt: c.postedAt })), pays.map((p) => ({ supplierId: String(p.refs?.supplierId), amount: amt(p, 'supplier_payable') })), s.supplierPaymentTermsDays);
  const ad14 = await adSpendReporting(ctx, { from: new Date(now.getTime() - 14 * DAY), to: now }, s.reportingCurrency);
  const measured = await measuredRefundRate(ctx);
  const f = forecastCashFlow({
    now, horizonDays, openingCash: s.openingCash, receivables, settlementDays: (p) => (p && s.pspSettlementDays[p] !== undefined ? s.pspSettlementDays[p]! : s.pspSettlementDaysDefault),
    payables, refundRate: measured ?? s.assumedRefundRate, chargebackRate: s.assumedChargebackRate, refundRateBasis: measured === null ? 'estimated' : 'measured',
    rollingReservePct: s.pspRollingReservePct, adSpendPerDay: ad14 === null ? null : ad14 / 14, opexPerDay: s.monthlyOpex / 30.4375,
  });
  const bal = await ledgerBalances();
  const cashLedger = Object.entries(bal).reduce((a, [cur, b]) => a + conv(b.cash ?? 0, cur), 0);
  const pspRecv = Object.entries(bal).reduce((a, [cur, b]) => a + conv(b.psp_receivable ?? 0, cur), 0);
  const supplierOwed = Object.entries(bal).reduce((a, [cur, b]) => a + conv(b.supplier_payable ?? 0, cur), 0);
  return {
    currency: s.reportingCurrency, fx, forecast: f,
    position: { ledgerCash: Object.keys(bal).length ? cashLedger : null, pspReceivable: Object.keys(bal).length ? pspRecv : null, supplierPayable: Object.keys(bal).length ? supplierOwed : null, openingCash: s.openingCash, note: 'Ledger cash only reflects PSP payouts and supplier payments entered in the ledger; it is not a bank balance.' },
    assumptions: { pspSettlementDays: s.pspSettlementDays, pspSettlementDaysDefault: s.pspSettlementDaysDefault, supplierPaymentTermsDays: s.supplierPaymentTermsDays, rollingReservePct: s.pspRollingReservePct, refundRate: measured ?? s.assumedRefundRate, refundRateBasis: measured === null ? 'estimated' : 'measured', chargebackRate: s.assumedChargebackRate },
  };
}

async function measuredRefundRate(ctx: Ctx): Promise<number | null> {
  const since = new Date(ctx.now().getTime() - 90 * DAY);
  const [a] = await Order.aggregate<{ orders: number; total: number; refunded: number }>([{ $match: { isDemo: { $ne: true }, 'payment.paidAt': { $gte: since } } }, { $group: { _id: null, orders: { $sum: 1 }, total: { $sum: '$amounts.total' }, refunded: { $sum: '$costs.refunded' } } }]);
  const s = await getFinanceSettings(ctx);
  return a && a.orders >= s.minOrdersForMeasured && a.total > 0 ? a.refunded / a.total : null;
}

/** Supplier cost actually paid vs the landed cost the selling price was based on (market.landedCost). */
export async function costAlertReport(ctx: Ctx, days = 30) {
  const s = await getFinanceSettings(ctx);
  const since = new Date(ctx.now().getTime() - days * DAY);
  const ships = await Shipment.find({ createdAt: { $gte: since }, status: { $nin: ['FAILED', 'CANCELLED'] }, 'cost.productCost': { $gt: 0 }, productId: { $exists: true } }).sort({ createdAt: -1 }).limit(1000).select('orderId productId quantity cost supplierId createdAt').lean();
  const orders = new Map((await Order.find({ _id: { $in: ships.map((x) => x.orderId) } }).select('orderNumber country').lean()).map((o) => [String(o._id), o]));
  const prods = new Map((await Product.find({ _id: { $in: ships.map((x) => x.productId) } }).select('title markets.country markets.landedCost').lean()).map((p) => [String(p._id), p]));
  const obs: CostObservation[] = [];
  for (const sh of ships) {
    const o = orders.get(String(sh.orderId));
    const p = prods.get(String(sh.productId));
    const m = p?.markets?.find((x) => x.country === o?.country);
    const qty = sh.quantity ?? 1;
    if (!o || !p || !m?.landedCost) continue;
    obs.push({ key: String(sh._id), label: p.title, productId: String(sh.productId), supplierId: String(sh.supplierId), quoted: m.landedCost, actual: Math.round(((sh.cost?.productCost ?? 0) + (sh.cost?.shippingCost ?? 0) + (sh.cost?.duties ?? 0)) / qty), quantity: qty, at: sh.createdAt, orderNumber: o.orderNumber });
  }
  return { thresholdPct: s.costChangeAlertPct, checked: obs.length, alerts: costChangeAlerts(obs, s.costChangeAlertPct), note: 'Compares actual landed cost per unit (product + shipping + duties, order currency) with the landed cost stored on the product market, which is the quote the selling price was set from. Product markets are refreshed periodically, so a very recent re-quote can mask drift.' };
}

/** Country price books: current market pricing per product, read-only. */
export async function priceBooks(country: string | undefined, page: number, pageSize: number) {
  const match = { 'markets.0': { $exists: true }, state: { $nin: ['BANNED', 'REJECTED'] }, ...(country ? { 'markets.country': country } : {}) };
  const [items, total] = await Promise.all([
    Product.find(match).sort({ updatedAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).select('title sku state markets').lean(),
    Product.countDocuments(match),
  ]);
  const rows = items.flatMap((p) => p.markets.filter((m) => !country || m.country === country).map((m) => ({
    productId: String(p._id), title: p.title, sku: p.sku, state: p.state, country: m.country, currency: m.currency ?? null, enabled: m.enabled, price: m.price, compareAtPrice: m.compareAtPrice ?? null, landedCost: m.landedCost ?? null,
    expectedProfit: m.expectedProfit ?? null, expectedMargin: m.expectedMargin ?? null, cpaSource: m.cpaSource, refundSource: m.refundSource,
    basis: m.cpaSource === 'assumed' || m.refundSource !== 'measured' ? 'estimated' : 'measured',
  })));
  return { rows, total, page, pageSize, note: 'Prices and cached margins as stored on each product market. Margins marked estimated rest on assumed acquisition cost or refund rate.' };
}

/* --------------------------- ledger vs source reconciliation --------------------------- */

export interface LedgerFinding { kind: string; orderId?: string; detail: string; severity: 'critical' | 'high' | 'medium' }

/** Compares the ledger with Orders/Payments/Refunds/Shipments/AdMetric. Read-only. Complements (does not replace) runReconciliation. */
export async function ledgerReconciliation(ctx: Ctx, o: { sinceDays?: number; limit?: number } = {}) {
  const since = new Date(ctx.now().getTime() - (o.sinceDays ?? 30) * DAY);
  const grace = new Date(ctx.now().getTime() - 30 * 60_000);
  const limit = o.limit ?? 2000;
  const findings: LedgerFinding[] = [];
  const orders = await Order.find({ createdAt: { $gte: since }, 'payment.status': { $in: PAID }, isDemo: { $ne: true } }).sort({ createdAt: -1 }).limit(limit).select('orderNumber amounts costs.refunded payment.paidAt createdAt').lean();
  const ids = orders.map((x) => x._id);
  const entries = await FinanceLedgerEntry.find({ 'refs.orderId': { $in: ids } }).select('kind lines refs.orderId').lean();
  const by = new Map<string, typeof entries>();
  for (const e of entries) by.set(String(e.refs?.orderId), [...(by.get(String(e.refs?.orderId)) ?? []), e]);
  const sumLine = (es: typeof entries, kind: string, account: LedgerAccount, side: 'debit' | 'credit') => es.filter((e) => e.kind === kind).reduce((a, e) => a + e.lines.filter((l) => l.account === account && l.side === side).reduce((x, l) => x + l.amount, 0), 0);
  let matched = 0;
  for (const ord of orders) {
    const id = String(ord._id);
    const es = by.get(id) ?? [];
    const total = ord.amounts?.total ?? 0;
    const paidEntry = sumLine(es, 'order_paid', 'psp_receivable', 'debit');
    if (!paidEntry) {
      if (new Date(ord.createdAt) < grace) findings.push({ kind: 'paid_order_not_in_ledger', orderId: id, detail: `${ord.orderNumber} is paid (${total}) but has no ledger entry yet (run ledger sync)`, severity: 'medium' });
      continue;
    }
    if (paidEntry !== total) findings.push({ kind: 'ledger_amount_mismatch', orderId: id, detail: `${ord.orderNumber}: ledger receivable ${paidEntry} != order total ${total}`, severity: 'critical' });
    const refunded = sumLine(es, 'refund', 'psp_receivable', 'credit');
    if (Math.abs(refunded - (ord.costs?.refunded ?? 0)) > 1) findings.push({ kind: 'ledger_refund_mismatch', orderId: id, detail: `${ord.orderNumber}: ledger refunds ${refunded} != order refunded ${ord.costs?.refunded ?? 0}`, severity: 'high' });
    else matched++;
  }
  // payments succeeded without ledger order entry is covered above; refunds without ledger:
  const refunds = await Refund.find({ status: 'succeeded', updatedAt: { $gte: since } }).select('orderId amount updatedAt').limit(limit).lean();
  const refKeys = new Set((await FinanceLedgerEntry.find({ idempotencyKey: { $in: refunds.map((r) => `refund:${r._id}`) } }).select('idempotencyKey').lean()).map((e) => e.idempotencyKey));
  for (const r of refunds) if (!refKeys.has(`refund:${r._id}`) && new Date((r as unknown as { updatedAt: Date }).updatedAt) < grace) findings.push({ kind: 'refund_not_in_ledger', orderId: String(r.orderId), detail: `Refund ${r._id} (${r.amount}) succeeded but is not in the ledger`, severity: 'high' });
  // shipments with cost but no ledger entry
  const ships = await Shipment.find({ updatedAt: { $gte: since }, status: { $in: ['CREATED', 'SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED'] }, 'cost.productCost': { $gt: 0 } }).select('orderId').limit(limit).lean();
  const shipKeys = new Set((await FinanceLedgerEntry.find({ idempotencyKey: { $in: ships.map((s) => `supplier_cost:${s._id}`) } }).select('idempotencyKey').lean()).map((e) => e.idempotencyKey));
  for (const s of ships) if (!shipKeys.has(`supplier_cost:${s._id}`)) findings.push({ kind: 'supplier_cost_not_in_ledger', orderId: String(s.orderId), detail: `Supplier order ${s._id} has a recorded cost but no ledger entry (run ledger sync)`, severity: 'medium' });
  // ad spend drift (older than 2 days)
  const cutoff = new Date(ctx.now().getTime() - 2 * DAY);
  const [adSrc] = await AdMetric.aggregate<{ spend: number }>([{ $match: { isDemo: { $ne: true }, date: { $gte: since, $lte: cutoff } } }, { $group: { _id: null, spend: { $sum: '$spend' } } }]);
  const [adLed] = await FinanceLedgerEntry.aggregate<{ spend: number }>([{ $match: { kind: 'ad_spend', currency: 'USD', 'refs.metricId': { $exists: true }, postedAt: { $gte: since, $lte: cutoff } } }, { $unwind: '$lines' }, { $match: { 'lines.account': 'ad_spend' } }, { $group: { _id: null, spend: { $sum: '$lines.amount' } } }]);
  if (Math.abs((adSrc?.spend ?? 0) - (adLed?.spend ?? 0)) > 100) findings.push({ kind: 'ad_spend_drift', detail: `Ad metrics total ${adSrc?.spend ?? 0} vs ledger ${adLed?.spend ?? 0} (USD minor units) for settled days; platforms restate data, so small drift is expected`, severity: 'medium' });
  // negative PSP receivable (more refunds/fees booked than receipts) per currency
  const bal = await ledgerBalances();
  for (const [cur, b] of Object.entries(bal)) {
    if ((b.psp_receivable ?? 0) < 0) findings.push({ kind: 'negative_psp_receivable', detail: `PSP receivable is negative in ${cur} (${b.psp_receivable}): payouts exceed what the ledger says the PSP owes`, severity: 'high' });
    if ((b.supplier_payable ?? 0) < 0) findings.push({ kind: 'negative_supplier_payable', detail: `Supplier payable is negative in ${cur} (${b.supplier_payable}): supplier payments exceed recorded costs`, severity: 'high' });
  }
  const payCount = await Payment.countDocuments({ status: { $in: PAID }, createdAt: { $gte: since } });
  return { checked: { orders: orders.length, refunds: refunds.length, shipments: ships.length, payments: payCount }, matchedOrders: matched, findings, ranAt: ctx.now().toISOString(), note: 'Read-only comparison of the ledger with Orders, Payments, Refunds, Shipments and ad metrics. Provider (PSP/bank) statements are not available to this system, so payouts are not independently verified.' };
}

/* --------------------------------- objective model --------------------------------- */

/** Measured inputs for the objective model, in INR major units. Null fields = not measurable yet. */
export async function measuredForModel(ctx: Ctx): Promise<MeasuredInputs | null> {
  const to = ctx.now();
  const from = new Date(to.getTime() - 90 * DAY);
  const { facts } = await loadFacts(ctx, { from, to }, 'INR');
  if (!facts.length) return null;
  const s = await getFinanceSettings(ctx);
  const known = facts.filter((f) => f.costKnown);
  const krev = known.reduce((a, f) => a + f.total - f.tax, 0);
  const prior = new Set((await Order.distinct('email', { 'payment.paidAt': { $lt: from, $ne: null }, isDemo: { $ne: true } })).map((e) => String(e).toLowerCase()));
  const kp = computeKpis({ facts, priorCustomers: prior, rangeDays: 90, adSpend: await adSpendReporting(ctx, { from, to }, 'INR'), chargebacks: { amount: 0, count: 0, recorded: false }, settings: { csCostPerOrder: s.csCostPerOrder, otherVariablePerOrder: s.otherVariablePerOrder, monthlyOpex: 0, assumedChargebackRate: s.assumedChargebackRate } });
  const inr = (v: number | null) => (v === null ? null : v / 100);
  const costs = known.reduce((a, f) => a + f.supplierCost + f.shippingCost + f.duties, 0);
  const fee = known.reduce((a, f) => a + f.paymentFee, 0);
  const enoughKnown = known.length >= s.minOrdersForMeasured;
  const grossKnown = known.reduce((a, f) => a + f.total, 0);
  return {
    orders: facts.length,
    aov: inr(kp.aov.value),
    refundRate: kp.refundRate.value,
    cac: inr(kp.cac.value),
    landedCostPct: enoughKnown && krev > 0 ? costs / krev : null,
    paymentFeePct: enoughKnown && grossKnown > 0 ? fee / grossKnown : null,
    repeatOrderShare: kp.repeatOrderShare.value,
    chargebackRate: null,
    contributionPerOrder: enoughKnown && kp.contribution.value !== null ? kp.contribution.value / 100 / known.length : null,
  };
}

export async function objectiveModel(ctx: Ctx) {
  const s = await getFinanceSettings(ctx);
  const { sets, saved } = await getScenarioSets();
  const measured = await measuredForModel(ctx);
  const applied = applyMeasured(sets, measured, s.minOrdersForMeasured);
  const results = runAll(applied.sets);
  const inrPerUsd = (await currentFx(ctx)).rates.INR;
  return {
    saved, measured, measuredApplied: applied.applied, provenanceNote: applied.note,
    sets: applied.sets, results, sensitivity: sensitivity(applied.sets.base.assumptions),
    fx: { inrPerUsd, note: 'INR is the reporting currency of this model; measured figures were converted at the current stored FX rate.' },
    minOrdersForMeasured: s.minOrdersForMeasured,
  };
}
