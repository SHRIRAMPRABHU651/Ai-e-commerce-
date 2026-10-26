import { randomBytes } from 'node:crypto';
import { Cart, Order, Promotion, ReferralCode, Referral } from '@orvia/database';
import { REFERRAL_TERMS } from '@orvia/types';
import { SYSTEM } from '../infra/context';
import type { Ctx } from '../infra/context';
import { audit } from '../infra/audit';
import { applyCoupon } from './cart';
import { notify } from './notify';

const hex = (n: number) => randomBytes(n).toString('hex').toUpperCase();
const link = (ctx: Ctx, code: string) => `${ctx.cfg.WEB_URL}/?ref=${encodeURIComponent(code)}`;

/**
 * The invited friend's discount is an ordinary first-order Promotion, so every existing guard applies unchanged:
 * first orders only, one use per email, and the discount is clamped so an order can never fall below landed cost.
 */
export async function ensureReferralCode(ctx: Ctx, user: { id: string; email: string }) {
  const existing = await ReferralCode.findOne({ userId: user.id }).lean();
  if (existing) return existing;
  const code = `FRIEND-${hex(3)}`;
  const promo = await Promotion.create({ name: `Referral ${code}`, type: 'first_order', code, percent: REFERRAL_TERMS.friendPercent, usageLimit: 0, perUserLimit: 1, automated: true, recommendedBy: 'referral' });
  try {
    return (await ReferralCode.create({ userId: user.id, email: user.email, code, promotionId: promo._id })).toObject();
  } catch (e) {
    if ((e as { code?: number }).code !== 11000) throw e;
    await Promotion.deleteOne({ _id: promo._id }); // lost a race with a parallel request: keep the winner
    return (await ReferralCode.findOne({ userId: user.id }).lean())!;
  }
}

export async function referralSummary(ctx: Ctx, user: { id: string; email: string }) {
  const rc = await ensureReferralCode(ctx, user);
  const [rewarded, rejected, ordered] = await Promise.all([
    Referral.find({ referrerUserId: user.id, status: 'rewarded' }).select('rewardCode').lean(),
    Referral.countDocuments({ referrerUserId: user.id, status: 'rejected' }),
    Order.countDocuments({ couponCode: rc.code, 'payment.status': 'succeeded' }),
  ]);
  const codes = rewarded.map((r) => r.rewardCode).filter((c): c is string => !!c);
  const promos = await Promotion.find({ code: { $in: codes } }).select('code usedCount endsAt').lean();
  const now = ctx.now();
  return {
    code: rc.code, link: link(ctx, rc.code), friendPercent: REFERRAL_TERMS.friendPercent, rewardPercent: REFERRAL_TERMS.rewardPercent,
    friendsOrdered: ordered, rewardsEarned: rewarded.length, notRewarded: rejected,
    rewards: promos.map((p) => ({ code: p.code!, status: p.usedCount > 0 ? 'used' : p.endsAt && p.endsAt < now ? 'expired' : 'available', expiresAt: p.endsAt })),
  };
}

/** Called from a shared link. Attaches the friend's code to the cart unless the shopper already chose a coupon. Never reveals who referred them. */
export async function claimReferral(ctx: Ctx, cartToken: string, rawCode: string): Promise<{ valid: boolean; applied: boolean; percent?: number }> {
  const code = rawCode.trim().toUpperCase();
  const rc = await ReferralCode.findOne({ code }).lean();
  const promo = rc && (await Promotion.findOne({ _id: rc.promotionId, active: true }).select('percent').lean());
  if (!rc || !promo) return { valid: false, applied: false };
  const cart = await Cart.findOne({ token: cartToken }).select('couponCode').lean();
  if (cart && !cart.couponCode) {
    await applyCoupon(ctx, cartToken, code);
    return { valid: true, applied: true, percent: promo.percent };
  }
  return { valid: true, applied: false, percent: promo.percent };
}

export type SettleResult = 'rewarded' | 'rejected' | 'skipped';

/**
 * Reward the referrer — only after the friend's order is DELIVERED and still not refunded/cancelled (the job runs after
 * a hold period), so a refund cannot be farmed for credit. Idempotent: one row per invited email.
 */
export async function settleReferral(ctx: Ctx, orderId: string): Promise<SettleResult> {
  const order = await Order.findById(orderId).lean();
  if (!order || !order.couponCode || order.status !== 'DELIVERED' || order.payment?.status !== 'succeeded') return 'skipped';
  const rc = await ReferralCode.findOne({ code: order.couponCode }).lean();
  if (!rc) return 'skipped';
  const base = { referrerUserId: rc.userId, referrerEmail: rc.email, refereeEmail: order.email.toLowerCase(), orderId: order._id, code: rc.code };
  const reject = async (reason: string): Promise<SettleResult> => {
    try { await Referral.create({ ...base, status: 'rejected', reason }); } catch (e) { if ((e as { code?: number }).code !== 11000) throw e; }
    await audit(ctx, SYSTEM, { action: 'referral.rejected', resource: 'order', resourceId: orderId, reason });
    return 'rejected';
  };
  if (String(rc.userId) === String(order.userId ?? '') || rc.email === order.email.toLowerCase()) return reject('self_referral');
  if (order.fraud?.level === 'high') return reject('fraud_review');
  if (await Referral.exists({ refereeEmail: base.refereeEmail })) return 'skipped'; // already settled

  const rewardCode = `THANKS-${hex(4)}`;
  const expires = new Date(ctx.now().getTime() + REFERRAL_TERMS.rewardValidDays * 86_400_000);
  const reward = await Promotion.create({
    name: `Referral reward ${rewardCode}`, type: 'percentage', code: rewardCode, percent: REFERRAL_TERMS.rewardPercent, usageLimit: 1, perUserLimit: 1,
    endsAt: expires, automated: true, recommendedBy: 'referral-reward',
  });
  try {
    await Referral.create({ ...base, status: 'rewarded', rewardCode });
  } catch (e) {
    if ((e as { code?: number }).code !== 11000) throw e;
    await Promotion.deleteOne({ _id: reward._id });
    return 'skipped';
  }
  await notify(ctx, { template: 'referral_reward', to: rc.email, data: { code: rewardCode, discount: `${Math.round(REFERRAL_TERMS.rewardPercent * 100)}% off`, eta: expires.toDateString(), url: `${ctx.cfg.WEB_URL}/account/referrals` }, dedupeKey: `referral:${orderId}` });
  await audit(ctx, SYSTEM, { action: 'referral.rewarded', resource: 'order', resourceId: orderId, newValue: { referrer: rc.email, rewardCode } });
  return 'rewarded';
}
