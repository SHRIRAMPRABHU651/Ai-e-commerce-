import type { CountryConfig } from '@orvia/types';

/** All amounts are integer minor units in the SAME currency unless stated otherwise. */

export interface PaymentFeeModel {
  /** fraction of the charge, e.g. 0.029 */
  pct: number;
  /** fixed fee in minor units */
  fixed: number;
}

export const DEFAULT_PAYMENT_FEES: Record<string, PaymentFeeModel> = {
  stripe_US: { pct: 0.029, fixed: 30 },
  stripe_CA: { pct: 0.029, fixed: 30 },
  razorpay_IN: { pct: 0.02, fixed: 0 },
  mock: { pct: 0.029, fixed: 30 },
};

export function paymentFeeModelFor(country: string): PaymentFeeModel {
  return DEFAULT_PAYMENT_FEES[country === 'IN' ? 'razorpay_IN' : `stripe_${country}`] ?? DEFAULT_PAYMENT_FEES.mock!;
}

export const calcPaymentFee = (amount: number, m: PaymentFeeModel): number =>
  Math.round(amount * m.pct + m.fixed);

export function landedCost(p: {
  productCost: number;
  shippingCost: number;
  duties?: number;
  fulfillmentFee?: number;
}): number {
  return Math.round(p.productCost + p.shippingCost + (p.duties ?? 0) + (p.fulfillmentFee ?? 0));
}

/**
 * Import duty estimate. Duties apply only when the fulfilment origin country differs from the
 * destination. Below the de-minimis value no duty is charged. This is an ESTIMATE; real customs
 * assessment is made by the carrier / customs authority.
 */
export function estimateDuties(
  originCountry: string,
  dest: Pick<CountryConfig, 'code' | 'duty'>,
  declaredValue: number,
): number {
  if (originCountry === dest.code) return 0;
  if (declaredValue <= dest.duty.deMinimis) return 0;
  return Math.round(declaredValue * dest.duty.rate);
}

/** Convert a tax-exclusive/inclusive price to the tax amount contained or to be added. */
export function computeTax(
  cfg: Pick<CountryConfig, 'taxInclusive' | 'defaultTaxRate' | 'regionTaxRates'>,
  region: string,
  taxableAmount: number,
): { tax: number; rate: number } {
  const rate = cfg.regionTaxRates[region.toUpperCase()] ?? cfg.defaultTaxRate;
  if (rate === 0) return { tax: 0, rate };
  const tax = cfg.taxInclusive
    ? Math.round(taxableAmount - taxableAmount / (1 + rate))
    : Math.round(taxableAmount * rate);
  return { tax, rate };
}

export interface ContributionInput {
  sellingPrice: number;
  landedCost: number;
  paymentFee: number;
  expectedRefundCost: number;
  adCost: number;
  otherVariable?: number;
}

/** Contribution profit = price - landed - payment fees - expected refunds - ads - other variable. */
export function contributionProfit(i: ContributionInput): number {
  return Math.round(
    i.sellingPrice - i.landedCost - i.paymentFee - i.expectedRefundCost - i.adCost - (i.otherVariable ?? 0),
  );
}

export interface EconomicsInput {
  supplierCost: number;
  shippingCost: number;
  duties?: number;
  fulfillmentFee?: number;
  sellingPrice: number;
  paymentFee: PaymentFeeModel;
  refundRate: number; // fraction
  /** Ad cost per order = cpc / conversionRate when both given, else adCostPerOrder. */
  cpc?: number;
  conversionRate?: number;
  adCostPerOrder?: number;
  otherVariable?: number;
}

export interface Economics {
  supplier_cost: number;
  shipping_cost: number;
  landed_cost: number;
  selling_price: number;
  gross_margin: number; // fraction: (price - landed)/price
  payment_fee: number;
  estimated_return_cost: number;
  estimated_ad_cost: number;
  customer_acquisition_cost: number;
  expected_profit: number;
  profit_margin: number; // fraction of price
  ROAS: number;
  break_even_ROAS: number;
  conversion_rate: number;
  refund_rate: number;
}

export function productEconomics(i: EconomicsInput): Economics {
  const landed = landedCost({
    productCost: i.supplierCost,
    shippingCost: i.shippingCost,
    duties: i.duties,
    fulfillmentFee: i.fulfillmentFee,
  });
  const fee = calcPaymentFee(i.sellingPrice, i.paymentFee);
  const refundCost = Math.round(i.sellingPrice * i.refundRate);
  const cvr = i.conversionRate ?? 0;
  const cac =
    i.cpc !== undefined && cvr > 0 ? Math.round(i.cpc / cvr) : Math.round(i.adCostPerOrder ?? 0);
  const profit = contributionProfit({
    sellingPrice: i.sellingPrice,
    landedCost: landed,
    paymentFee: fee,
    expectedRefundCost: refundCost,
    adCost: cac,
    otherVariable: i.otherVariable,
  });
  const preAd = i.sellingPrice - landed - fee - refundCost - (i.otherVariable ?? 0);
  return {
    supplier_cost: i.supplierCost,
    shipping_cost: i.shippingCost,
    landed_cost: landed,
    selling_price: i.sellingPrice,
    gross_margin: i.sellingPrice > 0 ? (i.sellingPrice - landed) / i.sellingPrice : 0,
    payment_fee: fee,
    estimated_return_cost: refundCost,
    estimated_ad_cost: cac,
    customer_acquisition_cost: cac,
    expected_profit: profit,
    profit_margin: i.sellingPrice > 0 ? profit / i.sellingPrice : 0,
    ROAS: cac > 0 ? i.sellingPrice / cac : 0,
    break_even_ROAS: preAd > 0 ? i.sellingPrice / preAd : Number.POSITIVE_INFINITY,
    conversion_rate: cvr,
    refund_rate: i.refundRate,
  };
}

export const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
export const safeDiv = (a: number, b: number): number => (b === 0 ? 0 : a / b);

/** Dashboard-level rollups. "Profit" is never equal to revenue. */
export interface FinancialInputs {
  grossRevenue: number;
  discounts: number;
  refunds: number;
  supplierCost: number;
  shippingCost: number;
  duties: number;
  paymentFees: number;
  adSpend: number;
  otherVariable?: number;
  fixedOverheadEstimate?: number;
}

export interface FinancialSummary extends FinancialInputs {
  netRevenue: number;
  grossProfit: number;
  contributionProfit: number;
  netProfitEstimate: number;
  roas: number;
  margin: number;
}

export function summarizeFinancials(f: FinancialInputs): FinancialSummary {
  const netRevenue = f.grossRevenue - f.discounts - f.refunds;
  const grossProfit = netRevenue - f.supplierCost - f.shippingCost - f.duties;
  const contribution = grossProfit - f.paymentFees - f.adSpend - (f.otherVariable ?? 0);
  const net = contribution - (f.fixedOverheadEstimate ?? 0);
  return {
    ...f,
    netRevenue,
    grossProfit,
    contributionProfit: contribution,
    netProfitEstimate: net,
    roas: safeDiv(netRevenue, f.adSpend),
    margin: safeDiv(contribution, netRevenue),
  };
}
