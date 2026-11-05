/**
 * Pure FX logic: staleness policy, rate snapshots, conversions that report the rate used.
 * No IO. The persisting service is in fxService.ts; provider adapters are in fxProviders.ts.
 */
import { DEFAULT_FX } from '@orvia/types';
import type { Currency, FxConversion, FxPolicy, FxSnapshot, FxStaleness, FxTable } from '@orvia/types';
import { DomainError } from '../../infra/context';

const HOUR = 3_600_000;
const CURRENCIES: Currency[] = ['USD', 'CAD', 'INR'];

export const ageHours = (fetchedAt: Date, now: Date): number => Math.max(0, (now.getTime() - fetchedAt.getTime()) / HOUR);

/** fresh < warnHours <= warn < hardLimitHours <= expired */
export function fxStaleness(fetchedAt: Date, now: Date, p: Pick<FxPolicy, 'warnHours' | 'hardLimitHours'>): FxStaleness {
  const h = ageHours(fetchedAt, now);
  if (h >= p.hardLimitHours) return 'expired';
  if (h >= p.warnHours) return 'warn';
  return 'fresh';
}

/** A rate snapshot is only usable if every supported currency has a positive finite rate. */
export function validateRates(rates: Partial<Record<Currency, number>>): rates is Record<Currency, number> {
  return CURRENCIES.every((c) => typeof rates[c] === 'number' && Number.isFinite(rates[c]) && (rates[c] as number) > 0) && rates.USD === 1;
}

export const snapshotToTable = (s: FxSnapshot): FxTable => ({ USD: 1, CAD: s.rates.CAD, INR: s.rates.INR });

/** The dev/test fallback table as a snapshot. Production configuration refuses to use it. */
export function staticSnapshot(now: Date): FxSnapshot {
  return { base: 'USD', rates: { ...DEFAULT_FX }, source: 'static', fetchedAt: now };
}

/** Units of `to` per 1 unit of `from`. */
export function crossRate(rates: Record<Currency, number>, from: Currency, to: Currency): number {
  if (from === to) return 1;
  return rates[to] / rates[from];
}

/**
 * Convert minor units using a rate snapshot. Returns the rate, source and as-of used.
 * `stale` is true for both `warn` and `expired`; callers that price orders must also call `assertFxUsable`.
 */
export function convertWithSnapshot(minor: number, from: Currency, to: Currency, snap: FxSnapshot, now: Date, policy: Pick<FxPolicy, 'warnHours' | 'hardLimitHours'>): FxConversion {
  const staleness = fxStaleness(snap.fetchedAt, now, policy);
  const rate = crossRate(snap.rates, from, to);
  return { amount: Math.round(minor * rate), rate, source: snap.source, asOf: snap.fetchedAt.toISOString(), stale: staleness !== 'fresh', staleness, from, to };
}

/**
 * Policy for money paths that PRICE new orders: expired rates are refused when the hard limit is enforced
 * (production), unless an admin override is active. Warn-level staleness never blocks, it is surfaced.
 */
export function assertFxUsable(snap: FxSnapshot, now: Date, p: FxPolicy): { staleness: FxStaleness; overridden: boolean } {
  const staleness = fxStaleness(snap.fetchedAt, now, p);
  if (snap.source === 'static' && p.enforceHardLimit) throw new DomainError('FX rates come from the static dev table, which is not allowed in production', 'FX_STATIC_REFUSED', 503);
  if (staleness === 'expired' && p.enforceHardLimit) {
    if (p.adminOverride) return { staleness, overridden: true };
    throw new DomainError(`FX rates are ${Math.floor(ageHours(snap.fetchedAt, now))}h old (limit ${p.hardLimitHours}h); pricing new orders is paused until rates are refreshed or an admin override is set`, 'FX_RATES_EXPIRED', 503);
  }
  return { staleness, overridden: false };
}

/** Parse provider payloads into a snapshot (pure so it is unit-testable without network). */
export function parseFrankfurter(json: unknown, fetchedAt: Date): FxSnapshot {
  const j = json as { base?: string; date?: string; rates?: Record<string, number> };
  if (j?.base !== 'USD' || !j.rates) throw new Error('Unexpected Frankfurter response');
  const rates = { USD: 1, CAD: j.rates['CAD'], INR: j.rates['INR'] } as Partial<Record<Currency, number>>;
  if (!validateRates(rates)) throw new Error('Frankfurter response is missing a required currency');
  return { base: 'USD', rates, source: 'frankfurter', fetchedAt, providerDate: j.date };
}

export function parseExchangerateApi(json: unknown, fetchedAt: Date): FxSnapshot {
  const j = json as { result?: string; base_code?: string; conversion_rates?: Record<string, number>; time_last_update_utc?: string };
  if (j?.result !== 'success' || j.base_code !== 'USD' || !j.conversion_rates) throw new Error('Unexpected exchangerate-api response');
  const rates = { USD: 1, CAD: j.conversion_rates['CAD'], INR: j.conversion_rates['INR'] } as Partial<Record<Currency, number>>;
  if (!validateRates(rates)) throw new Error('exchangerate-api response is missing a required currency');
  return { base: 'USD', rates, source: 'exchangerate_api', fetchedAt, providerDate: j.time_last_update_utc };
}

/**
 * Guard against a provider glitch silently re-pricing the store: a single refresh may not move any rate by more than `maxMovePct`.
 * Returns the offending currency or null.
 */
export function suspiciousMove(prev: FxSnapshot | null, next: FxSnapshot, maxMovePct = 0.15): Currency | null {
  if (!prev) return null;
  for (const c of CURRENCIES) if (Math.abs(next.rates[c] - prev.rates[c]) / prev.rates[c] > maxMovePct) return c;
  return null;
}
