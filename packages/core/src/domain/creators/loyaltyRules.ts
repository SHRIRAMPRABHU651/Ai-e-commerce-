/** Pure loyalty rules: earn, tiers, redemption clamp, FIFO consumption and expiry. No IO. Money = USD minor units unless stated. */
import type { LoyaltyRules } from '@orvia/types';

export function computeTier(trailingSpendUsd: number, rules: Pick<LoyaltyRules, 'tiers'>): { tier: { name: string; multiplier: number }; next: { name: string; spendRemainingUsd: number } | null } {
  const sorted = [...rules.tiers].sort((a, b) => a.minSpendUsd - b.minSpendUsd);
  let idx = 0;
  sorted.forEach((t, i) => { if (trailingSpendUsd >= t.minSpendUsd) idx = i; });
  const cur = sorted[idx]!;
  const nxt = sorted[idx + 1];
  return { tier: { name: cur.name, multiplier: cur.multiplier }, next: nxt ? { name: nxt.name, spendRemainingUsd: nxt.minSpendUsd - trailingSpendUsd } : null };
}

/** Points earned on delivered NET value (after refunds, ex tax/shipping) in USD minor units. Whole points, rounded down. */
export const pointsForNet = (netUsdMinor: number, rules: Pick<LoyaltyRules, 'pointsPerUsd'>, multiplier: number): number =>
  Math.max(0, Math.floor((Math.max(0, netUsdMinor) / 100) * rules.pointsPerUsd * multiplier));

/** USD minor units that a number of points is worth. */
export const pointsValueUsd = (points: number, rules: Pick<LoyaltyRules, 'pointsPerUsdValue'>): number => Math.floor((points / rules.pointsPerUsdValue) * 100);

/**
 * Same margin rule as the promotion engine (`evaluatePromotions`): the discount may never exceed 50% of the subtotal and
 * may never push the order below landed cost + 5%. The live engine re-applies it at checkout; this lets us refuse
 * obviously unsafe redemptions up front and size the `minSubtotal` of the generated code.
 */
export const maxSafeDiscount = (subtotal: number, landed: number): number => Math.max(0, Math.min(Math.round(subtotal * 0.5), subtotal - Math.round(landed * 1.05)));

export type RedeemRefusal = 'below_minimum' | 'insufficient_points' | 'above_per_redemption_cap' | 'above_30d_cap' | 'not_whole_value';
export function planRedemption(i: { points: number; balance: number; redeemedLast30d: number; rules: LoyaltyRules }): { ok: true; points: number; valueUsd: number; minSubtotalUsd: number } | { ok: false; reason: RedeemRefusal } {
  const { points, rules } = i;
  if (points < rules.minRedeemPoints) return { ok: false, reason: 'below_minimum' };
  if (points > i.balance) return { ok: false, reason: 'insufficient_points' };
  if (points > rules.maxRedeemPoints) return { ok: false, reason: 'above_per_redemption_cap' };
  if (i.redeemedLast30d + points > rules.maxRedeemPer30d) return { ok: false, reason: 'above_30d_cap' };
  if (points % 10 !== 0) return { ok: false, reason: 'not_whole_value' };
  const valueUsd = pointsValueUsd(points, rules);
  // the code only applies to baskets at least 3x the discount, so the margin clamp never silently eats the customer's points
  return { ok: true, points, valueUsd, minSubtotalUsd: valueUsd * 3 };
}

export interface EarnRow { id: string; remaining: number; expiresAt: Date | null }
/** FIFO: spend from the earliest-expiring earn rows first. Returns per-row deductions (sum === points) or null if not enough. */
export function consumeFifo(rows: EarnRow[], points: number): { id: string; take: number }[] | null {
  const sorted = [...rows].filter((r) => r.remaining > 0).sort((a, b) => (a.expiresAt?.getTime() ?? Infinity) - (b.expiresAt?.getTime() ?? Infinity));
  const out: { id: string; take: number }[] = [];
  let left = points;
  for (const r of sorted) {
    if (left <= 0) break;
    const take = Math.min(r.remaining, left);
    out.push({ id: r.id, take });
    left -= take;
  }
  return left > 0 ? null : out;
}
/** Rows whose expiry has passed and still hold points. */
export const expirable = (rows: EarnRow[], now: Date): { id: string; points: number }[] =>
  rows.filter((r) => r.remaining > 0 && r.expiresAt && r.expiresAt.getTime() <= now.getTime()).map((r) => ({ id: r.id, points: r.remaining }));
