/** Honest delivery estimate bands derived from observed delivery history (pure). */
import type { DeliveryBand } from '@orvia/types';
import { dataConfidence, quantile, round3, wilsonLower } from './stats';

export const MIN_DELIVERY_SAMPLE = 5;

export interface PromisedWindow { minDays: number; maxDays: number }

/** Calendar days between two instants, never negative. */
export const daysBetween = (from: Date, to: Date): number => Math.max(0, (to.getTime() - from.getTime()) / 86_400_000);

/**
 * Build a delivery band.
 *  - >= MIN_DELIVERY_SAMPLE observed deliveries: p10..p90 of observed order-to-delivery days, with the upper
 *    end widened by (1 + 1/sqrt(n)) because small samples under-represent the tail.
 *  - otherwise: the supplier's promised window, widened (max * 1.5 + 2 days) and labelled unconfirmed.
 *  - no history and no promise: no numbers at all.
 * It is never a guarantee, and says so.
 */
export function deliveryBand(args: { observedDays: number[]; promised: PromisedWindow | null }): DeliveryBand {
  const obs = args.observedDays.filter((d) => Number.isFinite(d) && d >= 0);
  const n = obs.length;
  const p = args.promised;
  if (n >= MIN_DELIVERY_SAMPLE) {
    const lo = Math.max(0, Math.floor(quantile(obs, 0.1) ?? 0));
    const hi = Math.ceil((quantile(obs, 0.9) ?? 0) * (1 + 1 / Math.sqrt(n)));
    const max = Math.max(hi, lo + 1);
    const withinPromise = p ? obs.filter((d) => d <= p.maxDays + 1).length : null;
    const onTimeRateLow = p && withinPromise !== null ? round3(wilsonLower(withinPromise, n)) : null;
    return {
      minDays: lo, maxDays: max, basis: 'observed', sampleSize: n, onTimeRateLow, confidence: round3(dataConfidence(n)),
      statement: `Based on ${n} comparable delivered order${n === 1 ? '' : 's'}, most arrived in ${lo}-${max} days.${onTimeRateLow !== null && p ? ` At least ${Math.round(onTimeRateLow * 100)}% arrived within the supplier's ${p.maxDays}-day estimate (conservative bound).` : ''} This is a range from past deliveries, not a guarantee.`,
    };
  }
  if (p) {
    const max = Math.ceil(p.maxDays * 1.5) + 2;
    return {
      minDays: p.minDays, maxDays: max, basis: 'promised_only', sampleSize: n, onTimeRateLow: null, confidence: round3(dataConfidence(n) * 0.5),
      statement: `${n === 0 ? 'No delivery history yet for this product.' : `Only ${n} delivered order${n === 1 ? '' : 's'} so far.`} The supplier estimates ${p.minDays}-${p.maxDays} days; we show ${p.minDays}-${max} days because that estimate is not yet confirmed by real deliveries. This is not a guarantee.`,
    };
  }
  return { minDays: null, maxDays: null, basis: 'promised_only', sampleSize: n, onTimeRateLow: null, confidence: 0, statement: 'No delivery estimate is available yet: there is no delivery history and no supplier estimate for this destination.' };
}
