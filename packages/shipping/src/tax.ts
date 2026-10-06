import type { CountryConfig } from '@orvia/types';
import { orderTotals } from './index';
import type { OrderTotals } from './index';

/**
 * Tax / duty provider ports. Orvia ships an ESTIMATING implementation (rate tables in the country config) and a clear
 * extension point for a real tax engine (Stripe Tax, TaxJar, Avalara, GST services…). Anything computed by the estimator is
 * labelled "estimated" in the UI and in the launch gate — it is never presented as legal or tax advice.
 */
export interface TaxProvider {
  readonly key: string;
  readonly mode: 'estimated' | 'live';
  estimate(cfg: CountryConfig, region: string, subtotal: number, discount: number, shipping: number): OrderTotals;
  validate(cfg: CountryConfig): { ok: boolean; problems: string[] };
  healthCheck(): Promise<{ ok: boolean; message: string }>;
}

export interface DutyProvider {
  readonly key: string;
  readonly mode: 'estimated' | 'live';
  /** Estimated import duty (minor units of the destination currency) for goods declared at `declaredValue`. */
  estimate(cfg: CountryConfig, fromCountry: string, declaredValue: number): { duty: number; basis: string };
}

export class EstimatedTaxProvider implements TaxProvider {
  readonly key = 'estimated-rate-table';
  readonly mode = 'estimated' as const;
  estimate(cfg: CountryConfig, region: string, subtotal: number, discount: number, shipping: number): OrderTotals {
    return orderTotals(cfg, region, subtotal, discount, shipping);
  }
  validate(cfg: CountryConfig): { ok: boolean; problems: string[] } {
    const problems: string[] = [];
    if (cfg.defaultTaxRate < 0 || cfg.defaultTaxRate > 0.5) problems.push(`${cfg.code}: default tax rate ${cfg.defaultTaxRate} looks wrong`);
    if (cfg.code === 'US' && Object.keys(cfg.regionTaxRates ?? {}).length === 0) problems.push('US: no state tax rates configured — sales tax would be zero everywhere');
    if (cfg.code === 'CA' && Object.keys(cfg.regionTaxRates ?? {}).length === 0) problems.push('CA: no provincial rates configured (GST/HST/PST)');
    if (cfg.code === 'IN' && !cfg.taxInclusive) problems.push('IN: prices are expected to be GST-inclusive');
    return { ok: problems.length === 0, problems };
  }
  async healthCheck() {
    return { ok: true, message: 'Built-in rate table (estimates only)' };
  }
}

export class EstimatedDutyProvider implements DutyProvider {
  readonly key = 'estimated-duty-table';
  readonly mode = 'estimated' as const;
  estimate(cfg: CountryConfig, fromCountry: string, declaredValue: number): { duty: number; basis: string } {
    if (fromCountry === cfg.code) return { duty: 0, basis: 'domestic shipment' };
    if (declaredValue <= cfg.duty.deMinimis) return { duty: 0, basis: `under the ${cfg.code} de-minimis threshold` };
    return { duty: Math.round(declaredValue * cfg.duty.rate), basis: `${Math.round(cfg.duty.rate * 100)}% flat estimate for ${cfg.code}` };
  }
}
