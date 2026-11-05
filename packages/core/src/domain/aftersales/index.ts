import type { Ctx } from '../../infra/context';
import type { ScheduleDef } from '../../infra/queue';
import { checkChargebackDeadlines } from './chargebacks';
import { reconcileWithProvider } from './paymentOps';
import { syncReturnRefunds } from './service';

export * from './policy';
export * from './eligibility';
export * from './refundMath';
export * from './refundTimeline';
export * from './stateMachines';
export * from './evidence';
export * from './labels';
export * from './webhookRules';
export * from './webhookClaim';
export * from './chargebackRules';
export * from './chargebacks';
export * from './paymentOps';
export * from './refundEvents';
export * from './service';
export * from './claims';

const HOUR = 3_600_000;

/** Register this workstream's job handlers (called from registerJobs). */
export function register_aftersales_Jobs(ctx: Ctx): void {
  ctx.queue.register('aftersales_chargeback_deadlines', () => checkChargebackDeadlines(ctx));
  ctx.queue.register('aftersales_provider_reconciliation', () => reconcileWithProvider(ctx));
  ctx.queue.register('aftersales_refund_sync', () => syncReturnRefunds(ctx));
}

/** Default schedules contributed by this workstream (merged into DEFAULT_SCHEDULES). */
export const AFTERSALES_SCHEDULES: (ScheduleDef & { risk: 'low' | 'medium' | 'high' })[] = [
  { name: 'aftersales_chargeback_deadlines', everyMs: HOUR, job: 'aftersales_chargeback_deadlines', description: 'Escalate chargebacks whose evidence deadline is near or passed', risk: 'low' },
  { name: 'aftersales_provider_reconciliation', everyMs: 6 * HOUR, job: 'aftersales_provider_reconciliation', description: 'Compare recent payments with the payment provider (read-only) and flag discrepancies', risk: 'medium' },
  { name: 'aftersales_refund_sync', everyMs: 15 * 60_000, job: 'aftersales_refund_sync', description: 'Complete returns whose pending refund was approved or finished', risk: 'low' },
];
