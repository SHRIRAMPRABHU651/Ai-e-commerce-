/**
 * Pure contribution math. No IO.
 *
 *   Contribution = selling price (ex-tax, after discount)
 *                − supplier product cost − shipping − payment fees − taxes/duties borne by us
 *                − acquisition cost − refund reserve − chargeback reserve
 *                − customer-service cost − other variable costs
 *
 * Every component carries the economics engine's basis label (measured / quoted / set / estimated);
 * anything `estimated` is an assumption and the result says how much of the figure rests on one.
 */
import type { FinanceBasis, FinanceProvenance } from '@orvia/types';

export interface ContributionComponent {
  /** Minor units, >= 0. */
  amount: number;
  basis: FinanceBasis;
  note?: string;
}

export const COST_KEYS = ['supplierCost', 'shipping', 'paymentFee', 'taxesDuties', 'acquisitionCost', 'refundReserve', 'chargebackReserve', 'customerService', 'otherVariable'] as const;
export type CostKey = (typeof COST_KEYS)[number];

export interface ContributionInput extends Record<CostKey, ContributionComponent> {
  /** Ex-tax price actually charged, after discount. */
  sellingPrice: ContributionComponent;
}

export interface ContributionLine {
  key: 'sellingPrice' | CostKey;
  label: string;
  amount: number;
  basis: FinanceBasis;
  /** `estimated` = rests on an assumption; `actual` = measured, quoted by a supplier/rate card, or set by the operator. */
  kind: 'actual' | 'estimated';
  note?: string;
}

export interface ContributionResult {
  contribution: number;
  /** contribution ÷ selling price; null when the price is 0. */
  marginPct: number | null;
  lines: ContributionLine[];
  provenance: FinanceProvenance;
  /** Sum of the cost components that are estimates. */
  estimatedCost: number;
  /** Share (0..1) of total cost that rests on estimates. null when there are no costs. */
  estimatedShare: number | null;
}

const LABEL: Record<'sellingPrice' | CostKey, string> = {
  sellingPrice: 'Selling price (ex-tax, after discount)',
  supplierCost: 'Supplier product cost',
  shipping: 'Shipping',
  paymentFee: 'Payment fees',
  taxesDuties: 'Taxes / duties borne by Orvia',
  acquisitionCost: 'Acquisition cost (CAC)',
  refundReserve: 'Refund reserve',
  chargebackReserve: 'Chargeback reserve',
  customerService: 'Customer-service cost',
  otherVariable: 'Other variable costs',
};

const line = (key: 'sellingPrice' | CostKey, c: ContributionComponent): ContributionLine => ({ key, label: LABEL[key], amount: c.amount, basis: c.basis, kind: c.basis === 'estimated' ? 'estimated' : 'actual', note: c.note });

export function computeContribution(i: ContributionInput): ContributionResult {
  for (const k of ['sellingPrice', ...COST_KEYS] as const) if (!Number.isFinite(i[k].amount)) throw new Error(`contribution: ${k} must be a finite number`);
  const lines = [line('sellingPrice', i.sellingPrice), ...COST_KEYS.map((k) => line(k, i[k]))];
  const costLines = lines.slice(1);
  const totalCost = costLines.reduce((a, l) => a + l.amount, 0);
  const estimatedCost = costLines.filter((l) => l.kind === 'estimated').reduce((a, l) => a + l.amount, 0);
  const contribution = i.sellingPrice.amount - totalCost;
  const nonZero = lines.filter((l) => l.amount !== 0);
  const kinds = new Set(nonZero.map((l) => l.kind));
  const provenance: FinanceProvenance = !nonZero.length ? 'unavailable' : kinds.size === 2 ? 'mixed' : kinds.has('estimated') ? 'estimated' : 'actual';
  return {
    contribution,
    marginPct: i.sellingPrice.amount > 0 ? contribution / i.sellingPrice.amount : null,
    lines,
    provenance,
    estimatedCost,
    estimatedShare: totalCost > 0 ? estimatedCost / totalCost : null,
  };
}

/** Reserve = rate × price, always labelled an estimate unless the rate itself is measured. */
export const reserve = (price: number, rate: number, measured: boolean, note?: string): ContributionComponent => ({ amount: Math.max(0, Math.round(price * rate)), basis: measured ? 'measured' : 'estimated', note });

/** Contribution per order needed to cover fixed operating cost at a given order volume (null if volume 0). */
export const requiredContributionPerOrder = (monthlyOpex: number, ordersPerMonth: number): number | null => (ordersPerMonth > 0 ? monthlyOpex / ordersPerMonth : null);

/** Highest acquisition cost that still leaves `minMarginPct` of the selling price (negative means unattainable even for free traffic). */
export function breakEvenAcquisitionCost(i: ContributionInput, minMarginPct = 0): number {
  const withoutCac = computeContribution({ ...i, acquisitionCost: { amount: 0, basis: 'set' } });
  return Math.round(withoutCac.contribution - minMarginPct * i.sellingPrice.amount);
}
