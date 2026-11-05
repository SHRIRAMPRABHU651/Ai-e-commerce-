import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MockPaymentProvider } from '@orvia/payments';
import {
  AftersalesSupplierPolicy, AftersalesChargeback,
} from '@orvia/database';
import {
  DomainError, MongoKVStore, acceptChargeback, addEvidence, addNote, authorizeReturn, capturePayment, chargebackMetrics, createClaim, getEligibility, getEvidenceFile,
  getMyReturn, getReturnAdmin, handlePaymentWebhook, inspectReturn, listChargebacks, listClaims, listMyReturns, listReturnsAdmin, loadPolicy, markReceived, notFound, orderAftersales, previewRefund,
  reconcileWithProvider, recordChargebackEvidence, recordReplacementShipment, recordSupplierLabel, rejectReturn, resolveRefund, resolveReplacement, returnAnalytics, saveSupplierPolicy, savePolicy,
  startReturn, submitChargebackEvidence, transitionClaim, chargebackReserveSummary,
} from '@orvia/core';
import type { Ctx } from '@orvia/core';
import {
  RETURN_REASONS, RETURN_REASON_CODES, adminReturnQuerySchema, authorizeReturnSchema, chargebackEvidenceSchema, chargebackListQuerySchema, claimCreateSchema, claimTransitionSchema, inspectReturnSchema,
  mockDisputeSchema, noteSchema, recordLabelSchema, rejectReturnSchema, replacementShipmentSchema, resolveRefundSchema, startReturnSchema, supplierPolicySchema,
} from '@orvia/types';
import { route } from '../http';

const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;
const A = 'staff' as const;

/** Reads one image from a multipart request; size/type/content validation happens in addEvidence (domain). */
async function readImage(req: FastifyRequest, maxBytes: number): Promise<{ buffer: Buffer; mimetype: string }> {
  if (!req.isMultipart()) throw new DomainError('Send the photo as multipart/form-data', 'VALIDATION', 415);
  let file: { buffer: Buffer; mimetype: string } | undefined;
  try {
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      if (file) { part.file.resume(); continue; }
      const buffer = await part.toBuffer();
      if (part.file.truncated) throw new DomainError(`Photo is larger than ${Math.round(maxBytes / 1_000_000)} MB`, 'EVIDENCE_REJECTED', 422);
      file = { buffer, mimetype: part.mimetype };
    }
  } catch (e) {
    if (e instanceof DomainError) throw e;
    throw new DomainError(/limit/i.test((e as Error).message) ? 'Photo is too large' : 'Invalid upload', 'EVIDENCE_REJECTED', 422);
  }
  if (!file) throw new DomainError('No photo received', 'VALIDATION', 400);
  return file;
}

export function aftersalesRoutes(app: FastifyInstance, ctx: Ctx): void {
  /* ------------------------------- customer ------------------------------- */
  route(app, ctx, {
    method: 'GET', url: '/aftersales/reasons', summary: 'Return reason taxonomy', tags: ['Returns'],
    handler: () => ({ items: RETURN_REASON_CODES.map((code) => ({ code, ...RETURN_REASONS[code] })) }),
  });
  route(app, ctx, {
    method: 'GET', url: '/aftersales/orders/:orderNumber/eligibility', summary: 'What can be returned from this order, and why not', tags: ['Returns'], auth: 'user',
    query: z.object({ reason: z.enum(RETURN_REASON_CODES).optional() }),
    handler: async ({ req, user, query }) => {
      const { result, order, reasonMeta } = await getEligibility(ctx, (req.params as { orderNumber: string }).orderNumber, { userId: user.id, email: user.email }, query.reason);
      return { orderId: String(order._id), orderNumber: order.orderNumber, currency: order.currency, reason: query.reason ?? null, evidence: reasonMeta?.evidence ?? null, ...result };
    },
  });
  route(app, ctx, {
    method: 'GET', url: '/aftersales/orders/:orderNumber/status', summary: 'Return and refund status for an order (customer view)', tags: ['Returns'], auth: 'user',
    handler: ({ req, user }) => orderAftersales(ctx, (req.params as { orderNumber: string }).orderNumber, { userId: user.id, email: user.email }),
  });
  route(app, ctx, {
    method: 'POST', url: '/aftersales/returns', summary: 'Start a return (refund, replacement or exchange)', tags: ['Returns'], auth: 'user', body: startReturnSchema, rateLimit: { max: 20, timeWindow: '1 hour' },
    handler: async ({ req, user, body, reply }) => {
      const r = await startReturn(ctx, body, { userId: user.id, email: user.email, actor: req.actor });
      return reply.status(201).send({ id: String(r._id), rmaNumber: r.rmaNumber, state: r.state, evidenceRequired: r.evidenceRequired, needsStaffReview: !!r.needsStaffReview });
    },
  });
  route(app, ctx, { method: 'GET', url: '/aftersales/returns', summary: 'My returns', tags: ['Returns'], auth: 'user', handler: async ({ user }) => ({ items: await listMyReturns({ userId: user.id, email: user.email }) }) });
  route(app, ctx, { method: 'GET', url: '/aftersales/returns/:id', summary: 'One of my returns with refund timeline', tags: ['Returns'], auth: 'user', handler: ({ req, user }) => getMyReturn(ctx, idOf(req), { userId: user.id, email: user.email }) });
  route(app, ctx, {
    method: 'POST', url: '/aftersales/returns/:id/evidence', summary: 'Upload a photo for a return (multipart, field "file")', tags: ['Returns'], auth: 'user', rateLimit: { max: 30, timeWindow: '1 hour' },
    handler: async ({ req, reply, user }) => reply.status(201).send(await addEvidence(ctx, idOf(req), await readImage(req, ctx.cfg.MEDIA_MAX_BYTES), { userId: user.id, email: user.email, actor: req.actor })),
  });
  app.get('/api/v1/aftersales/returns/:id/evidence/:evidenceId', { schema: { hide: true } }, async (req, reply) => {
    if (!req.user) throw new DomainError('Authentication required', 'UNAUTHENTICATED', 401);
    const p = req.params as { id: string; evidenceId: string };
    const f = await getEvidenceFile(ctx, p.id, p.evidenceId, { userId: req.user.id, email: req.user.email }, false);
    return reply.header('content-type', f.contentType).header('x-content-type-options', 'nosniff').header('cache-control', 'private, no-store').send(f.body);
  });

  /* --------------------------------- staff --------------------------------- */
  route(app, ctx, { method: 'GET', url: '/admin/aftersales/returns', summary: 'RMA queue', tags: ['Admin'], auth: A, permission: 'returns:read', query: adminReturnQuerySchema, handler: ({ query }) => listReturnsAdmin(query) });
  route(app, ctx, { method: 'GET', url: '/admin/aftersales/returns/:id', summary: 'RMA detail with refund preview', tags: ['Admin'], auth: A, permission: 'returns:read', handler: ({ req }) => getReturnAdmin(ctx, idOf(req)) });
  route(app, ctx, { method: 'GET', url: '/admin/aftersales/returns/:id/refund-preview', summary: 'Deterministic refund calculation', tags: ['Admin'], auth: A, permission: 'returns:read', handler: async ({ req }) => (await previewRefund(ctx, idOf(req))).calc });
  route(app, ctx, { method: 'POST', url: '/admin/aftersales/returns/:id/authorize', summary: 'Authorize the RMA', tags: ['Admin'], auth: A, permission: 'returns:write', body: authorizeReturnSchema, handler: async ({ req, body }) => ({ state: (await authorizeReturn(ctx, idOf(req), req.actor, body.note)).state }) });
  route(app, ctx, { method: 'POST', url: '/admin/aftersales/returns/:id/reject', summary: 'Reject the RMA', tags: ['Admin'], auth: A, permission: 'returns:write', body: rejectReturnSchema, handler: async ({ req, body }) => ({ state: (await rejectReturn(ctx, idOf(req), req.actor, body.note)).state }) });
  route(app, ctx, { method: 'POST', url: '/admin/aftersales/returns/:id/received', summary: 'Mark goods received', tags: ['Admin'], auth: A, permission: 'returns:write', body: authorizeReturnSchema, handler: async ({ req, body }) => ({ state: (await markReceived(ctx, idOf(req), req.actor, body.note)).state }) });
  route(app, ctx, { method: 'POST', url: '/admin/aftersales/returns/:id/inspect', summary: 'Record inspection outcome', tags: ['Admin'], auth: A, permission: 'returns:write', body: inspectReturnSchema, handler: async ({ req, body }) => ({ state: (await inspectReturn(ctx, idOf(req), req.actor, body)).state }) });
  route(app, ctx, {
    method: 'POST', url: '/admin/aftersales/returns/:id/refund', summary: 'Execute the refund through the guarded refund function (approval limits apply)', tags: ['Admin'], auth: A, permission: 'refunds:write', body: resolveRefundSchema,
    handler: async ({ req, body }) => { const r = await resolveRefund(ctx, idOf(req), req.actor, body); return { state: r.rma.state, refundStatus: r.refund.status, refundId: String(r.refund._id), calc: r.calc }; },
  });
  route(app, ctx, { method: 'POST', url: '/admin/aftersales/returns/:id/replacement', summary: 'Approve replacement/exchange', tags: ['Admin'], auth: A, permission: 'returns:write', handler: async ({ req }) => ({ state: (await resolveReplacement(ctx, idOf(req), req.actor)).state }) });
  route(app, ctx, { method: 'POST', url: '/admin/aftersales/returns/:id/replacement-shipment', summary: 'Record the replacement shipment', tags: ['Admin'], auth: A, permission: 'returns:write', body: replacementShipmentSchema, handler: async ({ req, body }) => ({ state: (await recordReplacementShipment(ctx, idOf(req), req.actor, body)).state }) });
  route(app, ctx, { method: 'POST', url: '/admin/aftersales/returns/:id/label', summary: 'Record a supplier-provided return label', tags: ['Admin'], auth: A, permission: 'returns:write', body: recordLabelSchema, handler: async ({ req, body }) => { await recordSupplierLabel(ctx, idOf(req), req.actor, body); return { ok: true }; } });
  route(app, ctx, { method: 'POST', url: '/admin/aftersales/returns/:id/notes', summary: 'Add a dispute/handling note', tags: ['Admin'], auth: A, permission: 'returns:write', body: noteSchema, handler: async ({ req, body }) => { await addNote(ctx, idOf(req), req.actor, body); return { ok: true }; } });
  route(app, ctx, {
    method: 'POST', url: '/admin/aftersales/returns/:id/evidence', summary: 'Staff upload of a photo', tags: ['Admin'], auth: A, permission: 'returns:write',
    handler: async ({ req, reply }) => reply.status(201).send(await addEvidence(ctx, idOf(req), await readImage(req, ctx.cfg.MEDIA_MAX_BYTES), { actor: req.actor }, true)),
  });
  app.get('/api/v1/admin/aftersales/returns/:id/evidence/:evidenceId', { schema: { hide: true } }, async (req, reply) => {
    const { can } = await import('@orvia/auth');
    if (!req.user || req.user.role === 'CUSTOMER' || !can(req.user.role, 'returns:read')) throw new DomainError('Forbidden', 'FORBIDDEN', 403);
    const p = req.params as { id: string; evidenceId: string };
    const f = await getEvidenceFile(ctx, p.id, p.evidenceId, {}, true);
    return reply.header('content-type', f.contentType).header('x-content-type-options', 'nosniff').header('cache-control', 'private, no-store').send(f.body);
  });

  // supplier return policy + deployment policy
  route(app, ctx, { method: 'GET', url: '/admin/aftersales/suppliers/:id/policy', summary: 'Supplier return handling', tags: ['Admin'], auth: A, permission: 'returns:read', handler: async ({ req }) => (await AftersalesSupplierPolicy.findOne({ supplierId: idOf(req) }).lean()) ?? { supplierId: idOf(req), supportsReturns: 'unknown', supportsReplacement: false, supportsExchange: false, defectOnly: false, instructions: '' } });
  route(app, ctx, { method: 'PUT', url: '/admin/aftersales/suppliers/:id/policy', summary: 'Set supplier return handling', tags: ['Admin'], auth: A, permission: 'returns:write', body: supplierPolicySchema, handler: async ({ req, body }) => saveSupplierPolicy(ctx, idOf(req), body, req.actor) });
  route(app, ctx, { method: 'GET', url: '/admin/aftersales/policy', summary: 'After-sales policy (shipping/restocking/exclusions)', tags: ['Admin'], auth: A, permission: 'returns:read', handler: () => loadPolicy() });
  route(app, ctx, {
    method: 'PUT', url: '/admin/aftersales/policy', summary: 'Update after-sales policy', tags: ['Admin'], auth: A, permission: 'settings:write',
    body: z.object({ excludedCategories: z.array(z.string().max(60)).max(100).optional(), restockingFeeBps: z.number().int().min(0).max(5000).optional(), defaultClaimWindowDays: z.number().int().min(1).max(365).optional(), shippingRefund: z.record(z.enum(['US', 'CA', 'IN']), z.enum(['fault_only', 'full_return', 'always'])).optional(), returnShippingDeduction: z.record(z.enum(['US', 'CA', 'IN']), z.number().int().min(0)).optional() }),
    handler: ({ req, body }) => savePolicy(ctx, body as never, req.actor),
  });

  // supplier recovery claims
  route(app, ctx, { method: 'GET', url: '/admin/aftersales/claims', summary: 'Supplier recovery claims', tags: ['Admin'], auth: A, permission: 'returns:read', query: adminReturnQuerySchema.omit({ state: true }).extend({ state: z.string().max(30).optional() }), handler: ({ query }) => listClaims(query) });
  route(app, ctx, { method: 'POST', url: '/admin/aftersales/claims', summary: 'Open a supplier claim', tags: ['Admin'], auth: A, permission: 'returns:write', body: claimCreateSchema, handler: async ({ req, body, reply }) => reply.status(201).send(await createClaim(ctx, req.actor, body)) });
  route(app, ctx, { method: 'POST', url: '/admin/aftersales/claims/:id/transition', summary: 'Move a claim through its state machine', tags: ['Admin'], auth: A, permission: 'returns:write', body: claimTransitionSchema, handler: ({ req, body }) => transitionClaim(ctx, idOf(req), req.actor, body) });

  route(app, ctx, { method: 'GET', url: '/admin/aftersales/analytics', summary: 'Return analytics from real data', tags: ['Admin'], auth: A, permission: 'returns:read', query: z.object({ days: z.coerce.number().int().min(7).max(365).default(90) }), handler: ({ query }) => returnAnalytics(ctx, query.days) });

  // chargebacks
  route(app, ctx, { method: 'GET', url: '/admin/aftersales/chargebacks', summary: 'Chargebacks / disputes', tags: ['Admin'], auth: A, permission: 'payments:read', query: chargebackListQuerySchema, handler: ({ query }) => listChargebacks({ state: query.state }, query.page, query.pageSize, ctx.now()) });
  route(app, ctx, { method: 'GET', url: '/admin/aftersales/chargebacks/metrics', summary: 'Chargeback rate, deadlines and reserve', tags: ['Admin'], auth: A, permission: 'payments:read', query: z.object({ days: z.coerce.number().int().min(7).max(365).default(90) }), handler: ({ query }) => chargebackMetrics(ctx, query.days) });
  route(app, ctx, { method: 'GET', url: '/admin/aftersales/chargebacks/reserve', summary: 'Chargeback reserve by currency (finance hook)', tags: ['Admin'], auth: A, permission: 'payments:read', handler: async () => ({ items: await chargebackReserveSummary() }) });
  route(app, ctx, { method: 'GET', url: '/admin/aftersales/chargebacks/:id', summary: 'Chargeback detail', tags: ['Admin'], auth: A, permission: 'payments:read', handler: async ({ req }) => { const c = await AftersalesChargeback.findById(idOf(req)).lean(); if (!c) throw notFound('Chargeback'); return c; } });
  route(app, ctx, { method: 'POST', url: '/admin/aftersales/chargebacks/:id/evidence', summary: 'Record evidence for a dispute', tags: ['Admin'], auth: A, permission: 'refunds:approve', body: chargebackEvidenceSchema, handler: async ({ req, body }) => { const c = await recordChargebackEvidence(ctx, idOf(req), body, req.actor); return { state: c.state, evidenceCount: c.evidence.length }; } });
  route(app, ctx, { method: 'POST', url: '/admin/aftersales/chargebacks/:id/submit', summary: 'Send recorded evidence to the provider (unverified without live credentials)', tags: ['Admin'], auth: A, permission: 'refunds:approve', handler: async ({ req }) => { const c = await submitChargebackEvidence(ctx, idOf(req), req.actor); return { state: c.state, submission: c.submission }; } });
  route(app, ctx, { method: 'POST', url: '/admin/aftersales/chargebacks/:id/accept', summary: 'Accept (do not contest) a dispute', tags: ['Admin'], auth: A, permission: 'refunds:approve', body: z.object({ note: z.string().max(300).default('') }), handler: async ({ req, body }) => ({ state: (await acceptChargeback(ctx, idOf(req), req.actor, body.note)).state }) });

  // payments hardening
  route(app, ctx, { method: 'POST', url: '/admin/aftersales/payments/:id/capture', summary: 'Capture an authorized payment (manual-capture providers)', tags: ['Admin'], auth: A, permission: 'refunds:approve', handler: ({ req }) => capturePayment(ctx, idOf(req), req.actor) });
  route(app, ctx, { method: 'POST', url: '/admin/aftersales/payments/reconcile', summary: 'Run provider reconciliation now', tags: ['Admin'], auth: A, permission: 'refunds:approve', body: z.object({ sinceHours: z.number().int().min(1).max(336).default(72) }), handler: ({ body }) => reconcileWithProvider(ctx, { sinceHours: body.sinceHours }) });

  // dev-only dispute simulation: signed webhook through the real verification and ingestion path
  if (!ctx.cfg.isProduction && ctx.cfg.APP_ENV !== 'staging') {
    const kv = new MongoKVStore();
    route(app, ctx, {
      method: 'POST', url: '/dev/aftersales/simulate-dispute', summary: '[dev] Simulate a card dispute webhook (PAYMENT_MODE=mock only)', tags: ['Dev'], auth: A, permission: 'refunds:approve', body: mockDisputeSchema,
      handler: async ({ body }) => {
        if (ctx.cfg.PAYMENT_MODE !== 'mock') throw new DomainError('Only available with PAYMENT_MODE=mock', 'FORBIDDEN', 403);
        const mock = new MockPaymentProvider(ctx.cfg.MOCK_PAYMENT_WEBHOOK_SECRET, kv);
        const sim = await mock.simulateDispute(body.intentId, { status: body.status, amount: body.amount, reason: body.reason, disputeId: body.disputeId, eventId: body.eventId });
        return { outcome: await handlePaymentWebhook(ctx, 'mock', sim.body, sim.headers) };
      },
    });
  }
}
