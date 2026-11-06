import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { can } from '@orvia/auth';
import type { Permission } from '@orvia/auth';
import { Supplier, SuppliernetDispute, SuppliernetDocument, SuppliernetIngestionJob, SuppliernetMatchCandidate, SuppliernetProfile, SuppliernetReturnAuth, SuppliernetSlaSnapshot, SuppliernetStatement, User } from '@orvia/database';
import {
  DomainError, acceptOrder, addDisputeEvidence, addDocument, attestStep, audit, compareQuotes, computeAndStoreSla, credentialStatus, dashboard, decideMatch, decideReturnAuthorization, disputeStatement, docView,
  getSlaDefinition, getVerification, ingestSupplierCatalog, inviteSupplier, linkSupplierUser, listDocuments, listOrders, markShipped, notFound, openDispute, portalDisputeRespond, portalDisputes, portalDocumentFile, portalDocuments,
  portalReturnDecide, portalReturns, portalStatements, portalSubmitStatement, portalSuppliers, portalUploadDocument, portalVerification, readDocumentFile, requestReturnAuthorization, reviewDocument, rotateCredentials,
  runProbe, setSlaDefinition, settleStatement, submitProfile, submitStatement, submitStatementCsv, submitStockObservations, transitionDispute, transitionSupplier, uploadOffers, verifyDeliveryFromShipment,
} from '@orvia/core';
import type { Ctx } from '@orvia/core';
import { PLANNED_PROVIDERS, PROVIDER_DEFINITIONS, feedConfigSchema } from '@orvia/suppliers';
import {
  DISPUTE_STATES, DOCUMENT_MAX_BYTES, MATCH_STATUSES, RETURN_AUTH_STATES, SUPPLIER_DOCUMENT_KINDS, SUPPLIER_ONBOARDING_STATES, VERIFICATION_STEP_KINDS,
  disputeCreateSchema, evidenceItemSchema, inviteSupplierSchema, manualEvidenceSchema, matchDecisionSchema, objectId, paginationSchema, probeSchema, quoteCompareQuerySchema,
  settlementSchema, slaDefinitionSchema, statementCreateSchema, statementCsvSchema, stockObservationsSchema, supplierProfileSchema,
} from '@orvia/types';
import { route } from '../http';

const idParam = (req: { params: unknown }, name = 'id'): string => {
  const v = (req.params as Record<string, string>)[name] ?? '';
  if (!objectId.safeParse(v).success) throw new DomainError('Invalid id', 'VALIDATION', 400);
  return v;
};

/** Reads one multipart file + small text fields. */
async function readUpload(req: FastifyRequest): Promise<{ file: { buffer: Buffer; mimetype: string }; fields: Record<string, string> }> {
  if (!req.isMultipart()) throw new DomainError('Send the document as multipart/form-data', 'VALIDATION', 415);
  const fields: Record<string, string> = {};
  let file: { buffer: Buffer; mimetype: string } | undefined;
  try {
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        if (file) { part.file.resume(); continue; }
        const buffer = await part.toBuffer();
        if (part.file.truncated) throw new DomainError('File is too large', 'VALIDATION', 413);
        file = { buffer, mimetype: part.mimetype };
      } else fields[part.fieldname] = String(part.value).slice(0, 200);
    }
  } catch (e) {
    if (e instanceof DomainError) throw e;
    throw new DomainError(/limit/i.test((e as Error).message) ? 'File is too large' : 'Invalid upload', 'VALIDATION', 413);
  }
  if (!file) throw new DomainError('No file received', 'VALIDATION', 400);
  return { file, fields };
}

const sendFile = (reply: FastifyReply, f: { body: Buffer; mime: string; title: string }) =>
  reply.header('content-type', f.mime).header('x-content-type-options', 'nosniff').header('cache-control', 'private, no-store').header('content-disposition', `attachment; filename="${f.title.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)}"`).send(f.body);

const docFields = z.object({ kind: z.enum(SUPPLIER_DOCUMENT_KINDS), title: z.string().trim().min(2).max(160), expiresAt: z.coerce.date().optional() });

export function suppliernetRoutes(app: FastifyInstance, ctx: Ctx): void {
  const A = 'staff' as const;
  const R = 'suppliers:read' as const;
  const W = 'suppliers:write' as const;
  const base = '/admin/supplier-network';
  const sid = (req: { params: unknown }) => idParam(req, 'id');
  const exists = async (id: string) => { if (!(await Supplier.exists({ _id: id }))) throw notFound('Supplier'); };

  /* ============================== admin ============================== */
  route(app, ctx, {
    method: 'GET', url: `${base}/overview`, summary: 'Supplier network pipeline, adapter matrix and SLA board', tags: ['SupplierNetwork'], auth: A, permission: R,
    handler: async () => {
      const [byState, sups, snaps] = await Promise.all([
        SuppliernetProfile.aggregate([{ $group: { _id: '$state', n: { $sum: 1 } } }]),
        Supplier.find({ 'network.state': { $exists: true } }).sort({ updatedAt: -1 }).limit(200).select('code name provider active servesCountries network healthState').lean(),
        SuppliernetSlaSnapshot.aggregate([{ $sort: { computedAt: -1 } }, { $group: { _id: '$supplierId', worst: { $first: '$worst' }, computedAt: { $first: '$computedAt' }, metrics: { $first: '$metrics' }, breaches: { $first: '$breaches' } } }, { $limit: 500 }]),
      ]);
      const snap = new Map(snaps.map((s) => [String(s._id), s]));
      return {
        pipeline: SUPPLIER_ONBOARDING_STATES.map((s) => ({ state: s, count: byState.find((b) => b._id === s)?.n ?? 0 })),
        suppliers: sups.map((s) => ({ id: String(s._id), code: s.code, name: s.name, provider: s.provider, active: s.active, healthState: s.healthState, state: s.network?.state, supplierType: s.network?.supplierType, productionReady: !!s.network?.productionReady, productionReadyUntil: s.network?.productionReadyUntil, sla: snap.get(String(s._id)) ?? null })),
        enforcement: { enforced: ctx.cfg.SUPPLIER_ENFORCE_VERIFICATION ?? ctx.cfg.isProduction, appEnv: ctx.cfg.APP_ENV },
        adapters: { configured: ctx.suppliers.adapters(), definitions: PROVIDER_DEFINITIONS.map((d) => ({ key: d.key, name: d.name, integrationStatus: d.integrationStatus, orderingMode: d.orderingMode, catalogMode: d.catalogMode, notes: d.notes })), planned: PLANNED_PROVIDERS },
      };
    },
  });

  route(app, ctx, {
    method: 'POST', url: `${base}/suppliers`, summary: 'Invite a supplier (creates the supplier, profile shell and a SUPPLIER portal user)', tags: ['SupplierNetwork'], auth: A, permission: W, body: inviteSupplierSchema,
    handler: async ({ req, body, reply }) => reply.status(201).send(await inviteSupplier(ctx, body, req.actor)),
  });

  route(app, ctx, {
    method: 'GET', url: `${base}/suppliers/:id`, summary: 'Supplier network detail', tags: ['SupplierNetwork'], auth: A, permission: R,
    handler: async ({ req }) => {
      const id = sid(req);
      const s = await Supplier.findById(id).select('code name provider active servesCountries network healthState apiStatus apiStatusMessage sandbox fulfillmentMode userIds config').lean();
      if (!s) throw notFound('Supplier');
      const [profile, docs, verification, creds, sla, users] = await Promise.all([
        SuppliernetProfile.findOne({ supplierId: id }).lean(), listDocuments(id), getVerification(ctx, id), credentialStatus(ctx, id), getSlaDefinition(id),
        User.find({ _id: { $in: s.userIds ?? [] } }).select('email name disabled lastLoginAt').lean(),
      ]);
      return { supplier: { ...s, userIds: undefined }, profile, documents: docs, verification, credentials: creds, slaDefinition: sla, users: users.map((u) => ({ id: String(u._id), email: u.email, name: u.name, disabled: u.disabled, lastLoginAt: u.lastLoginAt })) };
    },
  });

  route(app, ctx, {
    method: 'PUT', url: `${base}/suppliers/:id/profile`, summary: 'Save the supplier profile (submits it when the supplier is only invited)', tags: ['SupplierNetwork'], auth: A, permission: W, body: supplierProfileSchema,
    handler: async ({ req, body }) => submitProfile(ctx, sid(req), body, req.actor),
  });
  route(app, ctx, {
    method: 'POST', url: `${base}/suppliers/:id/transition`, summary: 'Move a supplier through the onboarding state machine (gated)', tags: ['SupplierNetwork'], auth: A, permission: W,
    body: z.object({ to: z.enum(SUPPLIER_ONBOARDING_STATES), reason: z.string().trim().max(500).optional() }),
    handler: async ({ req, body }) => transitionSupplier(ctx, sid(req), body.to, body.reason, req.actor),
  });
  route(app, ctx, {
    method: 'POST', url: `${base}/suppliers/:id/users`, summary: 'Link an existing SUPPLIER user to this supplier', tags: ['SupplierNetwork'], auth: A, permission: W, body: z.object({ email: z.string().email() }),
    handler: async ({ req, body }) => { await linkSupplierUser(ctx, sid(req), body.email, req.actor); return { ok: true }; },
  });
  route(app, ctx, {
    method: 'PUT', url: `${base}/suppliers/:id/feed-config`, summary: 'Validate and save the CSV/JSON feed mapping (provider must be "feed")', tags: ['SupplierNetwork'], auth: A, permission: W, body: feedConfigSchema,
    handler: async ({ req, body }) => {
      const s = await Supplier.findById(sid(req));
      if (!s) throw notFound('Supplier');
      if (s.provider !== 'feed') throw new DomainError('Supplier provider is not "feed"', 'VALIDATION', 409);
      s.config = body; await s.save();
      await audit(ctx, req.actor, { action: 'suppliernet.feed_config_saved', resource: 'supplier', resourceId: String(s._id), newValue: { url: body.url, format: body.format } });
      return { ok: true };
    },
  });

  // documents
  route(app, ctx, {
    method: 'POST', url: `${base}/suppliers/:id/documents`, summary: 'Upload a supplier document (multipart: file + kind, title, expiresAt)', tags: ['SupplierNetwork'], auth: A, permission: W, rateLimit: { max: 30, timeWindow: '1 minute' },
    handler: async ({ req, reply }) => {
      const id = sid(req); await exists(id);
      const { file, fields } = await readUpload(req);
      const f = docFields.safeParse(fields);
      if (!f.success) throw new DomainError('Invalid document fields', 'VALIDATION', 400, f.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
      return reply.status(201).send(await addDocument(ctx, id, { ...f.data, buffer: file.buffer, mime: file.mimetype }, req.actor));
    },
  });
  route(app, ctx, {
    method: 'GET', url: `${base}/suppliers/:id/documents/:docId/file`, summary: 'Download a supplier document (permission-checked, never public)', tags: ['SupplierNetwork'], auth: A, permission: R,
    handler: async ({ req, reply }) => sendFile(reply, await readDocumentFile(ctx, sid(req), idParam(req, 'docId'))),
  });
  route(app, ctx, {
    method: 'POST', url: `${base}/documents/:id/review`, summary: 'Verify or reject a supplier document', tags: ['SupplierNetwork'], auth: A, permission: W,
    body: z.object({ decision: z.enum(['verified', 'rejected']), note: z.string().trim().max(500).optional() }),
    handler: async ({ req, body }) => reviewDocument(ctx, sid(req), body.decision, body.note, req.actor),
  });
  route(app, ctx, {
    method: 'GET', url: `${base}/documents/expiring`, summary: 'Verified documents expiring within 60 days', tags: ['SupplierNetwork'], auth: A, permission: R,
    handler: async () => ({ items: (await SuppliernetDocument.find({ status: 'verified', expiresAt: { $lte: new Date(Date.now() + 60 * 86_400_000) } }).sort({ expiresAt: 1 }).limit(100).lean()).map((d) => ({ ...docView(d), supplierId: String(d.supplierId) })) }),
  });

  // credentials (write-only: values are never returned)
  route(app, ctx, {
    method: 'POST', url: `${base}/suppliers/:id/credentials/rotate`, summary: 'Set/rotate encrypted supplier credentials (values are never returned)', tags: ['SupplierNetwork'], auth: A, permission: W,
    body: z.object({ credentials: z.object({ apiKey: z.string().min(4).max(500).optional(), apiSecret: z.string().min(4).max(500).optional() }) }),
    handler: async ({ req, body }) => rotateCredentials(ctx, sid(req), body.credentials as Record<string, string>, req.actor),
  });

  // verification
  route(app, ctx, {
    method: 'GET', url: `${base}/suppliers/:id/verification`, summary: 'Verification checklist with evidence and production-readiness', tags: ['SupplierNetwork'], auth: A, permission: R,
    handler: async ({ req }) => getVerification(ctx, sid(req)),
  });
  route(app, ctx, {
    method: 'POST', url: `${base}/suppliers/:id/verification/:kind/probe`, summary: 'Run an automated verification probe (order-creating probes need typed confirmation)', tags: ['SupplierNetwork'], auth: A, permission: W, body: probeSchema, rateLimit: { max: 20, timeWindow: '1 minute' },
    handler: async ({ req, body }) => {
      const kind = z.enum(VERIFICATION_STEP_KINDS).parse((req.params as { kind: string }).kind);
      return runProbe(ctx, sid(req), kind, body, req.actor);
    },
  });
  route(app, ctx, {
    method: 'POST', url: `${base}/suppliers/:id/verification/:kind/attest`, summary: 'Record manual attestation with checkable evidence', tags: ['SupplierNetwork'], auth: A, permission: W, body: manualEvidenceSchema,
    handler: async ({ req, body }) => attestStep(ctx, sid(req), z.enum(VERIFICATION_STEP_KINDS).parse((req.params as { kind: string }).kind), body, req.actor),
  });
  route(app, ctx, {
    method: 'POST', url: `${base}/suppliers/:id/verification/stock-observations`, summary: 'Submit independently observed stock counts for the open stock sample', tags: ['SupplierNetwork'], auth: A, permission: W, body: stockObservationsSchema,
    handler: async ({ req, body }) => submitStockObservations(ctx, sid(req), body, req.actor),
  });
  route(app, ctx, {
    method: 'POST', url: `${base}/suppliers/:id/verification/delivery-from-shipment`, summary: 'Use a DELIVERED shipment as delivery evidence', tags: ['SupplierNetwork'], auth: A, permission: W, body: z.object({ shipmentId: objectId }),
    handler: async ({ req, body }) => verifyDeliveryFromShipment(ctx, sid(req), body.shipmentId, req.actor),
  });

  // ingestion + matching
  route(app, ctx, {
    method: 'POST', url: `${base}/suppliers/:id/ingest`, summary: 'Ingest the supplier catalogue through its adapter and propose product matches', tags: ['SupplierNetwork'], auth: A, permission: W, rateLimit: { max: 6, timeWindow: '1 minute' },
    body: z.object({ maxItems: z.number().int().min(1).max(2000).optional() }),
    handler: async ({ req, body }) => ingestSupplierCatalog(ctx, sid(req), { trigger: 'manual', actor: req.actor, maxItems: body.maxItems }),
  });
  route(app, ctx, {
    method: 'GET', url: `${base}/ingestion-jobs`, summary: 'Recent ingestion jobs', tags: ['SupplierNetwork'], auth: A, permission: R, query: z.object({ supplierId: objectId.optional() }),
    handler: async ({ query }) => ({ items: await SuppliernetIngestionJob.find(query.supplierId ? { supplierId: query.supplierId } : {}).sort({ startedAt: -1 }).limit(50).lean() }),
  });
  route(app, ctx, {
    method: 'GET', url: `${base}/matches`, summary: 'Match candidates awaiting human review', tags: ['SupplierNetwork'], auth: A, permission: R, query: paginationSchema.extend({ status: z.enum(MATCH_STATUSES).default('pending') }),
    handler: async ({ query }) => {
      const [rows, total] = await Promise.all([SuppliernetMatchCandidate.find({ status: query.status }).sort({ score: -1 }).skip((query.page - 1) * query.pageSize).limit(query.pageSize).lean(), SuppliernetMatchCandidate.countDocuments({ status: query.status })]);
      const { Product, SupplierProduct } = await import('@orvia/database');
      const [prods, sps, sups] = await Promise.all([Product.find({ _id: { $in: rows.map((r) => r.productId) } }).select('title slug').lean(), SupplierProduct.find({ _id: { $in: rows.map((r) => r.supplierProductId) } }).select('title externalId images').lean(), Supplier.find({ _id: { $in: rows.map((r) => r.supplierId) } }).select('code name').lean()]);
      return { total, page: query.page, pageSize: query.pageSize, items: rows.map((r) => ({ ...r, product: prods.find((p) => String(p._id) === String(r.productId)), supplierProduct: sps.find((p) => String(p._id) === String(r.supplierProductId)), supplier: sups.find((p) => String(p._id) === String(r.supplierId)) })) };
    },
  });
  route(app, ctx, {
    method: 'POST', url: `${base}/matches/:id/decide`, summary: 'Approve (links the supplier product to the ORVIA product) or reject a match candidate', tags: ['SupplierNetwork'], auth: A, permission: W,
    body: matchDecisionSchema.extend({ decision: z.enum(['approve', 'reject']) }),
    handler: async ({ req, body }) => decideMatch(ctx, sid(req), body.decision, body.note, req.actor),
  });
  route(app, ctx, {
    method: 'GET', url: `${base}/quotes`, summary: 'Compare all linked suppliers for a product and destination (freshness labelled; live=true queries suppliers now)', tags: ['SupplierNetwork'], auth: A, permission: R, query: quoteCompareQuerySchema, rateLimit: { max: 30, timeWindow: '1 minute' },
    handler: async ({ query }) => compareQuotes(ctx, query.productId, query.country, { live: query.live }),
  });

  // SLA
  route(app, ctx, {
    method: 'GET', url: `${base}/sla`, summary: 'SLA board: latest snapshot per supplier', tags: ['SupplierNetwork'], auth: A, permission: R,
    handler: async () => {
      const snaps = await SuppliernetSlaSnapshot.aggregate([{ $sort: { computedAt: -1 } }, { $group: { _id: '$supplierId', doc: { $first: '$$ROOT' } } }, { $limit: 300 }]);
      const sups = await Supplier.find({ _id: { $in: snaps.map((s) => s._id) } }).select('code name network').lean();
      return { items: snaps.map((s) => ({ supplierId: String(s._id), supplier: sups.find((x) => String(x._id) === String(s._id)), snapshot: s.doc })) };
    },
  });
  route(app, ctx, { method: 'PUT', url: `${base}/suppliers/:id/sla`, summary: 'Define supplier SLA targets', tags: ['SupplierNetwork'], auth: A, permission: W, body: slaDefinitionSchema, handler: async ({ req, body }) => setSlaDefinition(ctx, sid(req), body, req.actor) });
  route(app, ctx, { method: 'POST', url: `${base}/suppliers/:id/sla/compute`, summary: 'Compute SLA now (may demote on a critical breach)', tags: ['SupplierNetwork'], auth: A, permission: W, handler: async ({ req }) => computeAndStoreSla(ctx, sid(req), req.actor) });

  // disputes
  route(app, ctx, {
    method: 'GET', url: `${base}/disputes`, summary: 'Supplier disputes', tags: ['SupplierNetwork'], auth: A, permission: R, query: paginationSchema.extend({ state: z.enum(DISPUTE_STATES).optional(), supplierId: objectId.optional() }),
    handler: async ({ query }) => {
      const q: Record<string, unknown> = {};
      if (query.state) q['state'] = query.state;
      if (query.supplierId) q['supplierId'] = query.supplierId;
      const [items, total] = await Promise.all([SuppliernetDispute.find(q).sort({ createdAt: -1 }).skip((query.page - 1) * query.pageSize).limit(query.pageSize).lean(), SuppliernetDispute.countDocuments(q)]);
      return { items, total, page: query.page, pageSize: query.pageSize };
    },
  });
  route(app, ctx, { method: 'POST', url: `${base}/disputes`, summary: 'Open a supplier dispute', tags: ['SupplierNetwork'], auth: A, permission: W, body: disputeCreateSchema, handler: async ({ req, body, reply }) => reply.status(201).send(await openDispute(ctx, body, req.actor)) });
  route(app, ctx, { method: 'POST', url: `${base}/disputes/:id/evidence`, summary: 'Add ORVIA evidence to a dispute', tags: ['SupplierNetwork'], auth: A, permission: W, body: evidenceItemSchema, handler: async ({ req, body }) => addDisputeEvidence(ctx, sid(req), 'orvia', body, req.actor) });
  route(app, ctx, {
    method: 'POST', url: `${base}/disputes/:id/transition`, summary: 'Move a dispute through its state machine', tags: ['SupplierNetwork'], auth: A, permission: W,
    body: z.object({ to: z.enum(DISPUTE_STATES), note: z.string().trim().max(1000).optional(), creditedMinor: z.number().int().min(0).max(1_000_000_000).optional() }),
    handler: async ({ req, body }) => transitionDispute(ctx, sid(req), body.to, body, req.actor),
  });

  // return authorizations
  route(app, ctx, {
    method: 'GET', url: `${base}/return-authorizations`, summary: 'Return authorizations requested from suppliers', tags: ['SupplierNetwork'], auth: A, permission: R, query: paginationSchema.extend({ state: z.enum(RETURN_AUTH_STATES).optional() }),
    handler: async ({ query }) => { const q = query.state ? { state: query.state } : {}; return { items: await SuppliernetReturnAuth.find(q).sort({ createdAt: -1 }).skip((query.page - 1) * query.pageSize).limit(query.pageSize).lean(), total: await SuppliernetReturnAuth.countDocuments(q) }; },
  });
  route(app, ctx, {
    method: 'POST', url: `${base}/return-authorizations`, summary: 'Request a return authorization from the supplier of a shipment', tags: ['SupplierNetwork'], auth: A, permission: W,
    body: z.object({ shipmentId: objectId.optional(), orderId: objectId.optional(), reason: z.string().trim().min(5).max(1000), returnRef: z.string().max(80).optional() }).refine((b) => b.shipmentId || b.orderId, 'shipmentId or orderId required'),
    handler: async ({ req, body, reply }) => reply.status(201).send(await requestReturnAuthorization(ctx, body, req.actor)),
  });
  route(app, ctx, {
    method: 'POST', url: `${base}/return-authorizations/:id/decide`, summary: 'Record the supplier’s answer on a return authorization (on their behalf)', tags: ['SupplierNetwork'], auth: A, permission: W,
    body: z.object({ to: z.enum(RETURN_AUTH_STATES), rmaNumber: z.string().max(60).optional(), note: z.string().max(500).optional(), refundMinor: z.number().int().min(0).optional() }),
    handler: async ({ req, body }) => decideReturnAuthorization(ctx, sid(req), body.to, body, req.actor),
  });

  // payables
  route(app, ctx, {
    method: 'GET', url: `${base}/statements`, summary: 'Supplier statements and reconciliation status', tags: ['SupplierNetwork'], auth: A, permission: R, query: paginationSchema.extend({ status: z.enum(['submitted', 'matched', 'discrepancies', 'disputed', 'settled']).optional(), supplierId: objectId.optional() }),
    handler: async ({ query }) => {
      const q: Record<string, unknown> = {};
      if (query.status) q['status'] = query.status;
      if (query.supplierId) q['supplierId'] = query.supplierId;
      const [items, total] = await Promise.all([SuppliernetStatement.find(q).sort({ createdAt: -1 }).skip((query.page - 1) * query.pageSize).limit(query.pageSize).select('-lines').lean(), SuppliernetStatement.countDocuments(q)]);
      return { items, total, page: query.page, pageSize: query.pageSize };
    },
  });
  route(app, ctx, { method: 'GET', url: `${base}/statements/:id`, summary: 'Statement with line-level reconciliation', tags: ['SupplierNetwork'], auth: A, permission: R, handler: async ({ req }) => { const s = await SuppliernetStatement.findById(sid(req)).lean(); if (!s) throw notFound('Statement'); return s; } });
  route(app, ctx, { method: 'POST', url: `${base}/suppliers/:id/statements`, summary: 'Enter a supplier statement manually', tags: ['SupplierNetwork'], auth: A, permission: W, body: statementCreateSchema, handler: async ({ req, body, reply }) => reply.status(201).send(await submitStatement(ctx, sid(req), { ...body, source: 'manual' }, req.actor)) });
  route(app, ctx, { method: 'POST', url: `${base}/suppliers/:id/statements/csv`, summary: 'Upload a supplier statement as CSV text', tags: ['SupplierNetwork'], auth: A, permission: W, body: statementCsvSchema, handler: async ({ req, body, reply }) => reply.status(201).send(await submitStatementCsv(ctx, sid(req), body, req.actor)) });
  route(app, ctx, { method: 'POST', url: `${base}/statements/:id/dispute`, summary: 'Dispute the over-billed lines of a statement', tags: ['SupplierNetwork'], auth: A, permission: W, body: z.object({ summary: z.string().trim().min(10).max(2000) }), handler: async ({ req, body }) => disputeStatement(ctx, sid(req), body.summary, req.actor) });
  route(app, ctx, { method: 'POST', url: `${base}/statements/:id/settle`, summary: 'Record settlement (record-only: no payment is initiated)', tags: ['SupplierNetwork'], auth: A, permission: W, body: settlementSchema, handler: async ({ req, body }) => settleStatement(ctx, sid(req), body, req.actor) });

  /* ======================= supplier portal (tenant-scoped) ======================= */
  const P = (perm: 'supplierportal:read' | 'supplierportal:write') => ({ auth: 'user' as const, perm });
  // Every portal route: SUPPLIER role + supplierportal:* permission, then the supplier is resolved from the caller's own userIds.
  const guard = (user: { role: string }, perm: Permission) => {
    if (user.role !== 'SUPPLIER' || !can('SUPPLIER', perm)) throw new DomainError('Forbidden', 'FORBIDDEN', 403);
  };
  const supplierQ = z.object({ supplierId: objectId.optional() });
  const pr = P('supplierportal:read'), pw = P('supplierportal:write');
  const limit = { max: 120, timeWindow: '1 minute' };

  route(app, ctx, { method: 'GET', url: '/supplier/me', summary: 'Supplier portal: my supplier(s)', tags: ['SupplierPortal'], auth: pr.auth, rateLimit: limit, handler: async ({ user }) => { guard(user, pr.perm); return { suppliers: (await portalSuppliers(user.id)).map((s) => ({ id: String(s._id), code: s.code, name: s.name, provider: s.provider, state: s.network?.state })), user: { name: user.name, email: user.email } }; } });
  route(app, ctx, { method: 'GET', url: '/supplier/dashboard', summary: 'Supplier portal dashboard', tags: ['SupplierPortal'], auth: pr.auth, query: supplierQ, rateLimit: limit, handler: async ({ user, query }) => { guard(user, pr.perm); return dashboard(ctx, user.id, query.supplierId); } });
  route(app, ctx, { method: 'GET', url: '/supplier/orders', summary: 'Supplier portal: my orders', tags: ['SupplierPortal'], auth: pr.auth, query: paginationSchema.extend({ supplierId: objectId.optional(), status: z.enum(['CREATED', 'SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED', 'CANCELLED', 'RETURNED']).optional() }), rateLimit: limit, handler: async ({ user, query }) => { guard(user, pr.perm); return listOrders(user.id, query); } });
  route(app, ctx, { method: 'POST', url: '/supplier/orders/accept', summary: 'Supplier portal: accept a queued order and record the supplier order reference', tags: ['SupplierPortal'], auth: pw.auth, body: z.object({ supplierId: objectId.optional(), orderId: objectId, lineKey: z.string().min(1).max(80), supplierOrderId: z.string().trim().min(2).max(120) }), rateLimit: { max: 60, timeWindow: '1 minute' }, handler: async ({ user, body }) => { guard(user, pw.perm); return acceptOrder(ctx, user.id, body); } });
  route(app, ctx, { method: 'POST', url: '/supplier/shipments/:id/ship', summary: 'Supplier portal: mark shipped with tracking', tags: ['SupplierPortal'], auth: pw.auth, body: z.object({ supplierId: objectId.optional(), trackingNumber: z.string().trim().min(5).max(40), carrier: z.string().trim().min(2).max(60) }), rateLimit: { max: 60, timeWindow: '1 minute' }, handler: async ({ req, user, body }) => { guard(user, pw.perm); return markShipped(ctx, user.id, { ...body, shipmentId: idParam(req) }); } });
  route(app, ctx, { method: 'POST', url: '/supplier/offers/upload', summary: 'Supplier portal: price/stock CSV (manual suppliers)', tags: ['SupplierPortal'], auth: pw.auth, body: z.object({ supplierId: objectId.optional(), csv: z.string().min(10).max(900_000) }), rateLimit: { max: 10, timeWindow: '1 minute' }, handler: async ({ user, body }) => { guard(user, pw.perm); return uploadOffers(ctx, user.id, body.supplierId, body.csv); } });
  route(app, ctx, { method: 'GET', url: '/supplier/documents', summary: 'Supplier portal: my documents', tags: ['SupplierPortal'], auth: pr.auth, query: supplierQ, handler: async ({ user, query }) => { guard(user, pr.perm); return { items: await portalDocuments(user.id, query.supplierId), maxBytes: DOCUMENT_MAX_BYTES }; } });
  route(app, ctx, {
    method: 'POST', url: '/supplier/documents', summary: 'Supplier portal: upload a document (multipart)', tags: ['SupplierPortal'], auth: pw.auth, rateLimit: { max: 20, timeWindow: '1 minute' },
    handler: async ({ req, reply, user }) => {
      guard(user, pw.perm);
      const { file, fields } = await readUpload(req);
      const f = docFields.safeParse(fields);
      if (!f.success) throw new DomainError('Invalid document fields', 'VALIDATION', 400);
      return reply.status(201).send(await portalUploadDocument(ctx, user.id, fields['supplierId'] && objectId.safeParse(fields['supplierId']).success ? fields['supplierId'] : undefined, { ...f.data, buffer: file.buffer, mime: file.mimetype }));
    },
  });
  route(app, ctx, { method: 'GET', url: '/supplier/documents/:id/file', summary: 'Supplier portal: download my document', tags: ['SupplierPortal'], auth: pr.auth, query: supplierQ, handler: async ({ req, reply, user, query }) => { guard(user, pr.perm); return sendFile(reply, await portalDocumentFile(ctx, user.id, query.supplierId, idParam(req))); } });
  route(app, ctx, { method: 'GET', url: '/supplier/verification', summary: 'Supplier portal: verification status', tags: ['SupplierPortal'], auth: pr.auth, query: supplierQ, handler: async ({ user, query }) => { guard(user, pr.perm); return portalVerification(ctx, user.id, query.supplierId); } });
  route(app, ctx, { method: 'GET', url: '/supplier/statements', summary: 'Supplier portal: my statements', tags: ['SupplierPortal'], auth: pr.auth, query: supplierQ, handler: async ({ user, query }) => { guard(user, pr.perm); return { items: await portalStatements(user.id, query.supplierId) }; } });
  route(app, ctx, { method: 'POST', url: '/supplier/statements', summary: 'Supplier portal: submit a statement (CSV)', tags: ['SupplierPortal'], auth: pw.auth, body: statementCsvSchema.extend({ supplierId: objectId.optional() }), rateLimit: { max: 10, timeWindow: '1 minute' }, handler: async ({ user, body, reply }) => { guard(user, pw.perm); return reply.status(201).send(await portalSubmitStatement(ctx, user.id, body.supplierId, body)); } });
  route(app, ctx, { method: 'GET', url: '/supplier/disputes', summary: 'Supplier portal: my disputes', tags: ['SupplierPortal'], auth: pr.auth, query: supplierQ, handler: async ({ user, query }) => { guard(user, pr.perm); return { items: await portalDisputes(user.id, query.supplierId) }; } });
  route(app, ctx, { method: 'POST', url: '/supplier/disputes/:id/respond', summary: 'Supplier portal: respond to a dispute', tags: ['SupplierPortal'], auth: pw.auth, body: evidenceItemSchema.extend({ supplierId: objectId.optional() }), handler: async ({ req, user, body }) => { guard(user, pw.perm); await portalDisputeRespond(ctx, user.id, body.supplierId, idParam(req), body); return { ok: true }; } });
  route(app, ctx, { method: 'GET', url: '/supplier/returns', summary: 'Supplier portal: return authorization requests', tags: ['SupplierPortal'], auth: pr.auth, query: supplierQ, handler: async ({ user, query }) => { guard(user, pr.perm); return { items: await portalReturns(user.id, query.supplierId) }; } });
  route(app, ctx, { method: 'POST', url: '/supplier/returns/:id/decide', summary: 'Supplier portal: authorise/reject a return', tags: ['SupplierPortal'], auth: pw.auth, body: z.object({ supplierId: objectId.optional(), to: z.enum(['authorized', 'rejected', 'received_by_supplier', 'refunded_by_supplier']), rmaNumber: z.string().max(60).optional(), note: z.string().max(500).optional(), refundMinor: z.number().int().min(0).optional() }), handler: async ({ req, user, body }) => { guard(user, pw.perm); await portalReturnDecide(ctx, user.id, body.supplierId, idParam(req), body.to, body); return { ok: true }; } });
}
