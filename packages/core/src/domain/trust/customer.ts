/** Customer-facing trust services: Digital Product Passport, Purchase Confidence report, Fair Deal ranking. */
import { Product, Supplier, SupplierOffer, TrustEvidence } from '@orvia/database';
import type { FairDealOfferInput, FairDealResult, FairDealWeights, ProductPassport, PurchaseConfidenceReport } from '@orvia/types';
import { estimateDelivery, orderTotals, pickShipping } from '@orvia/shipping';
import { getCountry } from '../../infra/countries';
import { DomainError, notFound } from '../../infra/context';
import type { Ctx } from '../../infra/context';
import { isSellable } from '../catalog';
import { similar } from '../recommendations';
import { completenessOf } from './checklist';
import { deliveryBand } from './delivery';
import { rankOffersByFairValue } from './fairDeal';
import { buildConfidenceReport, buildPassport, STOCK_STALE_HOURS } from './passport';
import { findLeaks } from './guard';
import { gatherProduct } from './service';
import type { ProductContext } from './service';

type Lean = Parameters<typeof gatherProduct>[1];

async function loadSellable(slug: string): Promise<Lean> {
  const p = (await Product.findOne({ slug }).lean()) as unknown as Lean | null;
  if (!p || !isSellable(p.state)) throw new DomainError('Product not found', 'NOT_FOUND', 404);
  return p;
}

const newestStamp = (g: ProductContext): Date | null => {
  const stamps = g.offers.map((o) => o.confirmedAt ?? o.syncedAt).filter((d): d is Date => !!d);
  return stamps.length ? new Date(Math.max(...stamps.map((d) => d.getTime()))) : null;
};

const promisedOf = (m?: { minDays?: number; maxDays?: number }) => (m?.minDays && m.maxDays ? { minDays: m.minDays, maxDays: m.maxDays } : null);

export async function getProductPassport(ctx: Ctx, slug: string, country: string): Promise<ProductPassport> {
  const p = await loadSellable(slug);
  const g = await gatherProduct(ctx, p, country);
  const m = p.markets.find((x) => x.country === country && x.enabled);
  const organic = (p.organic?.evidence ?? []).map((o) => ({ claim: o.claim, verified: !!o.verified, certUrl: o.certUrl, sourceUrl: o.sourceUrl, observedAt: o.observedAt, expiresAt: o.expiresAt, type: o.type }));
  const alt = await similar(String(p._id), country as never, 4);
  const stamp = newestStamp(g);
  const passport = buildPassport({
    now: ctx.now(), country,
    product: {
      slug: p.slug, title: p.title, brand: p.brand ?? 'Orvia', description: p.description ?? '', state: p.state, attributes: p.attributes ?? {},
      safetyStandards: p.compliance?.safetyInfo?.standards ?? [], safetyAgeRange: p.compliance?.safetyInfo?.ageRange, certificateUrl: p.compliance?.safetyInfo?.certificateUrl, organic,
      marketEnabled: !!m, price: m?.price ?? null, currency: m?.currency ?? '', compareAtPrice: m?.compareAtPrice ?? null, promised: promisedOf(m), shipsFrom: m?.shipsFrom ?? null,
    },
    evidence: g.evidence, supplierDisplayName: g.serving?.name ?? null, images: g.images,
    offer: g.offers.length ? { newestSyncAt: stamp, manual: g.serving?.offer?.source === 'manual', available: !!g.serving?.offer } : null,
    history: g.hist.history, risk: g.risk, reviews: g.hist.reviewSummary,
    alternatives: alt.slice(0, 4).map((a) => ({ slug: a.slug, title: a.title, price: a.price, currency: a.currency, image: a.images[0]?.card ?? a.images[0]?.url ?? null })),
    restrictions: g.restrictions,
  });
  const leaks = findLeaks(passport, [...g.suppliers.map((s) => s.id), ...g.offers.map((o) => String(o.supplierId))]);
  if (leaks.length) { ctx.log.error({ leaks }, 'trust passport leak guard tripped'); throw new DomainError('Passport unavailable', 'INTERNAL', 500); }
  return passport;
}

export async function getPurchaseConfidence(ctx: Ctx, slug: string, country: string, quantity: number, region?: string): Promise<PurchaseConfidenceReport> {
  const p = await loadSellable(slug);
  const g = await gatherProduct(ctx, p, country);
  const cfg = await getCountry(country as never);
  const m = p.markets.find((x) => x.country === country && x.enabled);
  const promised = promisedOf(m);
  const band = deliveryBand({ observedDays: g.hist.history.deliveredDays, promised });
  const estimateLabel = band.minDays !== null && band.maxDays !== null ? estimateDelivery(band.minDays, band.maxDays, cfg.locale, ctx.now()).label : null;

  let pricing: PurchaseConfidenceReport['pricing'] = null;
  if (m && m.price > 0) {
    const subtotal = m.price * quantity;
    const ship = pickShipping(cfg, 'standard', subtotal);
    const t = orderTotals(cfg, region ?? '', subtotal, 0, ship.charge);
    pricing = {
      currency: m.currency ?? cfg.currency, unitPrice: m.price, subtotal, shipping: ship.charge, tax: t.tax, total: t.total, taxIsEstimate: true, taxInclusive: t.taxInclusive,
      importChargesNote: m.shipsFrom && m.shipsFrom !== country ? `Ships from ${m.shipsFrom}. Import duties or customs charges may apply and are not included in this total.` : null,
    };
  }
  const stamp = newestStamp(g);
  const stale = !stamp || (ctx.now().getTime() - stamp.getTime()) / 3_600_000 > STOCK_STALE_HOURS;
  const supplier = g.serving ? (g.suppliers.find((s) => s.name === g.serving?.name)?.trust ?? null) : null;
  const available = !!m && m.price > 0 && (m.stock ?? 0) > 0;
  const report = buildConfidenceReport({
    now: ctx.now(), country, quantity, product: { slug: p.slug, title: p.title, available, promised, shipsFrom: m?.shipsFrom ?? null },
    checklist: g.checklist, supplier, deliveredDays: g.hist.history.deliveredDays, estimateLabel, returnWindowDays: cfg.returnWindowDays, pricing, restrictions: g.restrictions, risk: g.risk, offerStale: stale,
  });
  const leaks = findLeaks(report, [...g.suppliers.map((s) => s.id)]);
  if (leaks.length) { ctx.log.error({ leaks }, 'trust confidence leak guard tripped'); throw new DomainError('Report unavailable', 'INTERNAL', 500); }
  return report;
}

/**
 * Fair Deal for one product across its supplier offers for a destination.
 * priceMode 'landed_cost' (default, staff/internal) compares what each offer costs Orvia to deliver;
 * 'customer' uses the customer's delivered price, which is identical across offers, so the ranking is then driven by quality.
 * Never swaps products: all offers are for `productId`. Substitution requires explicit customer consent upstream.
 */
export async function fairDealForProduct(ctx: Ctx, productId: string, country: string, quantity: number, opts: { weights?: Partial<FairDealWeights>; priceMode?: 'landed_cost' | 'customer'; region?: string } = {}): Promise<FairDealResult> {
  const p = (await Product.findById(productId).lean()) as unknown as Lean | null;
  if (!p) throw notFound('Product');
  const g = await gatherProduct(ctx, p, country);
  const cfg = await getCountry(country as never);
  const m = p.markets.find((x) => x.country === country && x.enabled);
  const offers = (await SupplierOffer.find({ productId, destination: country }).limit(40).lean());
  const sups = new Map((await Supplier.find({ _id: { $in: offers.map((o) => o.supplierId) } }).select('name returnPolicyDays active').lean()).map((s) => [String(s._id), s]));
  const warranty = await TrustEvidence.findOne({ subject: 'product', subjectId: productId, key: 'warranty_months', supersededAt: { $exists: false } }).lean();
  const warrantyMonths = warranty && Number.isFinite(Number(warranty.value)) ? Math.max(0, Math.round(Number(warranty.value))) : null;
  const completeness = completenessOf(g.checklist);
  const mode = opts.priceMode ?? 'landed_cost';

  let customerTotal: number | null = null;
  if (m && m.price > 0) {
    const subtotal = m.price * quantity;
    customerTotal = orderTotals(cfg, opts.region ?? '', subtotal, 0, pickShipping(cfg, 'standard', subtotal).charge).total;
  }
  const inputs: FairDealOfferInput[] = offers.map((o) => {
    const sid = String(o.supplierId);
    const s = sups.get(sid);
    const trust = g.suppliers.find((x) => x.id === sid)?.trust;
    const band = deliveryBand({ observedDays: g.hist.history.deliveredDays, promised: { minDays: o.minDays ?? 0, maxDays: o.maxDays ?? 0 } });
    return {
      offerId: String(o._id), productId, supplierRef: sid, supplierDisplayName: s?.name ?? 'Supplier',
      available: !!s && s.active !== false && o.available !== false && (o.stock ?? 0) >= quantity,
      totalDeliveredPrice: mode === 'customer' ? (customerTotal ?? 0) : ((o.productCost ?? 0) + (o.shippingCost ?? 0) + (o.fulfillmentFee ?? 0)) * quantity,
      currency: mode === 'customer' ? (m?.currency ?? cfg.currency) : o.currency,
      evidenceCompleteness: completeness,
      supplierTrust: trust ? { score: trust.score, status: trust.status, confidence: trust.confidence } : null,
      delivery: band.minDays !== null && band.maxDays !== null ? { minDays: band.minDays, maxDays: band.maxDays, confidence: band.confidence, basis: band.basis } : null,
      returnWindowDays: s?.returnPolicyDays ?? null,
      warrantyMonths,
    };
  });
  return rankOffersByFairValue(inputs, { weights: opts.weights, requestedProductId: productId });
}
