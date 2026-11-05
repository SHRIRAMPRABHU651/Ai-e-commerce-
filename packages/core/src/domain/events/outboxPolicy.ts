/** Outbox retry / dead-letter / expiry decisions (pure, deterministic given `rand`). */
import type { MarketingProviderKey } from '@orvia/types';

export const OUTBOX_MAX_ATTEMPTS = 8;
const BASE_MS = 30_000;
const CAP_MS = 6 * 3_600_000;
const HOUR = 3_600_000;

/** Delay before attempt number `attempt + 1`, where `attempt` failures have happened (1-based): 30s, 1m, 2m, … capped at 6h, ±25% jitter. */
export function retryDelayMs(failedAttempts: number, rand = 0.5): number {
  const raw = Math.min(CAP_MS, BASE_MS * 2 ** Math.max(0, failedAttempts - 1));
  return Math.round(raw * (0.75 + 0.5 * rand));
}

export type FailureDecision = { status: 'pending'; nextAttemptAt: Date } | { status: 'dead' };

/** After a failed delivery: retry with backoff while the error is retryable and attempts remain, otherwise dead-letter. */
export function decideAfterFailure(o: { failedAttempts: number; retryable: boolean; now: Date; rand?: number; maxAttempts?: number }): FailureDecision {
  if (!o.retryable || o.failedAttempts >= (o.maxAttempts ?? OUTBOX_MAX_ATTEMPTS)) return { status: 'dead' };
  return { status: 'pending', nextAttemptAt: new Date(o.now.getTime() + retryDelayMs(o.failedAttempts, o.rand)) };
}

/** Platforms reject events older than this; sending them would only burn retries. */
const MAX_AGE_MS: Record<MarketingProviderKey, number> = {
  meta: 7 * 24 * HOUR, // Conversions API: event_time within 7 days
  tiktok: 7 * 24 * HOUR,
  ga4: 72 * HOUR, // Measurement Protocol: timestamp_micros up to 72h in the past
  google_ads: 90 * 24 * HOUR, // conversion window; the conversion action's own window may be shorter
};
export const maxEventAgeMs = (p: MarketingProviderKey): number => MAX_AGE_MS[p];
export const isExpiredForProvider = (p: MarketingProviderKey, occurredAt: Date, now: Date): boolean => now.getTime() - occurredAt.getTime() > MAX_AGE_MS[p];

/** A stuck `sending` row (worker crashed) becomes claimable again after this lock. */
export const OUTBOX_LOCK_MS = 2 * 60_000;
