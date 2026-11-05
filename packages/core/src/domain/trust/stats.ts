/**
 * Small-sample statistics for TrustGraph. Pure functions, no IO.
 *
 * Every rate is shrunk toward a documented prior (Beta-Binomial posterior mean) so a supplier with 2 perfect
 * orders never looks better than one with 200 good ones. `confidence` is the weight the data carries in the
 * posterior: n / (n + k), where k is the prior strength (pseudo-observations).
 */
import type { TrustStatus } from '@orvia/types';

/** Thresholds, documented in docs/ORVIA_TRUSTGRAPH.md. */
export const TRUST_THRESHOLDS = {
  /** Below this many resolved shipments no numeric score is shown. */
  minProvisional: 5,
  /** At or above this many (and confidence >= minEstablishedConfidence) the score is "established". */
  minEstablished: 30,
  minEstablishedConfidence: 0.55,
  /** Offer data older than this (hours) counts as stale for the established gate. */
  staleAfterHours: 24 * 14,
} as const;

/** Prior strength k (pseudo-observations) used for all rate components. */
export const PRIOR_STRENGTH = 10;

/** Documented neutral priors per component: what we assume about an unknown supplier before evidence. */
export const COMPONENT_PRIORS = {
  fulfilment_success: 0.9,
  on_time_delivery: 0.75,
  cancellation: 0.95,
  stock_accuracy: 0.9,
  defect: 0.95,
  return: 0.9,
  refund_response: 0.7,
  satisfaction: 0.75,
  dispute: 0.97,
} as const;

export const clamp = (x: number, lo = 0, hi = 1): number => Math.min(hi, Math.max(lo, x));

/** Beta-Binomial posterior mean with a prior of mean `priorMean` and strength `k`. Monotone in successes and n. */
export function shrunkRate(successes: number, n: number, priorMean: number, k = PRIOR_STRENGTH): number {
  const nn = Math.max(0, n);
  const s = clamp(successes, 0, nn);
  return clamp((s + priorMean * k) / (nn + k));
}

/** Weight the data carries versus the prior: 0 with no data, approaching 1 as n grows. */
export function dataConfidence(n: number, k = PRIOR_STRENGTH): number {
  const nn = Math.max(0, n);
  return nn / (nn + k);
}

/** Wilson score interval lower bound (z = 1.645, ~95% one-sided). 0 for n = 0. */
export function wilsonLower(successes: number, n: number, z = 1.645): number {
  if (n <= 0) return 0;
  const p = clamp(successes / n);
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return clamp((centre - margin) / (1 + z2 / n));
}

export function wilsonUpper(successes: number, n: number, z = 1.645): number {
  if (n <= 0) return 1;
  const p = clamp(successes / n);
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return clamp((centre + margin) / (1 + z2 / n));
}

/** Exponential freshness: 1 now, 0.5 after one half-life, hard 0 after `expiresAt`. */
export function freshness(observedAt: Date | string | null | undefined, now: Date, halfLifeHours: number, expiresAt?: Date | string | null): number {
  if (!observedAt) return 0;
  if (expiresAt && new Date(expiresAt).getTime() <= now.getTime()) return 0;
  const ageH = Math.max(0, (now.getTime() - new Date(observedAt).getTime()) / 3_600_000);
  return clamp(Math.pow(0.5, ageH / Math.max(1, halfLifeHours)));
}

/**
 * Status gate. `sampleSize` is the number of resolved observations (e.g. resolved shipments).
 * Never returns `established` with fewer than `minEstablished` observations or low confidence.
 */
export function statusFor(sampleSize: number, confidence: number, opts: { stale?: boolean; min?: number } = {}): TrustStatus {
  const minProv = opts.min ?? TRUST_THRESHOLDS.minProvisional;
  if (sampleSize < minProv) return 'insufficient_data';
  if (sampleSize >= TRUST_THRESHOLDS.minEstablished && confidence >= TRUST_THRESHOLDS.minEstablishedConfidence && !opts.stale) return 'established';
  return 'provisional';
}

/** Approximate 90% interval around a shrunk score (0..100), using effective sample n + k. */
export function scoreRange(score: number, sampleSize: number, k = PRIOR_STRENGTH): { low: number; high: number } {
  const s = clamp(score / 100);
  const half = 1.645 * Math.sqrt((s * (1 - s)) / (Math.max(0, sampleSize) + k)) * 100;
  const h = Math.max(half, 2);
  return { low: Math.round(clamp(score - h, 0, 100)), high: Math.round(clamp(score + h, 0, 100)) };
}

/** Linear-interpolated quantile of a numeric sample (q in 0..1). undefined for empty input. */
export function quantile(values: number[], q: number): number | undefined {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return undefined;
  const pos = clamp(q) * (v.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return v[lo]! + (v[hi]! - v[lo]!) * (pos - lo);
}

export const round1 = (x: number): number => Math.round(x * 10) / 10;
export const round3 = (x: number): number => Math.round(x * 1000) / 1000;
