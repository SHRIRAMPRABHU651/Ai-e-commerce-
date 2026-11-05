/**
 * Returns / RMA service. Extends the core `Return` flow (returns.ts) without changing it: the core record keeps the
 * coarse status, `AftersalesReturn` carries the workflow. Money is decided by deterministic code (refundMath) and
 * executed only through the guarded `refundOrder` (idempotency, approval limits).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { AftersalesConfig, AftersalesReturn, AftersalesSupplierPolicy, Order, Payment, Product, ProductVariant, Refund, ReturnRequest, Shipment } from '@orvia/database';
import { RETURN_REASONS } from '@orvia/types';
import type { CountryCode, ReturnReasonCode, RmaState, StartReturnInput } from '@orvia/types';
import { audit } from '../../infra/audit';
import { getCountry } from '../../infra/countries';
import { conflict, DomainError, forbidden, notFound } from '../../infra/context';
import type { Actor, Ctx } from '../../infra/context';
import { notify } from '../notify';
import { decideReturn, requestReturn } from '../returns';
import { refundOrder } from '../orders';
import { canAddEvidence, evidenceSatisfied, evidenceStorageKey, isReturnOwner, validateEvidenceFile } from './evidence';
import { evaluateEligibility, validateSelection } from './eligibility';
import type { EligibilityLine } from './eligibility';
import { buildReturnInstructions, getLabelProvider } from './labels';
import { mergePolicy } from './policy';
import type { AftersalesPolicy, SupplierReturnPolicy } from './policy';
import { computeRefund, exchangeDifference } from './refundMath';
import { buildRefundTimeline } from './refundTimeline';
import { RMA_MACHINE, TransitionError, assertTransition } from './stateMachines';

type Who = { userId?: string; email?: string };
const ACTIVE_CORE = ['requested', 'approved', 'received', 'refunded'];
const rmaNumber = () => `RMA-${randomBytes(5).toString('hex').toUpperCase()}`;

const tx = <T>(fn: () => T): T => {
  try { return fn(); } catch (e) { if (e instanceof TransitionError) throw conflict(e.message); throw e; }
};

export async function loadPolicy(): Promise<AftersalesPolicy> {
  const doc = await AftersalesConfig.findOne({ key: 'policy' }).lean();
  return mergePolicy(doc?.value as Partial<AftersalesPolicy> | undefined);
}

export async function savePolicy(ctx: Ctx, patch: Partial<AftersalesPolicy>, actor: Actor): Promise<AftersalesPolicy> {
  const merged = mergePolicy({ ...(await loadPolicy()), ...patch });
  await AftersalesConfig.updateOne({ key: 'policy' }, { $set: { value: merged, updatedBy: actor.id } }, { upsert: true });
  await audit(ctx, actor, { action: 'aftersales.policy_updated', resource: 'aftersales_policy', newValue: merged });
  return merged;
}

export async function getSupplierPolicy(supplierId: string) {
  return AftersalesSupplierPolicy.findOne({ supplierId }).lean();
}
const toRules = (p: Awaited<ReturnType<typeof getSupplierPolicy>>): SupplierReturnPolicy | null => (p ? { supportsReturns: p.supportsReturns ?? 'unknown', supportsReplacement: !!p.supportsReplacement, supportsExchange: !!p.supportsExchange, returnWindowDays: p.returnWindowDays ?? undefined, defectOnly: !!p.defectOnly } : null);

export async function saveSupplierPolicy(ctx: Ctx, supplierId: string, data: Record<string, unknown>, actor: Actor) {
  const doc = await AftersalesSupplierPolicy.findOneAndUpdate({ supplierId }, { $set: { ...data, updatedBy: actor.id } }, { upsert: true, new: true });
  await audit(ctx, actor, { action: 'aftersales.supplier_policy_updated', resource: 'supplier', resourceId: supplierId, newValue: data });
  return doc;
}

/* ----------------------------- order context ----------------------------- */
async function loadOrderFor(orderRef: string, who: Who, staff = false) {
  const order = /^[a-f\d]{24}$/i.test(orderRef) ? await Order.findById(orderRef) : await Order.findOne({ orderNumber: orderRef });
  if (!order) throw notFound('Order');
  if (!staff && !isReturnOwner({ userId: order.userId ? String(order.userId) : undefined, email: order.email }, who)) throw forbidden();
  return order;
}

async function buildLines(order: InstanceType<typeof Order>, excludeReturnId?: string): Promise<(EligibilityLine & { supplierId?: string; productId: string; unitPrice: number })[]> {
  const ships = await Shipment.find({ orderId: order._id, status: { $nin: ['FAILED', 'CANCELLED'] } }).select('sku supplierId lineKey').lean();
  const products = await Product.find({ _id: { $in: order.items.map((i) => i.productId) } }).select('category topCategory').lean();
  const prodBy = new Map(products.map((p) => [String(p._id), p]));
  const mine = await AftersalesReturn.find({ orderId: order._id, state: { $nin: ['rejected', 'cancelled'] } }).select('returnId items state').lean();
  const covered = new Set(mine.map((m) => String(m.returnId)));
  const legacy = await ReturnRequest.find({ orderId: order._id, status: { $in: ACTIVE_CORE } }).select('itemSkus').lean();
  const returned = new Map<string, number>();
  for (const m of mine) {
    if (excludeReturnId && String(m.returnId) === excludeReturnId) continue;
    for (const it of m.items) returned.set(it.sku ?? '', (returned.get(it.sku ?? '') ?? 0) + (m.state === 'resolved' ? it.acceptedQuantity ?? it.quantity ?? 0 : it.quantity ?? 0));
  }
  for (const l of legacy) {
    if (covered.has(String(l._id))) continue;
    for (const sku of l.itemSkus) returned.set(sku, order.items.find((i) => i.sku === sku)?.quantity ?? 0);
  }
  const out = [];
  for (const it of order.items) {
    const sup = ships.find((s) => s.lineKey === it.lineKey || s.sku === it.sku)?.supplierId;
    const pol = sup ? toRules(await getSupplierPolicy(String(sup))) : null;
    const p = prodBy.get(String(it.productId));
    out.push({ sku: it.sku, title: it.title, quantity: it.quantity, category: p?.category ?? p?.topCategory ?? undefined, alreadyReturned: Math.min(it.quantity, returned.get(it.sku) ?? 0), supplier: pol, supplierId: sup ? String(sup) : undefined, productId: String(it.productId), unitPrice: it.unitPrice ?? 0 });
  }
  return out;
}

export async function getEligibility(ctx: Ctx, orderRef: string, who: Who, reason?: ReturnReasonCode, conditions: Record<string, EligibilityLine['condition']> = {}) {
  const order = await loadOrderFor(orderRef, who);
  const [cfg, policy, lines, open] = await Promise.all([getCountry(order.country), loadPolicy(), buildLines(order), ReturnRequest.exists({ orderId: order._id, status: { $in: ['requested', 'approved', 'received'] } })]);
  const result = evaluateEligibility({
    now: ctx.now(), deliveredAt: order.deliveredAt ?? null, paymentOk: ['succeeded', 'partially_refunded'].includes(order.payment?.status ?? ''), countryWindowDays: cfg.returnWindowDays, reason,
    lines: lines.map((l) => ({ ...l, condition: conditions[l.sku] ?? l.condition })), excludedCategories: policy.excludedCategories, openReturn: !!open,
  });
  return { order, lines, result, reasonMeta: reason ? RETURN_REASONS[reason] : null };
}

/* ------------------------------- customer ------------------------------- */
export async function startReturn(ctx: Ctx, input: StartReturnInput, who: Who & { actor: Actor }) {
  const cond = Object.fromEntries(input.items.map((i) => [i.sku, i.condition]));
  const { order, lines, result } = await getEligibility(ctx, input.orderId, who, input.reason, cond);
  const problems = validateSelection(result, input.items, input.resolution);
  if (problems.length) throw new DomainError(problems[0]!.message, 'NOT_ELIGIBLE', 422, problems);

  let exchange: { requestedSku?: string; priceDifferenceRefund?: number } | undefined;
  if (input.resolution === 'exchange') {
    if (!input.exchangeSku || input.items.length !== 1) throw new DomainError('Choose one item and the variant you want instead', 'VALIDATION', 422);
    const line = lines.find((l) => l.sku === input.items[0]!.sku)!;
    const [cur, next] = await Promise.all([ProductVariant.findOne({ sku: line.sku }).lean(), ProductVariant.findOne({ sku: input.exchangeSku, active: true }).lean()]);
    if (!next || String(next.productId) !== line.productId) throw new DomainError('That variant is not available for exchange', 'EXCHANGE_UNAVAILABLE', 422);
    const d = exchangeDifference(line.unitPrice, line.unitPrice + (next.priceDelta ?? 0) - (cur?.priceDelta ?? 0), input.items[0]!.quantity);
    if (d.customerOwes > 0) throw new DomainError('That variant costs more. Place a new order for it and return this item for a refund.', 'EXCHANGE_PRICE_DIFFERENCE', 422);
    exchange = { requestedSku: input.exchangeSku, priceDifferenceRefund: d.refundDue };
  }

  const core = await requestReturn(ctx, { orderId: String(order._id), reason: input.reason, details: input.details, itemSkus: input.items.map((i) => i.sku) }, { userId: who.userId, email: who.email, actor: who.actor });
  const reqEv = RETURN_REASONS[input.reason].evidence;
  const doc = await AftersalesReturn.create({
    returnId: core._id, orderId: order._id, orderNumber: order.orderNumber, userId: order.userId, email: order.email, country: order.country, currency: order.currency, rmaNumber: rmaNumber(),
    state: 'submitted', reasonCode: input.reason, details: input.details, resolution: input.resolution,
    items: input.items.map((i) => { const l = lines.find((x) => x.sku === i.sku)!; return { sku: i.sku, title: l.title, productId: l.productId, supplierId: l.supplierId, quantity: i.quantity, unitPrice: l.unitPrice, condition: i.condition }; }),
    evidenceRequired: reqEv === 'required', eligibility: JSON.parse(JSON.stringify(result.lines.filter((l) => input.items.some((i) => i.sku === l.sku)))),
    returnMethod: result.lines.find((l) => l.sku === input.items[0]!.sku)?.returnMethod, needsStaffReview: result.lines.some((l) => input.items.some((i) => i.sku === l.sku) && l.needsStaffReview),
    exchange, timeline: [{ state: 'submitted', at: ctx.now(), actor: who.actor.id, note: 'Return requested' }],
  });
  await audit(ctx, who.actor, { action: 'aftersales.return_started', resource: 'return', resourceId: String(core._id), newValue: { rma: doc.rmaNumber, resolution: input.resolution, reason: input.reason } });
  return doc;
}

export async function addEvidence(ctx: Ctx, rmaId: string, file: { buffer: Buffer; mimetype: string }, who: Who & { actor: Actor }, staff = false) {
  const rma = await AftersalesReturn.findById(rmaId);
  if (!rma) throw notFound('Return');
  const owner = isReturnOwner({ userId: rma.userId ? String(rma.userId) : undefined, email: rma.email }, who);
  if (!staff && !owner) throw forbidden();
  if (!canAddEvidence({ isStaff: staff, isOwner: owner, state: rma.state })) throw conflict('Photos can no longer be added to this return');
  const check = validateEvidenceFile(file, { maxBytes: ctx.cfg.MEDIA_MAX_BYTES, existingCount: rma.evidence.length });
  if (!check.ok) throw new DomainError(check.error!.message, 'EVIDENCE_REJECTED', 422, { code: check.error!.code });
  let out: Buffer;
  try {
    // Decode + re-encode: proves the image is real and strips EXIF/GPS metadata from customer photos.
    out = await sharp(file.buffer, { limitInputPixels: 50_000_000, failOn: 'error' }).rotate().resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
  } catch {
    throw new DomainError('The image is corrupt or cannot be decoded', 'EVIDENCE_REJECTED', 422, { code: 'corrupt' });
  }
  const id = randomUUID();
  const key = evidenceStorageKey(String(rma._id), id, 'webp');
  await ctx.storage.put(key, out, 'image/webp');
  rma.evidence.push({ id, key, mime: 'image/webp', bytes: out.length, uploadedAt: ctx.now(), uploadedBy: who.actor.id, byStaff: staff });
  await rma.save();
  await audit(ctx, who.actor, { action: 'aftersales.evidence_added', resource: 'return', resourceId: String(rma.returnId), newValue: { evidenceId: id, bytes: out.length } });
  return { id, bytes: out.length };
}

/** Evidence is private: served only through an ownership / permission check, never from a public CDN path. */
export async function getEvidenceFile(ctx: Ctx, rmaId: string, evidenceId: string, who: Who, staff: boolean) {
  const rma = await AftersalesReturn.findById(rmaId).lean();
  if (!rma) throw notFound('Return');
  if (!staff && !isReturnOwner({ userId: rma.userId ? String(rma.userId) : undefined, email: rma.email }, who)) throw forbidden();
  const ev = rma.evidence.find((e) => e.id === evidenceId);
  if (!ev?.key) throw notFound('Photo');
  const obj = await ctx.storage.get(ev.key);
  if (!obj) throw notFound('Photo');
  return { body: obj.body, contentType: ev.mime ?? 'image/webp' };
}

const customerView = (r: Record<string, any>) => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
  id: String(r._id), returnId: String(r.returnId), rmaNumber: r.rmaNumber, orderNumber: r.orderNumber, state: r.state, reasonCode: r.reasonCode, resolution: r.resolution,
  items: (r.items ?? []).map((i: Record<string, unknown>) => ({ sku: i.sku, title: i.title, quantity: i.quantity, condition: i.condition })), instructions: r.instructions ?? null,
  label: r.label?.url ? { url: r.label.url, carrier: r.label.carrier, trackingNumber: r.label.trackingNumber } : null, evidenceRequired: !!r.evidenceRequired,
  evidence: (r.evidence ?? []).map((e: { id: string; uploadedAt: Date }) => ({ id: e.id, uploadedAt: e.uploadedAt })), fulfilment: r.fulfilment ?? null, createdAt: r.createdAt,
  timeline: (r.timeline ?? []).map((t: { state: string; at: Date; note?: string }) => ({ state: t.state, at: t.at, note: t.note })),
});

export async function listMyReturns(who: Who) {
  const or: Record<string, unknown>[] = [];
  if (who.userId) or.push({ userId: who.userId });
  if (who.email) or.push({ email: who.email.toLowerCase() }, { email: who.email });
  const rows = await AftersalesReturn.find({ $or: or }).sort({ createdAt: -1 }).limit(50).lean();
  return rows.map(customerView);
}

export async function getMyReturn(ctx: Ctx, id: string, who: Who) {
  const r = await AftersalesReturn.findById(id).lean();
  if (!r) throw notFound('Return');
  if (!isReturnOwner({ userId: r.userId ? String(r.userId) : undefined, email: r.email }, who)) throw forbidden();
  return { ...customerView(r), refund: await refundTimelineFor(String(r.orderId), r) };
}

export async function refundTimelineFor(orderId: string, rma?: Record<string, any> | null) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const refunds = await Refund.find({ orderId }).sort({ createdAt: -1 }).limit(20).select('status amount currency createdAt updatedAt failureReason').lean();
  const pay = await Payment.findOne({ orderId }).select('status').lean();
  const t = buildRefundTimeline({
    rmaState: rma?.state, rmaCreatedAt: rma?.createdAt, rmaEvents: (rma?.timeline ?? []).map((x: { state: string; at: Date }) => ({ state: x.state, at: x.at })),
    refunds: refunds.map((r) => ({ status: r.status, amount: r.amount ?? 0, currency: r.currency, createdAt: (r as { createdAt?: Date }).createdAt, updatedAt: (r as { updatedAt?: Date }).updatedAt, failureReason: r.failureReason })), paymentStatus: pay?.status,
  });
  return { ...t, refunds: refunds.map((r) => ({ id: String(r._id), status: r.status, amount: r.amount, currency: r.currency, createdAt: (r as { createdAt?: Date }).createdAt })) };
}

/** Customer refund timeline for an order they own (used by the order page component). */
export async function orderAftersales(ctx: Ctx, orderNumber: string, who: Who) {
  const order = await loadOrderFor(orderNumber, who);
  const rma = await AftersalesReturn.findOne({ orderId: order._id }).sort({ createdAt: -1 }).lean();
  return { orderNumber: order.orderNumber, return: rma ? customerView(rma) : null, refund: await refundTimelineFor(String(order._id), rma) };
}

/* -------------------------------- staff -------------------------------- */
async function loadRma(id: string) {
  const r = await AftersalesReturn.findById(id);
  if (!r) throw notFound('Return');
  return r;
}
const push = (r: InstanceType<typeof AftersalesReturn>, state: RmaState, ctx: Ctx, actor: Actor, note = '') => {
  tx(() => assertTransition(RMA_MACHINE, r.state as RmaState, state, 'Return'));
  r.state = state;
  r.timeline.push({ state, at: ctx.now(), actor: actor.id, note });
};
async function mail(ctx: Ctx, r: InstanceType<typeof AftersalesReturn>, text: string, key: string) {
  const order = await Order.findById(r.orderId).select('email address').lean();
  if (!order) return;
  await notify(ctx, { template: 'promotion', to: order.email, data: { name: order.address?.fullName ?? undefined, discount: undefined, productTitle: `${text} (${r.rmaNumber})` }, dedupeKey: `aftersales:${r._id}:${key}` }).catch(() => undefined);
}
async function restoreOrderStatus(orderId: unknown) {
  const o = await Order.findById(orderId).select('status deliveredAt').lean();
  if (o?.status === 'REFUND_REQUESTED') await Order.updateOne({ _id: orderId }, { $set: { status: o.deliveredAt ? 'DELIVERED' : 'IN_TRANSIT' } });
}
// `resolved` is not in the core Return enum; mongoose only validates enums on save/validate, and these are updateOne calls.
const setCore = (r: InstanceType<typeof AftersalesReturn>, status: string, note?: string) => ReturnRequest.updateOne({ _id: r.returnId }, { $set: { status, ...(note ? { resolutionNote: note } : {}) } });

export async function authorizeReturn(ctx: Ctx, id: string, actor: Actor, note = '') {
  const r = await loadRma(id);
  if (r.state !== 'submitted') throw conflict(`Return is ${r.state}`);
  const ev = evidenceSatisfied(r.evidenceRequired ? 'required' : 'none', r.evidence.length);
  if (!ev.ok) throw new DomainError(ev.message ?? 'Evidence required', 'EVIDENCE_REQUIRED', 422);
  const supplierId = r.items[0]?.supplierId ? String(r.items[0].supplierId) : undefined;
  const sp = supplierId ? await getSupplierPolicy(supplierId) : null;
  const method = (r.returnMethod ?? 'staff_decides') as 'ship_back' | 'staff_decides' | 'none_needed';
  let label: Record<string, unknown> | undefined;
  const provider = getLabelProvider(sp?.labelProvider ?? undefined);
  if (provider && method === 'ship_back') {
    try {
      const order = await Order.findById(r.orderId).select('address').lean();
      const l = await provider.issueLabel({ rmaNumber: r.rmaNumber, orderNumber: r.orderNumber ?? '', supplierId: supplierId!, from: { name: order?.address?.fullName ?? undefined, line1: order?.address?.line1 ?? undefined, city: order?.address?.city ?? undefined, region: order?.address?.region ?? undefined, postalCode: order?.address?.postalCode ?? undefined, country: order?.address?.country ?? undefined }, to: (sp?.returnAddress as Record<string, unknown>) ?? undefined });
      label = { url: l.url, carrier: l.carrier, trackingNumber: l.trackingNumber, providerRef: l.providerRef, providerKey: provider.key, source: 'provider', issuedAt: ctx.now() };
    } catch (e) {
      ctx.log.warn({ channel: 'aftersales', rma: r.rmaNumber, err: (e as Error).message }, 'return label provider failed; falling back to instructions');
    }
  }
  r.instructions = buildReturnInstructions({ rmaNumber: r.rmaNumber, orderNumber: r.orderNumber ?? '', returnMethod: method, supplierInstructions: sp?.instructions ?? undefined, returnAddress: sp?.returnAddress as never, hasLabel: !!label });
  if (label) r.set('label', label);
  if (sp?.returnAddress) r.set('returnAddress', sp.returnAddress);
  push(r, 'authorized', ctx, actor, note);
  await r.save();
  await decideReturn(ctx, String(r.returnId), 'approve', actor, note).catch((e) => { if ((e as { code?: string }).code !== 'CONFLICT') throw e; });
  await audit(ctx, actor, { action: 'aftersales.authorized', resource: 'return', resourceId: String(r.returnId), newValue: { rma: r.rmaNumber, label: !!label }, reason: note });
  await mail(ctx, r, 'Your return was approved', 'authorized');
  return r;
}

export async function rejectReturn(ctx: Ctx, id: string, actor: Actor, note: string) {
  const r = await loadRma(id);
  push(r, 'rejected', ctx, actor, note);
  await r.save();
  await setCore(r, 'rejected', note);
  await restoreOrderStatus(r.orderId);
  await audit(ctx, actor, { action: 'aftersales.rejected', resource: 'return', resourceId: String(r.returnId), reason: note });
  await mail(ctx, r, 'Your return could not be approved', 'rejected');
  return r;
}

export async function markReceived(ctx: Ctx, id: string, actor: Actor, note = '') {
  const r = await loadRma(id);
  push(r, 'received', ctx, actor, note);
  await r.save();
  await setCore(r, 'received');
  await audit(ctx, actor, { action: 'aftersales.received', resource: 'return', resourceId: String(r.returnId), reason: note });
  return r;
}

export async function inspectReturn(ctx: Ctx, id: string, actor: Actor, i: { outcome: 'accepted' | 'accepted_partial' | 'rejected'; acceptedItems?: { sku: string; quantity: number }[]; note: string }) {
  const r = await loadRma(id);
  if (i.outcome === 'rejected') {
    push(r, 'inspected', ctx, actor, i.note);
    r.inspection = { outcome: 'rejected', note: i.note, by: actor.id, at: ctx.now() } as never;
    push(r, 'rejected', ctx, actor, `Inspection failed: ${i.note}`);
    await r.save();
    await setCore(r, 'rejected', i.note);
    await restoreOrderStatus(r.orderId);
    return r;
  }
  for (const it of r.items) {
    const a = i.outcome === 'accepted' ? it.quantity ?? 0 : i.acceptedItems?.find((x) => x.sku === it.sku)?.quantity ?? 0;
    if (a > (it.quantity ?? 0)) throw new DomainError(`Accepted quantity for ${it.sku} exceeds the requested quantity`, 'VALIDATION', 422);
    it.acceptedQuantity = a;
  }
  if (i.outcome === 'accepted_partial' && r.items.every((it) => !it.acceptedQuantity)) throw new DomainError('Accept at least one unit or reject the return', 'VALIDATION', 422);
  push(r, 'inspected', ctx, actor, i.note);
  r.inspection = { outcome: i.outcome, note: i.note, by: actor.id, at: ctx.now() } as never;
  await r.save();
  await audit(ctx, actor, { action: 'aftersales.inspected', resource: 'return', resourceId: String(r.returnId), newValue: { outcome: i.outcome }, reason: i.note });
  return r;
}

export async function previewRefund(ctx: Ctx, id: string) {
  const r = await loadRma(id);
  const order = await Order.findById(r.orderId);
  if (!order) throw notFound('Order');
  const [policy, lines] = await Promise.all([loadPolicy(), buildLines(order, String(r.returnId))]);
  const qty = (sku: string) => { const it = r.items.find((x) => x.sku === sku); return it ? (r.state === 'inspected' || it.acceptedQuantity !== undefined ? it.acceptedQuantity ?? 0 : it.quantity ?? 0) : 0; };
  const fault = RETURN_REASONS[r.reasonCode as ReturnReasonCode].fault;
  const calc = computeRefund({
    currency: order.currency, amounts: { subtotal: order.amounts?.subtotal ?? 0, discount: order.amounts?.discount ?? 0, shipping: order.amounts?.shipping ?? 0, tax: order.amounts?.tax ?? 0, total: order.amounts?.total ?? 0, taxInclusive: !!order.amounts?.taxInclusive },
    lines: order.items.map((it) => ({ sku: it.sku, unitPrice: it.unitPrice ?? 0, quantity: it.quantity, returnQty: qty(it.sku), alreadyReturnedQty: lines.find((l) => l.sku === it.sku)?.alreadyReturned ?? 0 })),
    alreadyRefunded: order.costs?.refunded ?? 0, fault, shippingRule: policy.shippingRefund[order.country as CountryCode], restockingFeeBps: policy.restockingFeeBps, returnShippingDeduction: policy.returnShippingDeduction[order.country as CountryCode],
  });
  return { rma: r, order, calc };
}

export async function resolveRefund(ctx: Ctx, id: string, actor: Actor, i: { amount?: number; note: string }) {
  const { rma: r, order, calc } = await previewRefund(ctx, id);
  const retry = r.state === 'refund_pending' && !r.refundId;
  if (!retry && !['authorized', 'inspected'].includes(r.state)) throw conflict(`Return is ${r.state}; it must be authorized or inspected before a refund`);
  if (calc.refundable <= 0) throw new DomainError('Nothing is refundable for the accepted items', 'NOTHING_TO_REFUND', 409);
  const amount = i.amount ?? calc.refundable;
  if (amount > calc.refundable) throw new DomainError(`Amount exceeds the maximum refundable ${calc.refundable}`, 'VALIDATION', 422);
  r.refundCalc = JSON.parse(JSON.stringify({ ...calc, requested: amount }));
  if (!retry) push(r, 'refund_pending', ctx, actor, i.note);
  await r.save();
  const refund = await refundOrder(ctx, String(order._id), { actor, amount, reason: `return ${r.returnId}: ${r.reasonCode}`, keyHint: `ret-${r.returnId}` });
  r.refundId = refund._id;
  if (refund.status === 'succeeded') await completeRefund(ctx, r, actor);
  else await r.save();
  await audit(ctx, actor, { action: 'aftersales.refund', resource: 'return', resourceId: String(r.returnId), newValue: { amount, refundStatus: refund.status, refundId: String(refund._id) }, reason: i.note });
  return { rma: r, refund, calc };
}

async function completeRefund(ctx: Ctx, r: InstanceType<typeof AftersalesReturn>, actor: Actor) {
  if (r.state === 'resolved') return;
  push(r, 'resolved', ctx, actor, 'Refund completed');
  await r.save();
  await setCore(r, 'refunded');
  await restoreOrderStatus(r.orderId);
  await mail(ctx, r, 'Your refund was issued', 'refunded');
}

export async function resolveReplacement(ctx: Ctx, id: string, actor: Actor) {
  const r = await loadRma(id);
  if (!['authorized', 'inspected'].includes(r.state)) throw conflict(`Return is ${r.state}`);
  if (r.resolution === 'refund') throw new DomainError('This return asked for a refund', 'VALIDATION', 422);
  const supplierId = r.items[0]?.supplierId ? String(r.items[0].supplierId) : undefined;
  const sp = supplierId ? await getSupplierPolicy(supplierId) : null;
  if (!(r.resolution === 'replacement' ? sp?.supportsReplacement : sp?.supportsExchange)) throw conflict(`The supplier is not recorded as supporting ${r.resolution}s; refund instead`);
  push(r, 'replacement_pending', ctx, actor, `${r.resolution} approved`);
  r.set('fulfilment', { status: 'pending', updatedAt: ctx.now() });
  await r.save();
  const diff = r.exchange?.priceDifferenceRefund ?? 0;
  if (r.resolution === 'exchange' && diff > 0) await refundOrder(ctx, String(r.orderId), { actor, amount: diff, reason: `exchange price difference ${r.rmaNumber}`, keyHint: `exch-${r.returnId}` });
  await audit(ctx, actor, { action: 'aftersales.replacement_approved', resource: 'return', resourceId: String(r.returnId), newValue: { resolution: r.resolution, sku: r.exchange?.requestedSku } });
  await mail(ctx, r, `Your ${r.resolution} was approved`, 'replacement');
  return r;
}

export async function recordReplacementShipment(ctx: Ctx, id: string, actor: Actor, i: { supplierOrderRef?: string; carrier?: string; trackingNumber?: string; delivered: boolean }) {
  const r = await loadRma(id);
  if (r.state !== 'replacement_pending') throw conflict(`Return is ${r.state}`);
  r.set('fulfilment', { status: i.delivered ? 'delivered' : i.trackingNumber ? 'shipped' : 'ordered', supplierOrderRef: i.supplierOrderRef, carrier: i.carrier, trackingNumber: i.trackingNumber, updatedAt: ctx.now() });
  if (i.delivered) {
    push(r, 'resolved', ctx, actor, `${r.resolution} delivered`);
    await setCore(r, 'resolved');
    await restoreOrderStatus(r.orderId);
  }
  await r.save();
  await audit(ctx, actor, { action: 'aftersales.replacement_shipment', resource: 'return', resourceId: String(r.returnId), newValue: i });
  return r;
}

export async function recordSupplierLabel(ctx: Ctx, id: string, actor: Actor, l: { url: string; carrier?: string; trackingNumber?: string }) {
  const r = await loadRma(id);
  if (!['authorized', 'submitted'].includes(r.state)) throw conflict(`Return is ${r.state}`);
  r.set('label', { ...l, source: 'supplier_provided', issuedAt: ctx.now() });
  r.instructions = buildReturnInstructions({ rmaNumber: r.rmaNumber, orderNumber: r.orderNumber ?? '', returnMethod: 'ship_back', hasLabel: true });
  await r.save();
  await audit(ctx, actor, { action: 'aftersales.label_recorded', resource: 'return', resourceId: String(r.returnId), newValue: { source: 'supplier_provided' } });
  return r;
}

export async function addNote(ctx: Ctx, id: string, actor: Actor, n: { text: string; internal: boolean }) {
  const r = await loadRma(id);
  r.notes.push({ at: ctx.now(), by: actor.id, text: n.text, internal: n.internal });
  await r.save();
  await audit(ctx, actor, { action: 'aftersales.note', resource: 'return', resourceId: String(r.returnId), newValue: { internal: n.internal } });
  return r;
}

export async function listReturnsAdmin(q: { page: number; pageSize: number; state?: string }) {
  const f = q.state ? { state: q.state } : {};
  const [items, total] = await Promise.all([AftersalesReturn.find(f).sort({ createdAt: -1 }).skip((q.page - 1) * q.pageSize).limit(q.pageSize).select('-eligibility').lean(), AftersalesReturn.countDocuments(f)]);
  return { items, total, page: q.page, pageSize: q.pageSize };
}

export async function getReturnAdmin(ctx: Ctx, id: string) {
  const r = await AftersalesReturn.findById(id).lean();
  if (!r) throw notFound('Return');
  const [refund, timeline] = await Promise.all([r.refundId ? Refund.findById(r.refundId).lean() : null, refundTimelineFor(String(r.orderId), r)]);
  let preview = null;
  if (['authorized', 'inspected'].includes(r.state)) preview = (await previewRefund(ctx, id)).calc;
  return { ...r, refund, refundTimeline: timeline, refundPreview: preview };
}

/** Job: pending refunds that were approved / finished by someone else complete their return. */
export async function syncReturnRefunds(ctx: Ctx): Promise<{ checked: number; completed: number }> {
  const rows = await AftersalesReturn.find({ state: 'refund_pending', refundId: { $exists: true } }).limit(200);
  let completed = 0;
  for (const r of rows) {
    const refund = await Refund.findById(r.refundId).select('status').lean();
    if (refund?.status === 'succeeded') { await completeRefund(ctx, r, { id: 'system', type: 'system' }); completed++; }
  }
  return { checked: rows.length, completed };
}
