/**
 * The revenue-objective model (default objective ₹38 crore). Pure: no IO, no FX, no database.
 *
 * It answers one question: "if these assumptions held, what would reaching the target require, and would it make money?".
 * It does NOT predict that they hold. The objective is an input; the model can and does return "not reachable"
 * or "reachable but loss-making". Defaults are placeholders flagged "replace with measured data", chosen to be
 * cautious: the conservative set loses money per order on purpose. All money is INR major units (rupees).
 */
import { scenarioAssumptionsSchema, SCENARIO_NAMES } from '@orvia/types';
import type { AssumptionProvenance, ScenarioAssumptions, ScenarioInputSet, ScenarioName } from '@orvia/types';

const MONTH_DAYS = 30.4375;
/** Days of refund + chargeback outflow held as a cash buffer (a modelling constant, not a measurement). */
export const REFUND_BUFFER_DAYS = 30;
export const CRORE = 10_000_000;
export const toCrore = (inr: number): number => inr / CRORE;

export interface UnitEconomics {
  aov: number;
  tax: number;
  netPrice: number;
  refundedRevenue: number;
  chargebackLoss: number;
  netSalesPerOrder: number;
  landedCost: number;
  /** landed cost after the share recovered on refunded orders */
  landedCostEffective: number;
  paymentFee: number;
  acquisitionPerOrder: number;
  customerService: number;
  otherVariable: number;
  contributionBeforeAds: number;
  contributionPerOrder: number;
  contributionMargin: number | null;
  /** Highest CAC (per new customer) at which contribution per order is still >= 0. null when it is negative even with free traffic. */
  breakEvenCac: number | null;
}

export interface WorkingCapital {
  supplierFunding: number;
  adFunding: number;
  reserveHeld: number;
  refundBuffer: number;
  total: number;
}

export type Verdict = 'consistent' | 'needs_funding' | 'exceeds_capacity' | 'loss_making' | 'not_reachable';

export interface ScenarioResult {
  assumptions: ScenarioAssumptions;
  unit: UnitEconomics;
  ordersRequired: number;
  ordersPerDay: number;
  sessionsPerDay: number;
  newCustomers: number;
  gmv: number;
  grossSalesBeforeDiscounts: number;
  netSales: number;
  contribution: number;
  adSpendTotal: number;
  adSpendPerMonth: number;
  opexTotal: number;
  netProfit: number;
  netMargin: number | null;
  breakEvenOrdersPerMonth: number | null;
  workingCapital: WorkingCapital;
  verdict: Verdict;
  reachable: boolean;
  messages: string[];
}

export function unitEconomics(a: ScenarioAssumptions): UnitEconomics {
  const netPrice = a.aov / (1 + a.taxRate);
  const tax = a.aov - netPrice;
  const refundedRevenue = netPrice * a.refundRate;
  const chargebackLoss = netPrice * a.chargebackRate;
  const landedCost = netPrice * a.landedCostPct;
  const landedCostEffective = landedCost * (1 - a.refundRate * a.refundCostRecoveryPct);
  const paymentFee = a.aov * a.paymentFeePct + a.paymentFeeFixed;
  const acquisitionPerOrder = a.cac * (1 - a.repeatOrderShare);
  const netSalesPerOrder = netPrice - refundedRevenue - chargebackLoss;
  const contributionBeforeAds = netSalesPerOrder - landedCostEffective - paymentFee - a.csCostPerOrder - a.otherVariablePerOrder;
  const contributionPerOrder = contributionBeforeAds - acquisitionPerOrder;
  const newShare = 1 - a.repeatOrderShare;
  return {
    aov: a.aov, tax, netPrice, refundedRevenue, chargebackLoss, netSalesPerOrder, landedCost, landedCostEffective, paymentFee, acquisitionPerOrder,
    customerService: a.csCostPerOrder, otherVariable: a.otherVariablePerOrder, contributionBeforeAds, contributionPerOrder,
    contributionMargin: netSalesPerOrder > 0 ? contributionPerOrder / netSalesPerOrder : null,
    breakEvenCac: contributionBeforeAds >= 0 && newShare > 0 ? contributionBeforeAds / newShare : null,
  };
}

export function scenarioModel(input: ScenarioAssumptions): ScenarioResult {
  const a = scenarioAssumptionsSchema.parse(input);
  const u = unitEconomics(a);
  const days = a.horizonMonths * MONTH_DAYS;
  const messages: string[] = [];

  const perOrderBasis = a.targetBasis === 'gmv' ? u.aov : u.netSalesPerOrder;
  const ordersRequired = perOrderBasis > 0 ? a.targetAmountInr / perOrderBasis : Infinity;
  const ordersPerDay = ordersRequired / days;
  const gmv = ordersRequired * u.aov;
  const netSales = ordersRequired * u.netSalesPerOrder;
  const contribution = ordersRequired * u.contributionPerOrder;
  const adSpendTotal = ordersRequired * u.acquisitionPerOrder;
  const opexTotal = a.opexPerMonth * a.horizonMonths;
  const netProfit = contribution - opexTotal;

  // Steady-state working capital at the required run-rate.
  const landedPerDay = ordersPerDay * u.landedCostEffective;
  const supplierFunding = landedPerDay * Math.max(0, a.pspSettlementDays - a.supplierPaymentLeadDays);
  const adPerDay = ordersPerDay * u.acquisitionPerOrder;
  const adFunding = adPerDay * (a.adSpendLeadDays + a.pspSettlementDays);
  const reserveHeld = ordersPerDay * u.aov * a.rollingReservePct * a.rollingReserveHoldDays;
  const refundBuffer = ordersPerDay * (u.refundedRevenue + u.chargebackLoss) * (1 + a.taxRate) * REFUND_BUFFER_DAYS;
  const workingCapital: WorkingCapital = { supplierFunding, adFunding, reserveHeld, refundBuffer, total: supplierFunding + adFunding + reserveHeld + refundBuffer };

  let verdict: Verdict = 'consistent';
  if (!Number.isFinite(ordersRequired) || u.contributionPerOrder <= 0) {
    verdict = 'not_reachable';
    messages.push(
      !Number.isFinite(ordersRequired)
        ? 'Net sales per order are zero or negative under these assumptions, so no order volume reaches the target.'
        : `Contribution per order is ${fmtInr(u.contributionPerOrder)} (<= 0): every extra order loses money, so scaling toward the target would burn cash, not earn it. Fix unit economics (CAC, refunds, landed cost) before scaling.`,
    );
  } else if (a.maxOrdersPerDay !== null && ordersPerDay > a.maxOrdersPerDay) {
    verdict = 'exceeds_capacity';
    messages.push(`Reaching the target needs ${ordersPerDay.toFixed(0)} orders/day, above the stated capacity of ${a.maxOrdersPerDay}.`);
  } else if (a.maxMonthlyAdSpend !== null && adSpendTotal / a.horizonMonths > a.maxMonthlyAdSpend) {
    verdict = 'exceeds_capacity';
    messages.push(`Required average ad spend is ${fmtInr(adSpendTotal / a.horizonMonths)}/month, above the stated ceiling of ${fmtInr(a.maxMonthlyAdSpend)}.`);
  } else if (netProfit < 0) {
    verdict = 'loss_making';
    messages.push(`The revenue target is arithmetically attainable but loses ${fmtInr(-netProfit)} over ${a.horizonMonths} months after operating expenses.`);
  } else if (a.availableWorkingCapital !== null && workingCapital.total > a.availableWorkingCapital) {
    verdict = 'needs_funding';
    messages.push(`Working capital needed (${fmtInr(workingCapital.total)}) exceeds what is available (${fmtInr(a.availableWorkingCapital)}); shortfall ${fmtInr(workingCapital.total - a.availableWorkingCapital)}.`);
  } else {
    messages.push('Under these assumptions the target is arithmetically reachable and profitable. That is a statement about the assumptions, not a forecast: none of them is verified until it is replaced with measured data.');
    if (a.availableWorkingCapital === null) messages.push('No working-capital limit was entered, so funding feasibility was not tested.');
  }
  if (u.breakEvenCac !== null && a.cac > u.breakEvenCac) messages.push(`CAC ${fmtInr(a.cac)} is above break-even CAC ${fmtInr(u.breakEvenCac)}.`);

  const breakEvenOrdersPerMonth = u.contributionPerOrder > 0 ? a.opexPerMonth / u.contributionPerOrder : null;
  return {
    assumptions: a,
    unit: u,
    ordersRequired,
    ordersPerDay,
    sessionsPerDay: ordersPerDay / a.conversionRate,
    newCustomers: ordersRequired * (1 - a.repeatOrderShare),
    gmv,
    grossSalesBeforeDiscounts: a.discountRate < 1 ? gmv / (1 - a.discountRate) : gmv,
    netSales,
    contribution,
    adSpendTotal,
    adSpendPerMonth: adSpendTotal / a.horizonMonths,
    opexTotal,
    netProfit,
    netMargin: netSales > 0 ? netProfit / netSales : null,
    breakEvenOrdersPerMonth,
    workingCapital,
    verdict,
    reachable: verdict === 'consistent',
    messages,
  };
}

const fmtInr = (n: number): string => `₹${Math.round(n).toLocaleString('en-IN')}`;

/* ------------------------------ sensitivity ------------------------------ */

export interface SensitivityPoint { label: string; contributionPerOrder: number; ordersPerDay: number; netProfit: number; verdict: Verdict }
export interface Sensitivity { cac: SensitivityPoint[]; conversion: SensitivityPoint[]; refundRate: SensitivityPoint[] }

const point = (label: string, a: ScenarioAssumptions): SensitivityPoint => {
  const r = scenarioModel(a);
  return { label, contributionPerOrder: r.unit.contributionPerOrder, ordersPerDay: r.ordersPerDay, netProfit: r.netProfit, verdict: r.verdict };
};

/**
 * One-at-a-time sensitivities around `a`. A lower conversion rate raises CAC proportionally (the same traffic buys fewer orders),
 * so conversion changes are expressed through CAC = CAC₀ × conversion₀ ÷ conversion.
 */
export function sensitivity(a: ScenarioAssumptions): Sensitivity {
  const cacMult = [0.7, 0.85, 1, 1.25, 1.5];
  const convMult = [0.6, 0.8, 1, 1.2, 1.5];
  const refundDelta = [-0.03, 0, 0.03, 0.06, 0.1];
  return {
    cac: cacMult.map((m) => point(`CAC ×${m}`, { ...a, cac: a.cac * m })),
    conversion: convMult.map((m) => point(`conversion ×${m}`, { ...a, conversionRate: Math.min(0.2, a.conversionRate * m), cac: (a.cac * a.conversionRate) / Math.min(0.2, a.conversionRate * m) })),
    refundRate: refundDelta.map((d) => point(`refund rate ${d >= 0 ? '+' : ''}${(d * 100).toFixed(0)}pp`, { ...a, refundRate: Math.min(0.8, Math.max(0, a.refundRate + d)) })),
  };
}

/* --------------------------- defaults (placeholders) --------------------------- */

const base: ScenarioAssumptions = {
  targetAmountInr: 380_000_000, targetBasis: 'net_sales', horizonMonths: 12,
  aov: 1400, taxRate: 0.18, discountRate: 0.1,
  landedCostPct: 0.52, paymentFeePct: 0.024, paymentFeeFixed: 3,
  refundRate: 0.09, refundCostRecoveryPct: 0.2, chargebackRate: 0.005,
  cac: 380, repeatOrderShare: 0.12, conversionRate: 0.015,
  csCostPerOrder: 25, otherVariablePerOrder: 10, opexPerMonth: 1_200_000,
  pspSettlementDays: 4, supplierPaymentLeadDays: 0, adSpendLeadDays: 3, rollingReservePct: 0.05, rollingReserveHoldDays: 60,
  availableWorkingCapital: null, maxOrdersPerDay: null, maxMonthlyAdSpend: null,
};

/**
 * Documented placeholders. NONE of these is measured. The conservative set is deliberately loss-making per order.
 * `base` is not a forecast. Replace with measured data (the admin UI pulls measured values in once enough orders exist).
 */
export const DEFAULT_SCENARIOS: Record<ScenarioName, ScenarioAssumptions> = {
  conservative: { ...base, aov: 1100, landedCostPct: 0.6, paymentFeePct: 0.029, refundRate: 0.13, refundCostRecoveryPct: 0.1, chargebackRate: 0.008, cac: 600, repeatOrderShare: 0.06, conversionRate: 0.01, csCostPerOrder: 35, otherVariablePerOrder: 15, opexPerMonth: 1_500_000, pspSettlementDays: 7, rollingReservePct: 0.1, rollingReserveHoldDays: 90 },
  base,
  aggressive: { ...base, aov: 1600, landedCostPct: 0.48, paymentFeePct: 0.02, refundRate: 0.06, refundCostRecoveryPct: 0.3, chargebackRate: 0.003, cac: 300, repeatOrderShare: 0.2, conversionRate: 0.02, csCostPerOrder: 20, otherVariablePerOrder: 8, opexPerMonth: 1_000_000, pspSettlementDays: 3, rollingReservePct: 0.02, rollingReserveHoldDays: 30 },
};

export function defaultScenarioSets(): Record<ScenarioName, ScenarioInputSet> {
  const mk = (n: ScenarioName): ScenarioInputSet => ({
    assumptions: { ...DEFAULT_SCENARIOS[n] },
    provenance: Object.fromEntries(Object.keys(DEFAULT_SCENARIOS[n]).map((k) => [k, 'placeholder'])) as ScenarioInputSet['provenance'],
  });
  return { conservative: mk('conservative'), base: mk('base'), aggressive: mk('aggressive') };
}

/* ------------------------------ measured overlay ------------------------------ */

export interface MeasuredInputs {
  /** Cost-known / paid orders behind these figures. */
  orders: number;
  /** All in INR major units / fractions; null = not measurable yet. */
  aov: number | null;
  refundRate: number | null;
  cac: number | null;
  landedCostPct: number | null;
  paymentFeePct: number | null;
  repeatOrderShare: number | null;
  chargebackRate: number | null;
  /** Measured contribution per order (INR), shown as a cross-check against the model; not an input. */
  contributionPerOrder: number | null;
}

type Direction = 'lower_is_better' | 'higher_is_better';
const MEASURED_FIELDS: { field: keyof MeasuredInputs & keyof ScenarioAssumptions; dir: Direction }[] = [
  { field: 'aov', dir: 'higher_is_better' },
  { field: 'refundRate', dir: 'lower_is_better' },
  { field: 'cac', dir: 'lower_is_better' },
  { field: 'landedCostPct', dir: 'lower_is_better' },
  { field: 'paymentFeePct', dir: 'lower_is_better' },
  { field: 'repeatOrderShare', dir: 'higher_is_better' },
  { field: 'chargebackRate', dir: 'lower_is_better' },
];

/**
 * Replace placeholders with measured values when at least `minOrders` real orders exist.
 *  - base takes the measured value.
 *  - conservative is never better than measured; aggressive is never worse than measured (so ordering is preserved).
 * Fields the admin edited by hand (`provenance: 'admin'`) are never overwritten. Returns the provenance of every field.
 */
export function applyMeasured(sets: Record<ScenarioName, ScenarioInputSet>, m: MeasuredInputs | null, minOrders: number): { sets: Record<ScenarioName, ScenarioInputSet>; applied: boolean; note: string } {
  if (!m || m.orders < minOrders) {
    return { sets, applied: false, note: m ? `Only ${m.orders} paid orders so far (need ${minOrders}); every value below is a placeholder or an admin entry, not measured data.` : 'No paid orders yet; every value below is a placeholder or an admin entry, not measured data.' };
  }
  const out = {} as Record<ScenarioName, ScenarioInputSet>;
  for (const n of SCENARIO_NAMES) {
    const a = { ...sets[n].assumptions };
    const prov = { ...sets[n].provenance };
    for (const { field, dir } of MEASURED_FIELDS) {
      const v = m[field];
      if (v === null || prov[field] === 'admin') continue;
      const cur = a[field] as number;
      let next = v;
      let p: AssumptionProvenance = 'measured';
      if (n === 'conservative') {
        next = dir === 'lower_is_better' ? Math.max(cur, v) : Math.min(cur, v);
        if (next !== v) p = prov[field] ?? 'placeholder';
      } else if (n === 'aggressive') {
        next = dir === 'lower_is_better' ? Math.min(cur, v) : Math.max(cur, v);
        if (next !== v) p = prov[field] ?? 'placeholder';
      }
      (a as Record<string, unknown>)[field] = next;
      prov[field] = p;
    }
    out[n] = { assumptions: a, provenance: prov };
  }
  return { sets: out, applied: true, note: `Measured values from ${m.orders} paid orders replace placeholders in the base case; conservative/aggressive are kept on the correct side of them. Anything not listed as measured is still a placeholder.` };
}

export function runAll(sets: Record<ScenarioName, ScenarioInputSet>): Record<ScenarioName, ScenarioResult> {
  return { conservative: scenarioModel(sets.conservative.assumptions), base: scenarioModel(sets.base.assumptions), aggressive: scenarioModel(sets.aggressive.assumptions) };
}
