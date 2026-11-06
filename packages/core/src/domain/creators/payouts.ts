/**
 * Payouts. EXECUTION IS MANUAL: staff transfer the money through the bank/PSP console, then record the method and
 * external reference here. There is no payout provider adapter and nothing in this code moves money.
 */
import { AFFILIATE_DISCLOSURE } from '@orvia/types';
import { CreatorFlag, CreatorLedger, CreatorPayout, CreatorProfile } from '@orvia/database';
import { DomainError, conflict, notFound } from '../../infra/context';
import type { Actor, Ctx } from '../../infra/context';
import { audit } from '../../infra/audit';
import { getRules } from './config';
import { buildStatement, statementCsv, statementHtml } from './statement';
import type { StatementEntry } from './statement';

type Currency = 'USD' | 'CAD' | 'INR';

export function payoutChecklist(p: { payoutProfile?: { kycStatus?: string | null; taxInfoCollected?: boolean | null } | null; payoutsHeld?: boolean | null }, amount: number, threshold: number, openFlags: number) {
  return { kycOk: p.payoutProfile?.kycStatus === 'verified', taxOk: !!p.payoutProfile?.taxInfoCollected, thresholdOk: amount >= threshold && amount > 0, noOpenFlags: openFlags === 0 && !p.payoutsHeld };
}

export async function requestPayout(ctx: Ctx, creator: { _id: unknown }, input: { currency: Currency; note?: string }) {
  const p = await CreatorProfile.findById(creator._id).lean();
  if (!p || p.status !== 'approved') throw new DomainError('Creator account is not approved', 'CREATOR_NOT_APPROVED', 403);
  const rules = await getRules();
  const threshold = rules.payoutThreshold[input.currency] ?? 0;
  const pre = payoutChecklist(p, threshold, threshold, 0);
  if (!pre.kycOk || !pre.taxOk) throw new DomainError('Payout details must be verified first. Support collects identity and tax information through a secure channel.', 'PAYOUT_PROFILE_INCOMPLETE', 422, { kycOk: pre.kycOk, taxOk: pre.taxOk });
  if (p.payoutsHeld) throw new DomainError('Payouts are on hold for this account. Contact support.', 'PAYOUTS_HELD', 409);
  let payout;
  try {
    payout = await CreatorPayout.create({ creatorId: p._id, currency: input.currency, amount: 0, status: 'requested', requestedAt: ctx.now(), note: input.note });
  } catch (e) {
    if ((e as { code?: number }).code === 11000) throw conflict('You already have an open payout request in this currency', 'PAYOUT_OPEN');
    throw e;
  }
  // claim every unlocked payable row atomically-per-row, then verify the total
  await CreatorLedger.updateMany({ creatorId: p._id, currency: input.currency, status: 'payable', payoutId: { $exists: false } }, { $set: { payoutId: payout._id } });
  const rows = await CreatorLedger.find({ payoutId: payout._id }).select('amount').lean();
  const amount = rows.reduce((a, r) => a + r.amount, 0);
  if (amount < threshold || amount <= 0) {
    await CreatorLedger.updateMany({ payoutId: payout._id }, { $unset: { payoutId: 1 } });
    await CreatorPayout.deleteOne({ _id: payout._id });
    throw new DomainError('Your payable balance is below the payout threshold', 'BELOW_THRESHOLD', 422, { balance: amount, threshold });
  }
  payout.amount = amount;
  payout.entryCount = rows.length;
  await payout.save();
  await audit(ctx, { id: String(p.userId), type: 'user' }, { action: 'creator.payout_requested', resource: 'creator_payout', resourceId: String(payout._id), newValue: { amount, currency: input.currency } });
  return payoutView(payout.toObject());
}

const payoutView = (p: { _id: unknown; currency?: string | null; amount: number; status?: string | null; entryCount?: number | null; requestedAt?: Date | null; paidAt?: Date | null; method?: string | null; externalReference?: string | null; rejectedReason?: string | null }) => ({
  id: String(p._id), currency: p.currency ?? '', amount: p.amount, status: p.status ?? '', entryCount: p.entryCount ?? 0, requestedAt: p.requestedAt ?? null, paidAt: p.paidAt ?? null, method: p.method ?? null, externalReference: p.externalReference ?? null, rejectedReason: p.rejectedReason ?? null,
});

export async function listMyPayouts(creatorId: string) {
  return (await CreatorPayout.find({ creatorId }).sort({ createdAt: -1 }).limit(50).lean()).map(payoutView);
}

export async function adminListPayouts(status: string, page: number, pageSize: number) {
  const f = status === 'all' ? {} : { status };
  const [total, rows] = await Promise.all([CreatorPayout.countDocuments(f), CreatorPayout.find(f).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean()]);
  const cs = await CreatorProfile.find({ _id: { $in: rows.map((r) => r.creatorId) } }).select('handle payoutProfile payoutsHeld').lean();
  const m = new Map(cs.map((c) => [String(c._id), c]));
  const rules = await getRules();
  const items = await Promise.all(rows.map(async (r) => {
    const c = m.get(String(r.creatorId));
    const flags = await CreatorFlag.countDocuments({ creatorId: r.creatorId, status: 'open', severity: { $in: ['high', 'medium'] } });
    return { ...payoutView(r), creatorId: String(r.creatorId), handle: c?.handle ?? '', checklist: c ? payoutChecklist(c, r.amount, rules.payoutThreshold[r.currency as Currency] ?? 0, flags) : null };
  }));
  return { total, page, pageSize, items };
}

export async function approvePayout(ctx: Ctx, actor: Actor, id: string) {
  const p = await CreatorPayout.findById(id);
  if (!p) throw notFound('Payout');
  if (p.status !== 'requested') throw conflict('Payout is not awaiting approval', 'BAD_STATE');
  const c = await CreatorProfile.findById(p.creatorId).lean();
  const flags = await CreatorFlag.countDocuments({ creatorId: p.creatorId, status: 'open', severity: { $in: ['high', 'medium'] } });
  const rules = await getRules();
  const cl = payoutChecklist(c ?? {}, p.amount, rules.payoutThreshold[p.currency as Currency] ?? 0, flags);
  if (!c || !Object.values(cl).every(Boolean)) throw new DomainError('Payout checklist is not complete', 'CHECKLIST', 422, cl);
  p.status = 'approved'; p.approvedBy = actor.id; p.approvedAt = ctx.now(); p.checklist = cl;
  await p.save();
  await audit(ctx, actor, { action: 'creator.payout_approved', resource: 'creator_payout', resourceId: id, newValue: { amount: p.amount, currency: p.currency } });
  return payoutView(p.toObject());
}

export async function rejectPayout(ctx: Ctx, actor: Actor, id: string, reason: string) {
  const p = await CreatorPayout.findOneAndUpdate({ _id: id, status: { $in: ['requested', 'approved'] } }, { $set: { status: 'rejected', rejectedReason: reason } }, { new: true });
  if (!p) throw conflict('Payout cannot be rejected', 'BAD_STATE');
  await CreatorLedger.updateMany({ payoutId: p._id, status: 'payable' }, { $unset: { payoutId: 1 } });
  await audit(ctx, actor, { action: 'creator.payout_rejected', resource: 'creator_payout', resourceId: id, reason });
  return payoutView(p.toObject());
}

/** Record that staff executed the transfer out-of-band. Locks the ledger rows as paid. */
export async function markPayoutPaid(ctx: Ctx, actor: Actor, id: string, input: { method: string; externalReference: string }) {
  const p = await CreatorPayout.findOneAndUpdate({ _id: id, status: 'approved' }, { $set: { status: 'paid', paidBy: actor.id, paidAt: ctx.now(), method: input.method, externalReference: input.externalReference } }, { new: true });
  if (!p) throw conflict('Payout must be approved first', 'BAD_STATE');
  await CreatorLedger.updateMany({ payoutId: p._id }, { $set: { status: 'paid', paidAt: ctx.now() } });
  await audit(ctx, actor, { action: 'creator.payout_paid', resource: 'creator_payout', resourceId: id, newValue: { amount: p.amount, currency: p.currency, method: input.method, externalReference: input.externalReference } });
  return payoutView(p.toObject());
}

/** Statement for one payout. Ownership is part of the query: another creator's id simply 404s. */
export async function payoutStatement(creatorId: string, payoutId: string, format: 'json' | 'csv' | 'html') {
  const p = await CreatorPayout.findOne({ _id: payoutId, creatorId }).lean();
  if (!p) throw notFound('Payout');
  const c = await CreatorProfile.findById(creatorId).select('handle').lean();
  const rows = await CreatorLedger.find({ payoutId: p._id }).lean();
  const entries: StatementEntry[] = rows.map((r) => ({
    id: String(r._id), kind: r.kind as StatementEntry['kind'], status: r.status ?? '', amount: r.amount, currency: r.currency ?? '', orderRef: r.detail?.orderRef ?? undefined, orderedAt: r.detail?.orderedAt, deliveredAt: r.detail?.deliveredAt,
    holdUntil: r.holdUntil, netBase: r.detail?.netBase ?? undefined, rate: r.detail?.rate ?? undefined, rateSource: r.detail?.rateSource ?? undefined, capped: r.detail?.capped ?? [], note: r.note ?? undefined,
  }));
  const st = buildStatement({ handle: c?.handle ?? '', currency: p.currency ?? '', period: `Payout requested ${p.requestedAt?.toISOString().slice(0, 10) ?? ''}`, payoutId: String(p._id), payoutAmount: p.amount, entries, disclosure: AFFILIATE_DISCLOSURE });
  if (format === 'csv') return { contentType: 'text/csv; charset=utf-8', body: statementCsv(st), statement: st };
  if (format === 'html') return { contentType: 'text/html; charset=utf-8', body: statementHtml(st), statement: st };
  return { contentType: 'application/json', body: '', statement: st };
}
