/** TrustGraph service: loads data, runs the pure scorers, stores reproducible snapshots, serves admin views. */
import { Product, Supplier, SupplierOffer, TrustEvidence, TrustProductRiskSnapshot, TrustSupplierSnapshot } from '@orvia/database';
import type { EvidenceInput, ProductRiskResult, SupplierTrustResult, SupplierTrustSnapshotView, TrustStatus } from '@orvia/types';
import { audit } from '../../infra/audit';
import { DomainError, notFound } from '../../infra/context';
import type { Actor, Ctx } from '../../infra/context';
import { exportGate } from '../exportGate';
import { effectiveImages } from '../images';
import { aggregateProductRows, aggregateSupplierInputs, destinationsOf } from './aggregate';
import type { ProductHistory } from './aggregate';
import { buildChecklist } from './checklist';
import type { ChecklistItem } from './checklist';
import { loadProductRows, loadSupplierRows } from './collect';
import type { EvidenceRecord } from './passport';
import { priorsFromGlobal, scoreProductRisk, scoreSupplierTrust } from './scoring';

export const TRUST_MODEL_VERSION = 'trustgraph-1.0';
/** A supplier snapshot older than this is recomputed on demand by customer-facing reads. */
export const SUPPLIER_SNAPSHOT_MAX_AGE_MS = 6 * 3_600_000;
export type Trigger = 'schedule' | 'manual' | 'on_demand';

/* ------------------------------ supplier trust ------------------------------ */

interface SnapshotLean {
  supplierId: unknown; computedAt: Date; status: TrustStatus; score?: number | null; confidence?: number; sampleSize?: number;
  result?: SupplierTrustResult; destinations?: { destination: string; result: SupplierTrustResult }[]; inputs?: unknown;
}

const viewOf = (s: SnapshotLean, supplierName: string): SupplierTrustSnapshotView => ({
  ...(s.result as SupplierTrustResult),
  supplierId: String(s.supplierId),
  supplierName,
  computedAt: s.computedAt.toISOString(),
  destinations: Object.fromEntries((s.destinations ?? []).map((d) => [d.destination, d.result])),
});

export async function computeSupplierTrust(ctx: Ctx, supplierId: string, trigger: Trigger = 'on_demand'): Promise<SupplierTrustSnapshotView> {
  const sup = await Supplier.findById(supplierId).select('name').lean();
  if (!sup) throw notFound('Supplier');
  const now = ctx.now();
  const rows = await loadSupplierRows(supplierId, now);
  const gInputs = aggregateSupplierInputs(rows, now, null);
  const global = scoreSupplierTrust(gInputs);
  const priors = priorsFromGlobal(global);
  const destinations: { destination: string; result: SupplierTrustResult }[] = [];
  const destInputs: Record<string, unknown> = {};
  for (const d of destinationsOf(rows)) {
    const di = aggregateSupplierInputs(rows, now, d);
    destInputs[d] = di;
    destinations.push({ destination: d, result: scoreSupplierTrust({ ...di, priors }) });
  }
  const doc = await TrustSupplierSnapshot.create({ supplierId, computedAt: now, modelVersion: TRUST_MODEL_VERSION, status: global.status, score: global.score ?? undefined, confidence: global.confidence, sampleSize: global.sampleSize, inputs: { global: gInputs, destinations: destInputs }, result: global, destinations, trigger });
  return viewOf(doc.toObject() as unknown as SnapshotLean, sup.name);
}

/** Latest stored snapshot, recomputed on demand when missing or older than `maxAgeMs`. */
export async function latestSupplierTrust(ctx: Ctx, supplierId: string, maxAgeMs = SUPPLIER_SNAPSHOT_MAX_AGE_MS): Promise<SupplierTrustSnapshotView> {
  const snap = (await TrustSupplierSnapshot.findOne({ supplierId }).sort({ computedAt: -1 }).lean()) as unknown as SnapshotLean | null;
  if (snap && ctx.now().getTime() - snap.computedAt.getTime() <= maxAgeMs) {
    const sup = await Supplier.findById(supplierId).select('name').lean();
    return viewOf(snap, sup?.name ?? 'Supplier');
  }
  return computeSupplierTrust(ctx, supplierId, 'on_demand');
}

/** The result relevant to a destination: its own slice when it has data, otherwise the overall result. */
export function resultForDestination(v: SupplierTrustSnapshotView, country: string | null): SupplierTrustResult {
  const d = country ? v.destinations[country] : undefined;
  return d && d.status !== 'insufficient_data' ? d : v;
}

/* ------------------------------ product context ------------------------------ */

interface ProductLean {
  _id: unknown; slug: string; title: string; brand?: string; description?: string; state: string;
  attributes?: Record<string, string>;
  images?: { url?: string; alt?: string; source?: string; license?: string }[];
  organic?: { evidence?: { claim: string; type: string; certUrl?: string; sourceUrl?: string; observedAt?: Date; expiresAt?: Date; verified?: boolean }[] };
  compliance?: { status?: 'pending' | 'passed' | 'failed' | 'review'; flags?: string[]; safetyInfo?: { standards?: string[]; ageRange?: string; certificateUrl?: string } };
  markets: { country: string; enabled?: boolean; price: number; compareAtPrice?: number; currency?: string; shipsFrom?: string; minDays?: number; maxDays?: number; stock?: number; bestSupplierId?: unknown }[];
}

interface OfferLean { supplierId: unknown; destination: string; syncedAt?: Date; confirmedAt?: Date; available?: boolean; stock?: number; source?: string; minDays?: number; maxDays?: number }

export interface ProductContext {
  product: ProductLean;
  country: string | null;
  evidence: EvidenceRecord[];
  checklist: ChecklistItem[];
  images: { url: string; alt?: string; source: 'supplier' | 'admin' | 'listing'; license: 'unknown' | 'supplier_provided' | 'owned' }[];
  hist: ProductHistory;
  offers: OfferLean[];
  suppliers: { id: string; name: string; priority: number; trust: SupplierTrustResult }[];
  serving: { name: string; offer: OfferLean | null } | null;
  restrictions: { restricted: boolean; reasons: string[] };
  risk: ProductRiskResult;
}

export const loadEvidence = async (subject: 'product' | 'supplier' | 'manufacturer', id: string): Promise<EvidenceRecord[]> => {
  const rows = await TrustEvidence.find({ subject, subjectId: id, supersededAt: { $exists: false } }).sort({ observedAt: -1 }).limit(300).lean();
  return rows.map((r) => ({ subject: r.subject, kind: r.kind, key: r.key, value: r.value, provenance: r.provenance, source: r.source, sourceUrl: r.sourceUrl ?? null, observedAt: r.observedAt ?? null, expiresAt: r.expiresAt ?? null, jurisdiction: r.jurisdiction ?? [] }));
};

async function restrictionsFor(ctx: Ctx, p: ProductLean, country: string | null): Promise<{ restricted: boolean; reasons: string[] }> {
  const reasons: string[] = [];
  const c = p.compliance?.status;
  if (c === 'failed') reasons.push('This product did not pass compliance screening');
  if (c === 'review') reasons.push('This product is under compliance review');
  if (country) {
    const m = p.markets.find((x) => x.country === country);
    if (!m || !m.enabled) reasons.push(`Not currently sold in ${country}`);
    const gate = await exportGate(ctx, country);
    if (gate.required && !gate.attested) reasons.push(`Selling into ${country} is awaiting a destination-market compliance review`);
  }
  return { restricted: reasons.length > 0, reasons };
}

const asLicense = (l?: string): 'unknown' | 'supplier_provided' | 'owned' => (l === 'owned' || l === 'supplier_provided' ? l : 'unknown');

export async function gatherProduct(ctx: Ctx, p: ProductLean, country: string | null): Promise<ProductContext> {
  const now = ctx.now();
  const id = String(p._id);
  const [evidence, rows, offers] = await Promise.all([
    loadEvidence('product', id),
    loadProductRows(id),
    SupplierOffer.find({ productId: id, ...(country ? { destination: country } : {}) }).limit(40).select('supplierId destination syncedAt confirmedAt available stock source minDays maxDays').lean() as unknown as Promise<OfferLean[]>,
  ]);
  const usable = offers.filter((o) => o.available && (o.stock ?? 0) > 0);
  const supIds = [...new Set(usable.map((o) => String(o.supplierId)))].slice(0, 10);
  const sups = await Supplier.find({ _id: { $in: supIds }, active: true }).select('name priority').lean();
  const suppliers = await Promise.all(sups.map(async (s) => ({ id: String(s._id), name: s.name, priority: s.priority ?? 100, trust: resultForDestination(await latestSupplierTrust(ctx, String(s._id)), country) })));

  const imgSrc = country ? effectiveImages(p as never, country) : (p.images ?? []).filter((i) => i.url).map((i) => ({ url: i.url as string, alt: i.alt }));
  const byUrl = new Map((p.images ?? []).map((i) => [i.url ?? '', i]));
  const images = imgSrc.map((im) => { const src = byUrl.get(im.url); return { url: im.url, alt: im.alt, source: (src?.source === 'admin' ? 'admin' : src?.source === 'supplier' ? 'supplier' : 'listing') as 'supplier' | 'admin' | 'listing', license: asLicense(src?.license) }; });

  const organic = (p.organic?.evidence ?? []);
  const checklist = buildChecklist({ now, attributes: p.attributes ?? {}, description: p.description ?? '', safetyStandards: p.compliance?.safetyInfo?.standards ?? [], organicVerified: organic.some((o) => o.verified && (!o.expiresAt || o.expiresAt > now)), images, evidence });
  const hist = aggregateProductRows(rows, country);
  const restrictions = await restrictionsFor(ctx, p, country);

  const risk = scoreProductRisk({
    now, destination: country, evidence: checklist, compliance: { status: p.compliance?.status ?? 'pending', flags: p.compliance?.flags ?? [] },
    suppliers: suppliers.map((s) => ({ name: s.name, score: s.trust.score, status: s.trust.status, confidence: s.trust.confidence, sampleSize: s.trust.sampleSize })),
    shipping: hist.shipping, feedback: hist.feedback, restrictions,
  });

  const market = country ? p.markets.find((m) => m.country === country) : undefined;
  const best = suppliers.find((s) => String(market?.bestSupplierId ?? '') === s.id) ?? [...suppliers].sort((a, b) => a.priority - b.priority)[0];
  const serving = best ? { name: best.name, offer: usable.find((o) => String(o.supplierId) === best.id) ?? null } : null;
  return { product: p, country, evidence, checklist, images, hist, offers, suppliers, serving, restrictions, risk };
}

/* ------------------------------ product risk snapshots ------------------------------ */

export async function computeProductRisk(ctx: Ctx, productId: string, country: string | null, trigger: Trigger = 'on_demand'): Promise<ProductRiskResult> {
  const p = (await Product.findById(productId).lean()) as unknown as ProductLean | null;
  if (!p) throw notFound('Product');
  const g = await gatherProduct(ctx, p, country);
  await TrustProductRiskSnapshot.create({
    productId, destination: country, computedAt: ctx.now(), modelVersion: TRUST_MODEL_VERSION, status: g.risk.status, level: g.risk.level, score: g.risk.score ?? undefined, confidence: g.risk.confidence, sampleSize: g.risk.sampleSize,
    inputs: { checklist: g.checklist, history: { ...g.hist.shipping, ...g.hist.feedback }, restrictions: g.restrictions, suppliers: g.suppliers.map((s) => ({ name: s.name, score: s.trust.score, status: s.trust.status, confidence: s.trust.confidence, sampleSize: s.trust.sampleSize })) },
    result: g.risk, trigger,
  });
  return g.risk;
}

export interface RecomputeSummary { suppliers: number; products: number; snapshotsPruned: number; errors: number }

/** Recompute everything in scope. Bounded: at most 200 suppliers and 300 products per run. */
export async function recomputeTrust(ctx: Ctx, opts: { scope?: 'all' | 'suppliers' | 'products'; supplierId?: string; productId?: string }, trigger: Trigger, actor?: Actor): Promise<RecomputeSummary> {
  const scope = opts.scope ?? 'all';
  const out: RecomputeSummary = { suppliers: 0, products: 0, snapshotsPruned: 0, errors: 0 };
  if (scope !== 'products') {
    const ids = opts.supplierId ? [opts.supplierId] : (await Supplier.find({ active: true }).select('_id').limit(200).lean()).map((s) => String(s._id));
    for (const id of ids) {
      try { await computeSupplierTrust(ctx, id, trigger); out.suppliers++; } catch (e) { out.errors++; ctx.log.warn({ err: (e as Error).message, supplierId: id }, 'trust supplier recompute failed'); }
    }
  }
  if (scope !== 'suppliers') {
    const prods = opts.productId ? [{ _id: opts.productId, markets: [] as { country: string; enabled?: boolean }[] }] : (await Product.find({ state: { $in: ['PUBLISHED', 'TESTING', 'WINNER', 'SCALING'] } }).sort({ updatedAt: -1 }).limit(300).select('_id markets.country markets.enabled').lean());
    for (const pr of prods) {
      const countries = opts.productId ? ['US', 'CA', 'IN'] : [...new Set(pr.markets.filter((m) => m.enabled).map((m) => m.country))];
      try {
        await computeProductRisk(ctx, String(pr._id), null, trigger);
        for (const c of countries) await computeProductRisk(ctx, String(pr._id), c, trigger);
        out.products++;
      } catch (e) { out.errors++; ctx.log.warn({ err: (e as Error).message, productId: String(pr._id) }, 'trust product recompute failed'); }
    }
  }
  // Retention: keep 180 days of snapshot history for audit/trend; the latest per subject is always newer than that.
  const cutoff = new Date(ctx.now().getTime() - 180 * 86_400_000);
  out.snapshotsPruned = (await TrustSupplierSnapshot.deleteMany({ computedAt: { $lt: cutoff } })).deletedCount + (await TrustProductRiskSnapshot.deleteMany({ computedAt: { $lt: cutoff } })).deletedCount;
  if (actor) await audit(ctx, actor, { action: 'trust.recompute', resource: 'trust', resourceId: opts.supplierId ?? opts.productId ?? scope, newValue: out, reason: `manual recompute (${scope})` });
  return out;
}

/* ------------------------------ evidence ------------------------------ */

export async function recordEvidence(ctx: Ctx, input: EvidenceInput, actor: Actor) {
  if (input.provenance === 'verified' && actor.type !== 'user') throw new DomainError('Only a person can record verified evidence', 'FORBIDDEN', 403);
  const exists = input.subject === 'product' ? await Product.exists({ _id: input.subjectId }) : input.subject === 'supplier' ? await Supplier.exists({ _id: input.subjectId }) : true;
  if (!exists) throw notFound(input.subject === 'product' ? 'Product' : 'Supplier');
  if (input.expiresAt && input.expiresAt.getTime() <= ctx.now().getTime()) throw new DomainError('Evidence is already expired', 'INVALID', 422);
  // Supersede earlier evidence for the same key so history is kept but only one item is current.
  await TrustEvidence.updateMany({ subject: input.subject, subjectId: input.subjectId, kind: input.kind, key: input.key, supersededAt: { $exists: false } }, { $set: { supersededAt: ctx.now() } });
  const doc = await TrustEvidence.create({ ...input, observedAt: input.observedAt ?? ctx.now(), recordedBy: actor.id });
  await audit(ctx, actor, { action: 'trust.evidence.recorded', resource: input.subject, resourceId: input.subjectId, newValue: { kind: input.kind, key: input.key, provenance: input.provenance }, reason: input.source });
  return doc.toObject();
}

/* ------------------------------ admin views ------------------------------ */

export async function listSupplierTrust(_ctx: Ctx, q: { page: number; pageSize: number; status?: TrustStatus; q?: string }) {
  const filter: Record<string, unknown> = {};
  if (q.q) filter.name = new RegExp(q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const sups = await Supplier.find(filter).sort({ name: 1 }).limit(500).select('name code provider active').lean();
  const latest = (await TrustSupplierSnapshot.aggregate([
    { $match: { supplierId: { $in: sups.map((s) => s._id) } } }, { $sort: { computedAt: -1 } }, { $group: { _id: '$supplierId', doc: { $first: '$$ROOT' } } },
  ])) as { _id: unknown; doc: SnapshotLean }[];
  const by = new Map(latest.map((l) => [String(l._id), l.doc]));
  let items = sups.map((s) => {
    const snap = by.get(String(s._id));
    return { id: String(s._id), name: s.name, code: s.code, provider: s.provider, active: s.active, computed: !!snap, trust: snap ? viewOf(snap, s.name) : null, status: (snap?.status ?? 'insufficient_data') as TrustStatus };
  });
  if (q.status) items = items.filter((i) => i.status === q.status);
  const total = items.length;
  return { items: items.slice((q.page - 1) * q.pageSize, q.page * q.pageSize), total, page: q.page, pageSize: q.pageSize };
}

export async function listProductRisk(_ctx: Ctx, q: { page: number; pageSize: number; status?: TrustStatus; q?: string }) {
  const match: Record<string, unknown> = { destination: null };
  if (q.q) {
    const ids = await Product.find({ title: new RegExp(q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }).limit(200).select('_id').lean();
    match.productId = { $in: ids.map((i) => i._id) };
  }
  const base = [{ $match: match }, { $sort: { computedAt: -1 } }, { $group: { _id: '$productId', doc: { $first: '$$ROOT' } } }, { $replaceRoot: { newRoot: '$doc' } }, ...(q.status ? [{ $match: { status: q.status } }] : [])];
  const [rows, count] = await Promise.all([
    TrustProductRiskSnapshot.aggregate([...base, { $sort: { score: -1, computedAt: -1 } }, { $skip: (q.page - 1) * q.pageSize }, { $limit: q.pageSize }]) as Promise<{ productId: unknown; level: string; status: TrustStatus; score?: number; confidence: number; sampleSize: number; computedAt: Date; result: ProductRiskResult }[]>,
    TrustProductRiskSnapshot.aggregate([...base, { $count: 'n' }]) as Promise<{ n: number }[]>,
  ]);
  const prods = await Product.find({ _id: { $in: rows.map((r) => r.productId) } }).select('title slug state').lean();
  const pm = new Map(prods.map((p) => [String(p._id), p]));
  return {
    items: rows.map((r) => ({ productId: String(r.productId), title: pm.get(String(r.productId))?.title ?? 'Unknown product', slug: pm.get(String(r.productId))?.slug ?? null, state: pm.get(String(r.productId))?.state ?? null, level: r.level, status: r.status, score: r.score ?? null, confidence: r.confidence, sampleSize: r.sampleSize, computedAt: r.computedAt.toISOString(), risk: r.result })),
    total: count[0]?.n ?? 0, page: q.page, pageSize: q.pageSize,
  };
}

export async function productRiskDetail(ctx: Ctx, productId: string) {
  const p = await Product.findById(productId).select('title slug state markets.country markets.enabled').lean();
  if (!p) throw notFound('Product');
  const snaps = await TrustProductRiskSnapshot.aggregate([{ $match: { productId: p._id } }, { $sort: { computedAt: -1 } }, { $group: { _id: '$destination', doc: { $first: '$$ROOT' } } }]) as { _id: string | null; doc: { computedAt: Date; result: ProductRiskResult; inputs: unknown; modelVersion: string } }[];
  const evidence = await TrustEvidence.find({ subject: 'product', subjectId: productId }).sort({ createdAt: -1 }).limit(200).lean();
  const now = ctx.now();
  return {
    product: { id: String(p._id), title: p.title, slug: p.slug, state: p.state },
    overall: snaps.find((s) => s._id === null)?.doc ?? null,
    destinations: Object.fromEntries(snaps.filter((s) => s._id !== null).map((s) => [s._id as string, { computedAt: s.doc.computedAt, modelVersion: s.doc.modelVersion, result: s.doc.result, inputs: s.doc.inputs }])),
    evidence: evidence.map((e) => ({ id: String(e._id), kind: e.kind, key: e.key, value: e.value, provenance: e.provenance, source: e.source, sourceUrl: e.sourceUrl ?? null, observedAt: e.observedAt ?? null, expiresAt: e.expiresAt ?? null, expired: !!e.expiresAt && e.expiresAt <= now, superseded: !!e.supersededAt, recordedBy: e.recordedBy ?? null })),
  };
}
