/** Audience segment rule evaluation (pure). Rules are ANDed; every rule runs against facts derived from real orders/customers. */
import type { SegmentRule } from '@orvia/types';

export interface CustomerFacts {
  email: string;
  ordersCount: number;
  /** Net of nothing: sum of paid order totals converted to USD minor units (cents). */
  lifetimeValueUsd: number;
  lastOrderAt: Date | null;
  country: string | null;
  marketingConsent: boolean;
  /** Category slugs (sub-category and top category) the customer has bought from. */
  categories: string[];
}

const DAY = 86_400_000;

/** A customer who never ordered has no "days since last order": recency rules do NOT match them (use ordersCount eq 0 for that). */
export function daysSinceLastOrder(f: CustomerFacts, now: Date): number | null {
  return f.lastOrderAt ? Math.max(0, Math.floor((now.getTime() - f.lastOrderAt.getTime()) / DAY)) : null;
}

export function evaluateRule(r: SegmentRule, f: CustomerFacts, now: Date): boolean {
  switch (r.field) {
    case 'ordersCount': return r.op === 'eq' ? f.ordersCount === r.value : r.op === 'gte' ? f.ordersCount >= r.value : f.ordersCount <= r.value;
    case 'lifetimeValueUsd': { const usd = f.lifetimeValueUsd / 100; return r.op === 'gte' ? usd >= r.value : usd <= r.value; }
    case 'daysSinceLastOrder': { const d = daysSinceLastOrder(f, now); return d === null ? false : r.op === 'gte' ? d >= r.value : d <= r.value; }
    case 'country': return !!f.country && r.value.includes(f.country as 'US' | 'CA' | 'IN');
    case 'marketingConsent': return f.marketingConsent === r.value;
    case 'categoryAffinity': return f.categories.some((c) => r.value.includes(c));
  }
}

export const evaluateSegment = (rules: SegmentRule[], f: CustomerFacts, now: Date): boolean => rules.length > 0 && rules.every((r) => evaluateRule(r, f, now));

/** Rules that can be pushed down to the Customer collection query (the rest are evaluated in memory on derived facts). */
export function buildCustomerPrefilter(rules: SegmentRule[]): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  for (const r of rules) {
    if (r.field === 'country') q['country'] = { $in: r.value };
    if (r.field === 'marketingConsent') q['marketingConsent'] = r.value;
  }
  return q;
}

export const SEGMENT_PRESETS: { name: string; description: string; rules: SegmentRule[] }[] = [
  { name: 'Lapsed buyers (90+ days)', description: 'Bought before, nothing in the last 90 days', rules: [{ field: 'ordersCount', op: 'gte', value: 1 }, { field: 'daysSinceLastOrder', op: 'gte', value: 90 }] },
  { name: 'First-time buyers', description: 'Exactly one order', rules: [{ field: 'ordersCount', op: 'eq', value: 1 }] },
  { name: 'Repeat buyers', description: 'Two or more orders', rules: [{ field: 'ordersCount', op: 'gte', value: 2 }] },
  { name: 'High lifetime value (USD 150+)', description: 'Lifetime paid orders of at least USD 150', rules: [{ field: 'lifetimeValueUsd', op: 'gte', value: 150 }] },
  { name: 'Subscribers who have not bought', description: 'Opted in to marketing, zero orders', rules: [{ field: 'ordersCount', op: 'eq', value: 0 }, { field: 'marketingConsent', op: 'eq', value: true }] },
];
