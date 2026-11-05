import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCENARIOS, REFUND_BUFFER_DAYS, accountBalance, applyMeasured, assertFxUsable, assertBalanced, breakEvenAcquisitionCost, buildAdSpend, buildChargeback, buildCohorts, buildOrderPaid, buildPaymentFee,
  buildPspSettlement, buildRefund, buildReserveHold, buildReserveRelease, buildSupplierCost, buildSupplierSettlement, computeContribution, computeKpis, convertWithSnapshot, costChangeAlerts, crossRate, defaultScenarioSets,
  forecastCashFlow, fxStaleness, ikey, imbalance, observedLtv, openPayables, parseExchangerateApi, parseFrankfurter, profitability, reserve, reverseJournal, runAll, scenarioModel, sensitivity,
  staticSnapshot, suspiciousMove, totalsFromBalances, finalizeJournal, LedgerError, buildPnl,
} from '@orvia/core';
import type { OrderFact } from '@orvia/core';
import { DEFAULT_FX, convertMinor, scenarioAssumptionsSchema } from '@orvia/types';
import type { Currency, FxSnapshot } from '@orvia/types';

const T0 = new Date('2026-01-10T00:00:00Z');
const H = 3_600_000;
const policy = { warnHours: 30, hardLimitHours: 96, enforceHardLimit: true, adminOverride: false };
const snap = (hoursAgo: number, source: FxSnapshot['source'] = 'frankfurter'): FxSnapshot => ({ base: 'USD', rates: { USD: 1, CAD: 1.4, INR: 85 }, source, fetchedAt: new Date(T0.getTime() - hoursAgo * H) });

describe('FX policy and conversion', () => {
  it('classifies staleness at the warn and hard limits', () => {
    expect(fxStaleness(new Date(T0.getTime() - 29 * H), T0, policy)).toBe('fresh');
    expect(fxStaleness(new Date(T0.getTime() - 30 * H), T0, policy)).toBe('warn');
    expect(fxStaleness(new Date(T0.getTime() - 96 * H), T0, policy)).toBe('expired');
  });
  it('converts with a snapshot and reports rate, source, asOf and stale', () => {
    const c = convertWithSnapshot(10_000, 'USD', 'INR', snap(2), T0, policy);
    expect(c).toMatchObject({ amount: 850_000, rate: 85, source: 'frankfurter', stale: false, staleness: 'fresh', from: 'USD', to: 'INR' });
    expect(c.asOf).toBe(new Date(T0.getTime() - 2 * H).toISOString());
    expect(convertWithSnapshot(8500, 'INR', 'USD', snap(40), T0, policy)).toMatchObject({ amount: 100, stale: true, staleness: 'warn' });
  });
  it('cross rates are consistent and identity for same currency', () => {
    const r = snap(0).rates;
    expect(crossRate(r, 'INR', 'INR')).toBe(1);
    expect(crossRate(r, 'CAD', 'INR') * crossRate(r, 'INR', 'CAD')).toBeCloseTo(1, 10);
  });
  it('refuses expired rates for pricing in production unless an admin override is active', () => {
    expect(() => assertFxUsable(snap(100), T0, policy)).toThrow(/FX_RATES_EXPIRED|old/);
    expect(assertFxUsable(snap(100), T0, { ...policy, adminOverride: true })).toEqual({ staleness: 'expired', overridden: true });
    expect(assertFxUsable(snap(40), T0, policy).staleness).toBe('warn'); // warn never blocks
    expect(assertFxUsable(snap(1000), T0, { ...policy, enforceHardLimit: false }).staleness).toBe('expired'); // dev does not block
  });
  it('refuses the static dev table in production', () => {
    expect(() => assertFxUsable(staticSnapshot(T0), T0, policy)).toThrow(/static/);
    expect(assertFxUsable(staticSnapshot(T0), T0, { ...policy, enforceHardLimit: false }).staleness).toBe('fresh');
  });
  it('parses provider payloads and rejects incomplete ones', () => {
    const f = parseFrankfurter({ base: 'USD', date: '2026-01-09', rates: { CAD: 1.37, INR: 85.2 } }, T0);
    expect(f.rates).toEqual({ USD: 1, CAD: 1.37, INR: 85.2 });
    expect(f.providerDate).toBe('2026-01-09');
    expect(() => parseFrankfurter({ base: 'USD', rates: { CAD: 1.37 } }, T0)).toThrow();
    expect(parseExchangerateApi({ result: 'success', base_code: 'USD', conversion_rates: { CAD: 1.4, INR: 85 } }, T0).source).toBe('exchangerate_api');
    expect(() => parseExchangerateApi({ result: 'error' }, T0)).toThrow();
  });
  it('flags implausible rate jumps', () => {
    expect(suspiciousMove(snap(1), snap(0))).toBeNull();
    expect(suspiciousMove(snap(1), { ...snap(0), rates: { USD: 1, CAD: 1.4, INR: 120 } })).toBe('INR');
    expect(suspiciousMove(null, snap(0))).toBeNull();
  });
  it('the legacy convertMinor still works with the static table', () => {
    expect(convertMinor(100, 'USD', 'INR', DEFAULT_FX)).toBe(8400);
  });
});

const currencies: Currency[] = ['USD', 'CAD', 'INR'];
describe('ledger builders: debits = credits', () => {
  const at = T0;
  it('every builder balances across currencies and awkward amounts', () => {
    for (const currency of currencies) {
      for (const total of [1, 99, 1999, 33_333, 1_234_567]) {
        const tax = Math.round(total * 0.18 / 1.18);
        const discount = Math.floor(total * 0.1);
        const drafts = [
          buildOrderPaid({ orderId: 'o1', currency, postedAt: at, total, tax, discount, shipping: Math.floor(total / 7) }),
          buildPaymentFee({ orderId: 'o1', currency, postedAt: at, fee: Math.round(total * 0.029) + 30 }),
          buildRefund({ orderId: 'o1', refundId: 'r1', currency, postedAt: at, amount: Math.ceil(total / 3), orderTotal: total, orderTax: tax }),
          buildChargeback({ chargebackId: 'c1', currency, postedAt: at, amount: total, fee: 1500 }),
          buildSupplierCost({ orderId: 'o1', shipmentId: 's1', currency, postedAt: at, productCost: Math.round(total * 0.4), shippingCost: 123, duties: 77 }),
          buildSupplierSettlement({ settlementId: 'x', supplierId: 'sp', currency, postedAt: at, amount: total }),
          buildPspSettlement({ settlementId: 'p', currency, postedAt: at, amount: total }),
          buildAdSpend({ metricId: 'm', currency, postedAt: at, amount: total }),
          buildReserveHold({ id: 'h', currency, postedAt: at, amount: total }),
          buildReserveRelease({ id: 'h', currency, postedAt: at, amount: total }),
        ];
        for (const d of drafts) {
          expect(imbalance(d.lines), `${d.kind} ${currency} ${total}`).toBe(0);
          expect(() => assertBalanced(d)).not.toThrow();
          for (const l of d.lines) expect(Number.isInteger(l.amount) && l.amount > 0).toBe(true);
          const rev = reverseJournal(d, at);
          expect(imbalance(rev.lines)).toBe(0);
        }
      }
    }
  });
  it('order paid splits revenue, shipping, discount and tax correctly', () => {
    const d = buildOrderPaid({ orderId: 'o', currency: 'USD', postedAt: at, total: 11_800, tax: 1_800, discount: 500, shipping: 1_000 });
    const get = (a: string, s: string) => d.lines.find((l) => l.account === a && l.side === s)?.amount ?? 0;
    expect(get('psp_receivable', 'debit')).toBe(11_800);
    expect(get('discounts', 'debit')).toBe(500);
    expect(get('revenue_shipping', 'credit')).toBe(1_000);
    expect(get('revenue_product', 'credit')).toBe(11_800 - 1_800 + 500 - 1_000);
    expect(get('tax_payable', 'credit')).toBe(1_800);
  });
  it('refund gives back the proportional tax', () => {
    const d = buildRefund({ orderId: 'o', refundId: 'r', currency: 'USD', postedAt: at, amount: 5_900, orderTotal: 11_800, orderTax: 1_800 });
    expect(d.lines.find((l) => l.account === 'tax_payable')?.amount).toBe(900);
    expect(d.lines.find((l) => l.account === 'refunds')?.amount).toBe(5_000);
  });
  it('rejects non-integer, negative and empty journals', () => {
    expect(() => buildPaymentFee({ orderId: 'o', currency: 'USD', postedAt: at, fee: 10.5 })).toThrow(LedgerError);
    expect(() => buildPaymentFee({ orderId: 'o', currency: 'USD', postedAt: at, fee: -1 })).toThrow(LedgerError);
    expect(() => buildPaymentFee({ orderId: 'o', currency: 'USD', postedAt: at, fee: 0 })).toThrow(/nothing to post/);
    expect(() => finalizeJournal({ kind: 'adjustment', idempotencyKey: 'k', currency: 'USD', postedAt: at, memo: '', refs: {}, lines: [{ account: 'cash', side: 'debit', amount: 5 }, { account: 'refunds', side: 'credit', amount: 4 }] })).toThrow(/unbalanced/);
  });
  it('idempotency keys are stable and deterministic', () => {
    const a = buildOrderPaid({ orderId: 'abc', currency: 'INR', postedAt: at, total: 100, tax: 0, discount: 0, shipping: 0 });
    const b = buildOrderPaid({ orderId: 'abc', currency: 'INR', postedAt: new Date(), total: 100, tax: 0, discount: 0, shipping: 0 });
    expect(a.idempotencyKey).toBe(b.idempotencyKey);
    expect(a.idempotencyKey).toBe('order_paid:abc');
    expect(ikey.refund('r9')).toBe('refund:r9');
    expect(ikey.supplierCost('s1')).not.toBe(ikey.supplierCostReversal('s1'));
    expect(reverseJournal(a, at).idempotencyKey).toBe('rev:order_paid:abc');
  });
  it('account balances and derived totals follow normal balances', () => {
    const lines = [buildOrderPaid({ orderId: 'o', currency: 'USD', postedAt: at, total: 11_800, tax: 1_800, discount: 500, shipping: 1_000 }), buildRefund({ orderId: 'o', refundId: 'r', currency: 'USD', postedAt: at, amount: 1_180, orderTotal: 11_800, orderTax: 1_800 }), buildSupplierCost({ orderId: 'o', shipmentId: 's', currency: 'USD', postedAt: at, productCost: 4_000, shippingCost: 500, duties: 0 })].flatMap((d) => d.lines);
    expect(accountBalance('psp_receivable', lines)).toBe(11_800 - 1_180);
    expect(accountBalance('supplier_payable', lines)).toBe(4_500);
    const bal = Object.fromEntries((['revenue_product', 'revenue_shipping', 'discounts', 'refunds', 'cogs_product', 'shipping_cost', 'tax_payable'] as const).map((a) => [a, accountBalance(a, lines)]));
    const t = totalsFromBalances(bal);
    expect(t.grossSales).toBe(10_500);
    expect(t.netSales).toBe(10_500 - 500 - 1_000);
    expect(t.contributionBeforeAds).toBe(t.netSales - 4_000 - 500);
  });
  it('supplier payables are settled FIFO', () => {
    const open = openPayables([{ supplierId: 'a', amount: 100, postedAt: T0 }, { supplierId: 'a', amount: 100, postedAt: new Date(T0.getTime() + 86_400_000) }, { supplierId: 'b', amount: 50, postedAt: T0 }], [{ supplierId: 'a', amount: 150 }], 7);
    expect(open.map((p) => [p.supplierId, p.amount])).toEqual([['b', 50], ['a', 50]]);
    expect(open[1]!.dueAt.getTime()).toBe(T0.getTime() + 8 * 86_400_000);
  });
});

describe('contribution math', () => {
  const c = (amount: number, basis: 'measured' | 'quoted' | 'set' | 'estimated' = 'measured') => ({ amount, basis });
  const input = { sellingPrice: c(10_000, 'set'), supplierCost: c(4_000, 'quoted'), shipping: c(500, 'quoted'), paymentFee: c(320, 'quoted'), taxesDuties: c(0), acquisitionCost: c(2_000, 'estimated'), refundReserve: c(500, 'estimated'), chargebackReserve: c(50, 'estimated'), customerService: c(100, 'estimated'), otherVariable: c(30, 'estimated') };
  it('subtracts every component', () => {
    const r = computeContribution(input);
    expect(r.contribution).toBe(10_000 - 4_000 - 500 - 320 - 2_000 - 500 - 50 - 100 - 30);
    expect(r.marginPct).toBeCloseTo(r.contribution / 10_000, 10);
  });
  it('labels actual vs estimated and reports the estimated share', () => {
    const r = computeContribution(input);
    expect(r.provenance).toBe('mixed');
    expect(r.estimatedCost).toBe(2_680);
    expect(r.estimatedShare).toBeCloseTo(2_680 / 7_500, 10);
    expect(r.lines.find((l) => l.key === 'supplierCost')?.kind).toBe('actual');
    expect(r.lines.find((l) => l.key === 'acquisitionCost')?.kind).toBe('estimated');
    expect(computeContribution({ ...input, acquisitionCost: c(2_000), refundReserve: c(500), chargebackReserve: c(50), customerService: c(100), otherVariable: c(30) }).provenance).toBe('actual');
  });
  it('can be negative and has a null margin at zero price', () => {
    expect(computeContribution({ ...input, supplierCost: c(20_000) }).contribution).toBeLessThan(0);
    expect(computeContribution({ ...input, sellingPrice: c(0) }).marginPct).toBeNull();
  });
  it('reserves are estimates unless the rate is measured; break-even CAC excludes the current CAC', () => {
    expect(reserve(10_000, 0.05, false).basis).toBe('estimated');
    expect(reserve(10_000, 0.05, true)).toMatchObject({ amount: 500, basis: 'measured' });
    expect(breakEvenAcquisitionCost(input)).toBe(computeContribution({ ...input, acquisitionCost: c(0) }).contribution);
    expect(breakEvenAcquisitionCost(input, 0.1)).toBe(computeContribution({ ...input, acquisitionCost: c(0) }).contribution - 1000);
  });
});

let n = 0;
const fact = (o: Partial<OrderFact> & { email: string; paidAt: Date }): OrderFact => ({ id: `o${++n}`, country: 'IN', total: 11_800, tax: 1_800, discount: 0, shipping: 0, refunded: 0, costKnown: true, supplierCost: 4_000, shippingCost: 500, duties: 0, paymentFee: 300, delivered: true, fulfilled: true, attributed: false, lines: [{ productId: 'p1', value: 10_000 }], ...o });
const settings = { csCostPerOrder: 0, otherVariablePerOrder: 0, monthlyOpex: 0, assumedChargebackRate: 0.005 };

describe('KPIs, P&L and profitability', () => {
  const facts = Array.from({ length: 10 }, (_, i) => fact({ email: `u${i % 8}@x.com`, paidAt: new Date(T0.getTime() + i * 1000), attributed: i < 4, refunded: i === 0 ? 5_900 : 0 }));
  const k = computeKpis({ facts, priorCustomers: new Set(['u0@x.com']), rangeDays: 30, adSpend: 10_000, chargebacks: { amount: 0, count: 0, recorded: false }, settings: { ...settings, monthlyOpex: 100_000 } });
  it('separates GMV, net sales, contribution and profit', () => {
    expect(k.gmv.value).toBe(118_000);
    expect(k.taxCollected.value).toBe(18_000);
    expect(k.refundsExTax.value).toBe(5_000);
    expect(k.netSales.value).toBe(100_000 - 5_000);
    expect(k.grossProfit.value).toBe(95_000 - 40_000);
    expect(k.contribution.value).toBe(k.contributionBreakdown!.contribution);
    expect(k.netProfitEstimate.value).toBe(k.contribution.value! - Math.round(100_000 * 30 / 30.4375));
    expect(k.netProfitEstimate.provenance).toBe('estimated');
    expect(k.netProfitEstimate.note).toMatch(/ESTIMATE/);
  });
  it('computes CAC, AOV, repeat, refund and delivery from real facts', () => {
    expect(k.newCustomers).toBe(7);
    expect(k.cac.value).toBe(Math.round(10_000 / 7));
    expect(k.aov.value).toBe(11_800);
    expect(k.refundRate.value).toBeCloseTo(5_000 / 100_000, 10);
    expect(k.deliverySuccess.value).toBe(1);
    expect(k.repeatPurchaseRate.value).toBeGreaterThan(0);
  });
  it('is honest when data is missing: unavailable, never invented', () => {
    const empty = computeKpis({ facts: [], priorCustomers: new Set(), rangeDays: 30, adSpend: null, chargebacks: { amount: 0, count: 0, recorded: false }, settings });
    for (const v of [empty.gmv, empty.netSales, empty.contribution, empty.cac, empty.aov, empty.netProfitEstimate, empty.customerLifetimeValue]) expect(v).toMatchObject({ value: null, provenance: 'unavailable' });
    const noCost = computeKpis({ facts: [fact({ email: 'a@x.com', paidAt: T0, costKnown: false })], priorCustomers: new Set(), rangeDays: 30, adSpend: null, chargebacks: { amount: 0, count: 0, recorded: false }, settings });
    expect(noCost.contribution.value).toBeNull();
    expect(noCost.cac.provenance).toBe('unavailable');
    expect(noCost.caveats.join(' ')).toMatch(/No paid order has a recorded supplier cost/);
  });
  it('estimates chargeback cost only when none are recorded', () => {
    const lines = k.contributionBreakdown!.lines;
    expect(lines.find((l) => l.key === 'chargebackReserve')?.kind).toBe('estimated');
    const rec = computeKpis({ facts, priorCustomers: new Set(), rangeDays: 30, adSpend: 10_000, chargebacks: { amount: 1_000, count: 1, recorded: true }, settings });
    expect(rec.contributionBreakdown!.lines.find((l) => l.key === 'chargebackReserve')?.amount).toBe(1_000);
  });
  it('builds a P&L that ends at the net profit estimate', () => {
    const pnl = buildPnl(k, { opex: 1, opexNote: 'x' });
    expect(pnl.at(-1)!.key).toBe('netProfit');
    expect(pnl.find((l) => l.key === 'opex')!.provenance).toBe('estimated');
  });
  it('allocates order costs to products and suppliers by line value', () => {
    const f = [fact({ email: 'a@x.com', paidAt: T0, lines: [{ productId: 'p1', supplierId: 's1', value: 7_500 }, { productId: 'p2', supplierId: 's2', value: 2_500 }] })];
    const rows = profitability(f, 'product');
    expect(rows.map((r) => r.key).sort()).toEqual(['p1', 'p2']);
    expect(rows.reduce((a, r) => a + r.netRevenue, 0)).toBe(10_000);
    expect(rows.reduce((a, r) => a + r.cost, 0)).toBe(4_800);
    expect(profitability(f, 'supplier')).toHaveLength(2);
    expect(profitability([fact({ email: 'a@x.com', paidAt: T0, costKnown: false })], 'order')).toEqual([]);
  });
});

describe('cohorts and LTV', () => {
  const m = (y: number, mo: number, d = 5) => new Date(Date.UTC(y, mo - 1, d));
  const facts = [
    fact({ email: 'a@x.com', paidAt: m(2026, 1) }), fact({ email: 'a@x.com', paidAt: m(2026, 2) }), fact({ email: 'a@x.com', paidAt: m(2026, 3) }),
    fact({ email: 'b@x.com', paidAt: m(2026, 1) }), fact({ email: 'c@x.com', paidAt: m(2026, 2) }), fact({ email: 'c@x.com', paidAt: m(2026, 2, 20) }),
  ];
  const rows = buildCohorts(facts, { now: m(2026, 3, 31), adSpendByMonth: new Map([['2026-01', 4_000]]) });
  it('groups customers by first-order month with retention and per-customer value', () => {
    expect(rows.map((r) => [r.cohort, r.customers])).toEqual([['2026-01', 2], ['2026-02', 1]]);
    const jan = rows[0]!;
    expect(jan.retention).toEqual([2, 1, 1]);
    const per = 10_000 - 4_800; // ex-tax net minus costs per order
    expect(jan.cumulativeContributionPerCustomer).toEqual([Math.round(2 * per / 2), Math.round(3 * per / 2), Math.round(4 * per / 2) - 0]);
    expect(jan.cac).toBe(2_000);
    expect(jan.contributionAfterCac).toBe(jan.cumulativeContributionPerCustomer.at(-1)! - 2_000);
    expect(rows[1]!.cac).toBeNull();
    expect(rows[1]!.contributionAfterCac).toBeNull();
  });
  it('only reports observed offsets (no future months)', () => {
    expect(rows[1]!.retention).toHaveLength(2);
  });
  it('observed LTV needs history and enough customers', () => {
    expect(observedLtv(rows, 2, 1)).toMatchObject({ customers: 2, cohorts: 1 });
    expect(observedLtv(rows, 2, 20).value).toBeNull();
    expect(observedLtv(rows, 6, 1).value).toBeNull();
  });
});

describe('cost-change alerts', () => {
  it('flags only cost increases over the threshold, largest extra cost first', () => {
    const obs = [
      { key: '1', label: 'A', quoted: 1000, actual: 1040, quantity: 1, at: T0 },
      { key: '2', label: 'B', quoted: 1000, actual: 1100, quantity: 2, at: T0 },
      { key: '3', label: 'C', quoted: 1000, actual: 1400, quantity: 1, at: T0 },
      { key: '4', label: 'D', quoted: 1000, actual: 800, quantity: 5, at: T0 },
      { key: '5', label: 'E', quoted: 0, actual: 800, quantity: 5, at: T0 },
    ];
    const a = costChangeAlerts(obs, 0.05);
    expect(a.map((x) => x.key)).toEqual(['3', '2']);
    expect(a[0]!.severity).toBe('critical');
    expect(a[1]!.severity).toBe('warn');
    expect(a[1]!.extraCost).toBe(200);
  });
});

describe('cash-flow forecast', () => {
  const base = { now: T0, horizonDays: 28, openingCash: 100_000, receivables: [], settlementDays: (p?: string) => (p === 'fast' ? 2 : 7), payables: [], refundRate: 0.1, chargebackRate: 0.01, refundRateBasis: 'estimated' as const, rollingReservePct: 0, adSpendPerDay: 1_000, opexPerDay: 500 };
  it('settles receivables after the provider delay and reserves for refunds', () => {
    const f = forecastCashFlow({ ...base, receivables: [{ amount: 50_000, paidAt: new Date(T0.getTime() - 3 * 86_400_000), provider: 'slow' }, { amount: 20_000, paidAt: new Date(T0.getTime() - 1 * 86_400_000), provider: 'fast' }, { amount: 9_999, paidAt: new Date(T0.getTime() + 30 * 86_400_000) }] });
    expect(f.weeks).toHaveLength(4);
    expect(f.weeks[0]!.inflows).toBe(70_000); // slow: day +4, fast: day +1, both week 0
    expect(f.weeks[0]!.refundAndChargebackReserve).toBe(Math.round(50_000 * 0.11) + Math.round(20_000 * 0.11));
    expect(f.totals.inflows).toBe(70_000); // post-horizon settlement excluded
  });
  it('holds the rolling reserve, pays suppliers when due, and tracks the running balance', () => {
    const f = forecastCashFlow({ ...base, rollingReservePct: 0.1, receivables: [{ amount: 10_000, paidAt: new Date(T0.getTime() - 86_400_000), provider: 'fast' }], payables: [{ amount: 30_000, dueAt: new Date(T0.getTime() + 8 * 86_400_000) }] });
    expect(f.weeks[0]!.inflows).toBe(9_000);
    expect(f.weeks[0]!.reserveHeld).toBe(1_000);
    expect(f.weeks[1]!.supplierPayments).toBe(30_000);
    expect(f.weeks.at(-1)!.closing).toBe(100_000 + f.totals.net);
    expect(f.lowestClosing).toBeLessThan(100_000);
  });
  it('shows no running balance when opening cash is not entered', () => {
    const f = forecastCashFlow({ ...base, openingCash: null });
    expect(f.weeks.every((w) => w.closing === null)).toBe(true);
    expect(f.lowestClosing).toBeNull();
    expect(f.basis.join(' ')).toMatch(/Opening cash is not set/);
  });
  it('does not invent future sales', () => {
    expect(forecastCashFlow({ ...base, adSpendPerDay: null, opexPerDay: 0 }).totals.inflows).toBe(0);
  });
});

describe('objective model (₹38 crore)', () => {
  const sets = defaultScenarioSets();
  const res = runAll(sets);
  it('treats the target as an input', () => {
    const a = scenarioAssumptionsSchema.parse(DEFAULT_SCENARIOS.base);
    expect(a.targetAmountInr).toBe(380_000_000);
    const half = scenarioModel({ ...a, targetAmountInr: 190_000_000 });
    const full = scenarioModel(a);
    expect(full.ordersRequired).toBeCloseTo(half.ordersRequired * 2, 6);
    expect(full.netSales).toBeCloseTo(a.targetAmountInr, 3);
  });
  it('is internally consistent', () => {
    const r = res.base;
    expect(r.ordersPerDay * 12 * 30.4375).toBeCloseTo(r.ordersRequired, 3);
    expect(r.contribution).toBeCloseTo(r.ordersRequired * r.unit.contributionPerOrder, 3);
    expect(r.netProfit).toBeCloseTo(r.contribution - r.opexTotal, 3);
    expect(r.gmv).toBeGreaterThan(r.netSales);
    expect(r.workingCapital.total).toBeCloseTo(r.workingCapital.supplierFunding + r.workingCapital.adFunding + r.workingCapital.reserveHeld + r.workingCapital.refundBuffer, 6);
    expect(REFUND_BUFFER_DAYS).toBeGreaterThan(0);
  });
  it('orders scenarios conservative <= base <= aggressive', () => {
    expect(res.conservative.unit.contributionPerOrder).toBeLessThan(res.base.unit.contributionPerOrder);
    expect(res.base.unit.contributionPerOrder).toBeLessThan(res.aggressive.unit.contributionPerOrder);
    expect(res.conservative.netProfit).toBeLessThan(res.base.netProfit);
    expect(res.base.netProfit).toBeLessThan(res.aggressive.netProfit);
  });
  it('is monotone: worse CAC / refund rate lowers profit, better conversion raises it', () => {
    const s = sensitivity(DEFAULT_SCENARIOS.base);
    const dec = (xs: { netProfit: number }[]) => xs.every((p, i) => i === 0 || p.netProfit <= xs[i - 1]!.netProfit + 1e-6);
    expect(dec(s.cac)).toBe(true);
    expect(dec(s.refundRate)).toBe(true);
    const conv = s.conversion.map((p) => p.netProfit);
    expect(conv.every((v, i) => i === 0 || v >= conv[i - 1]! - 1e-6)).toBe(true);
    expect(s.cac.find((p) => p.label === 'CAC ×1')!.netProfit).toBeCloseTo(res.base.netProfit, 3);
  });
  it('NEVER defaults to optimistic numbers', () => {
    // conservative placeholder loses money per order and is declared not reachable
    expect(res.conservative.unit.contributionPerOrder).toBeLessThan(0);
    expect(res.conservative.verdict).toBe('not_reachable');
    expect(res.conservative.reachable).toBe(false);
    // even the aggressive default keeps a sane margin (no >35% contribution margin placeholder)
    for (const r of Object.values(res)) expect(r.unit.contributionMargin ?? 0).toBeLessThan(0.35);
    // base is not given a free pass either: thin margin
    expect(res.base.unit.contributionMargin!).toBeLessThan(0.15);
    // every default is flagged as a placeholder to replace
    for (const set of Object.values(sets)) expect(Object.values(set.provenance).every((p) => p === 'placeholder')).toBe(true);
    // a base case with realistic net-sales target needs a lot of orders: hundreds per day
    expect(res.base.ordersPerDay).toBeGreaterThan(300);
  });
  it('reports loss-making, capacity and funding limits instead of "reachable"', () => {
    const b = scenarioAssumptionsSchema.parse(DEFAULT_SCENARIOS.aggressive);
    expect(scenarioModel({ ...b, opexPerMonth: 1e9 }).verdict).toBe('loss_making');
    expect(scenarioModel({ ...b, maxOrdersPerDay: 10 }).verdict).toBe('exceeds_capacity');
    const rich = scenarioModel({ ...b, opexPerMonth: 0 });
    expect(scenarioModel({ ...b, opexPerMonth: 0, availableWorkingCapital: rich.workingCapital.total / 2 }).verdict).toBe('needs_funding');
    expect(scenarioModel({ ...b, opexPerMonth: 0, availableWorkingCapital: rich.workingCapital.total * 2 }).verdict).toBe('consistent');
    expect(rich.messages.join(' ')).toMatch(/not a forecast|assumptions/);
  });
  it('longer settlement delays and earlier ad spend need more working capital', () => {
    const b = scenarioAssumptionsSchema.parse(DEFAULT_SCENARIOS.aggressive);
    expect(scenarioModel({ ...b, pspSettlementDays: 14 }).workingCapital.total).toBeGreaterThan(scenarioModel(b).workingCapital.total);
    expect(scenarioModel({ ...b, adSpendLeadDays: 14 }).workingCapital.total).toBeGreaterThan(scenarioModel(b).workingCapital.total);
  });
  it('only pulls measured data once enough orders exist, and labels provenance', () => {
    const m = { orders: 12, aov: 1000, refundRate: 0.2, cac: 900, landedCostPct: 0.7, paymentFeePct: 0.03, repeatOrderShare: 0.02, chargebackRate: null, contributionPerOrder: -50 };
    const few = applyMeasured(sets, m, 30);
    expect(few.applied).toBe(false);
    expect(few.sets.base.assumptions.aov).toBe(DEFAULT_SCENARIOS.base.aov);
    expect(few.note).toMatch(/placeholder/);
    expect(applyMeasured(sets, null, 30).applied).toBe(false);
    const many = applyMeasured(sets, { ...m, orders: 60 }, 30);
    expect(many.applied).toBe(true);
    expect(many.sets.base.assumptions).toMatchObject({ aov: 1000, refundRate: 0.2, cac: 900, landedCostPct: 0.7 });
    expect(many.sets.base.provenance.cac).toBe('measured');
    expect(many.sets.base.provenance.chargebackRate).toBe('placeholder'); // not measurable -> stays placeholder
    // ordering preserved: conservative never better than measured, aggressive never worse
    expect(many.sets.conservative.assumptions.cac).toBeGreaterThanOrEqual(900);
    expect(many.sets.aggressive.assumptions.cac).toBeLessThanOrEqual(900);
    expect(many.sets.conservative.assumptions.aov).toBeLessThanOrEqual(1000);
    const r = runAll(many.sets);
    expect(r.conservative.netProfit).toBeLessThanOrEqual(r.base.netProfit);
    expect(r.base.netProfit).toBeLessThanOrEqual(r.aggressive.netProfit);
  });
  it('never overwrites an admin-entered value with measured data', () => {
    const custom = defaultScenarioSets();
    custom.base.assumptions.cac = 111;
    custom.base.provenance.cac = 'admin';
    const out = applyMeasured(custom, { orders: 100, aov: 1000, refundRate: 0.1, cac: 900, landedCostPct: null, paymentFeePct: null, repeatOrderShare: null, chargebackRate: null, contributionPerOrder: null }, 30);
    expect(out.sets.base.assumptions.cac).toBe(111);
    expect(out.sets.base.provenance.cac).toBe('admin');
    expect(out.sets.base.assumptions.aov).toBe(1000);
  });
  it('validates assumptions', () => {
    expect(() => scenarioModel({ ...DEFAULT_SCENARIOS.base, aov: -5 })).toThrow();
    expect(() => scenarioModel({ ...DEFAULT_SCENARIOS.base, conversionRate: 0 })).toThrow();
  });
});
