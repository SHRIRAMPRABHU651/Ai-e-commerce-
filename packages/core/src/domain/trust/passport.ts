/**
 * Digital Product Passport and Purchase Confidence report builders (pure).
 * Inputs are plain data collected by service.ts; outputs carry provenance on every field and are passed
 * through the no-leak serializer before leaving the API.
 */
import type { PassportDocument, PassportField, ProductPassport, Provenance, ProductRiskResult, PurchaseConfidenceReport, SupplierTrustResult, TrustStatus } from '@orvia/types';
import { deliveryBand } from './delivery';
import type { PromisedWindow } from './delivery';
import { AiClaimError, assertNoAiClaims, guardedField, toCustomerSafe } from './guard';
import { freshness, round3 } from './stats';

export interface EvidenceRecord {
  subject: 'product' | 'supplier' | 'manufacturer';
  kind: string;
  key: string;
  value: string;
  provenance: Provenance;
  source: string;
  sourceUrl?: string | null;
  observedAt?: Date | null;
  expiresAt?: Date | null;
  jurisdiction?: string[];
}

export interface PassportInputs {
  now: Date;
  country: string;
  product: {
    slug: string; title: string; brand: string; description: string; state: string;
    attributes: Record<string, string>;
    safetyStandards: string[]; safetyAgeRange?: string | null; certificateUrl?: string | null;
    organic: { claim: string; verified: boolean; certUrl?: string | null; sourceUrl?: string | null; observedAt?: Date | null; expiresAt?: Date | null; type: string }[];
    marketEnabled: boolean; price: number | null; currency: string; compareAtPrice: number | null;
    promised: PromisedWindow | null; shipsFrom: string | null;
  };
  evidence: EvidenceRecord[];
  supplierDisplayName: string | null;
  images: { url: string; alt?: string; source: 'supplier' | 'admin' | 'listing'; license: 'unknown' | 'supplier_provided' | 'owned' }[];
  offer: { newestSyncAt: Date | null; manual: boolean; available: boolean } | null;
  history: { deliveredDays: number[]; resolved: number; delivered: number; failed: number; returns: number; defects: number };
  risk: ProductRiskResult;
  reviews: { avg: number | null; count: number; verified: number; distribution: Record<string, number> };
  alternatives: ProductPassport['alternatives'];
  restrictions: { restricted: boolean; reasons: string[] };
  /** Optional price points from a future price-snapshot collection; never fabricated. */
  priceSnapshots?: { at: Date; price: number; currency: string }[];
}

const SPEC_MATERIAL = /(material|fabric|composition|made of|filling|lining)/i;
const SPEC_DIMENSION = /(dimension|size|length|width|height|depth|weight|capacity|diameter|volume|thickness)/i;
const iso = (d?: Date | null) => (d ? d.toISOString() : null);
const norm = (s: string) => s.trim().toLowerCase();

const isActive = (e: EvidenceRecord, now: Date) => !e.expiresAt || e.expiresAt.getTime() > now.getTime();

export const STOCK_FRESH_HOURS = 24;
export const STOCK_STALE_HOURS = 96;

function stockFreshness(offer: PassportInputs['offer'], now: Date): ProductPassport['stock'] {
  if (!offer || !offer.newestSyncAt) return { freshness: 'unknown', observedAt: null, note: 'No supplier stock confirmation on record.', provenance: 'supplier_provided' };
  const ageH = (now.getTime() - offer.newestSyncAt.getTime()) / 3_600_000;
  const f = ageH <= STOCK_FRESH_HOURS ? 'fresh' : ageH <= STOCK_STALE_HOURS ? 'aging' : 'stale';
  return { freshness: f, observedAt: offer.newestSyncAt.toISOString(), note: `Supplier stock last confirmed ${Math.round(ageH)} hour${Math.round(ageH) === 1 ? '' : 's'} ago${offer.manual ? ' (manually confirmed)' : ''}. Stock can change before you order.`, provenance: 'supplier_provided' };
}

function usageRights(license: string, source: string): { rights: string; provenance: Provenance } {
  if (license === 'owned') return { rights: 'Image owned or uploaded by Orvia.', provenance: 'verified' };
  if (license === 'supplier_provided') return { rights: 'Provided by the supplier; usage rights are as granted by the supplier.', provenance: 'supplier_provided' };
  return { rights: `Usage rights not confirmed${source === 'supplier' ? ' (supplier image)' : ''}.`, provenance: 'supplier_provided' };
}

export function buildPassport(i: PassportInputs): ProductPassport {
  const p = i.product;
  const activeEv = i.evidence.filter((e) => isActive(e, i.now));
  const verifiedFor = (key: string, kinds: string[]) => activeEv.find((e) => e.provenance === 'verified' && kinds.includes(e.kind) && norm(e.key) === norm(key));

  const mkField = (value: string, provenance: Provenance, source: string, observedAt?: Date | null, expiresAt?: Date | null): PassportField => ({ value, provenance, source, observedAt: iso(observedAt), freshness: expiresAt || observedAt ? round3(freshness(observedAt ?? i.now, i.now, 24 * 365, expiresAt)) : null });

  const specs: { key: string; field: PassportField }[] = [];
  const materials: PassportField[] = [];
  const dims: { key: string; field: PassportField }[] = [];
  const seen = new Set<string>();
  const place = (key: string, field: PassportField) => {
    if (SPEC_MATERIAL.test(key)) materials.push({ ...field, value: `${key}: ${field.value}` });
    else if (SPEC_DIMENSION.test(key)) dims.push({ key, field });
    else specs.push({ key, field });
  };
  for (const [k, v] of Object.entries(p.attributes)) {
    if (!v?.trim()) continue;
    seen.add(norm(k));
    const ver = verifiedFor(k, ['specification', 'material', 'dimension']);
    if (ver) place(k, mkField(ver.value, 'verified', ver.source, ver.observedAt, ver.expiresAt));
    else place(k, mkField(v, 'supplier_provided', 'Supplier listing'));
  }
  for (const e of activeEv) {
    if (e.provenance === 'ai_suggested') continue; // AI-suggested evidence is never displayed as a spec or claim
    if (!['specification', 'material', 'dimension'].includes(e.kind) || seen.has(norm(e.key))) continue;
    seen.add(norm(e.key));
    place(e.key, mkField(e.value, e.provenance, e.source, e.observedAt, e.expiresAt));
  }

  // Documents / certificates: only verified (active) evidence is shown as verified.
  const documents: PassportDocument[] = [];
  for (const std of p.safetyStandards) {
    const ver = activeEv.find((e) => e.provenance === 'verified' && ['certificate', 'test_report'].includes(e.kind) && (norm(e.key).includes(norm(std)) || norm(std).includes(norm(e.key))));
    documents.push(ver
      ? { title: std, kind: 'standard', provenance: 'verified', source: ver.source, url: ver.sourceUrl ?? null, observedAt: iso(ver.observedAt), expiresAt: iso(ver.expiresAt), jurisdiction: ver.jurisdiction }
      : { title: std, kind: 'standard', provenance: 'supplier_provided', source: 'Supplier listing (not independently verified)', url: null });
  }
  if (p.certificateUrl) documents.push({ title: 'Safety certificate (supplier-provided link)', kind: 'certificate', provenance: 'supplier_provided', source: 'Supplier listing (not independently verified)', url: p.certificateUrl });
  for (const o of p.organic) {
    const active = !o.expiresAt || o.expiresAt.getTime() > i.now.getTime();
    const verified = o.verified && active;
    documents.push({ title: `${o.claim.replace(/_/g, ' ')} claim (${o.type.replace(/_/g, ' ')})`, kind: 'organic_claim', provenance: verified ? 'verified' : 'supplier_provided', source: verified ? 'Orvia evidence review' : 'Supplier statement (not verified)', url: o.certUrl ?? o.sourceUrl ?? null, observedAt: iso(o.observedAt), expiresAt: iso(o.expiresAt), expired: !!o.expiresAt && !active });
  }
  for (const e of i.evidence) {
    if (!['certificate', 'test_report', 'document', 'image_rights'].includes(e.kind) || e.provenance === 'ai_suggested') continue;
    const active = isActive(e, i.now);
    if (documents.some((d) => d.title === e.key)) continue;
    documents.push({ title: e.key, kind: 'document', provenance: active ? e.provenance : e.provenance === 'verified' ? 'supplier_provided' : e.provenance, source: e.source, url: e.sourceUrl ?? null, observedAt: iso(e.observedAt), expiresAt: iso(e.expiresAt), expired: !active, jurisdiction: e.jurisdiction });
  }
  assertNoAiClaims(documents); // hard guarantee: no AI-suggested content in claim positions

  const mfr = activeEv.find((e) => e.kind === 'manufacturer' && e.provenance !== 'ai_suggested');
  const manufacturer = mfr ? mkField(mfr.value, mfr.provenance, mfr.source, mfr.observedAt, mfr.expiresAt) : null;
  const supplier = i.supplierDisplayName ? mkField(i.supplierDisplayName, 'supplier_provided', 'Fulfilment partner') : null;

  // Listing description is treated as AI-assisted text: labelled ai_suggested and stripped of any safety/compliance claim.
  const summary = guardedField({ kind: 'descriptive', value: p.description, provenance: 'ai_suggested', source: 'Listing description (may be AI-assisted; contains no safety or compliance claims)' });

  const images = i.images.slice(0, 12).map((im) => {
    const u = usageRights(im.license, im.source);
    return { url: im.url, alt: im.alt, provenance: u.provenance, source: im.source === 'admin' ? 'Uploaded by Orvia' : im.source === 'supplier' ? 'Supplier image' : 'Listing image', usageRights: u.rights };
  });

  const band = deliveryBand({ observedDays: i.history.deliveredDays, promised: p.promised });
  const h = i.history;
  const qualityStatus: TrustStatus = h.delivered < 5 ? 'insufficient_data' : h.delivered < 30 ? 'provisional' : 'established';

  const restrictionsFor = [{ country: i.country, restricted: i.restrictions.restricted || !p.marketEnabled, reasons: [...i.restrictions.reasons, ...(p.marketEnabled ? [] : [`Not currently sold in ${i.country}`])], provenance: 'verified' as Provenance }];

  const priceHistory = i.priceSnapshots?.length
    ? { available: true, points: i.priceSnapshots.slice(-60).map((s) => ({ at: s.at.toISOString(), price: s.price, currency: s.currency })), note: 'Recorded price snapshots.', provenance: 'verified' as Provenance }
    : { available: false, points: p.price !== null ? [{ at: i.now.toISOString(), price: p.price, currency: p.currency }] : [], note: 'Price history has not been recorded yet; only today\'s price is shown. Any "compare-at" price is a reference price, not a past selling price.', provenance: 'verified' as Provenance };

  const pass: ProductPassport = {
    generatedAt: i.now.toISOString(),
    country: i.country,
    product: { slug: p.slug, title: p.title, brand: mkField(p.brand, 'supplier_provided', 'Product listing'), lifecycle: mkField(p.state.toLowerCase().replace(/_/g, ' '), 'verified', 'Orvia catalogue') },
    identity: { manufacturer, supplier },
    summary,
    specifications: specs,
    materials,
    dimensions: dims,
    images,
    documents,
    restrictions: restrictionsFor,
    stock: stockFreshness(i.offer, i.now),
    priceHistory,
    delivery: { promised: p.promised, actual: band, provenance: band.basis === 'observed' ? 'verified' : 'supplier_provided' },
    quality: {
      delivered: h.delivered,
      returnRate: h.delivered >= 5 ? round3(h.returns / h.delivered) : null,
      defectRate: h.delivered >= 5 ? round3(h.defects / h.delivered) : null,
      sampleSize: h.delivered, status: qualityStatus, provenance: 'customer_reported',
      note: h.delivered >= 5 ? `Based on ${h.delivered} delivered orders; return reasons are reported by customers.` : 'Not enough delivery history yet to show return or defect rates.',
    },
    risk: { score: i.risk.score, level: i.risk.level, status: i.risk.status, confidence: i.risk.confidence, sampleSize: i.risk.sampleSize, components: i.risk.components, known: i.risk.known, caveats: i.risk.caveats, provenance: 'verified' },
    feedback: {
      ratingAvg: i.reviews.count > 0 ? i.reviews.avg : null, ratingCount: i.reviews.count, verifiedCount: i.reviews.verified, distribution: i.reviews.distribution, provenance: 'customer_reported',
      note: i.reviews.count === 0 ? 'No reviews yet.' : `${i.reviews.verified} of ${i.reviews.count} reviews are from verified purchases.`,
    },
    alternatives: i.alternatives,
  };
  return toCustomerSafe(pass);
}

/* ------------------------------ purchase confidence ------------------------------ */

export interface ConfidenceInputs {
  now: Date;
  country: string;
  quantity: number;
  product: { slug: string; title: string; available: boolean; promised: PromisedWindow | null; shipsFrom: string | null };
  checklist: { key: string; label: string; present: boolean; provenance: Provenance | null }[];
  supplier: SupplierTrustResult | null;
  deliveredDays: number[];
  estimateLabel: string | null;
  returnWindowDays: number;
  pricing: PurchaseConfidenceReport['pricing'];
  restrictions: { restricted: boolean; reasons: string[] };
  risk: ProductRiskResult;
  offerStale: boolean;
}

export function reliabilityLabel(s: SupplierTrustResult | null): string {
  if (!s || s.status === 'insufficient_data' || s.score === null) return 'Not enough delivery history yet';
  if (s.status === 'provisional') return `Early signal ${Math.round(s.score)}/100 (limited history, may change)`;
  return `Established ${Math.round(s.score)}/100`;
}

export function buildConfidenceReport(i: ConfidenceInputs): PurchaseConfidenceReport {
  const total = i.checklist.length || 1;
  const verified = i.checklist.filter((c) => c.present && c.provenance === 'verified').length;
  const supplierProvided = i.checklist.filter((c) => c.present && c.provenance === 'supplier_provided').length;
  const missing = i.checklist.filter((c) => !c.present).map((c) => c.label);
  const band = deliveryBand({ observedDays: i.deliveredDays, promised: i.product.promised });
  const s = i.supplier;

  const uncertainty: string[] = [
    'Delivery dates are estimates, never guarantees.',
    'Tax is an estimate and is finalised at checkout.',
    'Supplier stock and prices can change before your order is placed.',
  ];
  if (!s || s.status === 'insufficient_data') uncertainty.push('We do not yet have enough delivery history for this supplier to rate its reliability.');
  else if (s.status === 'provisional') uncertainty.push('Supplier reliability is provisional: it is based on limited history.');
  if (band.basis === 'promised_only') uncertainty.push('The delivery range is widened because it is not yet confirmed by real deliveries.');
  if (verified === 0) uncertainty.push('None of the product facts have been independently verified; they come from the supplier.');
  if (i.offerStale) uncertainty.push('Supplier stock information is out of date.');

  const limitations: string[] = [];
  if (missing.length) limitations.push(`Missing product information: ${missing.join(', ')}.`);
  if (i.restrictions.restricted) limitations.push(...i.restrictions.reasons);
  if (i.risk.status === 'insufficient_data') limitations.push('Not enough transaction history yet to compute a risk score for this product.');
  if (i.product.shipsFrom && i.product.shipsFrom !== i.country) limitations.push(`Ships from ${i.product.shipsFrom}; cross-border delivery can take longer and may involve customs.`);

  return toCustomerSafe({
    generatedAt: i.now.toISOString(),
    country: i.country,
    quantity: i.quantity,
    product: { slug: i.product.slug, title: i.product.title, available: i.product.available },
    uncertainty,
    infoCompleteness: {
      verifiedShare: round3(verified / total), supplierProvidedShare: round3(supplierProvided / total), missing,
      label: verified === 0 ? 'Supplier-provided information; not independently verified' : `${verified} of ${total} product facts verified`,
    },
    supplierReliability: { status: s?.status ?? 'insufficient_data', score: s?.score ?? null, range: s?.range ?? null, confidence: s?.confidence ?? 0, sampleSize: s?.sampleSize ?? 0, label: reliabilityLabel(s), known: s?.known ?? ['No completed shipments yet'] },
    delivery: { ...band, promised: i.product.promised, estimateLabel: i.estimateLabel, shipsFrom: i.product.shipsFrom },
    returns: { windowDays: i.returnWindowDays, note: `Returns can be requested within ${i.returnWindowDays} days of delivery. Each return is reviewed against the order and the reason given.`, provenance: 'verified' },
    pricing: i.pricing,
    restrictions: i.restrictions,
    knownLimitations: limitations,
  });
}

export { AiClaimError };
