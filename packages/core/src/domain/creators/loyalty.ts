import { randomBytes, randomUUID } from 'node:crypto';
import { LoyaltyAccount, LoyaltyLedger, LoyaltyRedemption, Order, Promotion, User } from '@orvia/database';
import { convertMinor } from '@orvia/types';
import type { Currency, LoyaltyReader, LoyaltyStatus } from '@orvia/types';
import { DomainError, conflict, notFound } from '../../infra/context';
import type { Actor, Ctx } from '../../infra/context';
import { audit } from '../../infra/audit';
import { netGoodsBase, refundFraction } from './commission';
import { getLoyaltyRules } from './config';
import { computeTier, consumeFifo, expirable, planRedemption, pointsForNet } from './loyaltyRules';

const DAY = 86_400_000;
const isDup = (e: unknown) => (e as { code?: number }).code === 11000;
const CUR: Record<string, Currency> = { US: 'USD', CA: 'CAD', IN: 'INR' };

export async function pointsBalance(userId: string): Promise<number> {
  const { Types } = await import('mongoose');
  const r = await LoyaltyLedger.aggregate<{ s: number }>([{ $match: { userId: new Types.ObjectId(userId) } }, { $group: { _id: null, s: { $sum: '$points' } } }]);
  return r[0]?.s ?? 0;
}

async function netUsd(ctx: Ctx, o: { amounts?: { subtotal?: number | null; discount?: number | null; shipping?: number | null; tax?: number | null; total?: number | null; taxInclusive?: boolean | null } | null; costs?: { refunded?: number | null } | null; currency: string }): Promise<number> {
  const a = o.amounts ?? {};
  const base = netGoodsBase({ subtotal: a.subtotal ?? 0, discount: a.discount ?? 0, shipping: a.shipping ?? 0, tax: a.tax ?? 0, taxInclusive: !!a.taxInclusive });
  const net = Math.round(base * (1 - refundFraction(o.costs?.refunded ?? 0, a.total ?? 0)));
  const ops = await ctx.settings.get('ops');
  return convertMinor(net, o.currency as Currency, 'USD', ops.fx);
}

/** Trailing-12-month delivered net spend (USD minor units). */
export async function trailingSpendUsd(ctx: Ctx, userId: string): Promise<number> {
  const rows = await Order.find({ userId, status: 'DELIVERED', deliveredAt: { $gte: new Date(ctx.now().getTime() - 365 * DAY) } }).select('amounts costs currency').limit(500).lean();
  let sum = 0;
  for (const r of rows) sum += await netUsd(ctx, r);
  return sum;
}

export async function getLoyaltyStatus(ctx: Ctx, userId: string): Promise<LoyaltyStatus> {
  const rules = await getLoyaltyRules();
  const [points, spend, lifetime, soon] = await Promise.all([
    pointsBalance(userId), trailingSpendUsd(ctx, userId),
    LoyaltyLedger.aggregate<{ s: number }>([{ $match: { userId: new (await import('mongoose')).Types.ObjectId(userId), kind: { $in: ['earn', 'bonus'] } } }, { $group: { _id: null, s: { $sum: '$points' } } }]),
    LoyaltyLedger.find({ userId, remaining: { $gt: 0 }, expiresAt: { $gte: ctx.now(), $lte: new Date(ctx.now().getTime() + 30 * DAY) } }).sort({ expiresAt: 1 }).limit(100).lean(),
  ]);
  const t = computeTier(spend, rules);
  const first = soon[0]?.expiresAt;
  const expiringPoints = first ? soon.filter((s) => s.expiresAt && s.expiresAt.getTime() === first.getTime()).reduce((a, s) => a + s.remaining, 0) : 0;
  const enrolled = points !== 0 || spend > 0 || (lifetime[0]?.s ?? 0) > 0;
  return {
    userId, enrolled, points, tier: enrolled ? t.tier.name : null, lifetimePoints: lifetime[0]?.s ?? 0, trailingSpendUsd: spend, nextTier: t.next,
    expiringSoon: first && expiringPoints ? { points: Math.min(expiringPoints, Math.max(0, points)), at: first.toISOString() } : null, asOf: ctx.now().toISOString(),
  };
}

/** Customer 360 contract. */
export const makeLoyaltyReader = (ctx: Ctx): LoyaltyReader => ({ getLoyaltyStatus: (userId) => getLoyaltyStatus(ctx, userId) });

async function addPoints(ctx: Ctx, userId: string, kind: 'earn' | 'bonus' | 'restore', points: number, key: string, extra: { orderId?: string; note?: string; meta?: unknown; expireDays?: number } = {}): Promise<boolean> {
  const rules = await getLoyaltyRules();
  try {
    await LoyaltyLedger.create({ userId, kind, points, remaining: points, expiresAt: new Date(ctx.now().getTime() + (extra.expireDays ?? rules.pointsExpireDays) * DAY), orderId: extra.orderId, idempotencyKey: key, note: extra.note, meta: extra.meta });
  } catch (e) { if (isDup(e)) return false; throw e; }
  return true;
}

/** Earn on delivered NET value (after refunds, ex tax and shipping). Runs after the hold period. Idempotent per order. */
export async function earnForOrder(ctx: Ctx, orderId: string): Promise<'earned' | 'skipped' | 'zero'> {
  const o = await Order.findById(orderId).lean();
  if (!o || !o.userId || o.status !== 'DELIVERED' || !['succeeded', 'partially_refunded'].includes(o.payment?.status ?? '')) return 'skipped';
  const rules = await getLoyaltyRules();
  const spend = await trailingSpendUsd(ctx, String(o.userId));
  const mult = computeTier(spend, rules).tier.multiplier;
  const net = await netUsd(ctx, o);
  const pts = pointsForNet(net, rules, mult);
  if (pts <= 0) return 'zero';
  const ok = await addPoints(ctx, String(o.userId), 'earn', pts, `earn:${orderId}`, { orderId, note: `Order ${o.orderNumber}`, meta: { multiplier: mult, netUsd: net } });
  if (ok) await audit(ctx, { id: 'system', type: 'system' }, { action: 'loyalty.earned', resource: 'order', resourceId: orderId, newValue: { points: pts } });
  return ok ? 'earned' : 'skipped';
}

/** If an earned order is refunded after points were granted, take back the points that no longer correspond to net value. */
export async function reconcileLoyaltyForOrder(ctx: Ctx, orderId: string): Promise<number> {
  const earn = await LoyaltyLedger.findOne({ idempotencyKey: `earn:${orderId}` });
  const o = await Order.findById(orderId).lean();
  if (!earn || !o) return 0;
  const rules = await getLoyaltyRules();
  const mult = (earn.meta as { multiplier?: number } | undefined)?.multiplier ?? 1;
  const target = ['CANCELLED', 'REFUNDED'].includes(o.status) ? 0 : pointsForNet(await netUsd(ctx, o), rules, mult);
  const prior = await LoyaltyLedger.aggregate<{ s: number }>([{ $match: { orderId: o._id, kind: { $in: ['reversal'] } } }, { $group: { _id: null, s: { $sum: '$points' } } }]);
  const delta = target - (earn.points + (prior[0]?.s ?? 0));
  if (delta >= 0) return 0;
  try {
    await LoyaltyLedger.create({ userId: earn.userId, kind: 'reversal', points: delta, orderId: o._id, idempotencyKey: `reversal:${orderId}:${o.costs?.refunded ?? 0}:${o.status}`, note: 'Order refunded' });
  } catch (e) { if (isDup(e)) return 0; throw e; }
  await LoyaltyLedger.updateOne({ _id: earn._id }, { $set: { remaining: Math.max(0, earn.remaining + delta) } });
  return delta;
}

export async function awardReferralBonus(ctx: Ctx, referrerUserId: string, orderId: string): Promise<boolean> {
  const rules = await getLoyaltyRules();
  if (rules.referralBonusPoints <= 0) return false;
  return addPoints(ctx, referrerUserId, 'bonus', rules.referralBonusPoints, `bonus:referral:${orderId}`, { orderId, note: 'Friend referral reward' });
}

/** Redeem points for a single-use, expiring fixed-amount discount code. The live promotion engine still clamps at checkout so a code can never create a negative-margin order. */
export async function redeemPoints(ctx: Ctx, userId: string, points: number) {
  const rules = await getLoyaltyRules();
  const [balance, recent] = await Promise.all([
    pointsBalance(userId),
    LoyaltyLedger.aggregate<{ s: number }>([{ $match: { userId: new (await import('mongoose')).Types.ObjectId(userId), kind: 'redeem', createdAt: { $gte: new Date(ctx.now().getTime() - 30 * DAY) } } }, { $group: { _id: null, s: { $sum: '$points' } } }]),
  ]);
  const plan = planRedemption({ points, balance, redeemedLast30d: -(recent[0]?.s ?? 0), rules });
  if (!plan.ok) throw new DomainError(({ below_minimum: `Minimum redemption is ${rules.minRedeemPoints} points`, insufficient_points: 'Not enough points', above_per_redemption_cap: `Maximum per redemption is ${rules.maxRedeemPoints} points`, above_30d_cap: 'Monthly redemption limit reached', not_whole_value: 'Redeem in multiples of 10 points' } as const)[plan.reason], 'REDEEM_REFUSED', 422, { reason: plan.reason });
  const redemptionId = randomUUID().replace(/-/g, '').slice(0, 24);
  const code = `LOYAL-${randomBytes(4).toString('hex').toUpperCase()}`;
  const row = await LoyaltyLedger.create({ userId, kind: 'redeem', points: -plan.points, remaining: 0, redemptionId, idempotencyKey: `redeem:${redemptionId}`, note: code });
  if ((await pointsBalance(userId)) < 0) { await LoyaltyLedger.deleteOne({ _id: row._id }); throw conflict('Not enough points', 'INSUFFICIENT_POINTS'); } // concurrent redemption lost the race
  const earns = await LoyaltyLedger.find({ userId, remaining: { $gt: 0 } }).select('remaining expiresAt').lean();
  for (const d of consumeFifo(earns.map((e) => ({ id: String(e._id), remaining: e.remaining, expiresAt: e.expiresAt ?? null })), plan.points) ?? []) await LoyaltyLedger.updateOne({ _id: d.id, remaining: { $gte: d.take } }, { $inc: { remaining: -d.take } });
  const ops = await ctx.settings.get('ops');
  const expiresAt = new Date(ctx.now().getTime() + rules.redemptionValidDays * DAY);
  const fixed: Record<string, number> = {}, min: Record<string, number> = {};
  for (const [country, cur] of Object.entries(CUR)) { fixed[country] = convertMinor(plan.valueUsd, 'USD', cur, ops.fx); min[country] = convertMinor(plan.minSubtotalUsd, 'USD', cur, ops.fx); }
  try {
    const promo = await Promotion.create({ name: `Loyalty ${code}`, type: 'fixed', code, fixedAmount: fixed, minSubtotal: min, usageLimit: 1, perUserLimit: 1, endsAt: expiresAt, automated: true, recommendedBy: 'loyalty' });
    await LoyaltyRedemption.create({ _id: redemptionId, userId, points: plan.points, valueUsd: plan.valueUsd, code, promotionId: promo._id, expiresAt });
  } catch (e) {
    await LoyaltyLedger.deleteOne({ _id: row._id });
    await addPoints(ctx, userId, 'restore', plan.points, `restore:failed:${redemptionId}`, { note: 'Redemption failed' });
    throw e;
  }
  await audit(ctx, { id: userId, type: 'user' }, { action: 'loyalty.redeemed', resource: 'loyalty', resourceId: userId, newValue: { points: plan.points, code } });
  return { code, points: plan.points, valueUsd: plan.valueUsd, expiresAt, minSubtotalUsd: plan.minSubtotalUsd };
}

export async function listLoyaltyActivity(userId: string, page: number, pageSize: number) {
  const [total, rows, reds] = await Promise.all([
    LoyaltyLedger.countDocuments({ userId }), LoyaltyLedger.find({ userId }).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
    LoyaltyRedemption.find({ userId }).sort({ createdAt: -1 }).limit(10).lean(),
  ]);
  return {
    total, page, pageSize,
    items: rows.map((r) => ({ id: String(r._id), kind: r.kind, points: r.points, note: r.kind === 'redeem' ? 'Redeemed for a discount code' : r.note ?? null, expiresAt: r.expiresAt ?? null, at: (r as { createdAt?: Date }).createdAt })),
    redemptions: reds.map((r) => ({ code: r.code, points: r.points, valueUsd: r.valueUsd, status: r.status, expiresAt: r.expiresAt })),
  };
}

/** Expire due points (never below zero balance) and restore points from unused, expired redemption codes. */
export async function expireLoyalty(ctx: Ctx, limit = 500): Promise<{ expired: number; restored: number }> {
  const now = ctx.now();
  const due = await LoyaltyLedger.find({ kind: { $in: ['earn', 'bonus', 'restore', 'adjust'] }, remaining: { $gt: 0 }, expiresAt: { $lte: now } }).limit(limit).lean();
  let expired = 0;
  for (const e of expirable(due.map((d) => ({ id: String(d._id), remaining: d.remaining, expiresAt: d.expiresAt ?? null })), now)) {
    const row = due.find((d) => String(d._id) === e.id)!;
    const take = Math.min(e.points, Math.max(0, await pointsBalance(String(row.userId))));
    if (take > 0) { try { await LoyaltyLedger.create({ userId: row.userId, kind: 'expire', points: -take, idempotencyKey: `expire:${e.id}`, note: 'Points expired' }); expired += take; } catch (err) { if (!isDup(err)) throw err; } }
    await LoyaltyLedger.updateOne({ _id: e.id }, { $set: { remaining: 0 } });
  }
  let restored = 0;
  const reds = await LoyaltyRedemption.find({ status: 'active', expiresAt: { $lte: now } }).limit(limit);
  for (const r of reds) {
    const promo = r.promotionId ? await Promotion.findById(r.promotionId).select('usedCount').lean() : null;
    if (promo && promo.usedCount > 0) { r.status = 'used'; await r.save(); continue; }
    r.status = 'expired'; await r.save();
    if (r.promotionId) await Promotion.updateOne({ _id: r.promotionId }, { $set: { active: false } });
    if (await addPoints(ctx, String(r.userId), 'restore', r.points ?? 0, `restore:${String(r._id)}`, { note: 'Unused discount code expired', expireDays: 30 })) restored += r.points ?? 0;
  }
  return { expired, restored };
}

/** Audited manual adjustment (`loyalty:write`). The balance may not go negative. */
export async function adjustLoyalty(ctx: Ctx, actor: Actor, userId: string, points: number, reason: string) {
  if (!Number.isInteger(points) || points === 0 || Math.abs(points) > 100_000) throw new DomainError('Points must be a non-zero whole number up to 100000', 'VALIDATION', 400);
  if (reason.trim().length < 5) throw new DomainError('A reason is required', 'VALIDATION', 400);
  if (!(await User.exists({ _id: userId }))) throw notFound('Customer');
  const before = await pointsBalance(userId);
  if (before + points < 0) throw new DomainError('Adjustment would make the balance negative', 'NEGATIVE_BALANCE', 422);
  const key = `adjust:${randomUUID()}`;
  const rules = await getLoyaltyRules();
  await LoyaltyLedger.create({ userId, kind: 'adjust', points, remaining: points > 0 ? points : 0, expiresAt: points > 0 ? new Date(ctx.now().getTime() + rules.pointsExpireDays * DAY) : undefined, idempotencyKey: key, note: `Adjustment: ${reason.slice(0, 120)}`, actor: actor.id });
  await audit(ctx, actor, { action: 'loyalty.adjusted', resource: 'loyalty', resourceId: userId, previousValue: { points: before }, newValue: { points: before + points }, reason });
  return { points: before + points };
}

export async function adminLoyaltyAccounts(q: { search?: string; page: number; pageSize: number }) {
  let userIds: unknown[] | null = null;
  if (q.search) {
    const users = await User.find({ email: new RegExp(`^${q.search.toLowerCase().replace(/[^a-z0-9@._+-]/g, '')}`) }).select('_id').limit(50).lean();
    userIds = users.map((u) => u._id);
  }
  const f = userIds ? { userId: { $in: userIds } } : {};
  const [total, rows] = await Promise.all([LoyaltyAccount.countDocuments(f), LoyaltyAccount.find(f).sort({ updatedAt: -1 }).skip((q.page - 1) * q.pageSize).limit(q.pageSize).lean()]);
  void rows;
  // balances come from the ledger (the account document is only a cache)
  const { Types } = await import('mongoose');
  const ledger = await LoyaltyLedger.aggregate<{ _id: unknown; s: number; last: Date }>([
    ...(userIds ? [{ $match: { userId: { $in: userIds.map((i) => new Types.ObjectId(String(i))) } } }] : []),
    { $group: { _id: '$userId', s: { $sum: '$points' }, last: { $max: '$createdAt' } } }, { $sort: { last: -1 } }, { $skip: (q.page - 1) * q.pageSize }, { $limit: q.pageSize },
  ]);
  const users = await User.find({ _id: { $in: ledger.map((l) => l._id) } }).select('email name').lean();
  const u = new Map(users.map((x) => [String(x._id), x]));
  return { total: Math.max(total, ledger.length), page: q.page, pageSize: q.pageSize, items: ledger.map((l) => ({ userId: String(l._id), email: u.get(String(l._id))?.email ?? '', name: u.get(String(l._id))?.name ?? '', points: l.s, lastActivity: l.last })) };
}
