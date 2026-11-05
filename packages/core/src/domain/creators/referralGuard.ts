/** Additive abuse checks for the existing referral programme (called from settleReferral). */
import { Order, Referral, ReferralSignal, Session, User } from '@orvia/database';
import type { Ctx } from '../../infra/context';
import { addressKey, hashSignal, normalizeEmail, normalizePhone, referralAbuse } from './fraudRules';
import type { PartyFacts, ReferralAbuse } from './fraudRules';

export const MAX_REFERRAL_REWARDS_30D = 10;
type OrderLike = { _id: unknown; email: string; address?: { line1?: string | null; postalCode?: string | null; country?: string | null; phone?: string | null } | null; fraud?: { ip?: string | null } | null };

const facts = (ctx: Ctx, email: string, orders: OrderLike[], extraIps: (string | null | undefined)[]): PartyFacts => {
  const h = (k: string, v: string) => (v ? hashSignal(ctx.cfg.JWT_SECRET, k, v) : '');
  return {
    normalizedEmail: normalizeEmail(email),
    addressHashes: orders.map((o) => h('addr', addressKey(o.address))).filter(Boolean),
    phoneHashes: orders.map((o) => h('phone', normalizePhone(o.address?.phone))).filter(Boolean),
    ipHashes: [...orders.map((o) => o.fraud?.ip), ...extraIps].filter((x): x is string => !!x).map((ip) => h('ip', ip)),
  };
};

export async function checkReferralAbuse(ctx: Ctx, order: OrderLike, rc: { userId: unknown; email: string }): Promise<ReferralAbuse | null> {
  const since = new Date(ctx.now().getTime() - 30 * 86_400_000);
  const [ref, refOrders, sessions, prior, rewards30] = await Promise.all([
    User.findById(rc.userId).select('email').lean(),
    Order.find({ userId: rc.userId, status: { $nin: ['CANCELLED'] } }).sort({ createdAt: -1 }).limit(20).select('address fraud.ip').lean(),
    Session.find({ userId: rc.userId, createdAt: { $gte: new Date(ctx.now().getTime() - 90 * 86_400_000) } }).select('ip').limit(30).lean(),
    ReferralSignal.find({ outcome: 'rewarded', orderId: { $ne: order._id } }).where('normalizedEmail').equals(normalizeEmail(order.email)).select('_id').limit(1).lean(),
    Referral.countDocuments({ referrerUserId: rc.userId, status: 'rewarded', createdAt: { $gte: since } }),
  ]);
  const referrer = facts(ctx, ref?.email ?? rc.email, refOrders as OrderLike[], sessions.map((s) => s.ip));
  referrer.normalizedEmail = normalizeEmail(ref?.email ?? rc.email);
  const referee = facts(ctx, order.email, [order], []);
  return referralAbuse({ referrer, referee, priorRefereeEmails: prior.length ? [referee.normalizedEmail] : [], referrerRewards30d: rewards30, maxRewards30d: MAX_REFERRAL_REWARDS_30D });
}

export async function recordReferralSignal(ctx: Ctx, order: OrderLike, rc: { userId: unknown }, outcome: 'rewarded' | 'rejected', reason?: string): Promise<void> {
  const f = facts(ctx, order.email, [order], []);
  try {
    await ReferralSignal.updateOne({ orderId: order._id }, { $setOnInsert: { orderId: order._id, referrerUserId: rc.userId, normalizedEmail: f.normalizedEmail, addressHash: f.addressHashes[0], phoneHash: f.phoneHashes[0], ipHash: f.ipHashes[0], outcome, reason } }, { upsert: true });
  } catch (e) { ctx.log.warn({ err: (e as Error).message }, 'referral signal not recorded'); }
}

/** Admin overview: codes, rewards and rejections with reasons (no raw signals; emails only for staff). */
export async function referralOverview(page: number, pageSize: number, status?: 'rewarded' | 'rejected') {
  const { ReferralCode } = await import('@orvia/database');
  const f = status ? { status } : {};
  const [codes, rewarded, rejected, total, rows, reasons] = await Promise.all([
    ReferralCode.countDocuments({}), Referral.countDocuments({ status: 'rewarded' }), Referral.countDocuments({ status: 'rejected' }), Referral.countDocuments(f),
    Referral.find(f).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
    Referral.aggregate<{ _id: string; n: number }>([{ $match: { status: 'rejected' } }, { $group: { _id: '$reason', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 20 }]),
  ]);
  return {
    totals: { codes, rewarded, rejected }, rejectionReasons: reasons.map((r) => ({ reason: r._id ?? 'unknown', count: r.n })), total, page, pageSize,
    items: rows.map((r) => ({ id: String(r._id), referrerEmail: r.referrerEmail, refereeEmail: r.refereeEmail, code: r.code, status: r.status, reason: r.reason ?? null, rewardCode: r.rewardCode ?? null, at: (r as { createdAt?: Date }).createdAt })),
  };
}
