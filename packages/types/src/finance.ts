/** finance: shared types and zod schemas (owned by the finance workstream). Pure: no IO. */
import { z } from 'zod';
import type { Currency } from './money';

export const FINANCE_CURRENCIES = ['USD', 'CAD', 'INR'] as const;
export const currencySchema = z.enum(FINANCE_CURRENCIES);

/* ------------------------------------------------------------------ */
/* FX                                                                  */
/* ------------------------------------------------------------------ */

export const FX_SOURCES = ['frankfurter', 'exchangerate_api', 'static', 'manual'] as const;
export type FxSource = (typeof FX_SOURCES)[number];

/** Rates quoted as units of currency per 1 USD (same convention as `FxTable`). */
export interface FxSnapshot {
  base: 'USD';
  rates: Record<Currency, number>;
  source: FxSource;
  /** When Orvia fetched (and so last confirmed) these rates. */
  fetchedAt: Date;
  /** The provider's own publication date, when it states one (ECB publishes once per working day). */
  providerDate?: string;
}

export type FxStaleness = 'fresh' | 'warn' | 'expired';

/** Every conversion in a money path returns this, so the rate used is always auditable. */
export interface FxConversion {
  amount: number;
  /** Units of `to` per 1 unit of `from`. */
  rate: number;
  source: FxSource;
  asOf: string;
  stale: boolean;
  staleness: FxStaleness;
  from: Currency;
  to: Currency;
}

export interface FxPolicy {
  warnHours: number;
  hardLimitHours: number;
  /** True in production: expired rates are refused for pricing unless `adminOverride`. */
  enforceHardLimit: boolean;
  adminOverride: boolean;
}

/* ------------------------------------------------------------------ */
/* Ledger                                                              */
/* ------------------------------------------------------------------ */

export const LEDGER_ACCOUNTS = [
  'cash',
  'psp_receivable',
  'psp_reserve',
  'revenue_product',
  'revenue_shipping',
  'discounts',
  'refunds',
  'chargebacks',
  'tax_payable',
  'cogs_product',
  'shipping_cost',
  'duties_cost',
  'payment_fees',
  'supplier_payable',
  'ad_spend',
  'other_variable',
] as const;
export type LedgerAccount = (typeof LEDGER_ACCOUNTS)[number];

export const ACCOUNT_KIND: Record<LedgerAccount, 'asset' | 'liability' | 'revenue' | 'contra_revenue' | 'expense'> = {
  cash: 'asset',
  psp_receivable: 'asset',
  psp_reserve: 'asset',
  revenue_product: 'revenue',
  revenue_shipping: 'revenue',
  discounts: 'contra_revenue',
  refunds: 'contra_revenue',
  chargebacks: 'contra_revenue',
  tax_payable: 'liability',
  cogs_product: 'expense',
  shipping_cost: 'expense',
  duties_cost: 'expense',
  payment_fees: 'expense',
  supplier_payable: 'liability',
  ad_spend: 'expense',
  other_variable: 'expense',
};

export const JOURNAL_KINDS = [
  'order_paid',
  'supplier_cost',
  'supplier_cost_reversal',
  'refund',
  'chargeback',
  'payment_fee',
  'psp_settlement',
  'supplier_settlement',
  'ad_spend',
  'reserve_hold',
  'reserve_release',
  'adjustment',
] as const;
export type JournalKind = (typeof JOURNAL_KINDS)[number];

export interface JournalLine {
  account: LedgerAccount;
  side: 'debit' | 'credit';
  /** Positive integer, minor units of the journal currency. */
  amount: number;
}

export interface JournalRefs {
  orderId?: string;
  paymentId?: string;
  refundId?: string;
  shipmentId?: string;
  supplierId?: string;
  supplierOrderId?: string;
  settlementId?: string;
  campaignId?: string;
  metricId?: string;
}

/** A balanced, immutable journal entry: sum(debits) === sum(credits) in `currency`. */
export interface JournalDraft {
  kind: JournalKind;
  idempotencyKey: string;
  currency: Currency;
  postedAt: Date;
  memo: string;
  lines: JournalLine[];
  refs: JournalRefs;
  /** For reversals: the key of the journal reversed. */
  reverses?: string;
}

/* ------------------------------------------------------------------ */
/* Provenance of a figure                                              */
/* ------------------------------------------------------------------ */

/** Same four labels as the economics engine (`Basis` in domain/economics). */
export type FinanceBasis = 'measured' | 'quoted' | 'set' | 'estimated';
export type Provenance = 'actual' | 'mixed' | 'estimated' | 'unavailable';

/* ------------------------------------------------------------------ */
/* Finance settings (stored in system_settings key "finance")          */
/* ------------------------------------------------------------------ */

export const financeSettingsSchema = z.object({
  /** Currency the dashboards report in. */
  reportingCurrency: currencySchema.default('INR'),
  /** Days between a customer's payment and cash reaching our account, by payment provider. Configure from your PSP contract. */
  pspSettlementDays: z.record(z.string().max(40), z.number().min(0).max(60)).default({ stripe: 7, razorpay: 3, mock: 2 }),
  pspSettlementDaysDefault: z.number().min(0).max(60).default(7),
  /** Days we have to pay suppliers after the order (0 = prepay at order placement, typical for dropship). */
  supplierPaymentTermsDays: z.number().min(0).max(120).default(0),
  /** Fraction of gross receipts held by the PSP as a rolling reserve (0 if none). */
  pspRollingReservePct: z.number().min(0).max(0.5).default(0),
  /** Estimated reserves used when measured values do not exist yet. Labelled as estimates everywhere. */
  assumedRefundRate: z.number().min(0).max(0.6).default(0.08),
  assumedChargebackRate: z.number().min(0).max(0.1).default(0.005),
  /** Variable costs per order that the platform cannot measure yet (reporting currency, minor units). */
  csCostPerOrder: z.number().int().min(0).default(0),
  otherVariablePerOrder: z.number().int().min(0).default(0),
  /** Fixed operating expenses per month (reporting currency, minor units). ASSUMPTIONS the admin sets; not measured. */
  monthlyOpex: z.number().int().min(0).default(0),
  /** Cash on hand on `openingCashAsOf`, reporting currency minor units. Null = not entered. */
  openingCash: z.number().int().nullable().default(null),
  openingCashAsOf: z.string().max(30).nullable().default(null),
  /** Supplier cost increase vs the quote at order time that raises an alert. */
  costChangeAlertPct: z.number().min(0).max(1).default(0.05),
  /** Minimum paid orders before measured values replace placeholders in the scenario model. */
  minOrdersForMeasured: z.number().int().min(5).max(1000).default(30),
  /** Admin override that allows pricing from expired FX rates in production. Audited. */
  fxOverrideUntil: z.string().max(40).nullable().default(null),
});
export type FinanceSettings = z.infer<typeof financeSettingsSchema>;
export const DEFAULT_FINANCE_SETTINGS: FinanceSettings = financeSettingsSchema.parse({});

/* ------------------------------------------------------------------ */
/* ₹38 crore objective model                                           */
/* ------------------------------------------------------------------ */

export const SCENARIO_NAMES = ['conservative', 'base', 'aggressive'] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

/** All money in INR major units (rupees). Rates are fractions (0.09 = 9%). */
export const scenarioAssumptionsSchema = z.object({
  /** The objective is an INPUT, never an assumption of achievability. */
  targetAmountInr: z.number().positive().default(380_000_000),
  targetBasis: z.enum(['gmv', 'net_sales']).default('net_sales'),
  horizonMonths: z.number().int().min(1).max(60).default(12),
  /** Average order value charged to the customer, including tax. */
  aov: z.number().positive(),
  /** Tax embedded in the AOV (e.g. GST 0.18). Net sales exclude it. */
  taxRate: z.number().min(0).max(0.5),
  discountRate: z.number().min(0).max(0.6),
  /** Supplier product cost + shipping + duties, as a share of net (ex-tax) price. */
  landedCostPct: z.number().min(0).max(1.5),
  paymentFeePct: z.number().min(0).max(0.1),
  paymentFeeFixed: z.number().min(0).max(100),
  refundRate: z.number().min(0).max(0.8),
  /** Share of the supplier cost recovered on a refunded order (returns to supplier / cancelled before shipping). */
  refundCostRecoveryPct: z.number().min(0).max(1),
  chargebackRate: z.number().min(0).max(0.2),
  /** Paid acquisition cost per NEW customer. */
  cac: z.number().min(0),
  /** Share of orders that come from repeat customers (no acquisition cost). */
  repeatOrderShare: z.number().min(0).max(0.9),
  /** Site conversion rate (orders / sessions); used for sensitivity and sessions required. */
  conversionRate: z.number().gt(0).max(0.2),
  csCostPerOrder: z.number().min(0),
  otherVariablePerOrder: z.number().min(0),
  opexPerMonth: z.number().min(0),
  // working capital timing (days)
  pspSettlementDays: z.number().min(0).max(60),
  supplierPaymentLeadDays: z.number().min(-60).max(60), // days supplier is paid after the order; negative = before
  adSpendLeadDays: z.number().min(0).max(60),
  rollingReservePct: z.number().min(0).max(0.5),
  rollingReserveHoldDays: z.number().min(0).max(180),
  /** Optional constraints used for the reachability verdict. */
  availableWorkingCapital: z.number().min(0).nullable().default(null),
  maxOrdersPerDay: z.number().min(0).nullable().default(null),
  maxMonthlyAdSpend: z.number().min(0).nullable().default(null),
});
export type ScenarioAssumptions = z.infer<typeof scenarioAssumptionsSchema>;

export type AssumptionProvenance = 'placeholder' | 'admin' | 'measured';
export interface ScenarioInputSet {
  assumptions: ScenarioAssumptions;
  /** Per-field provenance; anything not `measured` or `admin` is a placeholder to replace. */
  provenance: Partial<Record<keyof ScenarioAssumptions, AssumptionProvenance>>;
}
