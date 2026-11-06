import type { Ctx } from '../../infra/context';
import type { ScheduleDef } from '../../infra/queue';
import { deliverOutbox, generateLifecycleEvents, generatePurchaseEvents, generateRefundEvents } from './pipeline';
import { dispatchCampaigns, sendCampaignEmail } from './marketingService';

export * from './hashing';
export * from './eventModel';
export * from './outboxPolicy';
export * from './providers';
export * from './pipeline';
export * from './segments';
export * from './tokens';
export * from './campaignRules';
export * from './experimentsMath';
export * from './attributionRules';
export * from './feeds';
export * from './marketingService';

/** Register this workstream's job handlers (called from registerJobs). */
export function register_events_Jobs(ctx: Ctx): void {
  const q = ctx.queue;
  q.register('events_generate', async () => ({ purchase: await generatePurchaseEvents(ctx), refund: await generateRefundEvents(ctx), lifecycle: await generateLifecycleEvents(ctx) }));
  q.register('events_deliver', () => deliverOutbox(ctx));
  q.register('events_campaign_dispatch', () => dispatchCampaigns(ctx));
  q.register('events_campaign_send', (p: { campaignId: string; email: string }) => sendCampaignEmail(ctx, p));
}

const MIN = 60_000;
/** Default schedules contributed by this workstream (merged into DEFAULT_SCHEDULES). No schedule spends money or touches ad budgets. */
export const EVENTS_SCHEDULES: (ScheduleDef & { risk: 'low' | 'medium' | 'high' })[] = [
  { name: 'events_generate', everyMs: 5 * MIN, job: 'events_generate', description: 'Create conversion events from paid/refunded orders (cursor + idempotency keys)', risk: 'low' },
  { name: 'events_deliver', everyMs: MIN, job: 'events_deliver', description: 'Deliver the conversion-event outbox with retry/backoff/dead-letter', risk: 'low' },
  { name: 'events_campaign_dispatch', everyMs: 5 * MIN, job: 'events_campaign_dispatch', description: 'Start due scheduled email campaigns (consent-filtered) and close finished ones', risk: 'medium' },
];
