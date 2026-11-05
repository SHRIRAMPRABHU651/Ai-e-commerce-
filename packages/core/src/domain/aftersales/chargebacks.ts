/**
 * Chargeback / dispute management. Disputes arrive from verified provider webhooks (Stripe `charge.dispute.*`,
 * Razorpay `payment.dispute.*`) and are stored one-per-(provider, disputeId) so replays only update state.
 * Staff record evidence here; submission to the provider API is behind the adapter and UNVERIFIED without live credentials.
 */
import { AftersalesChargeback, ExceptionModel, Order, Payment } from '@orvia/database';
import type { ProviderDispute } from '@orvia/payments';
import type { ChargebackState } from '@orvia/types';
import { audit } from '../../infra/audit';
import { conflict, DomainError, notFound } from '../../infra/context';
import type { Actor, Ctx } from '../../infra/context';
import { raiseException } from '../exceptions';
import { chargebackRate, chargebackReserve, CHARGEBACK_ATTENTION_RATE, deadlineState, nextChargebackState, sumReserves } from './chargebackRules';
import { CHARGEBACK_MACHINE, assertTransition } from './stateMachines';

const OPEN: ChargebackState[] = ['warning', 'needs_response', 'evidence_recorded', 'submitted', 'under_review'];
const WEBHOOK_ACTOR: Actor = { id: 'webhook', type: 'webhook' };

export type DisputeOutcome = 'created' | 'updated' | 'unchanged' | 'unmatched';

/** Idempotent: safe for duplicate and out-of-order provider events. */
export async function ingestDispute(ctx: Ctx, providerKey: string, eventId: string, d: ProviderDispute): Promise<DisputeOutcome> {
  let intentId = d.intentId || undefined;
  if (!intentId && d.chargeId) {
    const prov = ctx.payments.get(providerKey);
    intentId = (await prov.resolveIntentFromCharge?.(d.chargeId).catch(() => null)) ?? undefined;
  }
  const pay = intentId ? await Payment.findOne({ provider: providerKey, intentId }).select('orderId currency').lean() : null;
  const order = pay ? await Order.findById(pay.orderId).select('orderNumber country currency').lean() : null;

  const base = {
    intentId, chargeId: d.chargeId, amount: d.amount, currency: (d.currency || pay?.currency || '').toUpperCase(), reason: d.reason, providerStatus: d.providerStatus,
    ...(d.fee !== undefined ? { fee: d.fee } : {}), ...(d.evidenceDueBy ? { evidenceDueBy: d.evidenceDueBy } : {}), ...(d.openedAt ? { openedAt: d.openedAt } : {}),
    ...(pay ? { orderId: pay.orderId, paymentId: pay._id, orderNumber: order?.orderNumber, country: order?.country } : {}),
  };

  let doc = await AftersalesChargeback.findOne({ provider: providerKey, disputeId: d.disputeId });
  let outcome: DisputeOutcome = 'updated';
  if (!doc) {
    try {
      doc = await AftersalesChargeback.create({
        provider: providerKey, disputeId: d.disputeId, ...base, state: d.state, unmatched: !pay, lastEventId: eventId,
        timeline: [{ state: d.state, at: ctx.now(), actor: 'webhook', note: `Dispute opened with provider status "${d.providerStatus}"` }],
      });
      outcome = pay ? 'created' : 'unmatched';
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e;
      doc = await AftersalesChargeback.findOne({ provider: providerKey, disputeId: d.disputeId });
    }
  }
  if (!doc) throw new DomainError('Dispute could not be stored', 'INTERNAL', 500);

  if (outcome === 'updated') {
    if (doc.lastEventId === eventId) return 'unchanged';
    const prev = doc.state as ChargebackState;
    const next = nextChargebackState(prev, d.state);
    doc.set({ ...base, unmatched: doc.unmatched && !pay, lastEventId: eventId });
    if (next !== prev) {
      doc.state = next;
      doc.timeline.push({ state: next, at: ctx.now(), actor: 'webhook', note: `Provider status "${d.providerStatus}"` });
      if (['won', 'lost', 'closed'].includes(next)) doc.closedAt = ctx.now();
    }
    await doc.save();
    if (next !== prev) await audit(ctx, WEBHOOK_ACTOR, { action: 'chargeback.state', resource: 'chargeback', resourceId: String(doc._id), previousValue: { state: prev }, newValue: { state: next }, provider: providerKey });
  } else {
    await audit(ctx, WEBHOOK_ACTOR, { action: 'chargeback.opened', resource: 'chargeback', resourceId: String(doc._id), newValue: { amount: d.amount, currency: base.currency, reason: d.reason, dueBy: d.evidenceDueBy }, provider: providerKey });
  }

  const key = `chargeback:${providerKey}:${d.disputeId}`;
  if (OPEN.includes(doc.state as ChargebackState) && doc.state !== 'warning') {
    // No orderId on purpose: raiseException(orderId) would flip the order into EXCEPTION status.
    await raiseException(ctx, {
      kind: 'CHARGEBACK', priority: 'critical', customerEmail: undefined,
      issue: `Chargeback ${d.disputeId}: ${doc.currency} ${(d.amount / 100).toFixed(2)} disputed${order ? ` on ${order.orderNumber}` : ' (order not matched)'}${doc.evidenceDueBy ? `, evidence due ${doc.evidenceDueBy.toISOString().slice(0, 10)}` : ''}`,
      aiRecommendation: 'Gather proof of delivery and customer communication, then record evidence in Returns → Chargebacks before the deadline.',
      suggestedAction: 'Respond to chargeback', actionCode: 'dismiss', details: { chargebackId: String(doc._id), orderNumber: order?.orderNumber }, dedupeKey: key,
    });
  }
  if (['won', 'lost', 'closed', 'accepted'].includes(doc.state)) {
    await ExceptionModel.updateMany({ dedupeKey: { $regex: `^(chargeback|chargeback-due):${providerKey}:${d.disputeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` }, status: { $in: ['open', 'in_progress'] } }, { $set: { status: 'resolved', resolution: `Dispute ${doc.state}`, resolvedBy: 'webhook', resolvedAt: new Date() } });
  }
  return doc.unmatched ? 'unmatched' : outcome;
}

export async function recordChargebackEvidence(ctx: Ctx, id: string, input: { text: string; category: string }, actor: Actor) {
  const cb = await AftersalesChargeback.findById(id);
  if (!cb) throw notFound('Chargeback');
  const from = cb.state as ChargebackState;
  if (!['warning', 'needs_response', 'evidence_recorded'].includes(from)) throw conflict(`Chargeback is ${from}; evidence can no longer be added`);
  cb.evidence.push({ at: ctx.now(), by: actor.id, category: input.category, text: input.text });
  if (from !== 'warning') {
    if (from !== 'evidence_recorded') assertTransition(CHARGEBACK_MACHINE, from, 'evidence_recorded', 'Chargeback');
    cb.state = 'evidence_recorded';
    if (from !== 'evidence_recorded') cb.timeline.push({ state: 'evidence_recorded', at: ctx.now(), actor: actor.id, note: 'Evidence recorded' });
  }
  await cb.save();
  await audit(ctx, actor, { action: 'chargeback.evidence_recorded', resource: 'chargeback', resourceId: id, newValue: { category: input.category, chars: input.text.length } });
  return cb;
}

/** Sends the recorded evidence to the provider. The call is UNVERIFIED without live credentials; the result is recorded as `submitted_unverified`. */
export async function submitChargebackEvidence(ctx: Ctx, id: string, actor: Actor) {
  const cb = await AftersalesChargeback.findById(id);
  if (!cb) throw notFound('Chargeback');
  const from = cb.state as ChargebackState;
  if (!['needs_response', 'evidence_recorded'].includes(from)) throw conflict(`Chargeback is ${from}; evidence cannot be submitted`);
  if (!cb.evidence.length) throw new DomainError('Record at least one piece of evidence first', 'NO_EVIDENCE', 422);
  if (cb.evidenceDueBy && cb.evidenceDueBy.getTime() < ctx.now().getTime()) throw new DomainError('The evidence deadline has passed', 'DEADLINE_PASSED', 409);
  const provider = ctx.payments.get(cb.provider);
  if (!provider.submitDisputeEvidence) {
    cb.submission = { status: 'unsupported', at: ctx.now(), by: actor.id, error: 'Provider adapter does not support evidence submission; submit manually in the provider dashboard', providerStatus: undefined } as never;
    await cb.save();
    return cb;
  }
  const summary = cb.evidence.map((e) => `[${e.category}] ${e.text}`).join('\n\n');
  try {
    const r = await provider.submitDisputeEvidence({ disputeId: cb.disputeId, summary, submit: true });
    assertTransition(CHARGEBACK_MACHINE, cb.state as ChargebackState, 'submitted', 'Chargeback');
    cb.state = 'submitted';
    cb.submission = { status: 'submitted_unverified', at: ctx.now(), by: actor.id, providerStatus: r.providerStatus } as never;
    cb.timeline.push({ state: 'submitted', at: ctx.now(), actor: actor.id, note: 'Evidence sent to provider (unverified: confirm in the provider dashboard)' });
  } catch (e) {
    cb.submission = { status: 'failed', at: ctx.now(), by: actor.id, error: (e as Error).message.slice(0, 300) } as never;
  }
  await cb.save();
  await audit(ctx, actor, { action: 'chargeback.evidence_submitted', resource: 'chargeback', resourceId: id, newValue: { status: (cb.submission as { status?: string } | undefined)?.status }, provider: cb.provider });
  return cb;
}

export async function acceptChargeback(ctx: Ctx, id: string, actor: Actor, note = '') {
  const cb = await AftersalesChargeback.findById(id);
  if (!cb) throw notFound('Chargeback');
  assertTransition(CHARGEBACK_MACHINE, cb.state as ChargebackState, 'accepted', 'Chargeback');
  cb.state = 'accepted';
  cb.accepted = { by: actor.id, at: ctx.now() };
  cb.closedAt = ctx.now();
  cb.timeline.push({ state: 'accepted', at: ctx.now(), actor: actor.id, note: note || 'Dispute accepted (not contested)' });
  await cb.save();
  await audit(ctx, actor, { action: 'chargeback.accepted', resource: 'chargeback', resourceId: id, newValue: { amount: cb.amount }, reason: note });
  return cb;
}

export async function listChargebacks(filter: { state?: string }, page: number, pageSize: number, now = new Date()) {
  const q = filter.state ? { state: filter.state } : {};
  const [rows, total] = await Promise.all([
    AftersalesChargeback.find(q).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
    AftersalesChargeback.countDocuments(q),
  ]);
  return {
    total, page, pageSize,
    items: rows.map((c) => ({ ...c, deadline: deadlineState(now, c.evidenceDueBy, c.state as ChargebackState), reserve: chargebackReserve({ state: c.state as ChargebackState, amount: c.amount ?? 0, fee: c.fee }) })),
  };
}

/** Finance hook: reserve held / lost per currency. Pure helper `sumReserves` is exported for callers that already hold rows. */
export async function chargebackReserveSummary(): Promise<{ currency: string; held: number; lost: number; released: number; fee: number; open: number }[]> {
  const rows = await AftersalesChargeback.find({}).select('state amount fee currency').limit(20_000).lean();
  const by = new Map<string, typeof rows>();
  for (const r of rows) by.set(r.currency ?? '', [...(by.get(r.currency ?? '') ?? []), r]);
  return [...by].map(([currency, items]) => ({ currency, ...sumReserves(items.map((c) => ({ state: c.state as ChargebackState, amount: c.amount ?? 0, fee: c.fee ?? 0 }))), open: items.filter((c) => OPEN.includes(c.state as ChargebackState)).length }));
}

export async function chargebackMetrics(ctx: Ctx, sinceDays = 90) {
  const since = new Date(ctx.now().getTime() - sinceDays * 86_400_000);
  const [disputes, pays, open, reserve] = await Promise.all([
    AftersalesChargeback.find({ $or: [{ openedAt: { $gte: since } }, { openedAt: { $exists: false }, createdAt: { $gte: since } }] }).select('amount currency provider state').limit(20_000).lean(),
    Payment.aggregate<{ _id: string; n: number; amount: number }>([{ $match: { status: { $in: ['succeeded', 'partially_refunded', 'refunded'] }, createdAt: { $gte: since } } }, { $group: { _id: '$currency', n: { $sum: 1 }, amount: { $sum: '$amount' } } }]),
    AftersalesChargeback.find({ state: { $in: OPEN } }).select('evidenceDueBy state').limit(2000).lean(),
    chargebackReserveSummary(),
  ]);
  const transactions = pays.reduce((a, p) => a + p.n, 0);
  const overall = chargebackRate({ disputes: disputes.length, transactions, disputedAmount: 0, transactedAmount: 0 });
  const byCurrency = pays.map((p) => {
    const ds = disputes.filter((d) => d.currency === p._id);
    return { currency: p._id, ...chargebackRate({ disputes: ds.length, transactions: p.n, disputedAmount: ds.reduce((a, d) => a + (d.amount ?? 0), 0), transactedAmount: p.amount }) };
  });
  const byProvider: Record<string, number> = {};
  for (const d of disputes) byProvider[d.provider] = (byProvider[d.provider] ?? 0) + 1;
  return {
    windowDays: sinceDays,
    rate: overall,
    attention: overall.reliable && overall.countRate !== null && overall.countRate >= CHARGEBACK_ATTENTION_RATE,
    attentionRate: CHARGEBACK_ATTENTION_RATE,
    byCurrency, byProvider,
    won: disputes.filter((d) => d.state === 'won').length,
    lost: disputes.filter((d) => ['lost', 'accepted'].includes(d.state)).length,
    open: open.length,
    overdue: open.filter((d) => deadlineState(ctx.now(), d.evidenceDueBy, d.state as ChargebackState) === 'overdue').length,
    dueSoon: open.filter((d) => deadlineState(ctx.now(), d.evidenceDueBy, d.state as ChargebackState) === 'due_soon').length,
    reserve,
  };
}

/** Job: escalate disputes whose evidence deadline is near or passed. Deduplicated per dispute and severity. */
export async function checkChargebackDeadlines(ctx: Ctx): Promise<{ checked: number; raised: number }> {
  const rows = await AftersalesChargeback.find({ state: { $in: ['needs_response', 'evidence_recorded'] }, evidenceDueBy: { $exists: true } }).sort({ evidenceDueBy: 1 }).limit(500).lean();
  let raised = 0;
  for (const c of rows) {
    const ds = deadlineState(ctx.now(), c.evidenceDueBy, c.state as ChargebackState);
    if (ds !== 'due_soon' && ds !== 'overdue') continue;
    await raiseException(ctx, {
      kind: 'CHARGEBACK', priority: 'critical',
      issue: ds === 'overdue' ? `Chargeback ${c.disputeId} evidence deadline has PASSED (${c.currency} ${((c.amount ?? 0) / 100).toFixed(2)} at risk)` : `Chargeback ${c.disputeId} evidence is due within 72h (${c.evidenceDueBy?.toISOString()})`,
      aiRecommendation: 'Submit evidence now or accept the dispute.', suggestedAction: 'Respond to chargeback', actionCode: 'dismiss', details: { chargebackId: String(c._id) }, dedupeKey: `chargeback-due:${c.provider}:${c.disputeId}:${ds}`,
    });
    raised++;
  }
  return { checked: rows.length, raised };
}
