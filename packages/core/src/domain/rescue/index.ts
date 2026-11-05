import type { Ctx } from '../../infra/context';
import type { ScheduleDef } from '../../infra/queue';
import { runAction, runRescueScan } from './service';

export * from './classifier';
export * from './options';
export * from './policy';
export * from './ranker';
export * from './consent';
export * from './guard';
export * from './retry';
export * from './messages';
export { getRescuePolicy, updateRescuePolicy } from './store';
export { RescueError, runRescueScan, recoveryView, decideConsent, staffDecide, rescueKpis, listCases, caseDetail, planAndAdvance, runAction, runDueActions } from './service';

/** Register this workstream's job handlers (called from registerJobs). */
export function register_rescue_Jobs(ctx: Ctx): void {
  ctx.queue.register('rescue_scan', () => runRescueScan(ctx));
  ctx.queue.register('rescue_run_action', async (p: { actionId: string }) => ({ outcome: await runAction(ctx, p.actionId) }));
}

/** Default schedules contributed by this workstream (merged into DEFAULT_SCHEDULES). */
export const RESCUE_SCHEDULES: (ScheduleDef & { risk: 'low' | 'medium' | 'high' })[] = [
  { name: 'rescue_scan', everyMs: 10 * 60_000, job: 'rescue_scan', description: 'Delivery Rescue: detect failing deliveries, plan recovery, run due recovery actions (bounded, deduped per order line)', risk: 'high' },
];
