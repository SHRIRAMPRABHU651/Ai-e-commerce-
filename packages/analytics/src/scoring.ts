import { clamp } from './economics';

export interface OpportunityComponents {
  demand: number;
  trendVelocity: number;
  /** Higher = more favourable (less saturated). */
  competition: number;
  supplierCost: number;
  shipping: number;
  profitMargin: number;
  videoPotential: number;
  repeatPurchase: number;
  supplierReliability: number;
  compliance: number;
}

export const OPPORTUNITY_WEIGHTS: Record<keyof OpportunityComponents, number> = {
  demand: 0.16,
  trendVelocity: 0.12,
  competition: 0.08,
  supplierCost: 0.1,
  shipping: 0.08,
  profitMargin: 0.16,
  videoPotential: 0.08,
  repeatPurchase: 0.04,
  supplierReliability: 0.08,
  compliance: 0.1,
};

export type OpportunityAction = 'TEST' | 'WATCH' | 'REJECT';

export interface OpportunityScore {
  components: OpportunityComponents;
  finalScore: number;
  action: OpportunityAction;
  reasons: string[];
}

export function scoreOpportunity(c: OpportunityComponents, thresholds = { test: 75, watch: 60 }): OpportunityScore {
  const clean = Object.fromEntries(
    Object.entries(c).map(([k, v]) => [k, clamp(Number.isFinite(v) ? v : 0, 0, 100)]),
  ) as unknown as OpportunityComponents;
  let total = 0;
  for (const k of Object.keys(OPPORTUNITY_WEIGHTS) as (keyof OpportunityComponents)[]) {
    total += clean[k] * OPPORTUNITY_WEIGHTS[k];
  }
  const finalScore = Math.round(total * 10) / 10;
  const reasons: string[] = [];
  let action: OpportunityAction = finalScore >= thresholds.test ? 'TEST' : finalScore >= thresholds.watch ? 'WATCH' : 'REJECT';
  if (clean.compliance < 50) {
    action = 'REJECT';
    reasons.push('Compliance score below 50 — hard reject');
  }
  if (clean.profitMargin < 30 && action === 'TEST') {
    action = 'WATCH';
    reasons.push('Margin score too low to start a paid test');
  }
  if (clean.supplierReliability < 50 && action === 'TEST') {
    action = 'WATCH';
    reasons.push('Supplier reliability too low to test');
  }
  const best = (Object.entries(clean) as [string, number][]).sort((a, b) => b[1] - a[1]).slice(0, 2);
  const worst = (Object.entries(clean) as [string, number][]).sort((a, b) => a[1] - b[1])[0];
  reasons.push(`Strongest: ${best.map(([k, v]) => `${k} ${v}`).join(', ')}`);
  if (worst) reasons.push(`Weakest: ${worst[0]} ${worst[1]}`);
  return { components: clean, finalScore, action, reasons };
}
