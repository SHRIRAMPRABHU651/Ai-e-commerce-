import { SystemSetting } from '@orvia/database';
import { DEFAULT_AD_RULES } from '@orvia/ads';
import { DEFAULT_RANK_WEIGHTS } from '@orvia/analytics';
import type { AdRulesConfig } from '@orvia/ads';
import { AUTOMATION_KEYS, DEFAULT_FX } from '@orvia/types';
import type { AutomationKey, AutomationMode, Currency, FxTable } from '@orvia/types';

export interface PricingSettings {
  minMarginPct: number;
  maxDiscountPct: number;
  minSellingPrice: Record<Currency, number>;
  targetProfitPerOrder: Record<Currency, number>;
  targetRoas: number;
  defaultStrategy: 'cost_plus' | 'target_margin' | 'competitor_based' | 'dynamic_demand' | 'ai_optimized';
  targetMarginPct: number;
  baseRefundRate: number;
  /** Expected ad cost per order as a fraction of the selling price when no campaign data exists yet. */
  assumedAdCostPct: number;
  /** Required relative change before a price update is proposed. */
  minPriceChangePct: number;
}

export interface AutomationSettings {
  modes: Record<AutomationKey, AutomationMode>;
  /** Max value of a single automatically-approved refund (minor units, USD-equivalent). */
  autoRefundLimitUsd: number;
}

export interface OpsSettings {
  lowStockThreshold: number;
  supplierPriceSpikePct: number;
  fraudHighScore: number;
  fraudMediumScore: number;
  highValueOrderUsd: number;
  abandonedCartDelayMinutes: number[];
  fulfillmentMaxAttempts: number;
  testDefaults: { durationDays: number; minImpressions: number; minClicks: number; minSpend: number; targetCpa: number; targetRoas: number; dailyBudget: number };
  fx: FxTable;
}

export interface SourcingSettings {
  /** Supplier selection weights (normalised at use). Everything that matters to a customer is an explicit, tunable factor. */
  weights: { profit: number; delivery: number; reliability: number; stockConfidence: number; tracking: number; returns: number; destinationFit: number; risk: number };
  /** Price/stock data older than this is not trusted for fulfilment decisions (live quotes are re-fetched before ordering anyway). */
  staleAfterMinutes: number;
  /** Manual-supplier offers (no API) expire after this long without being re-confirmed. */
  manualOfferTtlHours: number;
  /** Consecutive failed health checks before a supplier is treated as FAILING and excluded from new orders. */
  failingAfterChecks: number;
}

export interface MarketSettings {
  /** Trend-score component weights (normalised at use). */
  weights: { recency: number; velocity: number; crossSource: number; mentionGrowth: number; searchGrowth: number; availability: number; priceMomentum: number; internalConversion: number };
  /** Below this confidence a topic is never labelled TRENDING/RISING. */
  minConfidence: number;
  /** Competitor prices older than this lose confidence entirely. */
  priceStaleDays: number;
  /** Orvia events needed before a behavioural signal counts (prevents one or two purchases looking viral). */
  minInternalSample: number;
}

export interface SettingsMap {
  market: MarketSettings;
  sourcing: SourcingSettings;
  pricing: PricingSettings;
  ads: AdRulesConfig;
  automation: AutomationSettings;
  ops: OpsSettings;
  country_overrides: Record<string, unknown>;
}

export const defaultAutomationModes = (production: boolean): Record<AutomationKey, AutomationMode> => ({
  product_discovery: production ? 'ASSISTED' : 'AUTOMATIC',
  auto_publishing: 'ASSISTED',
  dynamic_pricing: 'ASSISTED',
  inventory_sync: 'AUTOMATIC',
  order_fulfillment: production ? 'ASSISTED' : 'AUTOMATIC',
  tracking: 'AUTOMATIC',
  customer_support: 'AUTOMATIC',
  ad_optimization: 'ASSISTED',
  promotion_optimization: 'ASSISTED',
  abandoned_cart: production ? 'OFF' : 'AUTOMATIC',
  ai_reports: 'AUTOMATIC',
});

export function buildDefaults(production: boolean): SettingsMap {
  return {
    pricing: {
      minMarginPct: 0.2,
      maxDiscountPct: 0.15,
      minSellingPrice: { USD: 999, CAD: 1299, INR: 39900 },
      targetProfitPerOrder: { USD: 500, CAD: 650, INR: 20000 },
      targetRoas: 2.5,
      defaultStrategy: 'target_margin',
      targetMarginPct: 0.4,
      baseRefundRate: 0.05,
      assumedAdCostPct: 0.2,
      minPriceChangePct: 0.02,
    },
    sourcing: { weights: DEFAULT_RANK_WEIGHTS, staleAfterMinutes: 360, manualOfferTtlHours: 72, failingAfterChecks: 3 },
    market: { weights: { recency: 0.2, velocity: 0.25, crossSource: 0.15, mentionGrowth: 0.15, searchGrowth: 0.1, availability: 0.05, priceMomentum: 0.05, internalConversion: 0.05 }, minConfidence: 0.35, priceStaleDays: 14, minInternalSample: 10 },
    ads: DEFAULT_AD_RULES,
    automation: { modes: defaultAutomationModes(production), autoRefundLimitUsd: 5000 },
    ops: {
      lowStockThreshold: 10,
      supplierPriceSpikePct: 0.1,
      fraudHighScore: 70,
      fraudMediumScore: 40,
      highValueOrderUsd: 30_000,
      abandonedCartDelayMinutes: [60, 24 * 60, 72 * 60],
      fulfillmentMaxAttempts: 5,
      testDefaults: { durationDays: 5, minImpressions: 1500, minClicks: 30, minSpend: 3000, targetCpa: 1500, targetRoas: 2.5, dailyBudget: 1000 },
      fx: DEFAULT_FX,
    },
    country_overrides: {},
  };
}

/** Typed system settings with defaults + 15s in-process cache. Admin edits are audited by callers. */
export class SettingsService {
  private cache = new Map<string, { at: number; value: unknown }>();
  private readonly defaults: SettingsMap;
  constructor(
    production: boolean,
    private readonly ttlMs = 15_000,
  ) {
    this.defaults = buildDefaults(production);
  }

  async get<K extends keyof SettingsMap>(key: K): Promise<SettingsMap[K]> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value as SettingsMap[K];
    const doc = await SystemSetting.findOne({ key }).lean();
    const def = this.defaults[key];
    const value = (doc?.value && typeof doc.value === 'object' ? deepMerge(def, doc.value as object) : def) as SettingsMap[K];
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  async set<K extends keyof SettingsMap>(key: K, patch: Partial<SettingsMap[K]>, by: string): Promise<SettingsMap[K]> {
    const current = await this.get(key);
    const next = deepMerge(current as object, patch as object) as SettingsMap[K];
    await SystemSetting.updateOne({ key }, { $set: { value: next, updatedBy: by } }, { upsert: true });
    this.cache.delete(key);
    return next;
  }

  invalidate(): void {
    this.cache.clear();
  }

  async automationMode(key: AutomationKey): Promise<AutomationMode> {
    return (await this.get('automation')).modes[key] ?? 'OFF';
  }

  async setAutomationMode(key: AutomationKey, mode: AutomationMode, by: string): Promise<void> {
    if (!AUTOMATION_KEYS.includes(key)) throw new Error('Unknown automation');
    const cur = await this.get('automation');
    await this.set('automation', { modes: { ...cur.modes, [key]: mode } }, by);
  }
}

function deepMerge<T extends object>(base: T, patch: object): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    const b = out[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' && !Array.isArray(b) ? deepMerge(b as object, v) : v;
  }
  return out as T;
}
