/**
 * Webhook idempotency claim. The event id is claimed with a unique insert; the claim is finalised by writing an
 * `outcome`. A claim that was never finalised (worker crashed mid-processing) becomes reclaimable after a grace
 * period so the provider's retry is processed instead of being dropped as a "duplicate".
 */
import { WebhookEvent } from '@orvia/database';
import type { Ctx } from '../../infra/context';
import { decideWebhookDedupe } from './webhookRules';

export type ClaimResult = 'process' | 'duplicate';

export async function claimWebhookEvent(ctx: Ctx, provider: string, evt: { id: string; type: string }, staleMs = 2 * 60_000): Promise<ClaimResult> {
  try {
    await WebhookEvent.create({ provider, eventId: evt.id, type: evt.type, processedAt: ctx.now() });
    return 'process';
  } catch (e) {
    if ((e as { code?: number }).code !== 11000) throw e;
  }
  const existing = await WebhookEvent.findOne({ provider, eventId: evt.id }).select('outcome processedAt').lean();
  const decision = decideWebhookDedupe(existing ? { outcome: existing.outcome, processedAt: existing.processedAt } : null, ctx.now(), staleMs);
  if (decision === 'process') return 'process';
  if (decision === 'duplicate') return 'duplicate';
  // retry_stale: take over atomically so two concurrent retries cannot both reprocess
  const taken = await WebhookEvent.findOneAndUpdate({ provider, eventId: evt.id, outcome: null, processedAt: existing?.processedAt }, { $set: { processedAt: ctx.now() } }, { new: true });
  if (taken) ctx.log.warn({ channel: 'payment', provider, eventId: evt.id }, 'reprocessing webhook whose previous attempt never completed');
  return taken ? 'process' : 'duplicate';
}

export async function finalizeWebhookEvent(provider: string, eventId: string, outcome: string): Promise<void> {
  await WebhookEvent.updateOne({ provider, eventId }, { $set: { outcome } });
}
