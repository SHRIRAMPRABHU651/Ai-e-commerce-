/**
 * Supplier portal domain functions. EVERY function takes the caller's user id and resolves the supplier through
 * `resolvePortalSupplier`, which only ever returns suppliers whose `userIds` contain that user. Ids from the URL/body are
 * checked for membership and otherwise answered with 404 (never 403) so other tenants' ids cannot be probed.
 */
import { ExceptionModel, Order, Shipment, Supplier, SuppliernetDispute, SuppliernetReturnAuth, SuppliernetStatement } from '@orvia/database';
import { audit } from '../../infra/audit';
import { DomainError, notFound } from '../../infra/context';
import type { Actor, Ctx } from '../../infra/context';
import { notify } from '../notify';
import { recomputeOrderStatus } from '../orderStatus';
import { recordManualFulfillment } from '../supplierOps';
import { applyOfferCsv } from './catalog';
import { addDisputeEvidence, decideReturnAuthorization, getSlaDefinition, submitStatement, submitStatementCsv } from './ops';
import { addDocument, getVerification, listDocuments, readDocumentFile } from './service';
import { toSlaFacts } from './sla';
import { SuppliernetSlaSnapshot, SuppliernetProfile } from '@orvia/database';
import { isValidTrackingNumber, portalAddress } from './tenant';

const objId = (v: unknown) => String(v);
export const portalActor = (userId: string): Actor => ({ id: userId, type: 'user', role: 'SUPPLIER' });

export async function portalSuppliers(userId: string) {
  return Supplier.find({ userIds: userId }).select('code name provider network active').limit(20).lean();
}

/** The caller's supplier. A requested id that is not theirs yields 404, exactly like a non-existent id. */
export async function resolvePortalSupplier(userId: string, requestedId?: string) {
  const mine = await Supplier.find({ userIds: userId }).limit(20);
  const pick = requestedId ? mine.find((s) => objId(s._id) === requestedId) : mine[0];
  if (!pick) throw notFound('Supplier');
  return pick;
}

export async function dashboard(ctx: Ctx, userId: string, supplierId?: string) {
  const s = await resolvePortalSupplier(userId, supplierId);
  const sid = objId(s._id);
  const [toShip, awaitingAccept, openDisputes, openReturns, snap, v, def] = await Promise.all([
    Shipment.countDocuments({ supplierId: s._id, status: 'CREATED' }),
    ExceptionModel.countDocuments({ kind: 'MANUAL_FULFILLMENT', status: { $in: ['open', 'in_progress'] }, 'details.supplierId': sid }),
    SuppliernetDispute.countDocuments({ supplierId: s._id, state: { $in: ['open', 'awaiting_supplier', 'awaiting_orvia', 'escalated'] } }),
    SuppliernetReturnAuth.countDocuments({ supplierId: s._id, state: 'requested' }),
    SuppliernetSlaSnapshot.findOne({ supplierId: s._id }).sort({ computedAt: -1 }).lean(),
    getVerification(ctx, sid),
    getSlaDefinition(sid),
  ]);
  return {
    supplier: { id: sid, code: s.code, name: s.name, provider: s.provider, state: s.network?.state ?? null, productionReady: !!s.network?.productionReady, canConfirmOrders: ['manual', 'feed'].includes(s.provider) },
    ordersToFulfil: { toShip, awaitingAcceptance: awaitingAccept }, openDisputes, openReturnRequests: openReturns,
    sla: { facts: toSlaFacts(sid, snap as never), targets: def },
    verification: { ready: v.readiness.ready, missing: v.readiness.missing, validUntil: v.readiness.validUntil },
  };
}

export async function listOrders(userId: string, o: { supplierId?: string; status?: string; page: number; pageSize: number }) {
  const s = await resolvePortalSupplier(userId, o.supplierId);
  const q: Record<string, unknown> = { supplierId: s._id, status: { $ne: 'PENDING_CREATE' } };
  if (o.status) q['status'] = o.status;
  const [rows, total] = await Promise.all([Shipment.find(q).sort({ createdAt: -1 }).skip((o.page - 1) * o.pageSize).limit(o.pageSize).lean(), Shipment.countDocuments(q)]);
  const orders = await Order.find({ _id: { $in: rows.map((r) => r.orderId) } }).select('orderNumber items address country').lean();
  const byId = new Map(orders.map((x) => [objId(x._id), x]));
  const items = rows.map((r) => {
    const ord = byId.get(objId(r.orderId));
    const line = ord?.items.find((i) => i.lineKey === r.lineKey);
    return {
      shipmentId: objId(r._id), orderNumber: ord?.orderNumber, status: r.status, supplierOrderId: r.supplierOrderId, product: line?.title, quantity: r.quantity, createdAt: (r as unknown as { createdAt: Date }).createdAt,
      trackingNumber: r.trackingNumber, carrier: r.carrier,
      // the ship-to address is only shared while the supplier still has to ship
      shipTo: r.status === 'CREATED' ? portalAddress(ord?.address as never) : undefined,
    };
  });
  const queue = o.page === 1 && !o.status ? await acceptanceQueue(s) : [];
  return { items, total, page: o.page, pageSize: o.pageSize, awaitingAcceptance: queue };
}

async function acceptanceQueue(s: { _id: unknown; provider: string }) {
  if (!['manual', 'feed'].includes(s.provider)) return [];
  const ex = await ExceptionModel.find({ kind: 'MANUAL_FULFILLMENT', status: { $in: ['open', 'in_progress'] }, 'details.supplierId': objId(s._id) }).limit(50).lean();
  const out = [];
  for (const e of ex) {
    const ord = e.orderId ? await Order.findById(e.orderId).select('orderNumber items address payment').lean() : null;
    if (!ord || ord.payment?.status !== 'succeeded') continue;
    const lineKey = (e.details as { lineKey?: string } | undefined)?.lineKey;
    const line = ord.items.find((i) => i.lineKey === lineKey);
    if (!line) continue;
    out.push({ orderId: objId(ord._id), orderNumber: ord.orderNumber, lineKey, product: line.title, quantity: line.quantity, shipTo: portalAddress(ord.address as never) });
  }
  return out;
}

/** Supplier accepts an order from the manual queue and records its own order reference. */
export async function acceptOrder(ctx: Ctx, userId: string, i: { supplierId?: string; orderId: string; lineKey: string; supplierOrderId: string }) {
  const s = await resolvePortalSupplier(userId, i.supplierId);
  if (!['manual', 'feed'].includes(s.provider)) throw new DomainError('Orders for API suppliers are placed automatically', 'CONFLICT', 409);
  const queued = await ExceptionModel.findOne({ kind: 'MANUAL_FULFILLMENT', status: { $in: ['open', 'in_progress'] }, orderId: i.orderId, 'details.supplierId': objId(s._id), 'details.lineKey': i.lineKey }).lean();
  if (!queued) throw notFound('Order'); // not assigned to this supplier
  return recordManualFulfillment(ctx, i.orderId, { lineKey: i.lineKey, supplierId: objId(s._id), supplierOrderId: i.supplierOrderId }, portalActor(userId));
}

/** Fulfilment confirmation: mark shipped with a validated tracking number. Only for suppliers whose tracking is entered by hand. */
export async function markShipped(ctx: Ctx, userId: string, i: { supplierId?: string; shipmentId: string; trackingNumber: string; carrier: string }) {
  const s = await resolvePortalSupplier(userId, i.supplierId);
  if (!['manual', 'feed'].includes(s.provider)) throw new DomainError('Your shipments are tracked through your API integration', 'CONFLICT', 409);
  if (!isValidTrackingNumber(i.trackingNumber)) throw new DomainError('Tracking number must be 5-40 letters/digits (- _ / . allowed)', 'VALIDATION', 422);
  const sh = await Shipment.findOne({ _id: i.shipmentId, supplierId: s._id });
  if (!sh) throw notFound('Shipment'); // includes shipments of other suppliers
  if (!['CREATED', 'SHIPPED'].includes(sh.status)) throw new DomainError(`Shipment is ${sh.status}`, 'CONFLICT', 409);
  const first = sh.status === 'CREATED';
  sh.status = 'SHIPPED'; sh.trackingNumber = i.trackingNumber.trim(); sh.carrier = i.carrier.trim().slice(0, 60);
  sh.events.push({ status: 'SHIPPED', description: first ? 'Shipped by supplier' : 'Tracking updated by supplier', at: ctx.now() } as never);
  await sh.save();
  const order = await Order.findById(sh.orderId);
  if (order) {
    await recomputeOrderStatus(objId(order._id), 'shipment shipped (supplier portal)');
    if (first) await notify(ctx, { template: 'shipped', to: order.email, orderId: objId(order._id), data: { name: order.address?.fullName ?? undefined, orderNumber: order.orderNumber, trackingNumber: sh.trackingNumber ?? undefined, carrier: sh.carrier ?? undefined, url: `${ctx.cfg.WEB_URL}/orders/${order.orderNumber}` }, dedupeKey: `ship:${sh._id}:shipped` });
  }
  await audit(ctx, portalActor(userId), { action: 'suppliernet.portal_shipped', resource: 'shipment', resourceId: objId(sh._id), newValue: { carrier: sh.carrier, supplier: s.code } });
  return { ok: true };
}

export const uploadOffers = async (ctx: Ctx, userId: string, supplierId: string | undefined, csv: string) => applyOfferCsv(ctx, objId((await resolvePortalSupplier(userId, supplierId))._id), csv, portalActor(userId));

export async function portalDocuments(userId: string, supplierId?: string) { return listDocuments(objId((await resolvePortalSupplier(userId, supplierId))._id)); }
export async function portalUploadDocument(ctx: Ctx, userId: string, supplierId: string | undefined, d: Parameters<typeof addDocument>[2]) { return addDocument(ctx, objId((await resolvePortalSupplier(userId, supplierId))._id), d, portalActor(userId)); }
export async function portalDocumentFile(ctx: Ctx, userId: string, supplierId: string | undefined, documentId: string) { return readDocumentFile(ctx, objId((await resolvePortalSupplier(userId, supplierId))._id), documentId); }

/** Verification status as the supplier may see it: statuses and dates, never operator notes or request/response payloads. */
export async function portalVerification(ctx: Ctx, userId: string, supplierId?: string) {
  const s = await resolvePortalSupplier(userId, supplierId);
  const v = await getVerification(ctx, objId(s._id));
  const prof = await SuppliernetProfile.findOne({ supplierId: s._id }).select('state').lean();
  return { state: prof?.state ?? null, ready: v.readiness.ready, validUntil: v.readiness.validUntil, steps: v.steps.map((x) => ({ kind: x.kind, required: x.required, effective: x.effective, validUntil: x.validUntil })) };
}

export async function portalStatements(userId: string, supplierId?: string) {
  const s = await resolvePortalSupplier(userId, supplierId);
  return (await SuppliernetStatement.find({ supplierId: s._id }).sort({ createdAt: -1 }).limit(50).select('number currency status totals disputedMinor settlement.settledAt periodStart periodEnd createdAt').lean()).map((x) => ({ id: objId(x._id), ...x, _id: undefined }));
}
export async function portalSubmitStatement(ctx: Ctx, userId: string, supplierId: string | undefined, i: { number: string; currency: 'USD' | 'CAD' | 'INR'; periodStart?: Date; periodEnd?: Date; csv: string }) {
  return submitStatementCsv(ctx, objId((await resolvePortalSupplier(userId, supplierId))._id), i, portalActor(userId), 'portal');
}
export { submitStatement };

export async function portalDisputes(userId: string, supplierId?: string) {
  const s = await resolvePortalSupplier(userId, supplierId);
  return SuppliernetDispute.find({ supplierId: s._id }).sort({ createdAt: -1 }).limit(50).lean();
}
export async function portalDisputeRespond(ctx: Ctx, userId: string, supplierId: string | undefined, disputeId: string, e: { note: string; documentId?: string; url?: string }) {
  const s = await resolvePortalSupplier(userId, supplierId);
  return addDisputeEvidence(ctx, disputeId, 'supplier', e, portalActor(userId), objId(s._id));
}
export async function portalReturns(userId: string, supplierId?: string) {
  const s = await resolvePortalSupplier(userId, supplierId);
  return SuppliernetReturnAuth.find({ supplierId: s._id }).sort({ createdAt: -1 }).limit(50).lean();
}
export async function portalReturnDecide(ctx: Ctx, userId: string, supplierId: string | undefined, id: string, to: 'authorized' | 'rejected' | 'received_by_supplier' | 'refunded_by_supplier', o: { rmaNumber?: string; note?: string; refundMinor?: number }) {
  const s = await resolvePortalSupplier(userId, supplierId);
  return decideReturnAuthorization(ctx, id, to, o, portalActor(userId), objId(s._id));
}
