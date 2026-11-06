/** Experiment bucketing and statistics (pure). Never decides to ship anything: it only reports. */
import { createHash } from 'node:crypto';

export interface VariantDef { key: string; weight: number }

/** Deterministic: the same (experimentKey, visitorId) always lands in the same variant; uniform over the weights. */
export function bucketUnit(experimentKey: string, visitorId: string): number {
  const h = createHash('sha256').update(`${experimentKey}:${visitorId}`).digest();
  return h.readUInt32BE(0) / 0x1_0000_0000;
}

export function assignVariant(experimentKey: string, visitorId: string, variants: VariantDef[]): string {
  const total = variants.reduce((a, v) => a + v.weight, 0);
  const u = bucketUnit(experimentKey, visitorId) * total;
  let acc = 0;
  for (const v of variants) {
    acc += v.weight;
    if (u < acc) return v.key;
  }
  return variants[variants.length - 1]!.key;
}

/** Standard normal CDF (Abramowitz-Stegun via erfc, |error| < 1.2e-7). */
export function normalCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.5 * z);
  const erfc = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? 1 - 0.5 * erfc : 0.5 * erfc;
}

export interface TwoPropResult { p1: number; p2: number; diff: number; z: number; pValue: number; ciLow: number; ciHigh: number }

/** Pooled two-proportion z-test (two-sided) plus an unpooled 95% Wald CI for the difference p2 - p1. */
export function twoProportionTest(x1: number, n1: number, x2: number, n2: number): TwoPropResult | null {
  if (n1 <= 0 || n2 <= 0) return null;
  const p1 = x1 / n1, p2 = x2 / n2, pool = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pool * (1 - pool) * (1 / n1 + 1 / n2));
  const z = se === 0 ? 0 : (p2 - p1) / se;
  const seU = Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2);
  return { p1, p2, diff: p2 - p1, z, pValue: se === 0 ? 1 : 2 * (1 - normalCdf(Math.abs(z))), ciLow: p2 - p1 - 1.96 * seU, ciHigh: p2 - p1 + 1.96 * seU };
}

export interface VariantStat { key: string; exposures: number; conversions: number }
export type ExperimentVerdict = 'not_enough_data' | 'no_clear_difference' | 'likely_better' | 'likely_worse' | 'control';

export interface VariantAssessment extends VariantStat { rate: number | null; verdict: ExperimentVerdict; pValue?: number; diff?: number; ciLow?: number; ciHigh?: number; summary: string }

export const MIN_EXPOSURES_PER_VARIANT = 200;
export const MIN_TOTAL_CONVERSIONS = 30;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/** Compares each variant to the first (control). Bonferroni-adjusted alpha 0.05 across the comparisons. */
export function assessExperiment(stats: VariantStat[]): { variants: VariantAssessment[]; overall: string } {
  const control = stats[0];
  if (!control) return { variants: [], overall: 'No variants.' };
  const totalConv = stats.reduce((a, s) => a + s.conversions, 0);
  const enough = stats.every((s) => s.exposures >= MIN_EXPOSURES_PER_VARIANT) && totalConv >= MIN_TOTAL_CONVERSIONS;
  const alpha = 0.05 / Math.max(1, stats.length - 1);
  const variants = stats.map((s, i): VariantAssessment => {
    const rate = s.exposures ? s.conversions / s.exposures : null;
    if (i === 0) return { ...s, rate, verdict: 'control', summary: 'Control (baseline).' };
    if (!enough) return { ...s, rate, verdict: 'not_enough_data', summary: `Not enough data yet: need at least ${MIN_EXPOSURES_PER_VARIANT} visitors per variant and ${MIN_TOTAL_CONVERSIONS} conversions in total.` };
    const t = twoProportionTest(control.conversions, control.exposures, s.conversions, s.exposures)!;
    const common = { ...s, rate, pValue: t.pValue, diff: t.diff, ciLow: t.ciLow, ciHigh: t.ciHigh };
    const compare = `${s.key} converts at ${pct(t.p2)} vs ${pct(t.p1)} for ${control.key} (difference ${t.diff >= 0 ? '+' : ''}${(t.diff * 100).toFixed(1)} points, 95% range ${(t.ciLow * 100).toFixed(1)} to ${(t.ciHigh * 100).toFixed(1)}; p = ${t.pValue.toFixed(3)}).`;
    if (t.pValue < alpha) return { ...common, verdict: t.diff > 0 ? 'likely_better' : 'likely_worse', summary: `${compare} The gap is unlikely to be chance, but this is evidence, not proof, and checking repeatedly while the test runs inflates false positives. A person decides.` };
    return { ...common, verdict: 'no_clear_difference', summary: `${compare} No clear difference.` };
  });
  return { variants, overall: enough ? 'Enough data for a read. Nothing is shipped automatically.' : 'Not enough data yet. Keep the test running; do not act on early differences.' };
}
