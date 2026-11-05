import type { Ctx } from '../../infra/context';
import type { ScheduleDef } from '../../infra/queue';
import { recomputeTrust } from './service';

export * from './stats';
export * from './scoring';
export * from './aggregate';
export * from './delivery';
export * from './guard';
export * from './fairDeal';
export * from './checklist';
export * from './passport';
export * from './service';
export * from './customer';

/** Register this workstream's job handlers (called from registerJobs). */
export function register_trust_Jobs(ctx: Ctx): void {
  // Scheduled and on-demand recompute: scores move automatically as shipments, returns, refunds and reviews accumulate.
  ctx.queue.register('trust_recompute', async (p: { scope?: 'all' | 'suppliers' | 'products'; supplierId?: string; productId?: string } | undefined) => recomputeTrust(ctx, p ?? {}, p?.supplierId || p?.productId ? 'on_demand' : 'schedule', undefined));
}

/** Default schedules contributed by this workstream (merged into DEFAULT_SCHEDULES). */
export const TRUST_SCHEDULES: (ScheduleDef & { risk: 'low' | 'medium' | 'high' })[] = [
  { name: 'trust_recompute', everyMs: 6 * 3_600_000, job: 'trust_recompute', payload: { scope: 'all' }, description: 'Recompute TrustGraph supplier reliability and product risk snapshots from real shipments, returns, refunds and reviews', risk: 'low' },
];
