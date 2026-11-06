import { Order } from '@orvia/database';
import type { Ctx } from '../../infra/context';
import type { ScheduleDef } from '../../infra/queue';
import { accrueCommission, clawbackScan, reconcileOrderCommission, settleLedger } from './ledger';
import { earnForOrder, expireLoyalty, reconcileLoyaltyForOrder } from './loyalty';

export * from './config';
export * from './commission';
export * from './attribution';
export * from './fraudRules';
export * from './loyaltyRules';
export * from './statement';
export * from './profiles';
export * from './tracking';
export * from './orderHooks';
export * from './ledger';
export * from './payouts';
export * from './loyalty';
export * from './discussion';
export { checkReferralAbuse, recordReferralSignal, referralOverview, MAX_REFERRAL_REWARDS_30D } from './referralGuard';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Register this workstream's job handlers (called from registerJobs). */
export function register_creators_Jobs(ctx: Ctx): void {
  ctx.queue.register('creator_commission_accrue', async (p: { orderId: string }) => ({ result: await accrueCommission(ctx, p.orderId) }));
  ctx.queue.register('creator_ledger_settle', async (p: { sinceHours?: number } = {}) => {
    const scan = await clawbackScan(ctx, p?.sinceHours ?? 6); // clawbacks first so nothing refunded is released
    const since = new Date(ctx.now().getTime() - (p?.sinceHours ?? 6) * HOUR);
    const refunded = await Order.find({ updatedAt: { $gte: since }, userId: { $exists: true }, $or: [{ 'costs.refunded': { $gt: 0 } }, { status: { $in: ['REFUNDED', 'CANCELLED'] } }] }).select('_id').limit(1000).lean();
    let points = 0;
    for (const o of refunded) points += await reconcileLoyaltyForOrder(ctx, String(o._id));
    return { scan, loyaltyReversed: points, settle: await settleLedger(ctx) };
  });
  ctx.queue.register('creator_order_reconcile', async (p: { orderId: string }) => ({ commission: await reconcileOrderCommission(ctx, p.orderId), loyalty: await reconcileLoyaltyForOrder(ctx, p.orderId) }));
  ctx.queue.register('loyalty_earn', async (p: { orderId: string }) => ({ result: await earnForOrder(ctx, p.orderId) }));
  ctx.queue.register('loyalty_expire', async () => expireLoyalty(ctx));
}

/** Default schedules contributed by this workstream (merged into DEFAULT_SCHEDULES). */
export const CREATORS_SCHEDULES: (ScheduleDef & { risk: 'low' | 'medium' | 'high' })[] = [
  { name: 'creator_ledger_settle', everyMs: HOUR, job: 'creator_ledger_settle', description: 'Claw back refunded creator commissions, then release commissions whose hold has elapsed', risk: 'medium' },
  { name: 'creator_ledger_deep_scan', everyMs: DAY, job: 'creator_ledger_settle', payload: { sinceHours: 24 * 14 }, description: 'Daily wide refund/clawback sweep for creator commissions', risk: 'low' },
  { name: 'loyalty_expire', everyMs: DAY, job: 'loyalty_expire', description: 'Expire due loyalty points and restore unused redemption codes', risk: 'low' },
];
