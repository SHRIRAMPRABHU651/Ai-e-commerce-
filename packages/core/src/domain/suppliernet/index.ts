import { Supplier } from '@orvia/database';
import type { Ctx } from '../../infra/context';
import type { ScheduleDef } from '../../infra/queue';
import { ensureFeedAdapter } from './adapters';
import { ingestSupplierCatalog } from './catalog';
import { runSlaJob } from './ops';
import { runVerificationSweep } from './service';

export * from './gating';
export * from './matching';
export * from './sla';
export * from './reconcile';
export * from './tenant';
export * from './redact';
export * from './adapters';
export * from './service';
export * from './catalog';
export * from './ops';
export * from './portal';

const HOUR = 3_600_000;

/** Register this workstream's job handlers (called from registerJobs). */
export function register_suppliernet_Jobs(ctx: Ctx): void {
  ensureFeedAdapter(ctx);
  ctx.queue.register('suppliernet_sla', () => runSlaJob(ctx));
  ctx.queue.register('suppliernet_verification_sweep', () => runVerificationSweep(ctx));
  ctx.queue.register('suppliernet_feed_refresh', async () => {
    const feeds = await Supplier.find({ provider: 'feed', active: true }).select('_id').limit(100).lean();
    let ok = 0, failed = 0;
    for (const f of feeds) {
      try { await ingestSupplierCatalog(ctx, String(f._id), { trigger: 'schedule', actor: { id: 'system', type: 'system' }, maxItems: 1000 }); ok++; } catch (e) { failed++; ctx.log.warn({ channel: 'supplier', err: (e as Error).message }, 'feed refresh failed'); }
    }
    return { ok, failed };
  });
}

/** Default schedules contributed by this workstream (merged into DEFAULT_SCHEDULES). */
export const SUPPLIERNET_SCHEDULES: (ScheduleDef & { risk: 'low' | 'medium' | 'high' })[] = [
  { name: 'suppliernet_sla', everyMs: 6 * HOUR, job: 'suppliernet_sla', description: 'Compute supplier SLA facts, flag breaches and demote suppliers with critical breaches', risk: 'medium' },
  { name: 'suppliernet_verification_sweep', everyMs: 24 * HOUR, job: 'suppliernet_verification_sweep', description: 'Lapse expired supplier verification and documents; raise re-verification tasks', risk: 'low' },
  { name: 'suppliernet_feed_refresh', everyMs: 6 * HOUR, job: 'suppliernet_feed_refresh', description: 'Re-ingest CSV/JSON feed suppliers (read-only catalogue, price, stock)', risk: 'low' },
];
