/**
 * Pure commission rule engine. No IO. All money is integer minor units in the ORDER currency.
 *
 * The commission base is the NET CONTRIBUTION-SAFE BASE, never GMV:
 *   goods revenue after discounts, excluding tax and shipping, reduced pro-rata for refunds.
 * Commission is then capped by an order cap and by a share of the order's known contribution.
 */
import type { CommissionRules } from '@orvia/types';

export interface CommissionLine { category: string; gross: number }
export interface CommissionOrder {
  currency: string;
  lines: CommissionLine[];
  subtotal: number;
  discount: number;
  shipping: number;
  tax: number;
  total: number;
  taxInclusive: boolean;
  /** total refunded so far (order currency, includes shipping/tax share) */
  refunded: number;
  /** supplier/shipping/duty/payment costs when known (null = not yet known) */
  knownCosts: number | null;
}
export interface CreatorTerms {
  rateOverride?: number | null;
  categoryRateOverrides?: Record<string, number>;
  /** trailing-90-day delivered attributed orders (for tier) */
  orders90d: number;
}
export interface CommissionLineResult { category: string; net: number; rate: number; commission: number }
export interface CommissionResult {
  netBase: number;
  netBaseBeforeRefund: number;
  commission: number;
  rateSource: 'creator_override' | 'category' | 'default';
  tier: string | null;
  lines: CommissionLineResult[];
  capped: string[];
  reasons: string[];
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Goods revenue ex-tax, ex-shipping, after discount, before refunds. */
export function netGoodsBase(o: Pick<CommissionOrder, 'subtotal' | 'discount' | 'shipping' | 'tax' | 'taxInclusive'>): number {
  const after = Math.max(0, o.subtotal - o.discount);
  if (!o.taxInclusive || o.tax <= 0) return after;
  // tax-inclusive markets: tax is embedded in (goods + shipping); attribute it to goods pro rata
  const denom = after + Math.max(0, o.shipping);
  const goodsTax = denom > 0 ? Math.round((o.tax * after) / denom) : 0;
  return Math.max(0, after - goodsTax);
}

/** Fraction of the order value refunded, clamped to [0,1]. Refunds reduce the base pro rata (conservative for shipping-only refunds). */
export const refundFraction = (refunded: number, total: number): number => (total > 0 ? clamp(refunded / total, 0, 1) : refunded > 0 ? 1 : 0);

export function tierFor(rules: CommissionRules, orders90d: number): { name: string; bonusRate: number } | null {
  const sorted = [...rules.tiers].sort((a, b) => a.minOrders90d - b.minOrders90d);
  let hit: (typeof sorted)[number] | undefined;
  for (const t of sorted) if (orders90d >= t.minOrders90d) hit = t;
  return hit ? { name: hit.name, bonusRate: hit.bonusRate } : null;
}

/** Rate for one category. Precedence: creator category override > creator flat override > program category > program default (+tier bonus unless creator override). */
export function rateFor(category: string, rules: CommissionRules, creator: CreatorTerms): { rate: number; source: CommissionResult['rateSource']; tier: string | null } {
  const co = creator.categoryRateOverrides?.[category];
  if (typeof co === 'number') return { rate: clamp(co, 0, 0.5), source: 'creator_override', tier: null };
  if (typeof creator.rateOverride === 'number') return { rate: clamp(creator.rateOverride, 0, 0.5), source: 'creator_override', tier: null };
  const tier = tierFor(rules, creator.orders90d);
  const catRate = rules.categoryRates[category];
  const base = typeof catRate === 'number' ? catRate : rules.defaultRate;
  return { rate: clamp(base + (tier?.bonusRate ?? 0), 0, 0.5), source: typeof catRate === 'number' ? 'category' : 'default', tier: tier?.name ?? null };
}

export function computeCommission(order: CommissionOrder, rules: CommissionRules, creator: CreatorTerms): CommissionResult {
  const reasons: string[] = [];
  const capped: string[] = [];
  const before = netGoodsBase(order);
  const f = refundFraction(order.refunded, order.total);
  const netBase = Math.round(before * (1 - f));
  const empty = (reason: string): CommissionResult => ({ netBase, netBaseBeforeRefund: before, commission: 0, rateSource: 'default', tier: null, lines: [], capped, reasons: [...reasons, reason] });

  const min = rules.minOrderNet[order.currency as 'USD'] ?? 0;
  if (before < min) return empty('below_minimum_order');
  if (netBase <= 0) return empty(f >= 1 ? 'fully_refunded' : 'no_net_base');
  const gross = order.lines.reduce((a, l) => a + Math.max(0, l.gross), 0);
  if (gross <= 0 || order.lines.length === 0) return empty('no_lines');

  // allocate the net base to lines pro rata (remainder to the last line so lines sum exactly to the base)
  let allocated = 0;
  const lines: CommissionLineResult[] = [];
  let source: CommissionResult['rateSource'] = 'default';
  let tier: string | null = null;
  order.lines.forEach((l, i) => {
    const net = i === order.lines.length - 1 ? netBase - allocated : Math.round((netBase * Math.max(0, l.gross)) / gross);
    allocated += net;
    const r = rateFor(l.category, rules, creator);
    if (r.source === 'creator_override') source = 'creator_override';
    else if (r.source === 'category' && source === 'default') source = 'category';
    tier = r.tier ?? tier;
    lines.push({ category: l.category, net, rate: r.rate, commission: Math.round(net * r.rate) });
  });
  let commission = lines.reduce((a, l) => a + l.commission, 0);

  const orderCap = rules.maxPerOrder[order.currency as 'USD'] ?? 0;
  if (orderCap > 0 && commission > orderCap) { commission = orderCap; capped.push('max_per_order'); }

  if (order.knownCosts === null) {
    reasons.push('contribution_unknown');
  } else {
    const revenueExTax = Math.round(Math.max(0, order.total - order.tax) * (1 - f));
    const costsAfterRefund = Math.round(order.knownCosts * (1 - f));
    const contribution = revenueExTax - costsAfterRefund;
    const share = Math.max(0, Math.floor(contribution * rules.maxShareOfContribution));
    if (commission > share) { commission = share; capped.push('contribution_share'); }
    if (contribution <= 0) reasons.push('no_contribution');
  }
  // never more than 50% of the net base, whatever the rules say
  const hard = Math.floor(netBase * 0.5);
  if (commission > hard) { commission = hard; capped.push('hard_cap'); }
  return { netBase, netBaseBeforeRefund: before, commission: Math.max(0, commission), rateSource: source, tier, lines, capped, reasons };
}

/* ------------------------------ hold / clawback ------------------------------ */
export const DAY_MS = 86_400_000;

/** Commission becomes payable at: delivery + return window + buffer (+ escalation for high-refund creators). */
export function holdUntil(deliveredAt: Date, returnWindowDays: number, rules: CommissionRules, escalated: boolean): Date {
  const days = Math.max(0, returnWindowDays) + rules.holdBufferDays + (escalated ? rules.escalatedHoldDays : 0);
  return new Date(deliveredAt.getTime() + days * DAY_MS);
}
export const shouldEscalateHold = (refundedOrders: number, orders: number, rules: CommissionRules, minSample = 8): boolean => orders >= minSample && refundedOrders / orders > rules.refundRateHold;

/**
 * Given the freshly computed target commission and what the ledger already holds for the order
 * (sum of commission + clawback rows that are not reversed), return the delta to book.
 * Before the entry is payable the delta is applied in place; afterwards a negative delta becomes a clawback row.
 */
export const reconcileDelta = (target: number, ledgerSum: number): number => Math.max(0, target) - ledgerSum;

/** Only entries past their hold and with no open review flag become payable. */
export const isReleasable = (e: { status: string; holdUntil?: Date | null }, now: Date, held: boolean): boolean =>
  e.status === 'accrued' && !held && !!e.holdUntil && e.holdUntil.getTime() <= now.getTime();
