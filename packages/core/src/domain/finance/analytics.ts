/**
 * Pure profit analytics over plain order facts. No IO, no invented numbers: anything that cannot be computed from the
 * facts passed in is `null` with `provenance: 'unavailable'`. All money is minor units of ONE reporting currency.
 *
 *  GMV            what customers were charged (incl. tax and shipping, after discounts), paid orders only
 *  Net sales      GMV − tax − refunds (ex-tax) − chargebacks      (revenue we keep, before any cost)
 *  Contribution   net sales − supplier cost − shipping − duties − payment fees − acquisition − chargeback reserve − CS − other variable
 *  Net profit     contribution − operating expenses; an ESTIMATE because opex is an admin assumption
 */
import type { FinanceProvenance } from '@orvia/types';
import { computeContribution } from './contribution';
import type { ContributionResult } from './contribution';

const DAY = 86_400_000;
const MONTH_DAYS = 30.4375;

export interface OrderLine { productId: string; title?: string; supplierId?: string; supplierName?: string; /** ex-tax value of the line after discount */ value: number }

export interface OrderFact {
  id: string;
  orderNumber?: string;
  email: string;
  country: string;
  paidAt: Date;
  total: number;
  tax: number;
  discount: number;
  shipping: number;
  /** Refunded to the customer, including the tax part. */
  refunded: number;
  /** Supplier cost is only known once the supplier order is placed. Cost-based figures use cost-known orders only. */
  costKnown: boolean;
  supplierCost: number;
  shippingCost: number;
  duties: number;
  paymentFee: number;
  delivered: boolean;
  fulfilled: boolean;
  attributed: boolean;
  lines: OrderLine[];
}

export interface Kpi { value: number | null; provenance: FinanceProvenance; note?: string }
const kpi = (value: number | null, provenance: FinanceProvenance, note?: string): Kpi => ({ value, provenance: value === null ? 'unavailable' : provenance, note });
const div = (a: number, b: number): number | null => (b > 0 ? a / b : null);

export const exTax = (o: Pick<OrderFact, 'total' | 'tax'>) => o.total - o.tax;
/** Refunded amount without its proportional tax. */
export const refundExTax = (o: Pick<OrderFact, 'total' | 'tax' | 'refunded'>) => (o.total > 0 ? Math.round(o.refunded * (1 - o.tax / o.total)) : o.refunded);

export interface KpiInputs {
  facts: OrderFact[];
  /** Emails that already had a paid order before the range started. */
  priorCustomers: Set<string>;
  rangeDays: number;
  /** Platform-reported ad spend in the range (reporting currency), or null when there are no ad metrics. */
  adSpend: number | null;
  /** MeasuredCpa fallback (store level): total spend and attributed orders; used only when the range has no spend. */
  measuredCpa?: { spend: number; orders: number } | null;
  chargebacks: { amount: number; count: number; recorded: boolean };
  settings: { csCostPerOrder: number; otherVariablePerOrder: number; monthlyOpex: number; assumedChargebackRate: number };
  /** Minimum cost-known orders before cost-based percentages are shown. */
  minSample?: number;
}

export interface KpiReport {
  orders: number;
  costKnownOrders: number;
  costCoverage: number | null;
  customers: number;
  newCustomers: number;
  gmv: Kpi;
  discounts: Kpi;
  taxCollected: Kpi;
  refundsExTax: Kpi;
  chargebacks: Kpi;
  refundAdjustedRevenue: Kpi;
  netSales: Kpi;
  grossProfit: Kpi;
  contribution: Kpi;
  contributionMargin: Kpi;
  netProfitEstimate: Kpi;
  cac: Kpi;
  aov: Kpi;
  netAov: Kpi;
  repeatPurchaseRate: Kpi;
  repeatOrderShare: Kpi;
  refundRate: Kpi;
  chargebackRate: Kpi;
  deliverySuccess: Kpi;
  customerLifetimeValue: Kpi;
  advertisingContribution: Kpi;
  roas: Kpi;
  contributionBreakdown: ContributionResult | null;
  /** Plain-language limits of this report. */
  caveats: string[];
}

export function computeKpis(i: KpiInputs): KpiReport {
  const f = i.facts;
  const minSample = i.minSample ?? 5;
  const caveats: string[] = [];
  const orders = f.length;
  const known = f.filter((o) => o.costKnown);
  const sum = (xs: OrderFact[], g: (o: OrderFact) => number) => xs.reduce((a, o) => a + g(o), 0);

  const gmv = sum(f, (o) => o.total);
  const discounts = sum(f, (o) => o.discount);
  const tax = sum(f, (o) => o.tax);
  const revenueExTax = sum(f, exTax);
  const refunds = sum(f, refundExTax);
  const refundAdjusted = revenueExTax - refunds;
  const chargebackAmt = i.chargebacks.amount;
  const netSales = refundAdjusted - chargebackAmt;

  const emails = new Set(f.map((o) => o.email.toLowerCase()));
  const newCustomers = [...emails].filter((e) => !i.priorCustomers.has(e)).length;

  // cost-known subset
  const kRev = sum(known, exTax);
  const kRefunds = sum(known, refundExTax);
  const kSupplier = sum(known, (o) => o.supplierCost);
  const kShip = sum(known, (o) => o.shippingCost);
  const kDuties = sum(known, (o) => o.duties);
  const kFee = sum(known, (o) => o.paymentFee);
  const share = orders ? known.length / orders : 0;
  const enough = known.length >= minSample;
  if (orders && !known.length) caveats.push('No paid order has a recorded supplier cost yet, so cost-based figures (gross profit, contribution, net profit) are unavailable.');
  else if (orders && share < 1) caveats.push(`Cost-based figures cover ${known.length} of ${orders} paid orders (those with a placed supplier order); the rest have no known cost yet.`);
  if (known.length && !enough) caveats.push(`Only ${known.length} cost-known orders: below the ${minSample}-order minimum, percentages are not shown.`);

  const adSpend = i.adSpend !== null && i.adSpend > 0 ? i.adSpend : null;
  if (adSpend === null) caveats.push('No ad spend is recorded in this range: contribution excludes acquisition cost.');
  const acquisition = adSpend !== null ? Math.round(adSpend * share) : 0;

  const chargebackShare = orders ? known.length / orders : 0;
  const cbMeasured = i.chargebacks.recorded;
  const cbReserve = cbMeasured ? Math.round(chargebackAmt * chargebackShare) : Math.round(kRev * i.settings.assumedChargebackRate);
  if (!cbMeasured && known.length) caveats.push('No chargebacks have been recorded in the ledger, so chargeback cost is an estimate from the configured assumption.');

  const breakdown = known.length
    ? computeContribution({
        sellingPrice: { amount: kRev, basis: 'measured' },
        supplierCost: { amount: kSupplier, basis: 'measured' },
        shipping: { amount: kShip, basis: 'measured' },
        paymentFee: { amount: kFee, basis: 'measured' },
        taxesDuties: { amount: kDuties, basis: 'measured', note: 'import duties paid by Orvia; sales tax collected is not a cost' },
        acquisitionCost: { amount: acquisition, basis: adSpend === null ? 'estimated' : 'measured', note: adSpend === null ? 'no ad spend recorded' : 'platform-reported spend, pro-rated to cost-known orders' },
        refundReserve: { amount: kRefunds, basis: 'measured', note: 'actual refunds issued so far; recent orders may still be refunded' },
        chargebackReserve: { amount: cbReserve, basis: cbMeasured ? 'measured' : 'estimated' },
        customerService: { amount: known.length * i.settings.csCostPerOrder, basis: 'estimated', note: 'admin assumption per order' },
        otherVariable: { amount: known.length * i.settings.otherVariablePerOrder, basis: 'estimated', note: 'admin assumption per order' },
      })
    : null;

  const grossProfit = known.length ? kRev - kRefunds - kSupplier : null;
  const contribution = breakdown?.contribution ?? null;
  const months = i.rangeDays / MONTH_DAYS;
  const opex = Math.round(i.settings.monthlyOpex * months);
  const profitProv: FinanceProvenance = breakdown ? 'estimated' : 'unavailable';

  // customers
  const byEmail = new Map<string, number>();
  for (const o of f) byEmail.set(o.email.toLowerCase(), (byEmail.get(o.email.toLowerCase()) ?? 0) + 1);
  const repeatBuyers = [...byEmail].filter(([e, n]) => n >= 2 || i.priorCustomers.has(e)).length;
  const returningOrders = f.filter((o) => i.priorCustomers.has(o.email.toLowerCase())).length;

  const fulfilledOrders = f.filter((o) => o.fulfilled);
  const delivered = fulfilledOrders.filter((o) => o.delivered).length;

  // CAC
  let cac: Kpi;
  if (adSpend !== null && newCustomers > 0) cac = kpi(Math.round(adSpend / newCustomers), 'actual', 'platform-reported ad spend ÷ first-time customers in range (blended; organic buyers are included in the divisor)');
  else if (i.measuredCpa && i.measuredCpa.orders > 0) cac = kpi(Math.round(i.measuredCpa.spend / i.measuredCpa.orders), 'actual', 'measured CPA store (store level): spend ÷ attributed orders');
  else cac = kpi(null, 'unavailable', 'no ad spend recorded');

  // customer lifetime value (realised): contribution per customer so far
  const clv = breakdown && emails.size >= minSample ? kpi(Math.round(breakdown.contribution / Math.max(1, new Set(known.map((o) => o.email.toLowerCase())).size)), 'mixed', 'realised contribution per customer within this range, not a forecast') : kpi(null, 'unavailable', `needs at least ${minSample} customers with known costs`);

  // advertising contribution: attributed orders' contribution before ads, minus ad spend
  const att = known.filter((o) => o.attributed);
  const attBefore = att.length ? sum(att, (o) => exTax(o) - refundExTax(o) - o.supplierCost - o.shippingCost - o.duties - o.paymentFee) : null;
  const adContribution = adSpend !== null && attBefore !== null ? attBefore - adSpend : null;
  const attRevenue = sum(f.filter((o) => o.attributed), (o) => o.total);

  return {
    orders,
    costKnownOrders: known.length,
    costCoverage: div(known.length, orders),
    customers: emails.size,
    newCustomers,
    gmv: kpi(orders ? gmv : null, 'actual', 'sum of order totals charged to customers (incl. tax and shipping, after discounts), paid orders'),
    discounts: kpi(orders ? discounts : null, 'actual'),
    taxCollected: kpi(orders ? tax : null, 'actual', 'owed to the tax authority; not revenue'),
    refundsExTax: kpi(orders ? refunds : null, 'actual'),
    chargebacks: kpi(orders ? chargebackAmt : null, cbMeasured ? 'actual' : 'unavailable', cbMeasured ? undefined : 'none recorded in the ledger'),
    refundAdjustedRevenue: kpi(orders ? refundAdjusted : null, 'actual', 'ex-tax revenue after refunds'),
    netSales: kpi(orders ? netSales : null, cbMeasured ? 'actual' : 'mixed', 'ex-tax revenue after refunds and recorded chargebacks'),
    grossProfit: kpi(grossProfit, 'actual', 'net revenue of cost-known orders minus supplier product cost'),
    contribution: kpi(contribution, breakdown?.provenance ?? 'unavailable', 'see breakdown for actual vs estimated components'),
    contributionMargin: kpi(breakdown && enough && kRev > 0 ? breakdown.contribution / kRev : null, breakdown?.provenance ?? 'unavailable', 'contribution ÷ ex-tax revenue of cost-known orders'),
    netProfitEstimate: kpi(contribution === null ? null : contribution - opex, profitProv, i.settings.monthlyOpex > 0 ? `ESTIMATE: includes operating expenses of ${(i.settings.monthlyOpex / 100).toFixed(0)}/month set by an admin (an assumption, not measured)` : 'ESTIMATE: no operating expenses configured, so this equals contribution'),
    cac,
    aov: kpi(div(gmv, orders), 'actual', 'GMV ÷ paid orders (incl. tax)'),
    netAov: kpi(div(refundAdjusted, orders), 'actual', 'refund-adjusted ex-tax revenue ÷ paid orders'),
    repeatPurchaseRate: kpi(emails.size >= minSample ? repeatBuyers / emails.size : null, 'actual', 'buyers in range who have bought before or more than once ÷ buyers in range'),
    repeatOrderShare: kpi(div(returningOrders, orders), 'actual', 'orders from customers who had bought before the range'),
    refundRate: kpi(revenueExTax > 0 ? refunds / revenueExTax : null, 'actual', 'refunded ÷ ex-tax revenue; recent orders may not yet have refunds'),
    chargebackRate: kpi(orders && cbMeasured ? i.chargebacks.count / orders : null, 'actual', cbMeasured ? 'chargebacks ÷ paid orders' : 'none recorded'),
    deliverySuccess: kpi(fulfilledOrders.length >= minSample ? delivered / fulfilledOrders.length : null, 'actual', 'delivered ÷ fulfilled orders (in-transit orders count as not yet delivered)'),
    customerLifetimeValue: clv,
    advertisingContribution: kpi(adContribution, 'mixed', 'contribution of ad-attributed orders before ads minus platform ad spend; attribution is platform-reported and imperfect'),
    roas: kpi(adSpend !== null && attRevenue > 0 ? attRevenue / adSpend : null, 'mixed', 'attributed GMV ÷ ad spend'),
    contributionBreakdown: breakdown,
    caveats,
  };
}

/** Net profit figure for a P&L view: line items with provenance. */
export interface PnlLine { key: string; label: string; amount: number | null; provenance: FinanceProvenance; note?: string }
export function buildPnl(k: KpiReport, opts: { opex: number; opexNote: string }): PnlLine[] {
  const b = k.contributionBreakdown;
  const get = (key: string) => b?.lines.find((l) => l.key === key);
  const neg = (key: string, label: string): PnlLine => {
    const l = get(key);
    return { key, label, amount: l ? -l.amount : null, provenance: l ? (l.kind === 'estimated' ? 'estimated' : 'actual') : 'unavailable', note: l?.note };
  };
  return [
    { key: 'gmv', label: 'GMV (charged to customers, incl. tax)', amount: k.gmv.value, provenance: k.gmv.provenance },
    { key: 'tax', label: 'less sales tax collected', amount: k.taxCollected.value === null ? null : -k.taxCollected.value, provenance: k.taxCollected.provenance },
    { key: 'refunds', label: 'less refunds (ex-tax)', amount: k.refundsExTax.value === null ? null : -k.refundsExTax.value, provenance: k.refundsExTax.provenance },
    { key: 'chargebacks', label: 'less chargebacks', amount: k.chargebacks.value === null ? null : -k.chargebacks.value, provenance: k.chargebacks.provenance },
    { key: 'netSales', label: 'Net sales', amount: k.netSales.value, provenance: k.netSales.provenance },
    neg('supplierCost', 'Supplier product cost'),
    { key: 'grossProfit', label: 'Gross profit (cost-known orders)', amount: k.grossProfit.value, provenance: k.grossProfit.provenance, note: k.grossProfit.note },
    neg('shipping', 'Shipping'),
    neg('taxesDuties', 'Import duties'),
    neg('paymentFee', 'Payment fees'),
    neg('acquisitionCost', 'Advertising / acquisition'),
    neg('customerService', 'Customer service (assumption)'),
    neg('otherVariable', 'Other variable (assumption)'),
    { key: 'contribution', label: 'Contribution', amount: k.contribution.value, provenance: k.contribution.provenance, note: k.contribution.note },
    { key: 'opex', label: 'Operating expenses (assumption)', amount: -opts.opex, provenance: 'estimated', note: opts.opexNote },
    { key: 'netProfit', label: 'Net profit (estimate)', amount: k.netProfitEstimate.value, provenance: k.netProfitEstimate.provenance, note: k.netProfitEstimate.note },
  ];
}

/* ------------------------------------------------------------------ */
/* Profitability by product / supplier / order / country              */
/* ------------------------------------------------------------------ */

export interface ProfitRow {
  key: string;
  label: string;
  orders: number;
  /** ex-tax revenue after refunds, allocated by line value */
  netRevenue: number;
  cost: number;
  contributionBeforeAds: number;
  margin: number | null;
}

/** Order-level costs are allocated to lines in proportion to line value. Only cost-known orders are included. */
export function profitability(facts: OrderFact[], by: 'product' | 'supplier' | 'country' | 'order'): ProfitRow[] {
  const acc = new Map<string, ProfitRow & { _orders: Set<string> }>();
  const add = (key: string, label: string, id: string, rev: number, cost: number) => {
    const r = acc.get(key) ?? { key, label, orders: 0, netRevenue: 0, cost: 0, contributionBeforeAds: 0, margin: null, _orders: new Set<string>() };
    r.netRevenue += rev;
    r.cost += cost;
    r._orders.add(id);
    acc.set(key, r);
  };
  for (const o of facts) {
    if (!o.costKnown) continue;
    const net = exTax(o) - refundExTax(o);
    const cost = o.supplierCost + o.shippingCost + o.duties + o.paymentFee;
    if (by === 'order') { add(o.id, o.orderNumber ?? o.id, o.id, net, cost); continue; }
    if (by === 'country') { add(o.country, o.country, o.id, net, cost); continue; }
    const totalLine = o.lines.reduce((a, l) => a + l.value, 0);
    const lines = o.lines.length ? o.lines : [{ productId: 'unknown', title: 'Unknown', value: 1 }];
    const tl = totalLine > 0 ? totalLine : lines.length;
    for (const l of lines) {
      const w = (totalLine > 0 ? l.value : 1) / tl;
      if (by === 'product') add(l.productId, l.title ?? l.productId, o.id, Math.round(net * w), Math.round(cost * w));
      else add(l.supplierId ?? 'unknown', l.supplierName ?? l.supplierId ?? 'Unknown supplier', o.id, Math.round(net * w), Math.round(cost * w));
    }
  }
  return [...acc.values()].map(({ _orders, ...r }) => ({ ...r, orders: _orders.size, contributionBeforeAds: r.netRevenue - r.cost, margin: r.netRevenue > 0 ? (r.netRevenue - r.cost) / r.netRevenue : null })).sort((a, b) => b.contributionBeforeAds - a.contributionBeforeAds);
}

/* ------------------------------------------------------------------ */
/* Cohorts (monthly) and lifetime value                                */
/* ------------------------------------------------------------------ */

export interface CohortRow {
  cohort: string; // YYYY-MM of first paid order
  customers: number;
  /** active customers (>=1 order) in month offset 0..n */
  retention: number[];
  /** cumulative net revenue per customer by month offset */
  cumulativeNetRevenuePerCustomer: number[];
  /** cumulative contribution before ads per customer by offset (cost-known orders only) */
  cumulativeContributionPerCustomer: number[];
  /** cohort's acquisition spend divided by customers, when ad spend for that month is known */
  cac: number | null;
  /** latest cumulative contribution per customer minus CAC; null if CAC unknown */
  contributionAfterCac: number | null;
  /** share of the cohort's orders with known cost; below 1 means contribution is understated */
  costCoverage: number;
}

export const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
const monthIndex = (d: Date) => d.getUTCFullYear() * 12 + d.getUTCMonth();

export function buildCohorts(facts: OrderFact[], opts: { now: Date; adSpendByMonth?: Map<string, number>; minCohortSize?: number; maxOffset?: number }): CohortRow[] {
  const maxOffset = opts.maxOffset ?? 11;
  const first = new Map<string, Date>();
  for (const o of facts) {
    const e = o.email.toLowerCase();
    const cur = first.get(e);
    if (!cur || o.paidAt < cur) first.set(e, o.paidAt);
  }
  const cohorts = new Map<string, { customers: Set<string>; active: Set<string>[]; rev: number[]; con: number[]; orders: number; known: number }>();
  const nowIdx = monthIndex(opts.now);
  for (const [e, d] of first) {
    const k = monthKey(d);
    const c = cohorts.get(k) ?? { customers: new Set(), active: Array.from({ length: maxOffset + 1 }, () => new Set<string>()), rev: Array<number>(maxOffset + 1).fill(0), con: Array<number>(maxOffset + 1).fill(0), orders: 0, known: 0 };
    c.customers.add(e);
    cohorts.set(k, c);
  }
  for (const o of facts) {
    const e = o.email.toLowerCase();
    const c = cohorts.get(monthKey(first.get(e) as Date));
    if (!c) continue;
    const off = monthIndex(o.paidAt) - monthIndex(first.get(e) as Date);
    if (off < 0 || off > maxOffset) continue;
    c.active[off]!.add(e);
    c.rev[off]! += exTax(o) - refundExTax(o);
    c.orders += 1;
    if (o.costKnown) {
      c.known += 1;
      c.con[off]! += exTax(o) - refundExTax(o) - o.supplierCost - o.shippingCost - o.duties - o.paymentFee;
    }
  }
  const rows: CohortRow[] = [];
  for (const [k, c] of [...cohorts].sort(([a], [b]) => a.localeCompare(b))) {
    const [y, m] = k.split('-').map(Number) as [number, number];
    const observed = Math.min(maxOffset, nowIdx - (y * 12 + (m - 1)));
    const n = c.customers.size;
    let cr = 0;
    let cc = 0;
    const cumRev: number[] = [];
    const cumCon: number[] = [];
    for (let i = 0; i <= observed; i++) {
      cr += c.rev[i]!;
      cc += c.con[i]!;
      cumRev.push(Math.round(cr / n));
      cumCon.push(Math.round(cc / n));
    }
    const spend = opts.adSpendByMonth?.get(k);
    const cac = spend !== undefined && spend > 0 && n > 0 ? Math.round(spend / n) : null;
    rows.push({
      cohort: k,
      customers: n,
      retention: c.active.slice(0, observed + 1).map((s) => s.size),
      cumulativeNetRevenuePerCustomer: cumRev,
      cumulativeContributionPerCustomer: cumCon,
      cac,
      contributionAfterCac: cac === null || !cumCon.length ? null : cumCon[cumCon.length - 1]! - cac,
      costCoverage: c.orders ? c.known / c.orders : 0,
    });
  }
  return rows.filter((r) => r.customers >= (opts.minCohortSize ?? 1));
}

/** Observed (not forecast) lifetime value across cohorts old enough to have `months` of history. null without enough data. */
export function observedLtv(cohorts: CohortRow[], months: number, minCustomers = 20): { value: number | null; customers: number; cohorts: number } {
  const usable = cohorts.filter((c) => c.cumulativeContributionPerCustomer.length > months);
  const customers = usable.reduce((a, c) => a + c.customers, 0);
  if (customers < minCustomers) return { value: null, customers, cohorts: usable.length };
  const total = usable.reduce((a, c) => a + c.cumulativeContributionPerCustomer[months]! * c.customers, 0);
  return { value: Math.round(total / customers), customers, cohorts: usable.length };
}

/* ------------------------------------------------------------------ */
/* Supplier cost-change alerts                                         */
/* ------------------------------------------------------------------ */

export interface CostObservation { key: string; label: string; productId?: string; supplierId?: string; /** cost quoted/used when the price was set (per unit) */ quoted: number; /** cost actually incurred at order time (per unit) */ actual: number; quantity: number; at: Date; orderNumber?: string }
export interface CostAlert extends CostObservation { changePct: number; extraCost: number; severity: 'warn' | 'critical' }

/** Alert when the real supplier cost exceeds what the selling price was based on by more than `thresholdPct`. */
export function costChangeAlerts(obs: CostObservation[], thresholdPct: number): CostAlert[] {
  const out: CostAlert[] = [];
  for (const o of obs) {
    if (o.quoted <= 0 || o.actual <= 0) continue;
    const change = (o.actual - o.quoted) / o.quoted;
    if (change > thresholdPct) out.push({ ...o, changePct: change, extraCost: (o.actual - o.quoted) * o.quantity, severity: change > thresholdPct * 3 ? 'critical' : 'warn' });
  }
  return out.sort((a, b) => b.extraCost - a.extraCost);
}

/* ------------------------------------------------------------------ */
/* Cash-flow forecast                                                  */
/* ------------------------------------------------------------------ */

export interface Receivable { amount: number; paidAt: Date; provider?: string }
export interface Payable { amount: number; dueAt: Date; supplierId?: string }

export interface CashFlowInputs {
  now: Date;
  horizonDays: number;
  /** null when the admin has not entered opening cash */
  openingCash: number | null;
  /** Paid orders not yet settled by the PSP, in reporting currency. */
  receivables: Receivable[];
  settlementDays: (provider?: string) => number;
  payables: Payable[];
  /** Expected refunds / chargebacks as a share of inflows. */
  refundRate: number;
  chargebackRate: number;
  refundRateBasis: 'measured' | 'estimated';
  rollingReservePct: number;
  /** Planned ad spend per day (reporting currency), usually the trailing average. */
  adSpendPerDay: number | null;
  /** Fixed costs per day. */
  opexPerDay: number;
  /** Orders per day and net cash per new order are NOT assumed: only already-paid orders produce inflows. */
}

export interface CashFlowWeek {
  weekStart: string;
  inflows: number;
  supplierPayments: number;
  refundAndChargebackReserve: number;
  reserveHeld: number;
  adSpend: number;
  opex: number;
  net: number;
  closing: number | null;
}
export interface CashFlowForecast {
  weeks: CashFlowWeek[];
  totals: { inflows: number; outflows: number; net: number };
  openingCash: number | null;
  lowestClosing: number | null;
  basis: string[];
}

export function forecastCashFlow(i: CashFlowInputs): CashFlowForecast {
  const weeks = Math.max(1, Math.ceil(i.horizonDays / 7));
  const start = i.now.getTime();
  const bucket = (t: number) => Math.min(weeks - 1, Math.max(0, Math.floor((t - start) / (7 * DAY))));
  const w: CashFlowWeek[] = Array.from({ length: weeks }, (_, k) => ({ weekStart: new Date(start + k * 7 * DAY).toISOString().slice(0, 10), inflows: 0, supplierPayments: 0, refundAndChargebackReserve: 0, reserveHeld: 0, adSpend: 0, opex: 0, net: 0, closing: null }));
  const end = start + i.horizonDays * DAY;
  for (const r of i.receivables) {
    const at = r.paidAt.getTime() + i.settlementDays(r.provider) * DAY;
    if (at > end) continue; // settles after the horizon
    const t = Math.max(at, start);
    const b = w[bucket(t)]!;
    const held = Math.round(r.amount * i.rollingReservePct);
    b.inflows += r.amount - held;
    b.reserveHeld += held;
    b.refundAndChargebackReserve += Math.round(r.amount * (i.refundRate + i.chargebackRate));
  }
  for (const p of i.payables) {
    const t = Math.max(p.dueAt.getTime(), start);
    if (t > end) continue;
    w[bucket(t)]!.supplierPayments += p.amount;
  }
  for (let k = 0; k < weeks; k++) {
    const days = Math.min(7, i.horizonDays - k * 7);
    w[k]!.adSpend = Math.round((i.adSpendPerDay ?? 0) * days);
    w[k]!.opex = Math.round(i.opexPerDay * days);
  }
  let running = i.openingCash;
  let lowest: number | null = null;
  for (const b of w) {
    b.net = b.inflows - b.supplierPayments - b.refundAndChargebackReserve - b.adSpend - b.opex;
    if (running !== null) {
      running += b.net;
      b.closing = running;
      lowest = lowest === null ? running : Math.min(lowest, running);
    }
  }
  const inflows = w.reduce((a, b) => a + b.inflows, 0);
  const outflows = w.reduce((a, b) => a + b.supplierPayments + b.refundAndChargebackReserve + b.adSpend + b.opex, 0);
  return {
    weeks: w,
    totals: { inflows, outflows, net: inflows - outflows },
    openingCash: i.openingCash,
    lowestClosing: lowest,
    basis: [
      'Inflows are ONLY already-paid orders that the PSP has not yet settled (paid date + the configured settlement delay for the provider). Future sales are not forecast.',
      i.refundRateBasis === 'measured' ? 'Refund/chargeback outflow uses the measured refund rate plus the chargeback assumption.' : 'Refund/chargeback outflow uses ESTIMATED rates from settings (no measured refund rate yet).',
      'Supplier payments are recorded payables at their due date. Ad spend is the trailing daily average held flat. Operating expenses are the monthly assumption set in settings.',
      i.openingCash === null ? 'Opening cash is not set, so no running balance is shown, only the net movement.' : 'Opening cash is the figure entered in settings (not read from a bank).',
    ],
  };
}

/** FIFO: apply payments to the oldest unpaid supplier costs of the same supplier. Returns what is still owed with due dates. */
export function openPayables(costs: { supplierId: string; amount: number; postedAt: Date }[], payments: { supplierId: string; amount: number }[], termsDays: number): Payable[] {
  const paid = new Map<string, number>();
  for (const p of payments) paid.set(p.supplierId, (paid.get(p.supplierId) ?? 0) + p.amount);
  const out: Payable[] = [];
  for (const c of [...costs].sort((a, b) => a.postedAt.getTime() - b.postedAt.getTime())) {
    let remaining = c.amount;
    const credit = paid.get(c.supplierId) ?? 0;
    if (credit > 0) {
      const use = Math.min(credit, remaining);
      paid.set(c.supplierId, credit - use);
      remaining -= use;
    }
    if (remaining > 0) out.push({ amount: remaining, dueAt: new Date(c.postedAt.getTime() + termsDays * DAY), supplierId: c.supplierId });
  }
  return out;
}
