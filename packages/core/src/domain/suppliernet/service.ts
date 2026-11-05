/** Supplier onboarding, documents, credentials and verification (IO layer; rules live in gating.ts). */
import { createHash } from 'node:crypto';
import { decryptSecret, hashPassword, randomToken } from '@orvia/auth';
import { Shipment, Supplier, SuppliernetDocument, SuppliernetProfile, SuppliernetStockCheck, SuppliernetVerificationStep, User } from '@orvia/database';
import { DOCUMENT_ALLOWED_MIME, DOCUMENT_MAX_BYTES, REQUIRED_DOCUMENT_KINDS, VERIFICATION_STEP_KINDS, supplierProfileSchema } from '@orvia/types';
import type { ManualEvidenceInput, ProbeInput, SupplierDocumentKind, SupplierOnboardingState, SupplierType, VerificationStepKind, SupplierProfileInput } from '@orvia/types';
import { audit } from '../../infra/audit';
import { DomainError, notFound } from '../../infra/context';
import type { Actor, Ctx } from '../../infra/context';
import { raiseException } from '../exceptions';
import { requestPasswordReset } from '../identity';
import { providerFor, sealCredentials } from '../supplierAccess';
import { checkTransition, effectiveStepStatus, evaluatePriceAccuracy, evaluateReadiness, evaluateStockAccuracy, preProbationReadiness, requiredStepKinds, validUntilFor, validateManualEvidence } from './gating';
import { redactValue } from './redact';

const FAST = process.env.NODE_ENV === 'test';
export const MIN_PROBATION_DAYS = 7;
const objId = (v: unknown) => String(v);

/* ------------------------------ onboarding ------------------------------ */
export async function inviteSupplier(ctx: Ctx, input: { code: string; name: string; email: string; contactName?: string; supplierType: SupplierType; provider: 'manual' | 'rest' | 'feed' | 'cj'; servesCountries: string[] }, actor: Actor) {
  if (await Supplier.exists({ code: input.code })) throw new DomainError('A supplier with this code already exists', 'CONFLICT', 409);
  let user = await User.findOne({ email: input.email.toLowerCase() });
  if (user && user.role !== 'SUPPLIER') throw new DomainError('That email belongs to a non-supplier account; use a different contact email', 'CONFLICT', 409);
  if (!user) user = await User.create({ email: input.email, name: input.contactName ?? input.name, role: 'SUPPLIER', passwordHash: await hashPassword(randomToken(24), { fast: FAST }), emailVerified: true });
  const sup = await Supplier.create({
    code: input.code, name: input.name, provider: input.provider, servesCountries: input.servesCountries.filter((c) => ['US', 'CA', 'IN'].includes(c)), active: false, isDemo: false,
    fulfillmentMode: 'MANUAL', userIds: [user._id], network: { state: 'invited', supplierType: input.supplierType, productionReady: false },
  });
  await SuppliernetProfile.create({ supplierId: sup._id, supplierType: input.supplierType, state: 'invited', invitedEmail: input.email, history: [{ from: null, to: 'invited', at: ctx.now(), by: actor.id, reason: 'invited' }] });
  await requestPasswordReset(ctx, input.email); // the supplier sets their own password through the normal reset email
  await audit(ctx, actor, { action: 'suppliernet.supplier_invited', resource: 'supplier', resourceId: objId(sup._id), newValue: { code: input.code, supplierType: input.supplierType, provider: input.provider } });
  return { supplierId: objId(sup._id), userId: objId(user._id) };
}

export async function linkSupplierUser(ctx: Ctx, supplierId: string, email: string, actor: Actor) {
  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user || user.role !== 'SUPPLIER') throw new DomainError('No supplier-role user with that email', 'NOT_FOUND', 404);
  const r = await Supplier.updateOne({ _id: supplierId }, { $addToSet: { userIds: user._id } });
  if (!r.matchedCount) throw notFound('Supplier');
  await audit(ctx, actor, { action: 'suppliernet.user_linked', resource: 'supplier', resourceId: supplierId, newValue: { userId: objId(user._id) } });
}

export async function submitProfile(ctx: Ctx, supplierId: string, input: SupplierProfileInput, actor: Actor) {
  const prof = await SuppliernetProfile.findOne({ supplierId });
  if (!prof) throw notFound('Supplier profile');
  prof.profile = input;
  prof.supplierType = input.supplierType;
  prof.declaredCapabilities = input.declaredCapabilities;
  prof.profileSubmittedAt = ctx.now();
  await prof.save();
  await Supplier.updateOne({ _id: supplierId }, { $set: { 'network.supplierType': input.supplierType, returnPolicyDays: input.returnPolicy.returnsAccepted ? input.returnPolicy.windowDays : 0 } });
  await ensureSteps(supplierId);
  await audit(ctx, actor, { action: 'suppliernet.profile_submitted', resource: 'supplier', resourceId: supplierId, newValue: { legalName: input.legalName, supplierType: input.supplierType } });
  if (prof.state === 'invited') await transitionSupplier(ctx, supplierId, 'profile_submitted', 'profile submitted', actor);
  return { ok: true };
}

export const profileComplete = (p: unknown): boolean => supplierProfileSchema.safeParse(p).success;

async function gateFacts(ctx: Ctx, supplierId: string) {
  const [prof, sup, steps, docs] = await Promise.all([SuppliernetProfile.findOne({ supplierId }).lean(), Supplier.findById(supplierId).lean(), SuppliernetVerificationStep.find({ supplierId }).lean(), SuppliernetDocument.find({ supplierId }).select('kind status expiresAt').lean()]);
  if (!prof || !sup) throw notFound('Supplier');
  const now = ctx.now();
  const requiredDocsVerified = REQUIRED_DOCUMENT_KINDS.every((k) => docs.some((d) => d.kind === k && d.status === 'verified' && (!d.expiresAt || d.expiresAt > now)));
  const stepLikes = steps.map((s) => ({ kind: s.kind, required: s.required, status: s.status, passedAt: s.passedAt, validUntil: s.validUntil, evidence: s.evidence }));
  let integrationReady = false;
  try {
    const h = await (await providerFor(ctx, sup)).healthCheck();
    integrationReady = h.ok;
  } catch { integrationReady = false; }
  return { prof, sup, now, requiredDocsVerified, integrationReady, stepLikes, profileOk: profileComplete(prof.profile) };
}

export async function transitionSupplier(ctx: Ctx, supplierId: string, to: SupplierOnboardingState, reason: string | undefined, actor: Actor, opts: { system?: boolean } = {}) {
  const f = await gateFacts(ctx, supplierId);
  const readiness = evaluateReadiness(f.stepLikes, f.now);
  const check = checkTransition({
    from: f.prof.state as SupplierOnboardingState, to, profileComplete: f.profileOk, requiredDocsVerified: f.requiredDocsVerified, integrationReady: f.integrationReady,
    preProbationPassed: preProbationReadiness(f.stepLikes, f.now).ready, productionReady: readiness.ready, probationStartedAt: f.prof.probationStartedAt, minProbationDays: MIN_PROBATION_DAYS, reason, now: f.now,
  });
  // automatic demotion/suspension by the system is allowed to skip forward gates only for backward moves (checkTransition already allows those)
  if (!check.ok) throw new DomainError(`Cannot move supplier to ${to}`, 'GATE_BLOCKED', 409, { blockers: check.blockers });
  const from = f.prof.state;
  const set: Record<string, unknown> = { state: to };
  if (to === 'probation' && from !== 'approved') set['probationStartedAt'] = f.now;
  if (to === 'approved') set['approvedAt'] = f.now;
  if (to === 'suspended') set['suspendedReason'] = reason;
  await SuppliernetProfile.updateOne({ supplierId }, { $set: set, $push: { history: { from, to, at: f.now, by: opts.system ? 'system' : actor.id, reason } } });
  await Supplier.updateOne({ _id: supplierId }, { $set: { 'network.state': to, active: to === 'probation' || to === 'approved', ...(to === 'probation' && from === 'approved' ? { 'network.demotedAt': f.now, 'network.demotionReason': reason } : {}) } });
  await recomputeReadiness(ctx, supplierId);
  await audit(ctx, actor, { action: 'suppliernet.state_changed', resource: 'supplier', resourceId: supplierId, previousValue: from, newValue: to, reason });
  return { from, to };
}

/* ------------------------------- documents ------------------------------- */
const EXT: Record<string, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export async function addDocument(ctx: Ctx, supplierId: string, i: { kind: SupplierDocumentKind; title: string; buffer: Buffer; mime: string; expiresAt?: Date }, actor: Actor) {
  if (!(DOCUMENT_ALLOWED_MIME as readonly string[]).includes(i.mime)) throw new DomainError('Only PDF, JPEG, PNG or WebP documents are accepted', 'VALIDATION', 415);
  if (i.buffer.length === 0 || i.buffer.length > DOCUMENT_MAX_BYTES) throw new DomainError(`Document must be between 1 byte and ${DOCUMENT_MAX_BYTES / 1_000_000} MB`, 'VALIDATION', 413);
  const magic = i.buffer.subarray(0, 4).toString('latin1');
  const okMagic = (i.mime === 'application/pdf' && magic.startsWith('%PDF')) || (i.mime === 'image/png' && i.buffer[0] === 0x89 && magic.slice(1, 4) === 'PNG') || (i.mime === 'image/jpeg' && i.buffer[0] === 0xff && i.buffer[1] === 0xd8) || (i.mime === 'image/webp' && magic === 'RIFF');
  if (!okMagic) throw new DomainError('File content does not match its declared type', 'VALIDATION', 415);
  if (i.expiresAt && i.expiresAt.getTime() < ctx.now().getTime()) throw new DomainError('This document has already expired', 'VALIDATION', 422);
  const key = `suppliernet/docs/${supplierId}/${randomToken(24)}.${EXT[i.mime]}`;
  await ctx.storage.put(key, i.buffer, i.mime);
  const doc = await SuppliernetDocument.create({ supplierId, kind: i.kind, title: i.title, storageKey: key, mime: i.mime, bytes: i.buffer.length, sha256: createHash('sha256').update(i.buffer).digest('hex'), status: 'pending', expiresAt: i.expiresAt, uploadedBy: actor.id, uploadedByRole: actor.role });
  await audit(ctx, actor, { action: 'suppliernet.document_uploaded', resource: 'supplier', resourceId: supplierId, newValue: { documentId: objId(doc._id), kind: i.kind, bytes: i.buffer.length } });
  return { id: objId(doc._id) };
}

export const docView = (d: { _id: unknown; kind: string; title: string; mime?: string | null; bytes?: number | null; status: string; expiresAt?: Date | null; reviewNote?: string | null; reviewedAt?: Date | null; createdAt?: Date }) =>
  ({ id: objId(d._id), kind: d.kind, title: d.title, mime: d.mime, bytes: d.bytes, status: d.status, expiresAt: d.expiresAt, reviewNote: d.reviewNote, reviewedAt: d.reviewedAt, createdAt: (d as { createdAt?: Date }).createdAt });

export async function listDocuments(supplierId: string) {
  return (await SuppliernetDocument.find({ supplierId }).sort({ createdAt: -1 }).limit(100).lean()).map(docView);
}

/** File bytes for a document of THIS supplier. Callers have already authorised access (staff permission or supplier ownership). */
export async function readDocumentFile(ctx: Ctx, supplierId: string, documentId: string) {
  const d = await SuppliernetDocument.findOne({ _id: documentId, supplierId }).select('+storageKey mime title').lean();
  if (!d) throw notFound('Document');
  const f = await ctx.storage.get(d.storageKey);
  if (!f) throw notFound('Document file');
  return { body: f.body, mime: d.mime ?? 'application/octet-stream', title: d.title };
}

export async function reviewDocument(ctx: Ctx, documentId: string, decision: 'verified' | 'rejected', note: string | undefined, actor: Actor) {
  if (decision === 'rejected' && !(note && note.trim().length >= 3)) throw new DomainError('A reason is required to reject a document', 'VALIDATION', 422);
  const d = await SuppliernetDocument.findByIdAndUpdate(documentId, { $set: { status: decision, reviewedBy: actor.id, reviewedAt: ctx.now(), reviewNote: note } }, { new: true });
  if (!d) throw notFound('Document');
  await audit(ctx, actor, { action: 'suppliernet.document_reviewed', resource: 'supplier', resourceId: objId(d.supplierId), newValue: { documentId, decision } });
  return docView(d);
}

/* ------------------------------ credentials ------------------------------ */
export async function rotateCredentials(ctx: Ctx, supplierId: string, creds: Record<string, string>, actor: Actor) {
  const fields = Object.keys(creds).filter((k) => creds[k]);
  if (!fields.length) throw new DomainError('Provide at least one credential field', 'VALIDATION', 422);
  const sup = await Supplier.findById(supplierId).select('+credentialsEnc');
  if (!sup) throw notFound('Supplier');
  let merged: Record<string, string> = {};
  if (sup.credentialsEnc) {
    try { merged = JSON.parse(decryptSecret(sup.credentialsEnc, ctx.cfg.ENCRYPTION_KEY ?? ctx.cfg.JWT_SECRET)) as Record<string, string>; } catch { merged = {}; }
  }
  for (const k of fields) merged[k] = creds[k]!;
  sup.credentialsEnc = sealCredentials(ctx, merged);
  await sup.save(); // updatedAt changes, so the registry drops its cached provider
  await SuppliernetProfile.updateOne({ supplierId }, { $set: { 'credentials.fields': Object.keys(merged), 'credentials.lastRotatedAt': ctx.now(), 'credentials.rotatedBy': actor.id } });
  await audit(ctx, actor, { action: 'suppliernet.credentials_rotated', resource: 'supplier', resourceId: supplierId, newValue: { fields } }); // names only, never values
  return credentialStatus(ctx, supplierId);
}

export async function credentialStatus(ctx: Ctx, supplierId: string) {
  const prof = await SuppliernetProfile.findOne({ supplierId }).select('credentials').lean();
  const c = prof?.credentials;
  const interval = c?.rotationIntervalDays ?? 180;
  const last = c?.lastRotatedAt ?? null;
  return { fields: c?.fields ?? [], lastRotatedAt: last, rotatedBy: c?.rotatedBy ?? null, rotationIntervalDays: interval, rotationDue: last ? ctx.now().getTime() - new Date(last).getTime() > interval * 86_400_000 : (c?.fields?.length ?? 0) > 0 };
}

/* ------------------------------ verification ----------------------------- */
export async function ensureSteps(supplierId: string) {
  const prof = await SuppliernetProfile.findOne({ supplierId }).lean();
  const required = new Set(requiredStepKinds({ returnsAccepted: (prof?.profile as { returnPolicy?: { returnsAccepted?: boolean } } | undefined)?.returnPolicy?.returnsAccepted }));
  for (const kind of VERIFICATION_STEP_KINDS) {
    await SuppliernetVerificationStep.updateOne({ supplierId, kind }, { $set: { required: required.has(kind) }, $setOnInsert: { status: 'not_started', evidence: [] } }, { upsert: true });
  }
}

export async function recomputeReadiness(ctx: Ctx, supplierId: string) {
  await ensureSteps(supplierId);
  const steps = await SuppliernetVerificationStep.find({ supplierId }).lean();
  const r = evaluateReadiness(steps.map((s) => ({ kind: s.kind, required: s.required, status: s.status, passedAt: s.passedAt, validUntil: s.validUntil, evidence: s.evidence })), ctx.now());
  await Supplier.updateOne({ _id: supplierId }, { $set: { 'network.productionReady': r.ready, 'network.productionReadyUntil': r.validUntil ?? null, 'network.reverificationDueAt': r.validUntil ?? null } });
  return r;
}

export async function getVerification(ctx: Ctx, supplierId: string) {
  await ensureSteps(supplierId);
  const steps = await SuppliernetVerificationStep.find({ supplierId }).lean();
  const now = ctx.now();
  const readiness = await recomputeReadiness(ctx, supplierId);
  return {
    readiness,
    steps: VERIFICATION_STEP_KINDS.map((k) => {
      const s = steps.find((x) => x.kind === k)!;
      return { kind: k, required: s.required, status: s.status, effective: effectiveStepStatus({ kind: k, required: s.required, status: s.status, passedAt: s.passedAt, validUntil: s.validUntil, evidence: s.evidence }, now), passedAt: s.passedAt, validUntil: s.validUntil, evidence: s.evidence.slice(-10) };
    }),
  };
}

type EvidenceIn = { method: 'automated' | 'manual'; outcome: 'pass' | 'fail' | 'info'; summary: string; request?: unknown; response?: unknown; orderId?: string; shipmentId?: string; supplierOrderId?: string; documentId?: string; externalReference?: string; metrics?: Record<string, unknown> };

async function recordEvidence(ctx: Ctx, supplierId: string, kind: VerificationStepKind, e: EvidenceIn, actor: Actor, finalize: boolean) {
  const now = ctx.now();
  const ev = { at: now, operator: actor.id, ...e, request: redactValue(e.request), response: redactValue(e.response), metrics: e.metrics ? redactValue(e.metrics) : undefined };
  const status = e.outcome === 'pass' ? (finalize ? 'passed' : 'in_progress') : e.outcome === 'fail' ? 'failed' : 'in_progress';
  const set: Record<string, unknown> = { status };
  if (status === 'passed') { set['passedAt'] = now; set['validUntil'] = validUntilFor(kind, now); }
  if (status === 'failed') { set['passedAt'] = null; set['validUntil'] = null; }
  await ensureSteps(supplierId);
  await SuppliernetVerificationStep.updateOne({ supplierId, kind }, { $set: set, $push: { evidence: { $each: [ev], $slice: -50 } } });
  await audit(ctx, actor, { action: 'suppliernet.verification_evidence', resource: 'supplier', resourceId: supplierId, newValue: { kind, method: e.method, outcome: e.outcome } });
  return recomputeReadiness(ctx, supplierId);
}

/** Manual attestation: checkable evidence is mandatory (see validateManualEvidence). Pass/fail for measurable steps is computed, not trusted. */
export async function attestStep(ctx: Ctx, supplierId: string, kind: VerificationStepKind, e: ManualEvidenceInput, actor: Actor) {
  const problems = validateManualEvidence(kind, e);
  if (problems.length) throw new DomainError('Evidence is insufficient', 'EVIDENCE_REQUIRED', 422, { problems });
  let outcome: 'pass' | 'fail' = e.outcome;
  let summary = e.summary;
  if (kind === 'price_quote_accuracy') {
    const m = e.metrics as { quotedMinor: number; chargedMinor: number };
    const acc = evaluatePriceAccuracy(m.quotedMinor, m.chargedMinor);
    outcome = acc.ok ? 'pass' : 'fail';
    summary += ` [computed: charged ${acc.diffMinor >= 0 ? '+' : ''}${acc.diffMinor} minor units vs quote (${(acc.diffPct * 100).toFixed(1)}%)]`;
  }
  if (e.orderId) { /* referenced order must exist */
    const { Order } = await import('@orvia/database');
    if (!(await Order.exists({ _id: e.orderId }))) throw new DomainError('Referenced order does not exist', 'VALIDATION', 422);
  }
  if (e.shipmentId) {
    const sh = await Shipment.findById(e.shipmentId).select('supplierId status').lean();
    if (!sh || objId(sh.supplierId) !== supplierId) throw new DomainError('Referenced shipment does not belong to this supplier', 'VALIDATION', 422);
    if (kind === 'delivery_observed' && outcome === 'pass' && sh.status !== 'DELIVERED') throw new DomainError('The referenced shipment is not DELIVERED', 'EVIDENCE_REQUIRED', 422);
  }
  return recordEvidence(ctx, supplierId, kind, { ...e, method: 'manual', outcome, summary, metrics: e.metrics }, actor, true);
}

const AUTOMATED: VerificationStepKind[] = ['catalogue_availability', 'price_quote_accuracy', 'stock_accuracy_sample', 'test_order_placement', 'cancellation', 'shipment_tracking'];

/**
 * Automated probe. Read-only probes may hit any configured supplier. Anything that creates or cancels an order only runs with a
 * typed confirmation, and against a non-sandbox supplier additionally with an explicit cost acknowledgement. Mock suppliers are
 * refused by the registry in production.
 */
export async function runProbe(ctx: Ctx, supplierId: string, kind: VerificationStepKind, p: ProbeInput, actor: Actor) {
  if (!AUTOMATED.includes(kind)) throw new DomainError(`${kind} cannot be automated; record a manual attestation with evidence`, 'VALIDATION', 422);
  const sup = await Supplier.findById(supplierId);
  if (!sup) throw notFound('Supplier');
  const provider = await providerFor(ctx, sup);
  const country = (p.country ?? sup.servesCountries?.[0] ?? 'US') as 'US' | 'CA' | 'IN';
  const t0 = Date.now();
  const step = async (e: Omit<EvidenceIn, 'method'>, finalize = true) => ({ readiness: await recordEvidence(ctx, supplierId, kind, { method: 'automated', ...e }, actor, finalize), outcome: e.outcome, summary: e.summary });
  const failWith = (msg: string, request?: unknown) => step({ outcome: 'fail', summary: msg.slice(0, 500), request });
  const pickProduct = async (): Promise<string> => {
    if (p.externalId) return p.externalId;
    const first = (await provider.searchProducts({ limit: 1 })).items[0];
    if (!first) throw new Error('The catalogue returned no products to test with');
    return first.externalId;
  };
  try {
    if (kind === 'catalogue_availability') {
      const r = await provider.searchProducts({ limit: 10 });
      if (!r.items.length) return await failWith('Catalogue search returned no products');
      const bad = r.items.filter((i) => !i.externalId || !i.title);
      const probe = r.items[0]!;
      const detail = await provider.getProduct(probe.externalId);
      const inv = await provider.getInventory(probe.externalId, probe.variants[0]?.sku);
      const ok = !bad.length && !!detail && inv.total >= 0;
      return await step({ outcome: ok ? 'pass' : 'fail', summary: `${r.items.length} product(s) listed; detail ${detail ? 'ok' : 'missing'}; stock reported ${inv.total}${bad.length ? `; ${bad.length} missing id/title` : ''}`, request: { op: 'searchProducts+getProduct+getInventory', externalId: probe.externalId }, response: { items: r.items.length, withImages: r.items.filter((i) => i.images.length).length, stock: inv.total }, metrics: { responseMs: Date.now() - t0 } });
    }
    if (kind === 'stock_accuracy_sample') {
      const r = await provider.searchProducts({ limit: Math.min(p.sampleSize ?? 5, 20) });
      const rows: { externalId: string; sku?: string; claimed: number }[] = [];
      for (const it of r.items) rows.push({ externalId: it.externalId, sku: it.variants[0]?.sku, claimed: (await provider.getInventory(it.externalId, it.variants[0]?.sku)).total });
      if (!rows.length) return await failWith('No products available to sample');
      await SuppliernetStockCheck.insertMany(rows.map((x) => ({ supplierId, ...x, checkedAt: ctx.now(), source: 'api' })));
      return await step({ outcome: 'info', summary: `Collected ${rows.length} claimed stock values. Submit independently observed counts (stock-observations) to finish this step: an API cannot verify itself.`, response: { sampled: rows.length } }, false);
    }
    if (kind === 'test_order_placement') {
      const live = !sup.sandbox && sup.provider !== 'mock';
      const want = live ? 'PLACE LIVE TEST ORDER' : 'PLACE TEST ORDER';
      if (p.confirm !== want) throw new DomainError(`Type "${want}" to confirm. ${live ? 'This supplier has no sandbox: a REAL order with real cost will be created.' : ''}`.trim(), 'CONFIRMATION_REQUIRED', 409);
      if (live && p.acknowledgeLiveCost !== true) throw new DomainError('Acknowledge that a real, paid order will be created (acknowledgeLiveCost=true)', 'CONFIRMATION_REQUIRED', 409);
      if (!p.address) throw new DomainError('A test delivery address is required', 'VALIDATION', 422);
      const ext = await pickProduct();
      const product = await provider.getProduct(ext);
      const sku = p.sku ?? product?.variants[0]?.sku ?? ext;
      const [price, ship] = await Promise.all([provider.getPrice(ext, country, sku), provider.getShippingQuote(ext, country, 1)]);
      const quotedMinor = price.productCost + price.fulfillmentFee + ship.shippingCost;
      const key = `suppliernet-verify:${sup.code}:${Date.now()}`;
      const input = { idempotencyKey: key, orderRef: `TEST-${Date.now().toString(36).toUpperCase()}`, externalId: ext, sku, quantity: 1, destination: p.address as never };
      const o1 = await provider.createOrder(input);
      const o2 = await provider.createOrder(input); // idempotency proof: same key must not create a second order
      const idempotent = o1.supplierOrderId === o2.supplierOrderId;
      return await step({ outcome: idempotent ? 'pass' : 'fail', summary: idempotent ? `Test order ${o1.supplierOrderId} placed; repeating the same idempotency key returned the same order` : `Idempotency FAILED: ${o1.supplierOrderId} vs ${o2.supplierOrderId} (duplicate order created at the supplier!)`, request: { op: 'createOrder x2', externalId: ext, sku, live }, response: { supplierOrderId: o1.supplierOrderId, status: o1.status }, supplierOrderId: o1.supplierOrderId, metrics: { quotedMinor, chargedMinor: o1.cost.productCost + o1.cost.shippingCost + o1.cost.duties, currency: price.currency } });
    }
    if (kind === 'price_quote_accuracy') {
      const prior = await SuppliernetVerificationStep.findOne({ supplierId, kind: 'test_order_placement' }).lean();
      const last = [...(prior?.evidence ?? [])].reverse().find((e) => e.outcome === 'pass' && e.supplierOrderId);
      const q = (last?.metrics as { quotedMinor?: number } | undefined)?.quotedMinor;
      if (!last || typeof q !== 'number') throw new DomainError('Run a passing test order first: price accuracy compares its quote with the cost the supplier reports for that order', 'PRECONDITION', 409);
      const o = await provider.getOrder(last.supplierOrderId!);
      const charged = o.cost.productCost + o.cost.shippingCost + o.cost.duties;
      const acc = evaluatePriceAccuracy(q, charged);
      return await step({ outcome: acc.ok ? 'pass' : 'fail', summary: `Quoted ${q}, supplier order cost ${charged} (${(acc.diffPct * 100).toFixed(1)}% difference, tolerance 2%)`, supplierOrderId: last.supplierOrderId ?? undefined, request: { op: 'getOrder' }, response: { charged }, metrics: { quotedMinor: q, chargedMinor: charged } });
    }
    const orderId = p.supplierOrderId ?? [...((await SuppliernetVerificationStep.findOne({ supplierId, kind: 'test_order_placement' }).lean())?.evidence ?? [])].reverse().find((e) => e.supplierOrderId)?.supplierOrderId ?? undefined;
    if (!orderId) throw new DomainError('No test order found: place one first or pass supplierOrderId', 'PRECONDITION', 409);
    if (kind === 'cancellation') {
      if (p.confirm !== 'CANCEL TEST ORDER') throw new DomainError('Type "CANCEL TEST ORDER" to confirm', 'CONFIRMATION_REQUIRED', 409);
      const c = await provider.cancelOrder(orderId);
      return await step({ outcome: c.cancelled ? 'pass' : 'fail', summary: c.cancelled ? `Order ${orderId} cancelled` : `Not cancelled: ${c.reason ?? 'unknown'}`, supplierOrderId: orderId, request: { op: 'cancelOrder' }, response: c });
    }
    if (kind === 'shipment_tracking') {
      const t = await provider.getTracking(orderId);
      return await step({ outcome: t.available && !!t.trackingNumber ? 'pass' : 'fail', summary: t.available ? `Tracking ${t.trackingNumber} (${t.status}), ${t.events.length} event(s)` : `No tracking issued yet (status ${t.status}); try again later. ORVIA never invents tracking.`, supplierOrderId: orderId, request: { op: 'getTracking' }, response: { available: t.available, status: t.status, events: t.events.length } });
    }
  } catch (e) {
    if (e instanceof DomainError) throw e;
    return failWith(`Probe error: ${(e as Error).message}`);
  }
  throw new DomainError('Unsupported probe', 'VALIDATION', 422);
}

/** Operator-observed stock counts complete the stock accuracy step; accuracy is computed, never asserted. */
export async function submitStockObservations(ctx: Ctx, supplierId: string, input: { observations: { externalId: string; sku?: string; observed: number; source: string }[]; summary: string }, actor: Actor) {
  const samples: { claimed: number; observed: number }[] = [];
  for (const o of input.observations) {
    const chk = await SuppliernetStockCheck.findOneAndUpdate({ supplierId, externalId: o.externalId, observed: null }, { $set: { observed: o.observed, observedAt: ctx.now(), source: o.source } }, { sort: { checkedAt: -1 }, new: true });
    if (chk) samples.push({ claimed: chk.claimed, observed: o.observed });
  }
  if (!samples.length) throw new DomainError('No open stock samples match: run the stock probe first', 'PRECONDITION', 409);
  const r = evaluateStockAccuracy(samples);
  return recordEvidence(ctx, supplierId, 'stock_accuracy_sample', { method: 'manual', outcome: r.ok ? 'pass' : 'fail', summary: `${input.summary} [computed accuracy ${r.accuracy === null ? 'n/a' : (r.accuracy * 100).toFixed(0) + '%'} over ${r.sample} sample(s)${r.reason ? `: ${r.reason}` : ''}]`, metrics: { accuracy: r.accuracy ?? -1, sample: r.sample }, externalReference: input.observations[0]!.source }, actor, true);
}

/** Link a real DELIVERED shipment as delivery evidence (automated check of our own shipment record). */
export async function verifyDeliveryFromShipment(ctx: Ctx, supplierId: string, shipmentId: string, actor: Actor) {
  const sh = await Shipment.findById(shipmentId).lean();
  if (!sh || objId(sh.supplierId) !== supplierId) throw notFound('Shipment');
  const delivered = sh.status === 'DELIVERED';
  return recordEvidence(ctx, supplierId, 'delivery_observed', { method: 'automated', outcome: delivered ? 'pass' : 'fail', summary: delivered ? `Shipment ${shipmentId} delivered with ${sh.events?.length ?? 0} tracking event(s)` : `Shipment is ${sh.status}, not DELIVERED`, shipmentId, orderId: objId(sh.orderId), supplierOrderId: sh.supplierOrderId ?? undefined }, actor, true);
}

/** Daily job: lapse readiness, flag documents, raise re-verification reminders. */
export async function runVerificationSweep(ctx: Ctx): Promise<{ checked: number; lapsed: number; docsExpired: number }> {
  const now = ctx.now();
  let lapsed = 0;
  const sups = await Supplier.find({ 'network.state': { $in: ['probation', 'approved'] } }).select('code name network').limit(500).lean();
  for (const s of sups) {
    const wasReady = !!s.network?.productionReady;
    const r = await recomputeReadiness(ctx, objId(s._id));
    if (wasReady && !r.ready) {
      lapsed++;
      await raiseException(ctx, { kind: 'SUPPLIER_FAILURE', priority: 'high', issue: `Supplier ${s.name}: verification lapsed (${r.expired.join(', ') || r.missing.join(', ')}). It is no longer production-eligible until re-verified.`, aiRecommendation: 'Re-run the expired verification steps.', suggestedAction: 'Re-verify supplier', actionCode: 'dismiss', dedupeKey: `suppliernet:reverify:${s._id}` });
    }
  }
  const exp = await SuppliernetDocument.updateMany({ status: 'verified', expiresAt: { $lt: now } }, { $set: { status: 'rejected', reviewNote: 'Expired' } });
  return { checked: sups.length, lapsed, docsExpired: exp.modifiedCount };
}
