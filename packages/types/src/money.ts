/** All monetary values in Orvia are integers in minor units (cents / paise). */
export type Currency = 'USD' | 'CAD' | 'INR';

export function formatMoney(minor: number, currency: Currency, locale?: string): string {
  const loc = locale ?? (currency === 'INR' ? 'en-IN' : currency === 'CAD' ? 'en-CA' : 'en-US');
  const major = minor / 100;
  const hasFraction = Math.round(minor) % 100 !== 0;
  return new Intl.NumberFormat(loc, {
    style: 'currency',
    currency,
    minimumFractionDigits: currency === 'INR' && !hasFraction ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(major);
}

export type FxTable = Record<Currency, number>; // units per 1 USD

export const DEFAULT_FX: FxTable = { USD: 1, CAD: 1.37, INR: 84 };

export function convertMinor(minor: number, from: Currency, to: Currency, fx: FxTable = DEFAULT_FX): number {
  if (from === to) return Math.round(minor);
  const usd = minor / fx[from];
  return Math.round(usd * fx[to]);
}

export const pct = (n: number, digits = 1): string => `${(n * 100).toFixed(digits)}%`;
