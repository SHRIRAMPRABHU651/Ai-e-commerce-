/** SLA measurement, disputes, return authorizations and supplier payables reconciliation (IO layer). */
import { randomToken } from '@orvia/auth';
import { Order, Refund, Shipment, Supplier, SuppliernetDispute, SuppliernetProfile, SuppliernetReturnAuth, SuppliernetSla, SuppliernetSlaSnapshot, SuppliernetStatement, SuppliernetStockCheck } from '@orvia/database';
import { convertMinor, slaDefinitionSchema } from '@orvia/types';
import type { Currency, DisputeState, ReturnAuthState, SlaDefinition } from '@orvia/types';
import { audit } from '../../infra/audit';
import { DomainError, notFound } from '../../infra/context';
import type { Actor, Ctx } from '../../infra/context';
import { raiseException } from '../exceptions';
import { isStockSampleAccurate, decideDemotion, canDisputeTransition } from './gating';
import { disputableAmount, parseStatementCsv, reconcileStatement } from './reconcile';
import type { RecordedSupplierOrder, StatementLineIn } from './reconcile';
import { computeSlaMetrics, deliveredOnTime, evaluateBreaches, toSlaFacts } from './sla';
import type { SlaRawFacts, SupplierSlaFacts } from './sla';
import { transitionSupplier } from './service';

const objId = (v: unknown) => String(v);
const DAY = 86_400_000;

/* ----------------------------------- SLA ----------------------------------- */
export async function getSlaDefinition(supplierId: string): Promise<SlaDefinition> {
  const d = await SuppliernetSla.findOne({ supplierId }).lean();
  return slaDefinitionSchema.parse(d?.definition ?? {});
}
export async function setSlaDefinition(ctx: Ctx, supplierId: string, input: unknown, actor: Actor): Promise<SlaDefinition> {
  const def = slaDefinitionSchema.parse(input);
  if (!(await Supplier.exists({ _id: supplierId }))) throw notFound('Supplier');
  await SuppliernetSla.updateOne({ supplierId }, { $set: { definition: def, updatedBy: actor.id } }, { upsert: true });
  await audit(ctx, actor, { action: 'suppliernet.sla_defined', resource: 'supplier', resourceId: supplierId, newValue: def });
  return def;
}

export async function gatherSlaFacts(ctx: Ctx, supplierId: string, def: SlaDefinition): Promise<SlaRawFacts> {
  const now = ctx.now();
  const since = new Date(now.getTime() - def.windowDays * DAY);
  const [sup, prof] = await Promise.all([Supplier.findById(supplierId).select('avgResponseMs').lean(), SuppliernetProfile.findOne({ supplierId }).select('profile').lean()]);
  const handling = (prof?.profile as { leadTimes?: { handlingDays?: number } } | undefined)?.leadTimes?.handlingDays ?? 3;
  const ships = await Shipment.find({ supplierId, createdAt: { $gte: since }, status: { $ne: 'PENDING_CREATE' } }).select('status events estimatedDelivery orderId createdAt').limit(5000).lean();
  const shippedSet = ['SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'RETURNED'];
  const delivered = ships.filter((s) => s.status === 'DELIVERED');
  let withEta = 0, onTime = 0;
  for (const s of delivered) {
    if (!s.estimatedDelivery) continue;
    const at = [...(s.events ?? [])].reverse().find((e) => e.status === 'DELIVERED')?.at;
    if (!at) continue;
    withEta++;
    if (deliveredOnTime(new Date(at), new Date(s.estimatedDelivery))) onTime++;
  }
  const deliveredOrderIds = delivered.map((s) => s.orderId);
  const refunds = deliveredOrderIds.length ? (await Refund.distinct('orderId', { orderId: { $in: deliveredOrderIds }, status: 'succeeded' })).length : 0;
  const defects = await SuppliernetDispute.countDocuments({ supplierId, type: { $in: ['defective', 'wrong_item'] }, createdAt: { $gte: since }, state: { $nin: ['rejected', 'resolved_no_action'] } });
  const checks = await SuppliernetStockCheck.find({ supplierId, checkedAt: { $gte: since }, observed: { $ne: null } }).select('claimed observed').limit(2000).lean();
  return {
    windowDays: def.windowDays, assigned: ships.length, shipped: ships.filter((s) => shippedSet.includes(s.status)).length, failed: ships.filter((s) => s.status === 'FAILED').length,
    cancelled: ships.filter((s) => s.status === 'CANCELLED').length,
    overdueUnshipped: ships.filter((s) => s.status === 'CREATED' && now.getTime() - new Date((s as unknown as { createdAt: Date }).createdAt).getTime() > (handling + 2) * DAY).length,
    deliveredWithEta: withEta, deliveredOnTime: onTime, delivered: delivered.length, refunds, defects,
    stockChecks: checks.length, stockAccurate: checks.filter((c) => isStockSampleAccurate({ claimed: c.claimed, observed: c.observed ?? 0 })).length,
    avgResponseMs: sup?.avgResponseMs ?? null,
  };
}

export async function computeAndStoreSla(ctx: Ctx, supplierId: string, actor: Actor) {
  const def = await getSlaDefinition(supplierId);
  const facts = await gatherSlaFacts(ctx, supplierId, def);
  const metrics = computeSlaMetrics(facts, def);
  const { breaches, worst } = evaluateBreaches(metrics, def);
  await SuppliernetSlaSnapshot.create({ supplierId, computedAt: ctx.now(), windowDays: def.windowDays, facts, metrics, breaches, worst });
  const sup = await Supplier.findById(supplierId).select('name code network').lean();
  let demoted = false;
  if (sup && breaches.length) {
    await raiseException(ctx, { kind: 'SUPPLIER_FAILURE', priority: worst === 'critical' ? 'high' : 'medium', issue: `Supplier ${sup.name} breaches its SLA: ${breaches.map((b) => `${b.metric} ${b.severity}`).join(', ')}`, aiRecommendation: 'Review the SLA board; open a dispute or pause the supplier.', suggestedAction: 'Review supplier SLA', actionCode: 'dismiss', dedupeKey: `suppliernet:sla:${supplierId}` });
  }
  if (sup?.network?.state) {
    const d = decideDemotion(sup.network.state, worst);
    if (d.demote && d.to) { await transitionSupplier(ctx, supplierId, d.to, d.reason, actor, { system: true }); demoted = true; }
  }
  return { facts, metrics, breaches, worst, demoted };
}

export async function runSlaJob(ctx: Ctx): Promise<{ suppliers: number; breached: number; demoted: number }> {
  const sups = await Supplier.find({ 'network.state': { $in: ['probation', 'approved'] } }).select('_id').limit(500).lean();
  let breached = 0, demoted = 0;
  for (const s of sups) {
    const r = await computeAndStoreSla(ctx, objId(s._id), { id: 'system', type: 'system' });
    if (r.breaches.length) breached++;
    if (r.demoted) demoted++;
  }
  return { suppliers: sups.length, breached, demoted };
}

/** Pure-shaped read helper for the `trust` workstream: operational SLA facts from the latest snapshot ("insufficient data" => null fields). */
export async function getSupplierSlaFacts(supplierId: string): Promise<SupplierSlaFacts> {
  const snap = await SuppliernetSlaSnapshot.findOne({ supplierId }).sort({ computedAt: -1 }).lean();
  return toSlaFacts(supplierId, snap as never);
}

/* --------------------------------- disputes -------------------------------- */
const number = (p: string) => `${p}-${new Date().getFullYear().toString().slice(2)}${randomToken(4).toUpperCase().replace(/[^A-Z0-9]/g, 'X').slice(0, 6)}`;

export async function openDispute(ctx: Ctx, i: { supplierId: string; type: string; orderId?: string; shipmentId?: string; statementId?: string; amountMinor: number; currency: string; summary: string }, actor: Actor) {
  if (!(await Supplier.exists({ _id: i.supplierId }))) throw notFound('Supplier');
  if (i.shipmentId) {
    const sh = await Shipment.findById(i.shipmentId).select('supplierId').lean();
    if (!sh || objId(sh.supplierId) !== i.supplierId) throw new DomainError('Shipment does not belong to this supplier', 'VALIDATION', 422);
  }
  const d = await SuppliernetDispute.create({ ...i, number: number('DSP'), state: 'open', openedBy: actor.id, timeline: [{ from: null, to: 'open', at: ctx.now(), by: actor.id, note: 'opened' }] });
  await audit(ctx, actor, { action: 'suppliernet.dispute_opened', resource: 'supplier', resourceId: i.supplierId, newValue: { disputeId: objId(d._id), type: i.type, amountMinor: i.amountMinor } });
  return d;
}

export async function addDisputeEvidence(ctx: Ctx, disputeId: string, side: 'orvia' | 'supplier', e: { note: string; documentId?: string; url?: string }, actor: Actor, scopeSupplierId?: string) {
  const d = await SuppliernetDispute.findOne({ _id: disputeId, ...(scopeSupplierId ? { supplierId: scopeSupplierId } : {}) });
  if (!d) throw notFound('Dispute');
  if (['closed', 'rejected', 'resolved_credit', 'resolved_no_action'].includes(d.state)) throw new DomainError('Dispute is resolved', 'CONFLICT', 409);
  d.evidence.push({ at: ctx.now(), by: actor.id, side, ...e } as never);
  if (side === 'supplier' && d.state === 'awaiting_supplier') { d.timeline.push({ from: d.state, to: 'awaiting_orvia', at: ctx.now(), by: actor.id, note: 'supplier responded' } as never); d.state = 'awaiting_orvia'; }
  await d.save();
  await audit(ctx, actor, { action: 'suppliernet.dispute_evidence', resource: 'supplier', resourceId: objId(d.supplierId), newValue: { disputeId, side } });
  return d;
}

export async function transitionDispute(ctx: Ctx, disputeId: string, to: DisputeState, o: { note?: string; creditedMinor?: number }, actor: Actor) {
  const d = await SuppliernetDispute.findById(disputeId);
  if (!d) throw notFound('Dispute');
  if (!canDisputeTransition(d.state as DisputeState, to)) throw new DomainError(`Cannot move a dispute from ${d.state} to ${to}`, 'GATE_BLOCKED', 409);
  if (to === 'resolved_credit') {
    if (!o.creditedMinor || o.creditedMinor <= 0) throw new DomainError('A credited amount is required', 'VALIDATION', 422);
    d.creditedMinor = o.creditedMinor;
  }
  if (['resolved_credit', 'resolved_no_action', 'rejected'].includes(to) && !(o.note && o.note.trim().length >= 5)) throw new DomainError('A resolution note is required', 'VALIDATION', 422);
  d.timeline.push({ from: d.state, to, at: ctx.now(), by: actor.id, note: o.note } as never);
  d.state = to;
  if (['resolved_credit', 'resolved_no_action', 'rejected'].includes(to)) d.resolution = o.note;
  await d.save();
  if (d.statementId && to === 'resolved_credit') await SuppliernetStatement.updateOne({ _id: d.statementId }, { $inc: { disputedMinor: -Math.min(d.creditedMinor ?? 0, 1e12) } });
  await audit(ctx, actor, { action: 'suppliernet.dispute_state', resource: 'supplier', resourceId: objId(d.supplierId), newValue: { disputeId, to, creditedMinor: o.creditedMinor } });
  return d;
}

/* ------------------------- return authorizations --------------------------- */
export const RETURN_AUTH_TRANSITIONS: Record<ReturnAuthState, readonly ReturnAuthState[]> = {
  requested: ['authorized', 'rejected', 'cancelled'], authorized: ['received_by_supplier', 'cancelled'], received_by_supplier: ['refunded_by_supplier'], rejected: [], refunded_by_supplier: [], cancelled: [],
};

/**
 * Exposed for the aftersales workstream: ask the SUPPLIER of a shipment to authorise a return. The supplier is derived from the
 * shipment (never from the caller). Idempotent per (shipment, returnRef).
 */
export async function requestReturnAuthorization(ctx: Ctx, i: { shipmentId?: string; orderId?: string; reason: string; returnRef?: string }, actor: Actor) {
  const sh = i.shipmentId ? await Shipment.findById(i.shipmentId).lean() : i.orderId ? await Shipment.findOne({ orderId: i.orderId, status: { $in: ['SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'RETURNED'] } }).lean() : null;
  if (!sh) throw notFound('Shipment');
  if (i.returnRef) {
    const dup = await SuppliernetReturnAuth.findOne({ shipmentId: sh._id, returnRef: i.returnRef, state: { $nin: ['cancelled', 'rejected'] } });
    if (dup) return dup;
  }
  const ra = await SuppliernetReturnAuth.create({ number: number('RA'), supplierId: sh.supplierId, orderId: sh.orderId, shipmentId: sh._id, returnRef: i.returnRef, reason: i.reason.slice(0, 1000), state: 'requested', requestedBy: actor.id, timeline: [{ from: null, to: 'requested', at: ctx.now(), by: actor.id }] });
  await audit(ctx, actor, { action: 'suppliernet.return_auth_requested', resource: 'supplier', resourceId: objId(sh.supplierId), newValue: { returnAuthId: objId(ra._id), orderId: objId(sh.orderId) } });
  return ra;
}

export async function decideReturnAuthorization(ctx: Ctx, id: string, to: ReturnAuthState, o: { rmaNumber?: string; note?: string; refundMinor?: number }, actor: Actor, scopeSupplierId?: string) {
  const ra = await SuppliernetReturnAuth.findOne({ _id: id, ...(scopeSupplierId ? { supplierId: scopeSupplierId } : {}) });
  if (!ra) throw notFound('Return authorization');
  if (!RETURN_AUTH_TRANSITIONS[ra.state as ReturnAuthState].includes(to)) throw new DomainError(`Cannot move from ${ra.state} to ${to}`, 'GATE_BLOCKED', 409);
  if (to === 'authorized' && !o.rmaNumber?.trim()) throw new DomainError('An RMA number is required to authorise a return', 'VALIDATION', 422);
  if (to === 'rejected' && !(o.note && o.note.trim().length >= 5)) throw new DomainError('A reason is required to reject', 'VALIDATION', 422);
  if (to === 'authorized') ra.rmaNumber = o.rmaNumber!.trim().slice(0, 60);
  if (o.note) ra.supplierNote = o.note.slice(0, 500);
  if (to === 'refunded_by_supplier') ra.refundMinor = o.refundMinor;
  ra.timeline.push({ from: ra.state, to, at: ctx.now(), by: actor.id, note: o.note } as never);
  ra.state = to; ra.decidedBy = actor.id; ra.decidedAt = ctx.now();
  await ra.save();
  await audit(ctx, actor, { action: 'suppliernet.return_auth_state', resource: 'supplier', resourceId: objId(ra.supplierId), newValue: { returnAuthId: id, to } });
  return ra;
}

/** Read helper for aftersales: the supplier's answer for a return. */
export async function getReturnAuthorizationFor(returnRef: string) {
  return SuppliernetReturnAuth.findOne({ returnRef }).sort({ createdAt: -1 }).lean();
}

/* --------------------------------- payables -------------------------------- */
async function recordedOrdersFor(ctx: Ctx, supplierId: string, currency: Currency, period: { start?: Date; end?: Date }, keys: StatementLineIn[]): Promise<RecordedSupplierOrder[]> {
  const fx = (await ctx.settings.get('ops')).fx;
  const ids = keys.map((k) => k.supplierOrderId).filter((x): x is string => !!x);
  const q: Record<string, unknown> = { supplierId, supplierOrderId: { $exists: true, $ne: null }, status: { $nin: ['FAILED', 'CANCELLED', 'PENDING_CREATE'] } };
  const or: Record<string, unknown>[] = [];
  if (ids.length) or.push({ supplierOrderId: { $in: ids } });
  if (period.start && period.end) or.push({ createdAt: { $gte: period.start, $lte: period.end } });
  const refs = keys.map((k) => k.orderRef).filter((x): x is string => !!x);
  let orderIdsByRef: string[] = [];
  if (refs.length) { orderIdsByRef = (await Order.find({ orderNumber: { $in: refs } }).select('_id').limit(2000).lean()).map((o) => objId(o._id)); if (orderIdsByRef.length) or.push({ orderId: { $in: orderIdsByRef } }); }
  if (!or.length) return [];
  const ships = await Shipment.find({ ...q, $or: or }).limit(5000).lean();
  const orders = await Order.find({ _id: { $in: ships.map((s) => s.orderId) } }).select('orderNumber').lean();
  const num = new Map(orders.map((o) => [objId(o._id), o.orderNumber]));
  return ships.map((s) => {
    const c = s.cost as { productCost?: number; shippingCost?: number; duties?: number; currency?: string } | undefined;
    const total = (c?.productCost ?? 0) + (c?.shippingCost ?? 0) + (c?.duties ?? 0);
    const from = (c?.currency ?? currency) as Currency;
    return { shipmentId: objId(s._id), orderId: objId(s.orderId), orderNumber: num.get(objId(s.orderId)), supplierOrderId: s.supplierOrderId!, costMinor: from === currency ? total : convertMinor(total, from, currency, fx), fxConverted: from !== currency };
  });
}

export async function submitStatement(ctx: Ctx, supplierId: string, i: { number: string; currency: Currency; periodStart?: Date; periodEnd?: Date; lines: StatementLineIn[]; source: 'csv' | 'manual' | 'portal' }, actor: Actor) {
  if (!(await Supplier.exists({ _id: supplierId }))) throw notFound('Supplier');
  if (await SuppliernetStatement.exists({ supplierId, number: i.number })) throw new DomainError('A statement with this number already exists for this supplier', 'CONFLICT', 409);
  const recorded = await recordedOrdersFor(ctx, supplierId, i.currency, { start: i.periodStart, end: i.periodEnd }, i.lines);
  const r = reconcileStatement(i.lines, recorded);
  const st = await SuppliernetStatement.create({
    supplierId, number: i.number, currency: i.currency, periodStart: i.periodStart, periodEnd: i.periodEnd, source: i.source, status: r.status === 'matched' ? 'matched' : 'discrepancies',
    lines: r.lines, totals: r.totals, disputedMinor: 0, submittedBy: actor.id, reconciledAt: ctx.now(),
  });
  await audit(ctx, actor, { action: 'suppliernet.statement_submitted', resource: 'supplier', resourceId: supplierId, newValue: { statementId: objId(st._id), number: i.number, totals: r.totals } });
  return { id: objId(st._id), status: st.status, totals: r.totals, missing: r.missing.map((m) => ({ supplierOrderId: m.supplierOrderId, orderNumber: m.orderNumber, costMinor: m.costMinor })), disputableMinor: disputableAmount(r) };
}

export async function submitStatementCsv(ctx: Ctx, supplierId: string, i: { number: string; currency: Currency; periodStart?: Date; periodEnd?: Date; csv: string }, actor: Actor, source: 'csv' | 'portal' = 'csv') {
  const p = parseStatementCsv(i.csv);
  if (!p.lines.length) throw new DomainError('No valid statement lines', 'VALIDATION', 422, { errors: p.errors });
  const out = await submitStatement(ctx, supplierId, { ...i, lines: p.lines, source }, actor);
  return { ...out, parseErrors: p.errors };
}

/** Dispute the over-billed / unknown lines of a statement. Tracks the disputed amount; does not move money. */
export async function disputeStatement(ctx: Ctx, statementId: string, summary: string, actor: Actor) {
  const st = await SuppliernetStatement.findById(statementId);
  if (!st) throw notFound('Statement');
  if (st.status === 'settled') throw new DomainError('Statement is settled', 'CONFLICT', 409);
  const amount = st.lines.reduce((a, l) => a + (l.match === 'amount_difference' ? Math.max(0, l.diffMinor ?? 0) : l.match === 'unknown_order' || l.match === 'duplicate' ? Math.max(0, l.amountMinor ?? 0) : 0), 0);
  if (amount <= 0) throw new DomainError('No over-billed lines to dispute', 'VALIDATION', 422);
  const d = await openDispute(ctx, { supplierId: objId(st.supplierId), type: 'price_mismatch', statementId, amountMinor: amount, currency: st.currency, summary }, actor);
  st.status = 'disputed'; st.disputedMinor = amount;
  await st.save();
  return d;
}

/** Record that a statement was settled outside ORVIA (bank transfer etc.). RECORD-ONLY: no payment is initiated. */
export async function settleStatement(ctx: Ctx, statementId: string, i: { reference: string; amountMinor: number; note?: string }, actor: Actor) {
  const st = await SuppliernetStatement.findById(statementId);
  if (!st) throw notFound('Statement');
  if (st.status === 'settled') throw new DomainError('Already settled', 'CONFLICT', 409);
  if (st.status === 'discrepancies') throw new DomainError('Resolve or dispute the flagged lines before settling', 'GATE_BLOCKED', 409);
  const open = await SuppliernetDispute.countDocuments({ statementId, state: { $nin: ['resolved_credit', 'resolved_no_action', 'rejected', 'closed'] } });
  if (open) throw new DomainError('Disputes on this statement are still open', 'GATE_BLOCKED', 409);
  st.settlement = { ...i, settledAt: ctx.now(), settledBy: actor.id } as never;
  st.status = 'settled';
  await st.save();
  await audit(ctx, actor, { action: 'suppliernet.statement_settled', resource: 'supplier', resourceId: objId(st.supplierId), newValue: { statementId, reference: i.reference, amountMinor: i.amountMinor, recordOnly: true } });
  return st;
}
