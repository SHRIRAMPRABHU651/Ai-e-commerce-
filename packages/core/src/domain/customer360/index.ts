import type { Ctx } from '../../infra/context';
import type { ScheduleDef } from '../../infra/queue';
import { customer360Sweep } from './service';

export * from './lifegraph';
export * from './consent';
export * from './privacy';
export * from './companion';
export * from './service';

/** Register this workstream's job handlers (called from registerJobs). */
export function register_customer360_Jobs(ctx: Ctx): void {
  ctx.queue.register('customer360_sweep', async () => customer360Sweep(ctx));
}

/** Default schedules contributed by this workstream (merged into DEFAULT_SCHEDULES). */
export const CUSTOMER360_SCHEDULES: (ScheduleDef & { risk: 'low' | 'medium' | 'high' })[] = [
  { name: 'customer360_sweep', everyMs: 6 * 60 * 60 * 1000, job: 'customer360_sweep', description: 'Delete expired Commerce Memory items; mark deletion requests past cooling-off as ready for staff review', risk: 'low' },
];
