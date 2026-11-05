/** Provider refund webhooks. A refund the provider reports as failed after we recorded success is never silent. */
import { Refund } from '@orvia/database';
import type { PaymentWebhookEvent } from '@orvia/payments';
import { audit } from '../../infra/audit';
import type { Ctx } from '../../infra/context';
import { raiseException } from '../exceptions';

export async function handleRefundEvent(ctx: Ctx, providerKey: string, evt: PaymentWebhookEvent): Promise<'processed' | 'ignored' | 'unknown_intent'> {
  if (evt.type !== 'refund.failed' || !evt.providerRefundId) return 'ignored';
  const refund = await Refund.findOne({ providerRefundId: evt.providerRefundId });
  if (!refund) return 'unknown_intent';
  if (refund.status === 'failed') return 'processed';
  const wasSucceeded = refund.status === 'succeeded';
  refund.status = 'failed';
  refund.failureReason = evt.failureReason ?? 'refund_failed';
  await refund.save();
  await audit(ctx, { id: 'webhook', type: 'webhook' }, { action: 'refund.provider_failed', resource: 'refund', resourceId: String(refund._id), reason: refund.failureReason ?? undefined, provider: providerKey });
  // Order/payment totals were already moved when we recorded success; a human must reconcile the money.
  await raiseException(ctx, {
    kind: 'PAYMENT_FAILURE', priority: 'critical',
    issue: `Provider reports refund ${evt.providerRefundId} FAILED${wasSucceeded ? ' after it was recorded as succeeded' : ''} (${refund.failureReason}). The customer has not been refunded.`,
    aiRecommendation: 'Re-issue the refund by another method or contact the customer.', suggestedAction: 'Investigate refund', actionCode: 'dismiss',
    details: { refundId: String(refund._id), orderId: String(refund.orderId) }, dedupeKey: `refund-failed:${refund._id}`,
  });
  return 'processed';
}
