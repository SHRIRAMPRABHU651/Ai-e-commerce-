/** Supplier recovery claims and return analytics (real data only; small samples are flagged, not extrapolated). */
import { randomBytes } from 'node:crypto';
import { AftersalesClaim, AftersalesReturn, Order, OrderItem, Product, Shipment, Supplier } from '@orvia/database';
import type { ClaimKind, ClaimState, RmaState } from '@orvia/types';
import { audit } from '../../infra/audit';
import { conflict, DomainError, notFound } from '../../infra/context';
import type { Actor, Ctx } from '../../infra/context';
import { CLAIM_MACHINE, TransitionError, assertTransition, claimDeadline, maxRecoverable, validateClaimAmounts } from './stateMachines';
import { getSupplierPolicy, loadPolicy } from './service';

export async function createClaim(ctx: Ctx, actor: Actor, i: { orderId: string; supplierId: string; returnId?: string; kind: ClaimKind; claimedAmount: number; description: string }) {
  const order = await Order.findById(i.orderId).select('orderNumber currency deliveredAt createdAt').lean();
  if (!order) throw notFound('Order');
  const ships = await Shipment.find({ orderId: i.orderId, supplierId: i.supplierId, status: { $nin: ['FAILED', 'CANCELLED'] } }).select('cost').lean();
  if (!ships.length) throw new DomainError('This supplier did not fulfil any part of that order', 'VALIDATION', 422);
  const cost = ships.reduce((a, s) => ({ productCost: a.productCost + (s.cost?.productCost ?? 0), shippingCost: a.shippingCost + (s.cost?.shippingCost ?? 0) }), { productCost: 0, shippingCost: 0 });
  const max = maxRecoverable(i.kind, { ...cost, refundedToCustomer: 0 });
  if (max > 0 && i.claimedAmount > max) throw new DomainError(`Claim exceeds what we paid this supplier for the order (${max})`, 'VALIDATION', 422);
  const [sp, policy] = await Promise.all([getSupplierPolicy(i.supplierId), loadPolicy()]);
  const dueBy = claimDeadline(order.deliveredAt ?? (order as { createdAt?: Date }).createdAt ?? ctx.now(), sp?.claimWindowDays ?? undefined, policy.defaultClaimWindowDays);
  const claim = await AftersalesClaim.create({
    claimNumber: `CLM-${randomBytes(4).toString('hex').toUpperCase()}`, supplierId: i.supplierId, orderId: i.orderId, returnId: i.returnId, kind: i.kind, state: 'draft', currency: order.currency,
    claimedAmount: i.claimedAmount, description: i.description, dueBy, timeline: [{ state: 'draft', at: ctx.now(), actor: actor.id, note: 'Claim drafted' }],
  });
  if (i.returnId) await AftersalesReturn.updateOne({ returnId: i.returnId }, { $set: { supplierClaimId: claim._id } });
  await audit(ctx, actor, { action: 'aftersales.claim_created', resource: 'supplier_claim', resourceId: String(claim._id), newValue: { kind: i.kind, amount: i.claimedAmount } });
  return claim;
}

export async function transitionClaim(ctx: Ctx, id: string, actor: Actor, i: { to: ClaimState; approvedAmount?: number; recoveredAmount?: number; note: string }) {
  const c = await AftersalesClaim.findById(id);
  if (!c) throw notFound('Claim');
  try { assertTransition(CLAIM_MACHINE, c.state as ClaimState, i.to, 'Claim'); } catch (e) { if (e instanceof TransitionError) throw conflict(e.message); throw e; }
  const approved = i.to === 'accepted' ? c.claimedAmount ?? 0 : i.approvedAmount ?? c.approvedAmount ?? undefined;
  const err = validateClaimAmounts(i.to, { claimed: c.claimedAmount ?? 0, approved, recovered: i.recoveredAmount });
  if (err) throw new DomainError(err, 'VALIDATION', 422);
  if (['accepted', 'partially_accepted'].includes(i.to) && approved !== undefined) c.approvedAmount = approved;
  if (i.to === 'recovered') c.recoveredAmount = i.recoveredAmount ?? 0;
  c.state = i.to;
  c.timeline.push({ state: i.to, at: ctx.now(), actor: actor.id, note: i.note });
  await c.save();
  await audit(ctx, actor, { action: 'aftersales.claim_state', resource: 'supplier_claim', resourceId: id, newValue: { state: i.to, approved: c.approvedAmount, recovered: c.recoveredAmount }, reason: i.note });
  return c;
}

export async function listClaims(q: { page: number; pageSize: number; state?: string }) {
  const f = q.state ? { state: q.state } : {};
  const [items, total, sums] = await Promise.all([
    AftersalesClaim.find(f).sort({ createdAt: -1 }).skip((q.page - 1) * q.pageSize).limit(q.pageSize).lean(),
    AftersalesClaim.countDocuments(f),
    AftersalesClaim.aggregate<{ _id: { c: string; s: string }; claimed: number; approved: number; recovered: number }>([{ $group: { _id: { c: '$currency', s: '$state' }, claimed: { $sum: '$claimedAmount' }, approved: { $sum: '$approvedAmount' }, recovered: { $sum: '$recoveredAmount' } } }]),
  ]);
  const sup = new Map((await Supplier.find({ _id: { $in: items.map((x) => x.supplierId) } }).select('name').lean()).map((s) => [String(s._id), s.name]));
  return { items: items.map((c) => ({ ...c, supplierName: sup.get(String(c.supplierId)) })), total, page: q.page, pageSize: q.pageSize, totals: sums.map((s) => ({ currency: s._id.c, state: s._id.s, claimed: s.claimed, approved: s.approved, recovered: s.recovered })) };
}

/* ------------------------------- analytics ------------------------------- */
const MIN_DENOM = 20;
const rate = (n: number, d: number) => (d >= MIN_DENOM ? n / d : null);
const CLOSED: RmaState[] = ['rejected', 'cancelled'];

export async function returnAnalytics(ctx: Ctx, sinceDays = 90) {
  const since = new Date(ctx.now().getTime() - sinceDays * 86_400_000);
  const rows = await AftersalesReturn.find({ createdAt: { $gte: since }, state: { $nin: CLOSED } }).select('reasonCode country resolution state items').limit(20_000).lean();
  const [ordersByCountry, soldByProduct, shippedBySupplier] = await Promise.all([
    Order.aggregate<{ _id: string; n: number }>([{ $match: { createdAt: { $gte: since }, status: { $nin: ['PENDING_PAYMENT', 'CANCELLED'] } } }, { $group: { _id: '$country', n: { $sum: 1 } } }]),
    OrderItem.aggregate<{ _id: unknown; qty: number }>([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: '$productId', qty: { $sum: '$quantity' } } }]),
    Shipment.aggregate<{ _id: unknown; qty: number }>([{ $match: { createdAt: { $gte: since }, status: { $nin: ['FAILED', 'CANCELLED'] } } }, { $group: { _id: '$supplierId', qty: { $sum: '$quantity' } } }]),
  ]);
  const count = <T extends string>(xs: T[]) => xs.reduce<Record<string, number>>((a, x) => ((a[x] = (a[x] ?? 0) + 1), a), {});
  const byProductUnits = new Map<string, number>();
  const bySupplierUnits = new Map<string, number>();
  for (const r of rows) for (const it of r.items) {
    if (it.productId) byProductUnits.set(String(it.productId), (byProductUnits.get(String(it.productId)) ?? 0) + (it.quantity ?? 0));
    if (it.supplierId) bySupplierUnits.set(String(it.supplierId), (bySupplierUnits.get(String(it.supplierId)) ?? 0) + (it.quantity ?? 0));
  }
  const sold = new Map(soldByProduct.map((s) => [String(s._id), s.qty]));
  const shipped = new Map(shippedBySupplier.map((s) => [String(s._id), s.qty]));
  const [prods, sups] = await Promise.all([Product.find({ _id: { $in: [...byProductUnits.keys()] } }).select('title').lean(), Supplier.find({ _id: { $in: [...bySupplierUnits.keys()] } }).select('name').lean()]);
  const title = new Map(prods.map((p) => [String(p._id), p.title]));
  const sname = new Map(sups.map((s) => [String(s._id), s.name]));
  const top = (m: Map<string, number>, d: Map<string, number>, name: Map<string, string>) =>
    [...m].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([id, units]) => ({ id, name: name.get(id) ?? id, returnedUnits: units, soldUnits: d.get(id) ?? 0, rate: rate(units, d.get(id) ?? 0) }));
  const returnsByCountry = count(rows.map((r) => r.country ?? 'unknown'));
  const legacyTotal = await (await import('@orvia/database')).ReturnRequest.countDocuments({ createdAt: { $gte: since } });
  return {
    windowDays: sinceDays, minSampleForRates: MIN_DENOM, totalReturns: rows.length,
    legacyReturnsWithoutDetail: Math.max(0, legacyTotal - rows.length),
    byReason: Object.entries(count(rows.map((r) => r.reasonCode))).map(([reason, n]) => ({ reason, count: n })).sort((a, b) => b.count - a.count),
    byResolution: count(rows.map((r) => r.resolution ?? 'refund')),
    byCountry: ordersByCountry.map((o) => ({ country: o._id, orders: o.n, returns: returnsByCountry[o._id] ?? 0, rate: rate(returnsByCountry[o._id] ?? 0, o.n) })),
    byProduct: top(byProductUnits, sold, title),
    bySupplier: top(bySupplierUnits, shipped, sname),
    note: 'Rates are shown only when the denominator is at least the minimum sample; otherwise "insufficient data".',
  };
}
