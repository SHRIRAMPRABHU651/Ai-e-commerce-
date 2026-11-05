/**
 * Delivery Rescue service (IO): scan -> case -> plan -> consent/approval -> idempotent execution -> audit.
 * Never edits orders.ts; hooks in through its own job and by calling existing domain functions.
 * Money movement only ever goes through refundOrder (its own limits). No AI input to any decision.
 */
import { ExceptionModel, Order, RescueAction, RescueCase, RescueConsent, RescueTimeline, Refund, Shipment, Supplier, SupplierProduct, SystemSetting, ProductVariant } from '@orvia/database';
import { fetchLiveOffer } from '@orvia/suppliers';
import { RESCUE_ACTIVE_STATES, convertMinor } from '@orvia/types';
import type { CountryCode, Currency, RescueDecisionBody, RescueOptionKind } from '@orvia/types';
import { audit } from '../../infra/audit';
import { DomainError, SYSTEM, conflict, forbidden, notFound } from '../../infra/context';
import type { Actor, Ctx } from '../../infra/context';
import { raiseException, resolveException } from '../exceptions';
import { notify } from '../notify';
import { recomputeOrderStatus } from '../orderStatus';
import { refundOrder } from '../orders';
import { pickSupplierSku, providerFor } from '../supplierAccess';
import { classifyOrder, SHIPMENT_LIVE } from './classifier';
import type { ClassifierOrder } from './classifier';
import { consentExpiry, consentTransition, emailSubject, signConsentToken, termsHash, verifyConsentToken } from './consent';
import { actionKey, caseDedupeKey, duplicateOrderGuard, refundKeyHint, supplierOrderKey } from './guard';
import { customerKindText, rescueMessage } from './messages';
import type { RescueStage } from './messages';
import { authorize, readyToExecute } from './policy';
import { computePlan, fmtMoney, toUsd } from './plan';
import type { StoredOption } from './plan';
import { decideRetry } from './retry';
import { SYSTEM_RESCUE, actorOf, autoUsageToday, getRescuePolicy, logEvent } from './store';
import type { RescueActor } from './store';

const DAY = 86_400_000;
const ACTIVE = RESCUE_ACTIVE_STATES as unknown as string[];
type CaseDoc = InstanceType<typeof RescueCase>;
type ActionDoc = InstanceType<typeof RescueAction>;

export class RescueError extends Error {
  constructor(message: string, readonly code: string, readonly retryable = false) {
    super(message);
  }
}
const secretOf = (ctx: Ctx): string => ctx.cfg.ENCRYPTION_KEY ?? ctx.cfg.JWT_SECRET;
const optionsOf = (c: CaseDoc): StoredOption[] => (c.options ?? []) as unknown as StoredOption[];

/* ------------------------------------------------------------ notifications */
async function tell(ctx: Ctx, c: CaseDoc, stage: RescueStage, detail?: string, url?: string, key?: string): Promise<void> {
  if (c.kind === 'unusual_delivery_pattern' && stage === 'detected') return; // advisory: internal only
  const m = rescueMessage(stage, { kind: c.kind, title: c.title ?? 'your item', orderNumber: c.orderNumber, detail });
  await notify(ctx, {
    template: 'custom', to: c.email, orderId: String(c.orderId), userId: c.userId ? String(c.userId) : undefined,
    data: { subject: m.subject, message: m.message, url: url ?? `${ctx.cfg.WEB_URL}/orders/${c.orderNumber}`, orderNumber: c.orderNumber },
    dedupeKey: `rescue:${c._id}:${key ?? stage}:${c.round}`,
  });
}

/* --------------------------------------------------------------------- scan */
export interface ScanResult { scanned: number; created: number; updated: number; closed: number; actions: number; expired: number; planned: number }

export async function loadClassifierOrder(orderId: string): Promise<ClassifierOrder | null> {
  const o = await Order.findById(orderId).lean();
  if (!o) return null;
  const [ships, exs] = await Promise.all([Shipment.find({ orderId: o._id }).lean(), ExceptionModel.find({ orderId: o._id, status: { $in: ['open', 'in_progress'] } }).select('kind issue').lean()]);
  return toClassifierOrder(o, ships, exs);
}
type RawOrder = { _id: unknown; orderNumber: string; status: string; payment?: { status?: string | null; paidAt?: Date | null } | null; currency: string; country: string; exceptionOpen?: boolean | null; fulfillment?: { state?: string | null; lastError?: string | null } | null; items: { lineKey: string; title: string; quantity: number; unitPrice: number; productId: unknown; sku: string }[] };
type RawShip = { _id: unknown; lineKey: string; status: string; supplierId: unknown; supplierOrderId?: string | null; trackingNumber?: string | null; carrier?: string | null; estimatedDelivery?: Date | null; createdAt?: Date; lastError?: string | null; attempts?: number | null; events?: { status?: string | null; description?: string | null; at?: Date | null }[] };
function toClassifierOrder(o: RawOrder, ships: RawShip[], exs: { kind: string; issue: string }[]): ClassifierOrder {
  return {
    orderId: String(o._id), orderNumber: o.orderNumber, status: o.status, paymentStatus: o.payment?.status ?? undefined, paidAt: o.payment?.paidAt ?? null, currency: o.currency, country: o.country,
    exceptionOpen: !!o.exceptionOpen, fulfillmentState: o.fulfillment?.state ?? undefined, fulfillmentLastError: o.fulfillment?.lastError ?? null,
    items: o.items.map((i) => ({ lineKey: i.lineKey, title: i.title, quantity: i.quantity, unitPrice: i.unitPrice, productId: String(i.productId), sku: i.sku })),
    shipments: ships.map((s) => ({ id: String(s._id), lineKey: s.lineKey, status: s.status, supplierId: String(s.supplierId), supplierOrderId: s.supplierOrderId, trackingNumber: s.trackingNumber, carrier: s.carrier, estimatedDelivery: s.estimatedDelivery ?? null, createdAt: s.createdAt ?? new Date(0), lastError: s.lastError, attempts: s.attempts ?? 0, events: (s.events ?? []).map((e) => ({ status: e.status ?? undefined, description: e.description ?? undefined, at: new Date(e.at ?? 0) })) })),
    openExceptions: exs.map((e) => ({ kind: e.kind, issue: e.issue })),
  };
}

/** One bounded, idempotent pass: detect, plan, expire, execute due actions. Safe to run twice or after a crash. */
export async function runRescueScan(ctx: Ctx): Promise<ScanResult> {
  const res: ScanResult = { scanned: 0, created: 0, updated: 0, closed: 0, actions: 0, expired: 0, planned: 0 };
  const policy = await getRescuePolicy();
  if (!policy.enabled) return res;
  const now = ctx.now();
  const fx = (await ctx.settings.get('ops')).fx;
  const toU = toUsd(fx);
  // rotating cursor over active orders: every order is revisited across runs, each run is bounded
  const cur = (await SystemSetting.findOne({ key: 'rescue_scan_cursor' }).lean())?.value as { id?: string } | undefined;
  const base = { 'payment.status': { $in: ['succeeded', 'partially_refunded'] }, $or: [{ status: { $in: ['PAID', 'SUPPLIER_PROCESSING', 'SHIPPED', 'IN_TRANSIT', 'EXCEPTION'] } }, { status: 'DELIVERED', deliveredAt: { $gte: new Date(now.getTime() - 3 * DAY) } }] };
  let orders = await Order.find({ ...base, ...(cur?.id ? { _id: { $gt: cur.id } } : {}) }).sort({ _id: 1 }).limit(policy.scanBatch * 4).lean();
  const wrapped = orders.length < policy.scanBatch * 4 && !!cur?.id;
  if (wrapped && orders.length < policy.scanBatch) orders = [...orders, ...(await Order.find({ ...base, _id: { $lte: cur!.id } }).sort({ _id: 1 }).limit(policy.scanBatch * 4 - orders.length).lean())];
  await SystemSetting.updateOne({ key: 'rescue_scan_cursor' }, { $set: { value: { id: orders.length >= policy.scanBatch * 4 && !wrapped ? String(orders[orders.length - 1]!._id) : undefined } } }, { upsert: true });
  for (const o of orders) {
    res.scanned++;
    const [ships, exs] = await Promise.all([Shipment.find({ orderId: o._id }).lean(), ExceptionModel.find({ orderId: o._id, status: { $in: ['open', 'in_progress'] } }).select('kind issue').lean()]);
    const detections = classifyOrder(toClassifierOrder(o, ships, exs), policy, now, (n) => toU(n, o.currency));
    const hit = new Set(detections.map((d) => d.lineKey));
    for (const d of detections) {
      if (res.created >= policy.scanBatch) break;
      const key = caseDedupeKey(d.orderId, d.lineKey);
      const existing = await RescueCase.findOne({ dedupeKey: key, state: { $in: ACTIVE } });
      const item = o.items.find((i) => i.lineKey === d.lineKey)!;
      if (existing) {
        existing.lastSeenAt = now;
        const changed = existing.kind !== d.kind;
        existing.evidence = d.evidence as never;
        existing.daysOverdue = d.daysOverdue;
        if (changed && ['planned', 'awaiting_staff', 'awaiting_customer', 'monitoring', 'detected'].includes(existing.state)) {
          const before = existing.kind;
          existing.kind = d.kind;
          existing.severity = d.severity;
          await existing.save();
          await logEvent(existing._id, o._id, SYSTEM_RESCUE, 'reclassified', `Failure kind changed ${before} -> ${d.kind}`, { before, after: d.kind, evidence: d.evidence });
          await replan(ctx, existing, SYSTEM_RESCUE);
          res.updated++;
        } else await existing.save();
        continue;
      }
      try {
        const c = await RescueCase.create({ orderId: o._id, orderNumber: o.orderNumber, userId: o.userId, email: o.email, lineKey: d.lineKey, dedupeKey: key, country: o.country, currency: o.currency, kind: d.kind, severity: d.severity, state: 'detected', title: item.title, lineValue: d.lineValue, shipmentId: d.shipmentId ?? undefined, daysOverdue: d.daysOverdue, alsoDetected: d.alsoDetected, evidence: d.evidence, detectedAt: now, lastSeenAt: now, nextReviewAt: now });
        res.created++;
        await logEvent(c._id, o._id, SYSTEM_RESCUE, 'detected', `Detected ${d.kind} (${d.severity})`, { evidence: d.evidence, alsoDetected: d.alsoDetected, lineValue: d.lineValue, daysOverdue: d.daysOverdue });
        await audit(ctx, SYSTEM, { action: 'rescue.case.detected', resource: 'rescue_case', resourceId: String(c._id), newValue: { kind: d.kind, severity: d.severity, orderNumber: o.orderNumber }, reason: d.evidence[0]?.detail });
        await tell(ctx, c, 'detected');
        c.notified.push('detected');
        await c.save();
        await planAndAdvance(ctx, String(c._id), SYSTEM_RESCUE);
        res.planned++;
      } catch (e) {
        if ((e as { code?: number }).code !== 11000) ctx.log.error({ channel: 'order', orderId: String(o._id), err: (e as Error).message }, 'rescue: case creation failed');
      }
    }
    // active cases whose condition has cleared
    const open = await RescueCase.find({ orderId: o._id, state: { $in: ACTIVE } });
    for (const c of open) {
      if (hit.has(c.lineKey)) continue;
      const lineShips = ships.filter((s) => s.lineKey === c.lineKey && SHIPMENT_LIVE.includes(s.status as never));
      const delivered = lineShips.some((s) => s.status === 'DELIVERED');
      if (['executing', 'escalated', 'awaiting_staff'].includes(c.state) && !delivered && !['CANCELLED', 'REFUNDED'].includes(o.status)) continue; // humans / in-flight actions own these
      await closeCase(ctx, c, SYSTEM_RESCUE, { optionKind: delivered ? 'delivered' : ['CANCELLED', 'REFUNDED'].includes(o.status) ? 'order_cancelled' : 'closed_by_staff', auto: true, note: delivered ? 'Shipment delivered.' : 'Condition cleared on re-check.' }, 'resolved');
      res.closed++;
    }
  }
  res.expired = await expireConsents(ctx);
  res.actions = await runDueActions(ctx, 20);
  return res;
}

/* --------------------------------------------------------------------- plan */
async function replan(ctx: Ctx, c: CaseDoc, who: RescueActor): Promise<void> {
  await RescueConsent.updateMany({ caseId: c._id, status: 'pending' }, { $set: { status: 'revoked' } });
  c.round += 1;
  c.selectedOptionId = undefined;
  c.state = 'detected';
  await c.save();
  await logEvent(c._id, c.orderId, who, 'replan', `Re-planning (round ${c.round})`);
  await planAndAdvance(ctx, String(c._id), who);
}

export async function planAndAdvance(ctx: Ctx, caseId: string, who: RescueActor): Promise<void> {
  const c = await RescueCase.findById(caseId);
  if (!c || !ACTIVE.includes(c.state)) return;
  const policy = await getRescuePolicy();
  const plan = await computePlan(ctx, c, policy);
  c.options = plan.options as never;
  c.recommendedId = plan.set.recommendedId;
  c.recommendationReason = plan.set.recommendationReason;
  c.plannedAt = ctx.now();
  c.nextReviewAt = new Date(ctx.now().getTime() + 10 * 60_000);
  c.state = 'planned';
  await c.save();
  await logEvent(c._id, c.orderId, who, 'planned', `Recommended ${plan.set.recommendedId}: ${plan.set.recommendationReason}`, { notes: plan.notes, options: plan.options.map((o) => ({ id: o.id, kind: o.kind, feasible: o.feasible, impact: o.impact, eta: o.eta, auth: o.auth.mode, reasons: o.auth.reasons })) });
  const rec = plan.options.find((o) => o.id === plan.set.recommendedId)!;
  await advance(ctx, c, rec, who);
}

/** Decide what happens next for the recommended option, following the authorization decision. */
async function advance(ctx: Ctx, c: CaseDoc, rec: StoredOption, who: RescueActor): Promise<void> {
  if (rec.kind === 'escalate_human' || rec.auth.mode === 'blocked') return escalate(ctx, c, who, rec.kind === 'escalate_human' ? c.recommendationReason ?? 'Recommended for human handling' : 'No safe option');
  if (rec.auth.mode === 'auto') {
    await startOption(ctx, c, rec, { mode: 'auto', actorType: 'system', actorId: 'rescue-engine' });
    return;
  }
  if (rec.auth.requiresCustomerConsent) return offerToCustomer(ctx, c, rec.id);
  c.state = 'awaiting_staff';
  await c.save();
  await logEvent(c._id, c.orderId, who, 'awaiting_staff', 'Staff approval required', { reasons: rec.auth.reasons });
}

/* ------------------------------------------------------------------ consent */
async function offerToCustomer(ctx: Ctx, c: CaseDoc, focusId?: string): Promise<void> {
  const policy = await getRescuePolicy();
  const now = ctx.now();
  const offered = optionsOf(c).filter((o) => o.feasible && (o.auth.requiresCustomerConsent || o.kind === 'continue_shipment') && o.kind !== 'escalate_human' && (o.kind !== 'continue_shipment' || true));
  const expiresAt = consentExpiry(now, policy.consentTtlHours);
  for (const o of offered) {
    try {
      await RescueConsent.create({ caseId: c._id, orderId: c.orderId, round: c.round, optionId: o.id, optionKind: o.kind, termsHash: termsHash({ optionId: o.id, kind: o.kind, refund: o.impact.refund, extraCost: 0, etaMaxDays: o.eta.maxDays, replacementProductId: o.replacement?.productId, currency: c.currency }), terms: { label: o.label, text: o.customerText, refund: o.impact.refund, eta: o.eta, material: o.materialReasons }, status: 'pending', expiresAt });
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e;
    }
  }
  c.state = 'awaiting_customer';
  await c.save();
  await logEvent(c._id, c.orderId, SYSTEM_RESCUE, 'options_offered', `Offered ${offered.length} option(s) to the customer`, { options: offered.map((o) => o.id), focus: focusId, expiresAt });
  const token = signConsentToken({ caseId: String(c._id), round: c.round, exp: expiresAt.getTime(), sub: emailSubject(c.email) }, secretOf(ctx));
  await tell(ctx, c, 'options', undefined, `${ctx.cfg.WEB_URL}/orders/${c.orderNumber}/recovery?token=${encodeURIComponent(token)}`);
}

export async function expireConsents(ctx: Ctx): Promise<number> {
  const now = ctx.now();
  const stale = await RescueConsent.find({ status: 'pending', expiresAt: { $lte: now } }).limit(200);
  const caseIds = new Set<string>();
  for (const k of stale) {
    const t = consentTransition(k.status as 'pending', 'expire', true);
    if (!t.ok) continue;
    const r = await RescueConsent.updateOne({ _id: k._id, status: 'pending' }, { $set: { status: 'expired' } });
    if (r.modifiedCount) caseIds.add(String(k.caseId));
  }
  for (const id of caseIds) {
    const c = await RescueCase.findById(id);
    if (!c || c.state !== 'awaiting_customer') continue;
    if (await RescueConsent.countDocuments({ caseId: c._id, round: c.round, status: 'pending' })) continue;
    await escalate(ctx, c, SYSTEM_RESCUE, 'The customer did not answer before the consent links expired.');
  }
  return caseIds.size;
}

export interface Viewer { userId?: string; email?: string; token?: string }

async function authorizeViewer(ctx: Ctx, order: { _id: unknown; userId?: unknown; email: string }, cases: CaseDoc[], v: Viewer): Promise<{ via: 'token' | 'account'; cases: CaseDoc[]; by: string }> {
  if (v.userId && (String(order.userId) === v.userId || (v.email && order.email.toLowerCase() === v.email.toLowerCase()))) return { via: 'account', cases, by: v.userId };
  if (v.token) {
    const claimsId = (() => { try { return (JSON.parse(Buffer.from(v.token.split('.')[0]!, 'base64url').toString()) as { caseId?: string }).caseId; } catch { return undefined; } })();
    const c = cases.find((x) => String(x._id) === claimsId);
    if (c) {
      const chk = verifyConsentToken(v.token, secretOf(ctx), ctx.now(), { caseId: String(c._id), round: c.round, email: c.email });
      if (chk.ok) return { via: 'token', cases: [c], by: `token:${emailSubject(c.email)}` };
      throw new DomainError(chk.reason === 'expired' ? 'This link has expired' : 'This link is no longer valid', 'LINK_INVALID', 403, { reason: chk.reason });
    }
  }
  throw new DomainError('We could not find that order', 'NOT_FOUND', 404); // no oracle for who owns what
}

/** Customer view: plain-language options only. No costs, margins, supplier names or internal reasons. */
export async function recoveryView(ctx: Ctx, orderNumber: string, v: Viewer) {
  const order = await Order.findOne({ orderNumber: orderNumber.toUpperCase() }).select('userId email orderNumber currency').lean();
  if (!order) throw notFound('Order');
  const all = await RescueCase.find({ orderId: order._id }).sort({ createdAt: -1 }).limit(20);
  const auth = await authorizeViewer(ctx, order, all, v);
  const now = ctx.now();
  const out = [];
  for (const c of auth.cases) {
    const consents = await RescueConsent.find({ caseId: c._id, round: c.round }).lean();
    const byId = new Map(consents.map((k) => [k.optionId, k]));
    const offers = c.state === 'awaiting_customer' ? optionsOf(c).filter((o) => byId.has(o.id)).map((o) => {
      const k = byId.get(o.id)!;
      return { id: o.id, kind: o.kind, label: o.label, text: o.customerText, materialChanges: o.materialReasons, refund: o.impact.refund > 0 ? o.impact.refund : null, etaDays: o.eta.maxDays === null ? null : { min: o.eta.minDays, max: o.eta.maxDays }, status: k.status === 'pending' && k.expiresAt <= now ? 'expired' : k.status, expiresAt: k.expiresAt };
    }) : [];
    out.push({ caseId: String(c._id), state: c.state, problem: customerKindText(c.kind), item: c.title, currency: c.currency, openedAt: c.detectedAt, resolvedAt: c.resolvedAt ?? null, offers, statusText: statusText(c.state) });
  }
  return { orderNumber: order.orderNumber, cases: out };
}
const statusText = (s: string): string => ({ detected: 'We are looking into it.', planned: 'We are preparing a solution.', awaiting_customer: 'We need your decision.', awaiting_staff: 'A team member is reviewing this.', executing: 'We are putting your chosen solution in place.', monitoring: 'The fix is in place and we are watching it.', escalated: 'A team member is handling this personally.', resolved: 'Resolved.', closed: 'Closed.' } as Record<string, string>)[s] ?? '';

export async function decideConsent(ctx: Ctx, orderNumber: string, optionId: string, decision: 'accept' | 'decline', v: Viewer, ip?: string) {
  const order = await Order.findOne({ orderNumber: orderNumber.toUpperCase() }).select('userId email').lean();
  if (!order) throw notFound('Order');
  const cases = await RescueCase.find({ orderId: order._id, state: { $in: ACTIVE } });
  const auth = await authorizeViewer(ctx, order, cases, v);
  const c = auth.cases.find((x) => x.state === 'awaiting_customer');
  if (!c) throw conflict('There is nothing waiting for your decision', 'NOT_AWAITING');
  const consent = await RescueConsent.findOne({ caseId: c._id, round: c.round, optionId });
  if (!consent) throw notFound('Option');
  const now = ctx.now();
  const t = consentTransition(consent.status as 'pending', decision, consent.expiresAt <= now);
  if (!t.ok) throw new DomainError(t.reason === 'expired' ? 'This offer has expired' : 'This offer was already answered', t.reason === 'expired' ? 'CONSENT_EXPIRED' : 'CONSENT_USED', t.reason === 'expired' ? 410 : 409);
  // atomic single-use: only one request can move pending -> decided
  const won = await RescueConsent.findOneAndUpdate({ _id: consent._id, status: 'pending', expiresAt: { $gt: now } }, { $set: { status: t.next, decidedAt: now, decidedVia: auth.via, decidedBy: auth.by, ipHash: ip ? emailSubject(ip) : undefined } }, { new: true });
  if (!won) throw conflict('This offer was already answered', 'CONSENT_USED');
  const opt = optionsOf(c).find((o) => o.id === optionId)!;
  await logEvent(c._id, c.orderId, { type: 'customer', id: auth.by }, decision === 'accept' ? 'consent_accepted' : 'consent_declined', `Customer ${decision}ed "${opt.label}"`, { optionId, termsHash: consent.termsHash, via: auth.via });
  await audit(ctx, { id: auth.by, type: 'anonymous' }, { action: `rescue.consent.${decision}`, resource: 'rescue_case', resourceId: String(c._id), newValue: { optionId, termsHash: consent.termsHash }, reason: 'customer decision' });
  if (decision === 'decline') {
    await tell(ctx, c, 'consent_declined', opt.label, undefined, `declined:${optionId}`);
    if (!(await RescueConsent.countDocuments({ caseId: c._id, round: c.round, status: 'pending' }))) await escalate(ctx, c, { type: 'customer', id: auth.by }, 'The customer declined every offered option.');
    return { status: 'declined' as const };
  }
  await RescueConsent.updateMany({ caseId: c._id, round: c.round, status: 'pending' }, { $set: { status: 'revoked' } });
  c.selectedOptionId = optionId;
  await c.save();
  await tell(ctx, c, 'consent_accepted', opt.label, undefined, `accepted:${optionId}`);
  await proceedIfReady(ctx, c, opt, { type: 'customer', id: auth.by }, String(won._id));
  return { status: 'accepted' as const };
}

async function proceedIfReady(ctx: Ctx, c: CaseDoc, opt: StoredOption, who: RescueActor, consentId?: string): Promise<void> {
  const staffApproved = !!c.approval?.by && c.approval.at != null;
  const r = readyToExecute(opt.auth, { consentAccepted: opt.auth.requiresCustomerConsent, staffApproved });
  if (r.missing.includes('staff_approval')) {
    c.state = 'awaiting_staff';
    await c.save();
    await logEvent(c._id, c.orderId, who, 'awaiting_staff', 'Customer agreed; staff approval still required', { reasons: opt.auth.reasons });
    return;
  }
  if (opt.kind === 'continue_shipment') return void (await startOption(ctx, c, opt, { mode: 'customer_consent', actorType: who.type, actorId: who.id, consentId }));
  await startOption(ctx, c, opt, { mode: opt.auth.requiresCustomerConsent ? 'customer_consent' : 'staff_approval', actorType: who.type, actorId: who.id, consentId });
}

/* ---------------------------------------------------------------- staff side */
export async function staffDecide(ctx: Ctx, caseId: string, actor: Actor, body: RescueDecisionBody): Promise<CaseDoc> {
  const c = await RescueCase.findById(caseId);
  if (!c) throw notFound('Rescue case');
  const who = actorOf(actor);
  if (!ACTIVE.includes(c.state)) throw conflict('Case is already closed', 'CASE_CLOSED');
  await audit(ctx, actor, { action: `rescue.case.${body.action}`, resource: 'rescue_case', resourceId: caseId, newValue: { optionId: body.optionId }, reason: body.note });
  if (body.action === 'close') { await closeCase(ctx, c, who, { optionKind: 'closed_by_staff', auto: false, by: actor.id, note: body.note }, 'closed'); return c; }
  if (body.action === 'escalate') { await escalate(ctx, c, who, body.note); return c; }
  if (body.action === 'replan') { await replan(ctx, c, who); return (await RescueCase.findById(caseId))!; }
  const optionId = body.optionId ?? c.recommendedId;
  const opt = optionsOf(c).find((o) => o.id === optionId);
  if (!opt) throw new DomainError('Unknown option', 'VALIDATION', 400);
  if (body.action === 'override' && opt.id === c.recommendedId) throw new DomainError('That is the recommended option; use approve', 'VALIDATION', 400);
  if (!opt.feasible || opt.auth.mode === 'blocked') throw conflict(`Option is not feasible: ${opt.infeasibleReason ?? 'blocked'}`, 'NOT_FEASIBLE');
  if (opt.kind === 'escalate_human') { await escalate(ctx, c, who, body.note); return c; }
  if (opt.needsDuplicateAck && !body.acknowledgeDuplicateRisk) throw conflict('Acknowledge the duplicate-order risk to continue', 'ACK_REQUIRED');
  c.approval = { by: actor.id, role: actor.role, at: ctx.now(), note: body.note, acknowledgedDuplicateRisk: !!body.acknowledgeDuplicateRisk } as never;
  c.selectedOptionId = opt.id;
  await c.save();
  await logEvent(c._id, c.orderId, who, body.action === 'override' ? 'staff_override' : 'staff_approved', `${body.action} ${opt.label}: ${body.note}`, { optionId: opt.id, recommended: c.recommendedId, acknowledgedDuplicateRisk: !!body.acknowledgeDuplicateRisk });
  if (opt.auth.requiresCustomerConsent) {
    const accepted = await RescueConsent.findOne({ caseId: c._id, round: c.round, optionId: opt.id, status: 'accepted' }).lean();
    if (!accepted) { await offerToCustomer(ctx, c, opt.id); return (await RescueCase.findById(caseId))!; } // staff cannot waive customer consent
  }
  await startOption(ctx, c, opt, { mode: opt.auth.requiresCustomerConsent ? 'customer_consent' : 'staff_approval', actorType: 'staff', actorId: actor.id });
  return (await RescueCase.findById(caseId))!;
}

async function escalate(ctx: Ctx, c: CaseDoc, who: RescueActor, reason: string): Promise<void> {
  c.state = 'escalated';
  c.escalationReason = reason;
  await c.save();
  await RescueConsent.updateMany({ caseId: c._id, status: 'pending' }, { $set: { status: 'revoked' } });
  await logEvent(c._id, c.orderId, who, 'escalated', reason);
  const supplierSide = ['supplier_cancellation', 'supplier_acceptance_failure', 'stock_shortage'].includes(c.kind);
  await raiseException(ctx, { kind: supplierSide ? 'SUPPLIER_FAILURE' : 'TRACKING', priority: c.severity === 'low' ? 'medium' : c.severity, orderId: String(c.orderId), customerEmail: c.email, issue: `Delivery Rescue: ${c.kind.replace(/_/g, ' ')} on "${c.title}" needs a person. ${reason}`, aiRecommendation: c.recommendationReason ?? undefined, suggestedAction: 'Open the rescue case', actionCode: 'dismiss', details: { caseId: String(c._id) }, dedupeKey: `rescue:${c._id}` }, SYSTEM);
  if (!c.notified.includes('escalated')) { await tell(ctx, c, 'escalated'); c.notified.push('escalated'); await c.save(); }
}

async function closeCase(ctx: Ctx, c: CaseDoc, who: RescueActor, resolution: { optionKind: string; auto: boolean; by?: string; note?: string }, state: 'resolved' | 'closed'): Promise<void> {
  const fresh = await RescueCase.findOneAndUpdate({ _id: c._id, state: { $in: ACTIVE } }, { $set: { state, resolvedAt: ctx.now(), resolution: { ...resolution, by: resolution.by ?? who.id } } }, { new: true });
  if (!fresh) return;
  await RescueConsent.updateMany({ caseId: c._id, status: 'pending' }, { $set: { status: 'revoked' } });
  await logEvent(c._id, c.orderId, who, state, resolution.note ?? state, { resolution });
  const ex = await ExceptionModel.find({ dedupeKey: `rescue:${c._id}`, status: { $in: ['open', 'in_progress'] } }).select('_id').lean();
  for (const e of ex) await resolveException(ctx, String(e._id), SYSTEM, 'Rescue case closed');
  if (state === 'resolved' && !c.notified.includes('resolved')) { await tell(ctx, fresh, 'resolved', resolution.note); await RescueCase.updateOne({ _id: c._id }, { $push: { notified: 'resolved' } }); }
}

/* ---------------------------------------------------------------- execution */
export async function startOption(ctx: Ctx, c: CaseDoc, opt: StoredOption, by: { mode: string; actorType: string; actorId: string; consentId?: string }): Promise<void> {
  const policy = await getRescuePolicy();
  const fx = (await ctx.settings.get('ops')).fx;
  const key = actionKey(String(c._id), opt.kind, opt.id);
  try {
    const a = await RescueAction.create({ caseId: c._id, orderId: c.orderId, kind: opt.kind, optionId: opt.id, idempotencyKey: key, maxAttempts: policy.maxAttempts, authorizedBy: by, cost: { extraCost: opt.impact.extraCost, refund: opt.impact.refund }, costUsd: toUsd(fx)(opt.impact.exposure, c.currency), nextAttemptAt: ctx.now() });
    await logEvent(c._id, c.orderId, { type: by.actorType as RescueActor['type'], id: by.actorId }, 'action_created', `Action ${opt.kind} authorized by ${by.mode}`, { key, optionId: opt.id, authorizedBy: by, impact: opt.impact });
    c.state = 'executing';
    c.selectedOptionId = opt.id;
    await c.save();
    await ctx.queue.enqueue('rescue_run_action', { actionId: String(a._id) }, { dedupeKey: `rescue-act:${a._id}` });
  } catch (e) {
    if ((e as { code?: number }).code === 11000) { ctx.log.info({ channel: 'order', key }, 'rescue: duplicate action trigger ignored'); return; }
    throw e;
  }
}

export async function runDueActions(ctx: Ctx, limit: number): Promise<number> {
  const now = ctx.now();
  const due = await RescueAction.find({ $or: [{ state: { $in: ['pending', 'waiting'] } }, { state: 'running', lockedUntil: { $lt: now } }], nextAttemptAt: { $lte: now } }).sort({ nextAttemptAt: 1 }).limit(limit).select('_id').lean();
  let n = 0;
  for (const d of due) if ((await runAction(ctx, String(d._id))) !== 'skipped') n++;
  return n;
}

export async function runAction(ctx: Ctx, actionId: string): Promise<'done' | 'waiting' | 'retry' | 'dead' | 'skipped'> {
  const now = ctx.now();
  const a = await RescueAction.findOneAndUpdate({ _id: actionId, $or: [{ state: { $in: ['pending', 'waiting'] } }, { state: 'running', lockedUntil: { $lt: now } }], nextAttemptAt: { $lte: now } }, { $set: { state: 'running', lockedUntil: new Date(now.getTime() + 5 * 60_000) } }, { new: true });
  if (!a) return 'skipped';
  const c = await RescueCase.findById(a.caseId);
  if (!c || !ACTIVE.includes(c.state)) { a.state = 'failed'; a.lastError = 'case no longer active'; await a.save(); return 'dead'; }
  try {
    const out = await perform(ctx, a, c);
    if (out.waiting) {
      a.state = 'waiting';
      a.nextAttemptAt = new Date(now.getTime() + 10 * 60_000);
      a.result = out.result as never;
      if (now.getTime() - (a as unknown as { createdAt: Date }).createdAt.getTime() > 7 * DAY) throw new RescueError('Waiting for refund approval for more than 7 days', 'WAIT_TIMEOUT', false);
      await a.save();
      return 'waiting';
    }
    a.state = 'succeeded';
    a.result = out.result as never;
    a.lockedUntil = undefined;
    await a.save();
    await logEvent(c._id, c.orderId, SYSTEM_RESCUE, 'action_succeeded', `${a.kind} succeeded`, { result: out.result, key: a.idempotencyKey });
    return 'done';
  } catch (e) {
    const err = e as Error & { retryable?: boolean; code?: string };
    const retryable = err instanceof RescueError ? err.retryable : (err as { retryable?: boolean }).retryable !== false && err.name !== 'DomainError';
    a.attempts += 1;
    a.lastError = err.message;
    const d = decideRetry(a.attempts, a.maxAttempts, retryable);
    await logEvent(c._id, c.orderId, SYSTEM_RESCUE, 'action_failed', `${a.kind} attempt ${a.attempts} failed: ${err.message}`, { retry: d, code: err instanceof RescueError ? err.code : undefined });
    if (d.retry) {
      a.state = 'pending';
      a.nextAttemptAt = new Date(now.getTime() + d.delayMs);
      await a.save();
      return 'retry';
    }
    a.state = 'dead';
    await a.save();
    await logEvent(c._id, c.orderId, SYSTEM_RESCUE, 'dead_lettered', `Dead-lettered (${d.reason}); handed to staff`, { reason: d.reason });
    await audit(ctx, SYSTEM, { action: 'rescue.action.dead', resource: 'rescue_case', resourceId: String(c._id), newValue: { kind: a.kind, error: err.message }, reason: d.reason });
    await escalate(ctx, c, SYSTEM_RESCUE, `Automatic action ${a.kind} failed: ${err.message}`);
    return 'dead';
  }
}

async function perform(ctx: Ctx, a: ActionDoc, c: CaseDoc): Promise<{ waiting?: boolean; result: unknown }> {
  const opt = optionsOf(c).find((o) => o.id === a.optionId);
  if (!opt) throw new RescueError('Option not in snapshot', 'NO_OPTION');
  // Re-verify authorization from stored facts, not from the caller.
  const by = a.authorizedBy as { mode?: string } | undefined;
  if (opt.auth.requiresCustomerConsent && !(await RescueConsent.exists({ caseId: c._id, round: c.round, optionId: opt.id, status: 'accepted' })) && by?.mode !== 'auto') throw new RescueError('Customer consent missing', 'NO_CONSENT');
  if (opt.auth.requiresStaffApproval && !c.approval?.by) throw new RescueError('Staff approval missing', 'NO_APPROVAL');
  switch (opt.kind) {
    case 'continue_shipment':
      c.state = 'monitoring';
      c.nextReviewAt = new Date(ctx.now().getTime() + 6 * 3_600_000);
      await c.save();
      return { result: { monitoring: true } };
    case 'reorder_same_product_alt_supplier':
    case 'offer_equivalent_replacement':
      return { result: await placeReplacement(ctx, a, c, opt) };
    case 'offer_partial_refund':
    case 'offer_full_refund':
      return refundFlow(ctx, a, c, opt);
    default:
      throw new RescueError('Not executable', 'NOT_EXECUTABLE');
  }
}

async function placeReplacement(ctx: Ctx, a: ActionDoc, c: CaseDoc, opt: StoredOption) {
  const order = await Order.findById(c.orderId);
  if (!order) throw new RescueError('order missing', 'NO_ORDER');
  if (['CANCELLED', 'REFUNDED'].includes(order.status)) throw new RescueError('Order is cancelled/refunded', 'ORDER_CLOSED');
  const item = order.items.find((i) => i.lineKey === c.lineKey)!;
  const target = opt.kind === 'reorder_same_product_alt_supplier' ? opt.supplier! : { id: opt.replacement!.supplierId, name: opt.replacement!.supplierName, externalId: opt.replacement!.externalId, sku: opt.replacement!.supplierSku };
  const sup = await Supplier.findById(target.id);
  if (!sup || !sup.active || ['FAILING', 'DISABLED'].includes(sup.healthState ?? '')) throw new RescueError('Target supplier is no longer healthy', 'SUPPLIER_UNHEALTHY', true);
  const provider = await providerFor(ctx, sup);
  const idemKey = supplierOrderKey(String(c._id), String(order._id), c.lineKey);
  const ships = await Shipment.find({ orderId: order._id, lineKey: c.lineKey });
  const existing = ships.find((s) => s.idempotencyKey === idemKey);
  // 1. live re-quote BEFORE anything irreversible
  const fx = (await ctx.settings.get('ops')).fx;
  if (!existing || existing.status === 'PENDING_CREATE') {
    const live = await fetchLiveOffer(provider, target.externalId, order.country as CountryCode, item.quantity, target.sku);
    if (!live.available || live.stock < item.quantity) throw new RescueError('Alternative supplier no longer has stock', 'QUOTE_UNAVAILABLE', false);
    const conv = (n: number) => convertMinor(n, live.currency as Currency, order.currency as Currency, fx);
    const landed = conv(live.productCost) * item.quantity + conv(live.shippingCost) + conv(live.fulfillmentFee);
    if (opt.plannedLandedCost > 0 && landed > opt.plannedLandedCost * 1.15) throw new RescueError(`Live price moved above the approved cost (${fmtMoney(landed, order.currency)} vs ${fmtMoney(opt.plannedLandedCost, order.currency)}); re-plan required`, 'QUOTE_DRIFT', false);
  }
  // 2. duplicate guard + cancel-then-reorder
  const guard = duplicateOrderGuard({ supplierOrderKeyForCase: idemKey, shipments: ships.map((s) => ({ id: String(s._id), status: s.status, supplierOrderId: s.supplierOrderId, idempotencyKey: s.idempotencyKey })), staffAcknowledgedDuplicateRisk: !!c.approval?.acknowledgedDuplicateRisk });
  let row = existing;
  if (!row) {
    if (!guard.allow) throw new RescueError(`Refusing to reorder: ${guard.reason}`, `GUARD_${guard.code}`, false);
    if (guard.cancelFirst) {
      const old = ships.find((s) => String(s._id) === guard.cancelFirst!.id)!;
      const osup = await Supplier.findById(old.supplierId);
      if (!old.supplierOrderId || !osup) throw new RescueError('Cannot confirm cancellation of the original supplier order', 'CANCEL_UNCONFIRMED', false);
      const cancel = await (await providerFor(ctx, osup)).cancelOrder(old.supplierOrderId); // thrown errors are retryable
      if (!cancel.cancelled) throw new RescueError(`Original supplier order could not be cancelled (${cancel.reason ?? 'unknown'}); it may still ship, so no replacement was ordered`, 'CANCEL_REFUSED', false);
      old.status = 'CANCELLED';
      old.lastError = `Cancelled by Delivery Rescue case ${c._id}`;
      await old.save();
      await logEvent(c._id, c.orderId, SYSTEM_RESCUE, 'original_cancelled', 'Original supplier order cancelled and confirmed', { supplierOrderId: old.supplierOrderId });
    }
    try {
      row = await Shipment.create({ orderId: order._id, lineKey: c.lineKey, productId: opt.replacement ? opt.replacement.productId : item.productId, sku: opt.replacement ? opt.replacement.sku : item.sku, quantity: item.quantity, supplierId: sup._id, idempotencyKey: idemKey, status: 'PENDING_CREATE' });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw new RescueError('Another active supplier order exists for this line', 'CONCURRENT_ACTIVE', false);
      throw e;
    }
  }
  if (row.status === 'PENDING_CREATE') {
    const variant = await ProductVariant.findOne({ sku: item.sku }).select('supplierSku label').lean();
    const link = await SupplierProduct.findOne({ productId: opt.replacement ? opt.replacement.productId : item.productId, supplierId: sup._id }).select('variants').lean();
    const addr = order.address;
    const so = await provider.createOrder({ idempotencyKey: idemKey, orderRef: order.orderNumber, externalId: target.externalId, sku: pickSupplierSku(link?.variants, variant) ?? target.sku ?? target.externalId, quantity: item.quantity, destination: { fullName: addr?.fullName ?? '', line1: addr?.line1 ?? '', line2: addr?.line2 ?? '', city: addr?.city ?? '', region: addr?.region ?? '', postalCode: addr?.postalCode ?? '', country: order.country as CountryCode, phone: addr?.phone ?? '' } });
    const conv = (n: number) => convertMinor(n, so.cost.currency as Currency, order.currency as Currency, fx);
    row.supplierOrderId = so.supplierOrderId;
    row.status = 'CREATED';
    row.carrier = so.carrier;
    row.trackingNumber = so.trackingNumber;
    row.attempts += 1;
    row.cost = { productCost: conv(so.cost.productCost), shippingCost: conv(so.cost.shippingCost), duties: 0, currency: order.currency } as never;
    row.events.push({ status: 'CREATED', description: `Replacement order placed by Delivery Rescue`, at: ctx.now() } as never);
    await row.save();
    await Supplier.updateOne({ _id: sup._id }, { $inc: { 'stats.ordersTotal': 1 } });
  }
  const live = await Shipment.find({ orderId: order._id, status: { $in: ['CREATED', 'SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED'] } }).lean();
  await Order.updateOne({ _id: order._id }, { $set: { 'fulfillment.state': live.length === order.items.length ? 'placed' : 'partial', 'fulfillment.lastError': null, 'costs.supplierCost': live.reduce((s, x) => s + (x.cost?.productCost ?? 0), 0), 'costs.shippingCost': live.reduce((s, x) => s + (x.cost?.shippingCost ?? 0), 0) } });
  for (const e of await ExceptionModel.find({ orderId: order._id, kind: { $in: ['SUPPLIER_FAILURE', 'TRACKING'] }, status: { $in: ['open', 'in_progress'] }, dedupeKey: { $not: /^rescue:/ } }).select('_id').lean()) await resolveException(ctx, String(e._id), SYSTEM, `Resolved by Delivery Rescue case ${c._id}`);
  await recomputeOrderStatus(String(order._id), 'Delivery Rescue replacement placed');
  await RescueCase.updateOne({ _id: c._id }, { $set: { state: 'monitoring', nextReviewAt: new Date(ctx.now().getTime() + 6 * 3_600_000), 'actualCost.extraCost': opt.impact.extraCost, 'actualCost.refund': 0, resolution: { optionKind: opt.kind, auto: (a.authorizedBy as { mode?: string } | undefined)?.mode === 'auto', by: (a.authorizedBy as { actorId?: string } | undefined)?.actorId, note: `Replacement ordered from ${target.name}` } } });
  await audit(ctx, SYSTEM, { action: 'rescue.reorder.placed', resource: 'order', resourceId: String(order._id), newValue: { supplier: sup.code, key: idemKey, kind: opt.kind }, provider: sup.code, reason: `rescue case ${c._id}` });
  await tell(ctx, c, 'resolved', opt.kind === 'offer_equivalent_replacement' ? `We are sending “${opt.replacement!.title}” as agreed. You pay nothing extra.` : 'We placed your item with another approved supplier. Your tracking will appear on your order page.', undefined, 'executed');
  return { supplier: sup.code, supplierOrderId: row.supplierOrderId, key: idemKey };
}

async function refundFlow(ctx: Ctx, a: ActionDoc, c: CaseDoc, opt: StoredOption): Promise<{ waiting?: boolean; result: unknown }> {
  const order = await Order.findById(c.orderId);
  if (!order) throw new RescueError('order missing', 'NO_ORDER');
  const full = opt.kind === 'offer_full_refund';
  if (a.refundId) {
    const r = await Refund.findById(a.refundId).lean();
    if (r?.status === 'succeeded') return finishRefund(ctx, a, c, opt, r.amount);
    if (r?.status === 'failed' || r?.status === 'rejected') throw new RescueError(`Refund ${r.status}: ${r.failureReason ?? ''}`, 'REFUND_FAILED', false);
    return { waiting: true, result: { refundId: String(a.refundId), status: r?.status } };
  }
  if (full) {
    const ships = await Shipment.find({ orderId: order._id, lineKey: c.lineKey, status: { $in: ['PENDING_CREATE', 'CREATED'] } });
    for (const s of ships) {
      if (!s.supplierOrderId) throw new RescueError('A supplier order may exist without an id; will not refund and risk it shipping', 'MAYBE_WITH_SUPPLIER', false);
      const sup = await Supplier.findById(s.supplierId);
      const r = sup ? await (await providerFor(ctx, sup)).cancelOrder(s.supplierOrderId) : { cancelled: false, reason: 'supplier missing' };
      if (!r.cancelled) throw new RescueError(`Supplier could not cancel (${r.reason ?? 'unknown'}); not refunding while it may still ship`, 'CANCEL_REFUSED', false);
      s.status = 'CANCELLED';
      s.lastError = `Cancelled by Delivery Rescue case ${c._id}`;
      await s.save();
    }
  }
  const refund = await refundOrder(ctx, String(order._id), { actor: SYSTEM, amount: opt.impact.refund, reason: `Delivery Rescue (${c.kind}): ${opt.label}`, keyHint: refundKeyHint(String(c._id), opt.kind) });
  a.refundId = refund._id as never;
  await a.save();
  if (refund.status === 'succeeded') return finishRefund(ctx, a, c, opt, refund.amount);
  if (refund.status === 'pending_approval') await logEvent(c._id, c.orderId, SYSTEM_RESCUE, 'refund_pending_approval', 'Refund exceeds the automatic refund limit; waiting for its approval', { refundId: String(refund._id) });
  return { waiting: true, result: { refundId: String(refund._id), status: refund.status } };
}

async function finishRefund(ctx: Ctx, a: ActionDoc, c: CaseDoc, opt: StoredOption, amount: number) {
  const full = opt.kind === 'offer_full_refund';
  await RescueCase.updateOne({ _id: c._id }, { $set: { 'actualCost.refund': amount, 'actualCost.extraCost': 0 } });
  await tell(ctx, c, 'refunded', `${fmtMoney(amount, c.currency)} is being refunded to your original payment method.`, undefined, 'refund');
  const fresh = (await RescueCase.findById(c._id))!;
  if (full) {
    for (const e of await ExceptionModel.find({ orderId: c.orderId, status: { $in: ['open', 'in_progress'] } }).select('_id').lean()) await resolveException(ctx, String(e._id), SYSTEM, `Resolved by Delivery Rescue case ${c._id}`);
    await closeCase(ctx, fresh, SYSTEM_RESCUE, { optionKind: opt.kind, auto: (a.authorizedBy as { mode?: string } | undefined)?.mode === 'auto', by: (a.authorizedBy as { actorId?: string } | undefined)?.actorId, note: 'Refunded in full.' }, 'resolved');
  } else {
    fresh.state = 'monitoring';
    fresh.nextReviewAt = new Date(ctx.now().getTime() + 6 * 3_600_000);
    await fresh.save();
  }
  return { result: { refunded: amount } };
}

/* ------------------------------------------------------------------ queries */
export async function rescueKpis(ctx: Ctx, days: number) {
  const since = new Date(ctx.now().getTime() - days * DAY);
  const fx = (await ctx.settings.get('ops')).fx;
  const cases = await RescueCase.find({ detectedAt: { $gte: since } }).select('kind state resolution resolvedAt detectedAt actualCost currency severity').lean();
  const byKind: Record<string, number> = {};
  let resolved = 0, auto = 0, ttrMs = 0, costUsd = 0;
  const costByCurrency: Record<string, { extraCost: number; refund: number }> = {};
  for (const c of cases) {
    byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
    const e = c.actualCost?.extraCost ?? 0, r = c.actualCost?.refund ?? 0;
    const cc = (costByCurrency[c.currency] ??= { extraCost: 0, refund: 0 });
    cc.extraCost += e; cc.refund += r;
    costUsd += convertMinor(Math.max(0, e) + r, c.currency as Currency, 'USD', fx);
    if (c.state === 'resolved' && c.resolvedAt) { resolved++; if (c.resolution?.auto) auto++; ttrMs += c.resolvedAt.getTime() - c.detectedAt.getTime(); }
  }
  const consents = await RescueConsent.find({ createdAt: { $gte: since }, status: { $in: ['accepted', 'declined'] } }).select('status').lean();
  return {
    days, detected: cases.length, byKind, active: cases.filter((c) => ACTIVE.includes(c.state)).length, awaitingCustomer: cases.filter((c) => c.state === 'awaiting_customer').length, awaitingStaff: cases.filter((c) => c.state === 'awaiting_staff').length, escalated: cases.filter((c) => c.state === 'escalated').length,
    resolved, autoResolved: auto, autoResolvedPct: resolved ? auto / resolved : null, avgTimeToResolutionHours: resolved ? ttrMs / resolved / 3_600_000 : null,
    costOfRecoveryUsd: costUsd, costByCurrency, consentAcceptRate: consents.length ? consents.filter((k) => k.status === 'accepted').length / consents.length : null, consentSample: consents.length,
  };
}

export async function listCases(q: { page: number; pageSize: number; state?: string; active?: string; kind?: string; severity?: string; q?: string }) {
  const f: Record<string, unknown> = {};
  if (q.state) f['state'] = q.state; else if (q.active === 'true') f['state'] = { $in: ACTIVE }; else if (q.active === 'false') f['state'] = { $nin: ACTIVE };
  if (q.kind) f['kind'] = q.kind;
  if (q.severity) f['severity'] = q.severity;
  if (q.q) f['orderNumber'] = { $regex: `^${q.q.replace(/[^A-Za-z0-9-]/g, '')}`, $options: 'i' };
  const [items, total] = await Promise.all([RescueCase.find(f).sort({ createdAt: -1 }).skip((q.page - 1) * q.pageSize).limit(q.pageSize).select('-options').lean(), RescueCase.countDocuments(f)]);
  return { items, total, page: q.page, pageSize: q.pageSize };
}

export async function caseDetail(caseId: string) {
  const c = await RescueCase.findById(caseId).lean();
  if (!c) throw notFound('Rescue case');
  const [timeline, actions, consents] = await Promise.all([RescueTimeline.find({ caseId }).sort({ at: 1 }).limit(500).lean(), RescueAction.find({ caseId }).sort({ createdAt: 1 }).lean(), RescueConsent.find({ caseId }).sort({ createdAt: 1 }).select('-ipHash').lean()]);
  return { case: c, timeline, actions, consents };
}

export function assertStaff(actor: Actor): void {
  if (actor.type !== 'user') throw forbidden();
}
void SYSTEM_RESCUE;
export type { RescueOptionKind };
void autoUsageToday;
void authorize;
