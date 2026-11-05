import { SYSTEM } from '../../infra/context';
import type { Ctx } from '../../infra/context';
import type { ScheduleDef } from '../../infra/queue';
import { raiseException } from '../exceptions';
import { refreshFx } from './fxService';
import { backfillLedger, syncLedger } from './ledgerService';
import { costAlertReport, ledgerReconciliation } from './reportService';

export * from './fx';
export * from './fxProviders';
export * from './fxService';
export * from './ledger';
export * from './ledgerService';
export * from './contribution';
export * from './analytics';
export * from './scenario';
export * from './settings';
export * from './reportService';

/** Register this workstream's job handlers (called from registerJobs). */
export function register_finance_Jobs(ctx: Ctx): void {
  const q = ctx.queue;
  q.register('fx_refresh', async () => {
    if (ctx.cfg.FX_PROVIDER === 'static') return { skipped: 'static provider' };
    const s = await refreshFx(ctx);
    return { source: s.source, rates: s.rates };
  });
  q.register('ledger_sync', async () => {
    const total = { orders: 0, shipments: 0, refunds: 0, ads: 0, reversals: 0 };
    for (let i = 0; i < 10; i++) {
      const r = await syncLedger(ctx);
      for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += r[k];
      if (!r.more) break;
    }
    return total;
  });
  q.register('ledger_backfill', async () => backfillLedger(ctx, { actor: SYSTEM }));
  q.register('ledger_reconciliation', async () => {
    const r = await ledgerReconciliation(ctx, { sinceDays: 14 });
    for (const f of r.findings.filter((x) => x.severity !== 'medium')) {
      await raiseException(ctx, { kind: 'RECONCILIATION', priority: f.severity === 'critical' ? 'critical' : 'high', orderId: f.orderId, issue: `Ledger reconciliation: ${f.detail}`, aiRecommendation: 'Compare the ledger entry with the order and payment, then post a reversal or correct the source.', suggestedAction: 'Review', dedupeKey: `ledger:${f.kind}:${f.orderId ?? f.detail}` });
    }
    return { findings: r.findings.length };
  });
  q.register('finance_cost_alerts', async () => {
    const r = await costAlertReport(ctx, 7);
    for (const a of r.alerts.filter((x) => x.severity === 'critical').slice(0, 20)) {
      await raiseException(ctx, { kind: 'RECONCILIATION', priority: 'high', issue: `Supplier cost for "${a.label}" is ${(a.changePct * 100).toFixed(0)}% above the cost the price was based on (order ${a.orderNumber ?? ''})`, aiRecommendation: 'Re-quote the supplier and reprice or pause the product if the margin no longer clears.', suggestedAction: 'Review', dedupeKey: `costalert:${a.productId}:${a.supplierId}` });
    }
    return { alerts: r.alerts.length };
  });
}

const HOUR = 3_600_000;
/** Default schedules contributed by this workstream (merged into DEFAULT_SCHEDULES). */
export const FINANCE_SCHEDULES: (ScheduleDef & { risk: 'low' | 'medium' | 'high' })[] = [
  { name: 'fx_refresh', everyMs: 6 * HOUR, job: 'fx_refresh', description: 'Refresh stored FX rates from the configured provider (ECB via Frankfurter by default)', risk: 'low' },
  { name: 'ledger_sync', everyMs: 10 * 60_000, job: 'ledger_sync', description: 'Post new paid / refunded orders, supplier costs and ad spend to the finance ledger (idempotent)', risk: 'low' },
  { name: 'ledger_reconciliation', everyMs: 24 * HOUR, job: 'ledger_reconciliation', description: 'Compare the finance ledger with orders, payments, refunds and shipments', risk: 'low' },
  { name: 'finance_cost_alerts', everyMs: 6 * HOUR, job: 'finance_cost_alerts', description: 'Flag supplier costs that exceed the cost the selling price was based on', risk: 'low' },
];
