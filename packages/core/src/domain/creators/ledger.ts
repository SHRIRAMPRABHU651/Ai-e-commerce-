import { randomUUID } from 'node:crypto';
import { CreatorClick, CreatorFlag, CreatorLedger, CreatorProfile, Order, Product, Session, User } from '@orvia/database';
import type { CommissionRules } from '@orvia/types';
import { DomainError, conflict, notFound } from '../../infra/context';
import type { Actor, Ctx } from '../../infra/context';
import { audit } from '../../infra/audit';
import { getCountry } from '../../infra/countries';
import { decideAttribution } from './attribution';
import { computeCommission, holdUntil, isReleasable, reconcileDelta, shouldEscalateHold } from './commission';
import type { CommissionOrder, CreatorTerms } from './commission';
import { getRules, hashCreatorIp } from './config';
import { evaluateCreatorOrder, canonicalEmailForAbuse } from './fraudRules';

const DAY = 86_400_000;
const PAID_STATES = ['succeeded', 'partially_refunded', 'refunded'];
const isDup = (e: unknown) => (e as { code?: number }).code === 11000;
const asObj = (m: unknown): Record<string, number> => (m instanceof Map ? Object.fromEntries(m as Map<string, number>) : ((m as Record<string, number> | undefined) ?? {}));

type OrderLean = NonNullable<Awaited<ReturnType<typeof loadOrder>>>;
const loadOrder = (id: string) => Order.findById(id).lean();

async function commissionInput(order: OrderLean): Promise<CommissionOrder> {
  const ids = order.items.map((i) => i.productId);
  const prods = await Product.find({ _id: { $in: ids } }).select('category').lean();
  const cat = new Map(prods.map((p) => [String(p._id), p.category ?? '']));
  const c = order.costs;
  const known = c && (c.supplierCost ?? 0) > 0 ? (c.supplierCost ?? 0) + (c.shippingCost ?? 0) + (c.duties ?? 0) + (c.paymentFee ?? 0) : null;
  return {
    currency: order.currency, lines: order.items.map((i) => ({ category: cat.get(String(i.productId)) ?? '', gross: (i.unitPrice ?? 0) * (i.quantity ?? 0) })),
    subtotal: order.amounts?.subtotal ?? 0, discount: order.amounts?.discount ?? 0, shipping: order.amounts?.shipping ?? 0, tax: order.amounts?.tax ?? 0, total: order.amounts?.total ?? 0,
    taxInclusive: !!order.amounts?.taxInclusive, refunded: c?.refunded ?? 0, knownCosts: known,
  };
}
const termsOf = (p: { rateOverride?: number | null; categoryRateOverrides?: unknown }, orders90d: number): CreatorTerms => ({ rateOverride: p.rateOverride ?? null, categoryRateOverrides: asObj(p.categoryRateOverrides), orders90d });

async function openFlag(ctx: Ctx, f: { creatorId: unknown; orderId?: unknown; kind: string; severity: 'low' | 'medium' | 'high'; detail: string; dedupeKey: string; status?: 'open' | 'confirmed' }) {
  try {
    await CreatorFlag.create({ ...f, status: f.status ?? 'open' });
    await audit(ctx, { id: 'system', type: 'system' }, { action: 'creator.flag_opened', resource: 'creator_flag', resourceId: f.dedupeKey, newValue: { kind: f.kind, severity: f.severity } });
  } catch (e) { if (!isDup(e)) throw e; }
}

async function fraudFacts(ctx: Ctx, order: OrderLean, creator: { _id: unknown; userId: unknown }, rules: CommissionRules) {
  const cid = creator._id;
  const at = order.createdAt as Date;
  const [hour, day, sessions, same, total90, refunded90] = await Promise.all([
    Order.countDocuments({ 'creatorAttribution.creatorId': cid, createdAt: { $gte: new Date(at.getTime() - 3_600_000), $lt: at } }),
    Order.countDocuments({ 'creatorAttribution.creatorId': cid, createdAt: { $gte: new Date(at.getTime() - DAY), $lt: at } }),
    Session.find({ userId: creator.userId, createdAt: { $gte: new Date(ctx.now().getTime() - 60 * DAY) } }).select('ip').limit(50).lean(),
    order.fraud?.ip ? Order.find({ 'creatorAttribution.creatorId': cid, 'fraud.ip': order.fraud.ip, createdAt: { $gte: new Date(at.getTime() - 7 * DAY) } }).select('email').limit(50).lean() : Promise.resolve([]),
    Order.countDocuments({ 'creatorAttribution.creatorId': cid, createdAt: { $gte: new Date(ctx.now().getTime() - 90 * DAY) }, 'payment.status': { $in: PAID_STATES } }),
    Order.countDocuments({ 'creatorAttribution.creatorId': cid, createdAt: { $gte: new Date(ctx.now().getTime() - 90 * DAY) }, 'costs.refunded': { $gt: 0 } }),
  ]);
  const buyers = new Set([...same.map((o) => canonicalEmailForAbuse(o.email)), canonicalEmailForAbuse(order.email)]);
  const flags = evaluateCreatorOrder({
    ordersLastHour: hour, ordersLastDay: day, buyerIpHash: hashCreatorIp(ctx, order.fraud?.ip ?? undefined),
    creatorIpHashes: sessions.map((s) => hashCreatorIp(ctx, s.ip ?? undefined)).filter((x): x is string => !!x),
    buyersSameIp: order.fraud?.ip ? buyers.size : 0, creatorRefundRate: total90 ? refunded90 / total90 : 0, creatorOrderSample: total90, buyerFraudLevel: order.fraud?.level ?? undefined,
  }, rules);
  return { flags, total90, refunded90 };
}

/** Create the accrued commission row for a delivered, attributed order. Idempotent (`commission:<orderId>`). */
export async function accrueCommission(ctx: Ctx, orderId: string): Promise<'accrued' | 'skipped' | 'excluded' | 'zero'> {
  const order = await loadOrder(orderId);
  const att = order?.creatorAttribution;
  if (!order || !att?.creatorId || order.status !== 'DELIVERED' || !PAID_STATES.slice(0, 2).includes(order.payment?.status ?? '')) return 'skipped';
  const creator = await CreatorProfile.findById(att.creatorId).lean();
  if (!creator) return 'skipped';
  const cu = await User.findById(creator.userId).select('email').lean();
  const rules = await getRules();
  const decision = decideAttribution({
    touch: att.capturedAt && att.expiresAt ? { creatorId: String(creator._id), handle: creator.handle, capturedAt: att.capturedAt, expiresAt: att.expiresAt } : null,
    orderCreatedAt: order.createdAt as Date, referralCouponApplied: !!order.couponCode?.startsWith('FRIEND-'),
    buyer: { userId: order.userId ? String(order.userId) : undefined, normalizedEmail: canonicalEmailForAbuse(order.email) },
    creator: { userId: String(creator.userId), normalizedEmail: canonicalEmailForAbuse(cu?.email ?? ''), status: creator.status },
  });
  if (!decision.payable) {
    if (decision.reason === 'self_attribution') await openFlag(ctx, { creatorId: creator._id, orderId: order._id, kind: 'self_attribution', severity: 'low', detail: 'Creator bought through their own link; excluded', dedupeKey: `self:${orderId}`, status: 'confirmed' });
    await audit(ctx, { id: 'system', type: 'system' }, { action: 'creator.attribution_excluded', resource: 'order', resourceId: orderId, reason: decision.reason });
    return 'excluded';
  }
  const { flags, total90, refunded90 } = await fraudFacts(ctx, order, creator, rules);
  for (const f of flags) await openFlag(ctx, { creatorId: creator._id, orderId: f.kind === 'refund_rate' ? undefined : order._id, kind: f.kind, severity: f.severity, detail: f.detail, dedupeKey: f.kind === 'refund_rate' ? `refund_rate:${String(creator._id)}:${ctx.now().toISOString().slice(0, 7)}` : `${f.kind}:${orderId}` });
  const orders90d = await CreatorLedger.countDocuments({ creatorId: creator._id, kind: 'commission', status: { $ne: 'reversed' }, createdAt: { $gte: new Date(ctx.now().getTime() - 90 * DAY) } });
  const calc = computeCommission(await commissionInput(order), rules, termsOf(creator, orders90d));
  if (calc.commission <= 0) { await audit(ctx, { id: 'system', type: 'system' }, { action: 'creator.commission_zero', resource: 'order', resourceId: orderId, reason: calc.reasons.join(',') }); return 'zero'; }
  const cfg = await getCountry(order.country);
  const delivered = order.deliveredAt ?? ctx.now();
  const hold = holdUntil(delivered, cfg.returnWindowDays, rules, shouldEscalateHold(refunded90, total90, rules));
  try {
    await CreatorLedger.create({
      creatorId: creator._id, kind: 'commission', status: 'accrued', amount: calc.commission, currency: order.currency, orderId: order._id, idempotencyKey: `commission:${orderId}`, holdUntil: hold,
      detail: { orders90d, orderRef: `#${order.orderNumber.slice(-6)}`, orderedAt: order.createdAt, deliveredAt: delivered, netBase: calc.netBase, rate: calc.lines.length ? calc.commission / Math.max(1, calc.netBase) : 0, rateSource: calc.rateSource, tier: calc.tier ?? undefined, capped: calc.capped, reasons: calc.reasons, refundedAtCalc: order.costs?.refunded ?? 0, lines: calc.lines },
    });
  } catch (e) { if (isDup(e)) return 'skipped'; throw e; }
  await audit(ctx, { id: 'system', type: 'system' }, { action: 'creator.commission_accrued', resource: 'order', resourceId: orderId, newValue: { amount: calc.commission, currency: order.currency, holdUntil: hold } });
  return 'accrued';
}

/** Re-derive the commission from current refunds/cancellations and book the difference (in place while accrued, as a clawback once payable/paid). */
export async function reconcileOrderCommission(ctx: Ctx, orderId: string): Promise<'noop' | 'updated' | 'reversed' | 'clawback'> {
  const entries = await CreatorLedger.find({ orderId, kind: { $in: ['commission', 'clawback'] }, status: { $ne: 'reversed' } }).sort({ createdAt: 1 });
  const main = entries.find((e) => e.kind === 'commission');
  const order = await loadOrder(orderId);
  if (!main || !order) return 'noop';
  const creator = await CreatorProfile.findById(main.creatorId).lean();
  if (!creator) return 'noop';
  const forceZero = ['CANCELLED', 'REFUNDED'].includes(order.status) || !!(await CreatorFlag.exists({ orderId, status: 'confirmed' }));
  const rules = await getRules();
  const target = forceZero ? 0 : computeCommission(await commissionInput(order), rules, termsOf(creator, main.detail?.orders90d ?? 0)).commission;
  const delta = reconcileDelta(target, entries.reduce((a, e) => a + e.amount, 0));
  if (delta === 0) return 'noop';
  if (main.status === 'accrued') {
    const prev = main.amount;
    main.amount = target;
    if (target === 0) main.status = 'reversed';
    if (main.detail) main.detail.refundedAtCalc = order.costs?.refunded ?? 0;
    await main.save();
    await audit(ctx, { id: 'system', type: 'system' }, { action: 'creator.commission_adjusted', resource: 'order', resourceId: orderId, previousValue: { amount: prev }, newValue: { amount: target } });
    return target === 0 ? 'reversed' : 'updated';
  }
  if (delta > 0) return 'noop'; // never re-raise a commission that already became payable
  try {
    await CreatorLedger.create({
      creatorId: main.creatorId, kind: 'clawback', status: 'payable', amount: delta, currency: main.currency, orderId, payableAt: ctx.now(),
      idempotencyKey: `clawback:${orderId}:${order.costs?.refunded ?? 0}:${forceZero ? 'z' : 'p'}`, note: forceZero ? 'Order cancelled, refunded or charged back' : 'Partial refund',
      detail: { orderRef: main.detail?.orderRef, orderedAt: main.detail?.orderedAt, deliveredAt: main.detail?.deliveredAt, refundedAtCalc: order.costs?.refunded ?? 0 },
    });
  } catch (e) { if (isDup(e)) return 'noop'; throw e; }
  await audit(ctx, { id: 'system', type: 'system' }, { action: 'creator.commission_clawback', resource: 'order', resourceId: orderId, newValue: { amount: delta, currency: main.currency } });
  return 'clawback';
}

/** Release accrued commissions whose hold has elapsed (after re-checking refunds). Blocked by open review flags or a creator hold. */
export async function settleLedger(ctx: Ctx, limit = 500): Promise<{ released: number; held: number; reversed: number }> {
  const now = ctx.now();
  const due = await CreatorLedger.find({ kind: 'commission', status: 'accrued', holdUntil: { $lte: now } }).sort({ holdUntil: 1 }).limit(limit);
  let released = 0, held = 0, reversed = 0;
  for (const e of due) {
    if (e.orderId) await reconcileOrderCommission(ctx, String(e.orderId));
    const cur = await CreatorLedger.findById(e._id).lean();
    if (!cur || cur.status !== 'accrued') { if (cur?.status === 'reversed') reversed++; continue; }
    const creator = await CreatorProfile.findById(cur.creatorId).select('status payoutsHeld').lean();
    const openFlag = cur.orderId ? await CreatorFlag.exists({ orderId: cur.orderId, status: 'open' }) : null;
    const blocked = !creator || creator.status !== 'approved' || !!creator.payoutsHeld || !!openFlag;
    if (!isReleasable(cur, now, blocked)) { held++; continue; }
    const r = await CreatorLedger.updateOne({ _id: cur._id, status: 'accrued' }, { $set: { status: cur.amount > 0 ? 'payable' : 'reversed', payableAt: now } });
    if (r.modifiedCount) released++;
  }
  return { released, held, reversed };
}

/** Find recently refunded/cancelled orders that have ledger rows and reconcile them (clawback). */
export async function clawbackScan(ctx: Ctx, sinceHours = 6): Promise<{ checked: number; clawed: number }> {
  const since = new Date(ctx.now().getTime() - sinceHours * 3_600_000);
  const orders = await Order.find({ updatedAt: { $gte: since }, 'creatorAttribution.creatorId': { $exists: true }, $or: [{ 'costs.refunded': { $gt: 0 } }, { status: { $in: ['REFUNDED', 'CANCELLED'] } }] }).select('_id').limit(1000).lean();
  let clawed = 0;
  for (const o of orders) { const r = await reconcileOrderCommission(ctx, String(o._id)); if (r === 'clawback' || r === 'reversed' || r === 'updated') clawed++; }
  return { checked: orders.length, clawed };
}

/* ------------------------------ staff actions ------------------------------ */
export async function recordChargeback(ctx: Ctx, actor: Actor, orderId: string, note: string) {
  const entry = await CreatorLedger.findOne({ orderId, kind: 'commission' }).lean();
  if (!entry) throw notFound('Commission for this order');
  await openFlag(ctx, { creatorId: entry.creatorId, orderId, kind: 'chargeback', severity: 'high', detail: note.slice(0, 300), dedupeKey: `chargeback:${orderId}`, status: 'confirmed' });
  const r = await reconcileOrderCommission(ctx, orderId);
  await audit(ctx, actor, { action: 'creator.chargeback_recorded', resource: 'order', resourceId: orderId, reason: note, newValue: { result: r } });
  return { result: r };
}

export async function resolveFlag(ctx: Ctx, actor: Actor, id: string, resolution: 'cleared' | 'confirmed', note: string) {
  const f = await CreatorFlag.findOneAndUpdate({ _id: id, status: 'open' }, { $set: { status: resolution, resolvedBy: actor.id, resolvedAt: ctx.now(), resolution: note } }, { new: true }).lean();
  if (!f) throw conflict('Flag is not open', 'NOT_OPEN');
  if (resolution === 'confirmed' && f.orderId) await reconcileOrderCommission(ctx, String(f.orderId));
  await audit(ctx, actor, { action: 'creator.flag_resolved', resource: 'creator_flag', resourceId: id, newValue: { resolution }, reason: note });
  return f;
}

export async function holdCreatorPayouts(ctx: Ctx, actor: Actor, creatorId: string, held: boolean, reason?: string) {
  const r = await CreatorProfile.updateOne({ _id: creatorId }, { $set: { payoutsHeld: held, holdReason: held ? reason : undefined } });
  if (!r.matchedCount) throw notFound('Creator');
  await audit(ctx, actor, { action: held ? 'creator.payouts_held' : 'creator.payouts_released', resource: 'creator', resourceId: creatorId, reason });
}

export async function addAdjustment(ctx: Ctx, actor: Actor, creatorId: string, amount: number, currency: string, note: string) {
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 1_000_000_00) throw new DomainError('Invalid amount', 'VALIDATION', 400);
  if (!(await CreatorProfile.exists({ _id: creatorId }))) throw notFound('Creator');
  const e = await CreatorLedger.create({ creatorId, kind: 'adjustment', status: 'payable', amount, currency, payableAt: ctx.now(), idempotencyKey: `adjust:${randomUUID()}`, note: note.slice(0, 200), actor: actor.id });
  await audit(ctx, actor, { action: 'creator.adjustment', resource: 'creator', resourceId: creatorId, newValue: { amount, currency }, reason: note });
  return e;
}

/** Update per-creator commission override / payout checklist (staff). Stores only flags and opaque references. */
export async function updateCreatorTerms(ctx: Ctx, actor: Actor, creatorId: string, patch: { rateOverride?: number | null; kycStatus?: 'not_started' | 'collected' | 'verified' | 'rejected'; taxInfoCollected?: boolean; kycReference?: string; taxInfoReference?: string; method?: 'bank_transfer' | 'upi' | 'paypal' | 'other' }) {
  const set: Record<string, unknown> = {};
  const unset: Record<string, 1> = {};
  if (patch.rateOverride === null) unset.rateOverride = 1; else if (patch.rateOverride !== undefined) set.rateOverride = patch.rateOverride;
  const map: Record<string, unknown> = { kycStatus: patch.kycStatus, taxInfoCollected: patch.taxInfoCollected, kycReference: patch.kycReference, taxInfoReference: patch.taxInfoReference, method: patch.method };
  for (const [k, v] of Object.entries(map)) if (v !== undefined) set[`payoutProfile.${k}`] = v;
  if (patch.kycStatus || patch.taxInfoCollected !== undefined) { set['payoutProfile.verifiedBy'] = actor.id; set['payoutProfile.verifiedAt'] = ctx.now(); }
  const r = await CreatorProfile.updateOne({ _id: creatorId }, { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) });
  if (!r.matchedCount) throw notFound('Creator');
  await audit(ctx, actor, { action: 'creator.terms_updated', resource: 'creator', resourceId: creatorId, newValue: { ...patch, kycReference: patch.kycReference ? '[set]' : undefined, taxInfoReference: patch.taxInfoReference ? '[set]' : undefined } });
}

/* ------------------------------ reporting ------------------------------ */
export async function creatorBalances(creatorId: string) {
  const rows = await CreatorLedger.aggregate<{ _id: { c: string; s: string; locked: boolean }; sum: number }>([
    { $match: { creatorId: new (await import('mongoose')).Types.ObjectId(creatorId), status: { $ne: 'reversed' } } },
    { $group: { _id: { c: '$currency', s: '$status', locked: { $cond: [{ $ifNull: ['$payoutId', false] }, true, false] } }, sum: { $sum: '$amount' } } },
  ]);
  const out: Record<string, { accrued: number; payable: number; inPayout: number; paid: number }> = {};
  for (const r of rows) {
    const b = (out[r._id.c] ??= { accrued: 0, payable: 0, inPayout: 0, paid: 0 });
    if (r._id.s === 'accrued') b.accrued += r.sum;
    else if (r._id.s === 'paid') b.paid += r.sum;
    else if (r._id.locked) b.inPayout += r.sum;
    else b.payable += r.sum;
  }
  return out;
}

export async function listCommissions(creatorId: string, page: number, pageSize: number) {
  const f = { creatorId };
  const [total, rows] = await Promise.all([CreatorLedger.countDocuments(f), CreatorLedger.find(f).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean()]);
  return { total, page, pageSize, items: rows.map((r) => ({ id: String(r._id), kind: r.kind, status: r.status, amount: r.amount, currency: r.currency, orderRef: r.detail?.orderRef ?? null, netBase: r.detail?.netBase ?? null, rate: r.detail?.rate ?? null, holdUntil: r.holdUntil ?? null, note: r.note ?? null, createdAt: (r as { createdAt?: Date }).createdAt })) };
}

/** Per-creator metrics for a set of creators (one aggregate per source, bounded by the page of ids). */
export async function performanceFor(ids: string[], days = 90) {
  const { Types } = await import('mongoose');
  const oids = ids.map((i) => new Types.ObjectId(i));
  const since = new Date(Date.now() - days * DAY);
  const [clicks, orders, ledger] = await Promise.all([
    CreatorClick.aggregate<{ _id: unknown; n: number }>([{ $match: { creatorId: { $in: oids }, at: { $gte: since } } }, { $group: { _id: '$creatorId', n: { $sum: 1 } } }]),
    Order.aggregate<{ _id: unknown; orders: number; refunded: number }>([
      { $match: { 'creatorAttribution.creatorId': { $in: oids }, createdAt: { $gte: since }, 'payment.status': { $in: PAID_STATES } } },
      { $group: { _id: '$creatorAttribution.creatorId', orders: { $sum: 1 }, refunded: { $sum: { $cond: [{ $gt: ['$costs.refunded', 0] }, 1, 0] } } } },
    ]),
    CreatorLedger.aggregate<{ _id: { id: unknown; c: string; s: string; k: string }; sum: number; net: number }>([
      { $match: { creatorId: { $in: oids }, status: { $ne: 'reversed' } } },
      { $group: { _id: { id: '$creatorId', c: '$currency', s: '$status', k: '$kind' }, sum: { $sum: '$amount' }, net: { $sum: { $ifNull: ['$detail.netBase', 0] } } } },
    ]),
  ]);
  const out = new Map<string, { clicks: number; orders: number; refundRate: number | null; netSales: Record<string, number>; commission: Record<string, { accrued: number; payable: number; paid: number }> }>();
  for (const id of ids) out.set(id, { clicks: 0, orders: 0, refundRate: null, netSales: {}, commission: {} });
  for (const c of clicks) out.get(String(c._id))!.clicks = c.n;
  for (const o of orders) { const r = out.get(String(o._id))!; r.orders = o.orders; r.refundRate = o.orders ? o.refunded / o.orders : null; }
  for (const l of ledger) {
    const r = out.get(String(l._id.id))!;
    if (l._id.k === 'commission') r.netSales[l._id.c] = (r.netSales[l._id.c] ?? 0) + l.net;
    const b = (r.commission[l._id.c] ??= { accrued: 0, payable: 0, paid: 0 });
    if (l._id.s === 'accrued') b.accrued += l.sum; else if (l._id.s === 'paid') b.paid += l.sum; else b.payable += l.sum;
  }
  return out;
}

export async function adminCreatorsTable(q: { status?: string; search?: string; page: number; pageSize: number }) {
  const f: Record<string, unknown> = {};
  if (q.status) f.status = q.status;
  if (q.search) f.$or = [{ handle: new RegExp(`^${q.search.toLowerCase().replace(/[^a-z0-9_-]/g, '')}`) }];
  const [total, rows] = await Promise.all([CreatorProfile.countDocuments(f), CreatorProfile.find(f).sort({ createdAt: -1 }).skip((q.page - 1) * q.pageSize).limit(q.pageSize).lean()]);
  const perf = await performanceFor(rows.map((r) => String(r._id)));
  const users = await User.find({ _id: { $in: rows.map((r) => r.userId) } }).select('email').lean();
  const email = new Map(users.map((u) => [String(u._id), u.email]));
  return {
    total, page: q.page, pageSize: q.pageSize,
    items: rows.map((r) => ({
      id: String(r._id), handle: r.handle, displayName: r.displayName, email: email.get(String(r.userId)) ?? '', status: r.status, appliedAt: r.appliedAt, audience: r.audience ?? '', socialLinks: r.socialLinks ?? [], bio: r.bio ?? '',
      rateOverride: r.rateOverride ?? null, payoutsHeld: !!r.payoutsHeld, payout: { kycStatus: r.payoutProfile?.kycStatus ?? 'not_started', taxInfoCollected: !!r.payoutProfile?.taxInfoCollected }, performance: perf.get(String(r._id))!,
    })),
  };
}

export async function listFlags(status: string, page: number, pageSize: number) {
  const f = status === 'all' ? {} : { status };
  const [total, rows] = await Promise.all([CreatorFlag.countDocuments(f), CreatorFlag.find(f).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean()]);
  const cs = await CreatorProfile.find({ _id: { $in: rows.map((r) => r.creatorId) } }).select('handle').lean();
  const h = new Map(cs.map((c) => [String(c._id), c.handle]));
  return { total, page, pageSize, items: rows.map((r) => ({ id: String(r._id), creatorId: String(r.creatorId), handle: h.get(String(r.creatorId)) ?? '', orderId: r.orderId ? String(r.orderId) : null, kind: r.kind, severity: r.severity, detail: r.detail, status: r.status, resolution: r.resolution ?? null, createdAt: (r as { createdAt?: Date }).createdAt })) };
}
