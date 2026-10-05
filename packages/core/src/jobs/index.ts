import { Job, Order, Product } from '@orvia/database';
import { AUTOMATION_KEYS } from '@orvia/types';
import type { AutomationKey } from '@orvia/types';
import { SystemSetting } from '@orvia/database';
import { runNamedAgent } from '../agents/registry';
import type { Ctx } from '../infra/context';
import { onJobDead, fulfillOrder, requestFulfillment, syncTracking, verifyPendingPayments, expireUnpaidOrders } from '../domain/orders';
import { deliverNotification, notify } from '../domain/notify';
import { runPricingAgent } from '../domain/pricing';
import { scoreProduct } from '../domain/importer';
import { generateDailyBrief } from '../domain/brief';
import { recommendPromotions } from '../domain/marketing';
import { syncAdMetrics } from '../domain/adsService';
import { refreshTrends } from '../domain/discovery';
import { refreshSupplierReliability } from '../domain/reporting';
import { analyzeProductReviews } from '../domain/reviews';
import { Scheduler } from '../infra/queue';
import type { ScheduleDef } from '../infra/queue';
import { invalidateSearchIndex } from '../domain/search';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const DEFAULT_SCHEDULES: (ScheduleDef & { automation?: AutomationKey; risk: 'low' | 'medium' | 'high' })[] = [
  { name: 'order_sync', everyMs: 5 * MIN, job: 'order_sync', description: 'Re-request fulfilment for paid orders that have none queued', automation: 'order_fulfillment', risk: 'high' },
  { name: 'tracking_sync', everyMs: 5 * MIN, job: 'sync_tracking', description: 'Poll suppliers for shipment tracking and notify customers', automation: 'tracking', risk: 'low' },
  { name: 'payment_verification', everyMs: 5 * MIN, job: 'payment_verification', description: 'Confirm stale unpaid orders directly with the payment provider', risk: 'medium' },
  { name: 'inventory_sync', everyMs: 5 * MIN, job: 'sync_inventory', payload: { limit: 60 }, description: 'Rotating supplier stock + price refresh; pause/restore products', automation: 'inventory_sync', risk: 'medium' },
  { name: 'abandoned_cart', everyMs: 5 * MIN, job: 'abandoned_cart', description: 'Consent-based cart recovery messages', automation: 'abandoned_cart', risk: 'low' },
  { name: 'ad_metrics', everyMs: 15 * MIN, job: 'sync_ad_metrics', description: 'Pull ad platform metrics', automation: 'ad_optimization', risk: 'low' },
  { name: 'product_performance', everyMs: HOUR, job: 'product_performance', description: 'Trend scores, review sentiment', risk: 'low' },
  { name: 'campaign_performance', everyMs: HOUR, job: 'optimize_ads', description: 'Evaluate campaigns against budget rules', automation: 'ad_optimization', risk: 'high' },
  { name: 'pricing_analysis', everyMs: HOUR, job: 'pricing_analysis', description: 'Dynamic pricing proposals within margin guardrails', automation: 'dynamic_pricing', risk: 'high' },
  { name: 'housekeeping', everyMs: HOUR, job: 'housekeeping', description: 'Expire unpaid orders, refresh supplier reliability', risk: 'low' },
  { name: 'discovery', everyMs: DAY, job: 'discovery', description: 'Discover, score and import/propose products; start ad tests', automation: 'product_discovery', risk: 'medium' },
  { name: 'product_scoring', everyMs: DAY, job: 'score_products', description: 'Recompute opportunity scores', risk: 'low' },
  { name: 'daily_brief', everyMs: DAY, job: 'daily_brief', description: 'Generate the daily business brief', automation: 'ai_reports', risk: 'low' },
  { name: 'promotion_analysis', everyMs: DAY, job: 'recommend_promotions', description: 'Recommend country promotions', automation: 'promotion_optimization', risk: 'medium' },
];

/** Schedules with admin overrides (custom interval / disabled) from system_settings `schedule_overrides`. */
export async function effectiveSchedules(): Promise<(ScheduleDef & { enabled: boolean; automation?: AutomationKey; risk: string })[]> {
  const doc = await SystemSetting.findOne({ key: 'schedule_overrides' }).lean();
  const ov = (doc?.value ?? {}) as Record<string, { everyMs?: number; enabled?: boolean }>;
  return DEFAULT_SCHEDULES.map((s) => ({ ...s, everyMs: Math.max(60_000, ov[s.name]?.everyMs ?? s.everyMs), enabled: ov[s.name]?.enabled !== false }));
}

export function registerJobs(ctx: Ctx): void {
  const q = ctx.queue;
  q.onDead = (job, err) => onJobDead(ctx, job as { name: string; payload: unknown }, err);
  q.register('send_notification', (p: { notificationId: string; html?: string }) => deliverNotification(ctx, p));
  q.register('fulfill_order', (p: { orderId: string; force?: boolean }) => fulfillOrder(ctx, p.orderId, { force: p.force }));
  q.register('sync_tracking', (p: { orderId?: string }) => syncTracking(ctx, { orderId: p?.orderId }));
  q.register('payment_verification', () => verifyPendingPayments(ctx));
  q.register('order_sync', async () => {
    const mode = await ctx.settings.automationMode('order_fulfillment');
    if (mode !== 'AUTOMATIC') return { skipped: mode };
    const stuck = await Order.find({ status: 'PAID', exceptionOpen: false, 'fulfillment.state': { $in: ['none', 'queued'] }, 'payment.paidAt': { $lt: new Date(Date.now() - 2 * MIN) } }).select('_id').limit(100).lean();
    for (const o of stuck) await requestFulfillment(ctx, String(o._id));
    return { requeued: stuck.length };
  });
  q.register('sync_inventory', async () => { const r = await runNamedAgent(ctx, 'InventoryAgent', {}); invalidateSearchIndex(); return r; });
  q.register('sync_ad_metrics', () => syncAdMetrics(ctx));
  q.register('optimize_ads', () => runNamedAgent(ctx, 'AdOptimizationAgent'));
  q.register('pricing_analysis', async () => { const r = await runPricingAgent(ctx); invalidateSearchIndex(); return r; });
  q.register('product_performance', async () => {
    const t = await refreshTrends(ctx);
    const prods = await Product.find({ state: { $in: ['PUBLISHED', 'TESTING', 'WINNER', 'SCALING'] } }).select('_id').limit(50).lean();
    let alerts = 0;
    for (const p of prods) if ((await analyzeProductReviews(ctx, String(p._id))).alert) alerts++;
    invalidateSearchIndex();
    return { ...t, reviewAlerts: alerts };
  });
  q.register('housekeeping', async () => ({ expired: await expireUnpaidOrders(ctx), reliability: await refreshSupplierReliability() }));
  q.register('discovery', async () => {
    const d = await runNamedAgent(ctx, 'ProductDiscoveryAgent');
    const m = await runNamedAgent(ctx, 'MarketingAgent');
    invalidateSearchIndex();
    return { d, m };
  });
  q.register('score_products', async () => {
    const prods = await Product.find({ state: { $nin: ['BANNED', 'ARCHIVED'] } }).select('_id').limit(200).lean();
    for (const p of prods) await scoreProduct(ctx, String(p._id));
    return { scored: prods.length };
  });
  q.register('daily_brief', () => generateDailyBrief(ctx));
  q.register('recommend_promotions', () => recommendPromotions(ctx));
  q.register('abandoned_cart', () => runNamedAgent(ctx, 'AbandonedCartAgent'));
  q.register('review_request', async (p: { orderId: string }) => {
    const o = await Order.findById(p.orderId).lean();
    if (!o || !['DELIVERED'].includes(o.status)) return { skipped: true };
    const first = o.items[0];
    await notify(ctx, { template: 'review_request', to: o.email, orderId: String(o._id), data: { name: o.address?.fullName ?? undefined, productTitle: first?.title, url: `${ctx.cfg.WEB_URL}/orders/${o.orderNumber}#review` }, dedupeKey: `review-mail:${o._id}` });
    return { sent: true };
  });
}

export function createScheduler(ctx: Ctx): Scheduler {
  return new Scheduler(ctx.queue, async () => (await effectiveSchedules()).filter((s) => s.enabled), ctx.log);
}

const AUTOMATION_META: Record<AutomationKey, { name: string; description: string; risk: 'low' | 'medium' | 'high' }> = {
  product_discovery: { name: 'Product Discovery', description: 'Scan suppliers, score opportunities, import candidates', risk: 'medium' },
  auto_publishing: { name: 'Auto Publishing', description: 'Publish products that pass compliance and margin gates', risk: 'high' },
  dynamic_pricing: { name: 'Dynamic Pricing', description: 'Adjust prices within margin guardrails', risk: 'high' },
  inventory_sync: { name: 'Inventory Sync', description: 'Sync stock/prices; pause or restore products; switch supplier', risk: 'medium' },
  order_fulfillment: { name: 'Order Fulfillment', description: 'Place supplier orders for paid orders', risk: 'high' },
  tracking: { name: 'Tracking', description: 'Sync tracking and notify customers', risk: 'low' },
  customer_support: { name: 'Customer Support', description: 'AI assistant may perform confirmed cancellations', risk: 'medium' },
  ad_optimization: { name: 'Ad Optimization', description: 'Launch tests, scale/reduce/pause campaigns within safe-mode limits', risk: 'high' },
  promotion_optimization: { name: 'Promotion Optimization', description: 'Create recommended promotions', risk: 'medium' },
  abandoned_cart: { name: 'Abandoned Cart', description: 'Consent-based recovery messages', risk: 'low' },
  ai_reports: { name: 'AI Reports', description: 'Daily business brief and narrative', risk: 'low' },
};

export async function automationOverview(ctx: Ctx) {
  const modes = (await ctx.settings.get('automation')).modes;
  const schedules = await effectiveSchedules();
  const since = new Date(Date.now() - 7 * DAY);
  const out = [];
  for (const key of AUTOMATION_KEYS) {
    const meta = AUTOMATION_META[key];
    const sched = schedules.filter((s) => s.automation === key);
    const jobNames = sched.map((s) => s.job);
    const [last, ok, bad] = await Promise.all([
      jobNames.length ? Job.findOne({ name: { $in: jobNames }, status: { $in: ['completed', 'dead'] } }).sort({ updatedAt: -1 }).select('updatedAt status name').lean() : null,
      jobNames.length ? Job.countDocuments({ name: { $in: jobNames }, status: 'completed', updatedAt: { $gte: since } }) : 0,
      jobNames.length ? Job.countDocuments({ name: { $in: jobNames }, status: 'dead', updatedAt: { $gte: since } }) : 0,
    ]);
    const s0 = sched[0];
    out.push({
      key, ...meta, mode: modes[key] ?? 'OFF', schedule: sched.map((s) => ({ name: s.name, everyMs: s.everyMs, enabled: s.enabled })),
      lastRun: last?.updatedAt ?? null, nextRun: s0 && s0.enabled ? new Date((Math.floor(Date.now() / s0.everyMs) + 1) * s0.everyMs) : null, successRate: ok + bad ? ok / (ok + bad) : null, runs7d: ok + bad,
    });
  }
  return out;
}
