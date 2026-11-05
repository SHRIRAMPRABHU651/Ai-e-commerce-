/** Pure webhook-idempotency and payment-state comparison rules. */

export interface WebhookRecord { outcome?: string | null; processedAt?: Date | null }
export type DedupeDecision = 'process' | 'duplicate' | 'retry_stale';

/**
 * Decides what to do with a webhook whose event id was seen before.
 * - no record: process.
 * - record with a final outcome: duplicate (never reprocess).
 * - record without an outcome that is older than `staleMs`: the previous attempt crashed after claiming the event id,
 *   so a provider retry must be processed again (all handlers are themselves idempotent).
 * - record without an outcome that is recent: another worker is processing it right now -> duplicate.
 */
export function decideWebhookDedupe(existing: WebhookRecord | null, now: Date, staleMs = 2 * 60_000): DedupeDecision {
  if (!existing) return 'process';
  if (existing.outcome) return 'duplicate';
  const at = existing.processedAt?.getTime() ?? 0;
  return now.getTime() - at >= staleMs ? 'retry_stale' : 'duplicate';
}

export interface LocalPaymentState { status: string; amount: number; currency: string }
export interface ProviderPaymentState { status: string; amount: number; currency: string }
export type PaymentDiscrepancy =
  | 'provider_succeeded_local_pending'
  | 'provider_failed_local_pending'
  | 'local_succeeded_provider_not_succeeded'
  | 'amount_mismatch'
  | 'currency_mismatch';

/** Compares our Payment row with the provider's view. Returns [] when consistent. `partially_refunded`/`refunded` count as succeeded. */
export function comparePaymentState(local: LocalPaymentState, provider: ProviderPaymentState): PaymentDiscrepancy[] {
  const out: PaymentDiscrepancy[] = [];
  const localPaid = ['succeeded', 'partially_refunded', 'refunded'].includes(local.status);
  if (provider.status === 'succeeded' && !localPaid) out.push('provider_succeeded_local_pending');
  if (provider.status === 'failed' && local.status === 'pending') out.push('provider_failed_local_pending');
  if (localPaid && provider.status !== 'succeeded') out.push('local_succeeded_provider_not_succeeded');
  if (provider.status === 'succeeded' && localPaid) {
    if (provider.amount < local.amount) out.push('amount_mismatch');
    if (provider.currency.toUpperCase() !== local.currency.toUpperCase()) out.push('currency_mismatch');
  }
  return out;
}
