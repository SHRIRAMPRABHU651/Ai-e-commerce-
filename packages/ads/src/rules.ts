/**
 * Configurable ad budget rules. Pure functions: no I/O, fully unit-tested.
 * Default is SAFE MODE: scaling is stepwise and capped, and global daily/monthly limits always win.
 */
export interface AdRulesConfig {
  safeMode: boolean;
  /** Minimum sample before any data-driven judgement (below this we MAINTAIN, never kill). */
  minImpressions: number;
  minClicks: number;
  /** Pause if spend >= this and zero purchases (and clicks >= minClicks). */
  pauseNoPurchaseSpend: number;
  targetCpa: number;
  cpaReduceFactor: number;
  targetRoas: number;
  scaleStep: number;
  maxDailyBudget: number;
  minDailyBudget: number;
  maxRefundRate: number;
  /** Negative contribution profit only triggers a pause after this much spend. */
  negativeProfitMinSpend: number;
  dailyLimit: number;
  monthlyLimit: number;
}

export const DEFAULT_AD_RULES: AdRulesConfig = {
  safeMode: true,
  minImpressions: 1500,
  minClicks: 30,
  pauseNoPurchaseSpend: 3000,
  targetCpa: 1500,
  cpaReduceFactor: 0.7,
  targetRoas: 2.5,
  scaleStep: 0.2,
  maxDailyBudget: 5000,
  minDailyBudget: 500,
  maxRefundRate: 0.12,
  negativeProfitMinSpend: 2000,
  dailyLimit: 20_000,
  monthlyLimit: 400_000,
};

export interface CampaignWindow {
  impressions: number;
  clicks: number;
  spend: number;
  purchases: number;
  revenue: number;
  /** Contribution profit INCLUDING ad spend, computed by the caller from real order costs. */
  profit: number;
  refundRate: number;
}

export interface Headroom {
  dailyRemaining: number;
  monthlyRemaining: number;
}

export type AdAction = 'SCALE' | 'MAINTAIN' | 'REDUCE' | 'PAUSE';

export interface AdDecision {
  action: AdAction;
  newDailyBudget: number;
  reasons: string[];
  sufficientData: boolean;
  metrics: { cpa: number | null; roas: number | null; ctr: number | null };
}

export function evaluateCampaign(
  w: CampaignWindow,
  currentDailyBudget: number,
  cfg: AdRulesConfig,
  headroom: Headroom,
): AdDecision {
  const cpa = w.purchases > 0 ? w.spend / w.purchases : null;
  const roas = w.spend > 0 ? w.revenue / w.spend : null;
  const ctr = w.impressions > 0 ? w.clicks / w.impressions : null;
  const metrics = { cpa, roas, ctr };
  const reasons: string[] = [];
  const sample = w.impressions >= cfg.minImpressions && w.clicks >= cfg.minClicks;
  const hold = (r: string): AdDecision => ({ action: 'MAINTAIN', newDailyBudget: currentDailyBudget, reasons: [...reasons, r], sufficientData: sample, metrics });

  // 1. Hard spend limits always win.
  if (headroom.monthlyRemaining <= 0) return { action: 'PAUSE', newDailyBudget: currentDailyBudget, reasons: ['Monthly spend limit reached'], sufficientData: sample, metrics };
  if (headroom.dailyRemaining <= 0) return { action: 'PAUSE', newDailyBudget: currentDailyBudget, reasons: ['Daily spend limit reached'], sufficientData: sample, metrics };

  // 2. Spend with zero purchases.
  if (w.spend >= cfg.pauseNoPurchaseSpend && w.purchases === 0 && w.clicks >= cfg.minClicks) {
    return { action: 'PAUSE', newDailyBudget: currentDailyBudget, reasons: [`Spent ${w.spend} with ${w.clicks} clicks and 0 purchases`], sufficientData: true, metrics };
  }
  if (!sample && w.spend < cfg.pauseNoPurchaseSpend) return hold('Insufficient sample size — keep gathering data');

  // 3. Negative contribution profit.
  if (w.spend >= cfg.negativeProfitMinSpend && w.profit < 0) {
    return { action: 'PAUSE', newDailyBudget: currentDailyBudget, reasons: ['Contribution profit is negative after ad spend'], sufficientData: true, metrics };
  }

  // 4. Refund rate.
  if (w.refundRate > cfg.maxRefundRate * 2) {
    return { action: 'PAUSE', newDailyBudget: currentDailyBudget, reasons: [`Refund rate ${(w.refundRate * 100).toFixed(1)}% is more than 2× the limit`], sufficientData: true, metrics };
  }
  if (w.refundRate > cfg.maxRefundRate) {
    return {
      action: 'REDUCE',
      newDailyBudget: Math.max(cfg.minDailyBudget, Math.round(currentDailyBudget * cfg.cpaReduceFactor)),
      reasons: [`Refund rate ${(w.refundRate * 100).toFixed(1)}% above ${(cfg.maxRefundRate * 100).toFixed(0)}%`],
      sufficientData: true,
      metrics,
    };
  }

  // 5. CPA above target.
  if (cpa !== null && cpa > cfg.targetCpa) {
    const nb = Math.max(cfg.minDailyBudget, Math.round(currentDailyBudget * cfg.cpaReduceFactor));
    return { action: nb < currentDailyBudget ? 'REDUCE' : 'MAINTAIN', newDailyBudget: nb, reasons: [`CPA ${Math.round(cpa)} above target ${cfg.targetCpa}`], sufficientData: true, metrics };
  }

  // 6. ROAS above target and profitable -> scale within caps.
  if (roas !== null && roas >= cfg.targetRoas && w.profit > 0 && w.purchases >= 3) {
    const step = cfg.safeMode ? Math.min(cfg.scaleStep, 0.2) : cfg.scaleStep;
    const wanted = Math.round(currentDailyBudget * (1 + step));
    const cap = Math.min(cfg.maxDailyBudget, currentDailyBudget + headroom.dailyRemaining, headroom.monthlyRemaining);
    const nb = Math.max(currentDailyBudget, Math.min(wanted, cap));
    if (nb > currentDailyBudget) return { action: 'SCALE', newDailyBudget: nb, reasons: [`ROAS ${roas.toFixed(2)} ≥ target ${cfg.targetRoas} and profitable`], sufficientData: true, metrics };
    return hold('Profitable but already at the spending cap');
  }
  return hold('Within target ranges');
}

/** Scale budgets down proportionally so the total never exceeds the daily limit / remaining month. */
export function enforceSpendCaps(
  budgets: { id: string; dailyBudget: number }[],
  o: { dailyLimit: number; monthlyLimit: number; monthSpentSoFar: number; daysLeftInMonth: number },
): { id: string; dailyBudget: number }[] {
  const monthlyRemaining = Math.max(0, o.monthlyLimit - o.monthSpentSoFar);
  const monthlyDaily = o.daysLeftInMonth > 0 ? monthlyRemaining / o.daysLeftInMonth : 0;
  const cap = Math.max(0, Math.min(o.dailyLimit, monthlyDaily));
  const total = budgets.reduce((a, b) => a + b.dailyBudget, 0);
  if (total <= cap || total === 0) return budgets;
  const f = cap / total;
  return budgets.map((b) => ({ id: b.id, dailyBudget: Math.floor(b.dailyBudget * f) }));
}

export interface TestCriteria {
  minImpressions: number;
  minClicks: number;
  minSpend: number;
  targetCpa: number;
  targetRoas: number;
}
export interface TestAggregate {
  impressions: number;
  clicks: number;
  spend: number;
  purchases: number;
  revenue: number;
  profit: number;
}
export type TestVerdict = 'WIN' | 'CONTINUE' | 'KILL';

/** Never kills a product on an insufficient sample. */
export function evaluateTest(a: TestAggregate, c: TestCriteria): { verdict: TestVerdict; reasons: string[] } {
  const sampleOk = a.impressions >= c.minImpressions && a.clicks >= c.minClicks && a.spend >= c.minSpend;
  if (!sampleOk) {
    return {
      verdict: 'CONTINUE',
      reasons: [`Sample too small (impressions ${a.impressions}/${c.minImpressions}, clicks ${a.clicks}/${c.minClicks}, spend ${a.spend}/${c.minSpend})`],
    };
  }
  const cpa = a.purchases > 0 ? a.spend / a.purchases : Infinity;
  const roas = a.spend > 0 ? a.revenue / a.spend : 0;
  if (cpa <= c.targetCpa && roas >= c.targetRoas && a.profit > 0) {
    return { verdict: 'WIN', reasons: [`CPA ${Math.round(cpa)} ≤ ${c.targetCpa}, ROAS ${roas.toFixed(2)} ≥ ${c.targetRoas}, positive contribution`] };
  }
  if (a.purchases === 0 || a.profit < 0 || roas < c.targetRoas * 0.6) {
    return { verdict: 'KILL', reasons: [`Sample met but results are below criteria (ROAS ${roas.toFixed(2)}, profit ${a.profit}, purchases ${a.purchases})`] };
  }
  return { verdict: 'CONTINUE', reasons: [`Close to targets (ROAS ${roas.toFixed(2)}, CPA ${Number.isFinite(cpa) ? Math.round(cpa) : 'n/a'}); keep testing`] };
}

export interface CreativeStat {
  creativeId: string;
  impressions: number;
  clicks: number;
  spend: number;
  purchases: number;
  revenue: number;
}
export interface CreativeRank extends CreativeStat {
  ctr: number;
  cpc: number;
  cpm: number;
  roas: number;
  cpa: number | null;
  status: 'winner' | 'loser' | 'testing';
}

export function rankCreatives(stats: CreativeStat[], o: { minImpressions: number; minSpend: number; targetRoas: number }): CreativeRank[] {
  const ranked = stats
    .map((s) => ({
      ...s,
      ctr: s.impressions ? s.clicks / s.impressions : 0,
      cpc: s.clicks ? s.spend / s.clicks : 0,
      cpm: s.impressions ? (s.spend / s.impressions) * 1000 : 0,
      roas: s.spend ? s.revenue / s.spend : 0,
      cpa: s.purchases ? s.spend / s.purchases : null,
      status: 'testing' as 'winner' | 'loser' | 'testing',
    }))
    .sort((a, b) => b.roas - a.roas || b.ctr - a.ctr);
  const eligible = ranked.filter((r) => r.impressions >= o.minImpressions && r.spend >= o.minSpend);
  const top = eligible[0];
  for (const r of eligible) {
    if (r === top && r.roas >= o.targetRoas) r.status = 'winner';
    else if (r.roas < o.targetRoas * 0.5) r.status = 'loser';
  }
  return ranked;
}
