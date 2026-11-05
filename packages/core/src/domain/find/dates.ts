/** Pure calendar helpers on 'YYYY-MM-DD' strings (no timezone surprises: arithmetic is done in UTC on date-only values). */
import type { CountryCode } from '@orvia/types';

/** Representative IANA timezone per market (a single zone per country is an approximation, documented). */
export const COUNTRY_TZ: Record<CountryCode, string> = { US: 'America/New_York', CA: 'America/Toronto', IN: 'Asia/Kolkata' };

export type Ymd = string;

const toUtc = (d: Ymd): number => {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, day);
};
const fromUtc = (ms: number): Ymd => new Date(ms).toISOString().slice(0, 10);

export const isYmd = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && fromUtc(toUtc(s)) === s;
export const addDays = (d: Ymd, n: number): Ymd => fromUtc(toUtc(d) + n * 86_400_000);
export const diffDays = (a: Ymd, b: Ymd): number => Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
/** 0 = Sunday ... 6 = Saturday */
export const dayOfWeek = (d: Ymd): number => new Date(toUtc(d)).getUTCDay();
/** Monday-based week start of the date, used to tell "this week" from "next week". */
export const weekStart = (d: Ymd): Ymd => addDays(d, -((dayOfWeek(d) + 6) % 7));
export const daysInMonth = (y: number, m1: number): number => new Date(Date.UTC(y, m1, 0)).getUTCDate();
export const makeYmd = (y: number, m1: number, d: number): Ymd | null => {
  if (m1 < 1 || m1 > 12 || d < 1 || d > daysInMonth(y, m1)) return null;
  return `${String(y).padStart(4, '0')}-${String(m1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

/** The calendar date `now` falls on in the given timezone. */
export function todayIn(tz: string, now: Date): Ymd {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    return `${g('year')}-${g('month')}-${g('day')}`;
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
export const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'] as const;

export function formatYmd(d: Ymd): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(toUtc(d)));
}
