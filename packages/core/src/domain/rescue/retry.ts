/** Deterministic retry schedule for rescue actions (no jitter so it is testable; the queue adds its own spread). */
export function retryDelayMs(attempt: number, baseMs = 60_000, capMs = 3_600_000): number {
  const a = Math.max(1, Math.floor(attempt));
  return Math.min(capMs, baseMs * 2 ** (a - 1));
}

export type RetryDecision = { retry: true; delayMs: number } | { retry: false; reason: 'attempts_exhausted' | 'non_retryable' };

export function decideRetry(attemptsMade: number, maxAttempts: number, retryable: boolean): RetryDecision {
  if (!retryable) return { retry: false, reason: 'non_retryable' };
  if (attemptsMade >= maxAttempts) return { retry: false, reason: 'attempts_exhausted' };
  return { retry: true, delayMs: retryDelayMs(attemptsMade) };
}
