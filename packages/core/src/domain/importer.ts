import { providerFor } from './supplierAccess';
import { usableImages } from './images';
import { syncProductStateForImages } from './imagePipeline';
import { Product, ProductScore, ProductVariant, Supplier, SupplierProduct } from '@orvia/database';
import { scoreOpportunity } from '@orvia/analytics';
import { MOCK_MARKET_SIGNALS } from '@orvia/suppliers';
import type { SupplierProductSummary } from '@orvia/suppliers';
import { convertMinor, DEFAULT_COUNTRIES, slugify } from '@orvia/types';
import type { CountryCode } from '@orvia/types';
import { audit } from '../infra/audit';
import { DomainError, notFound } from '../infra/context';
import type { Actor, Ctx } from '../infra/context';
import { proposeOrExecute, registerExecutor } from './automation';
import { canPublish, categorySlugFor, publishProduct, transitionProduct, uniqueSlug } from './catalog';
import { checkCompliance } from './compliance';
import { raiseException } from './exceptions';
import { syncProductOffers } from './offers';
import { refreshProductMarkets } from './pricing';

export interface ImportResult {
  productId: string;
  slug: string;
  state: string;
  compliance: { status: string; flags: { code: string; severity: string; detail: string }[] };
  contentSource: 'gemini' | 'template';
  markets: { country: string; price?: number; priced: boolean }[];
  publish: { outcome: 'published' | 'proposed' | 'blocked' | 'skipped'; problems?: string[]; decisionId?: string };
  score?: { finalScore: number; action: string };
  notes: string[];
}

/** Market intelligence (demand/trend/competitor prices). Mock data is dev-only; live mode needs a real provider. */
export function marketIntelFor(ctx: Ctx, externalId: string): { demand: number; trend: number; competition: number; video: boolean; competitorPricesUsd: number[] } | null {
  if (ctx.cfg.SUPPLIER_MODE === 'mock' && !ctx.cfg.isProduction) {
    const s = MOCK_MARKET_SIGNALS[externalId];
    return s ? { demand: s.demand, trend: s.trend, competition: s.competition, video: s.video, competitorPricesUsd: s.retail } : null;
  }
  return null; // no market-intel provider configured: scores use neutral priors and admins can enter competitor prices
}

/** Ask the automation layer to publish a gate-passing product (ASSISTED → proposal, AUTOMATIC → publish now). */
export async function proposePublish(ctx: Ctx, pid: string, title: string, pricedMarkets: number): Promise<ImportResult['publish']> {
  const out = await proposeOrExecute(ctx, {
    automationKey: 'auto_publishing', agent: 'ContentAgent', kind: 'publish_product', resource: 'product', resourceId: pid,
    summary: `Publish "${title}" (compliance passed, ${pricedMarkets} market(s) priced)`, payload: { productId: pid }, confidence: 0.85, dedupeKey: `publish:${pid}`,
  });
  return out.status === 'executed' ? { outcome: 'published' } : out.status === 'proposed' ? { outcome: 'proposed', decisionId: out.decisionId } : { outcome: 'skipped' };
}

function sourceFor(sp: SupplierProductSummary) {
  return {
    title: sp.title,
    description: sp.description,
    category: sp.category,
    attributes: sp.attributes,
    tags: sp.tags,
    safetyStandards: sp.safetyInfo?.standards ?? [],
    ageRange: sp.safetyInfo?.ageRange,
    variants: sp.variants.map((v) => v.label),
  };
}

/**
 * Import a supplier product: fetch -> AI content -> compliance -> offers & pricing -> score -> publish gate.
 * Idempotent: re-importing an already-linked supplier product returns the existing product.
 */
export async function importProduct(ctx: Ctx, input: { supplierId: string; externalId: string }, actor: Actor): Promise<ImportResult> {
  const supplier = await Supplier.findById(input.supplierId);
  if (!supplier) throw notFound('Supplier');
  const provider = await providerFor(ctx, supplier);
  const existing = await SupplierProduct.findOne({ supplierId: supplier._id, externalId: input.externalId });
  if (existing?.productId) {
    const p = await Product.findById(existing.productId).lean();
    if (p) {
      return { productId: String(p._id), slug: p.slug, state: p.state, compliance: { status: p.compliance?.status ?? 'pending', flags: [] }, contentSource: 'template', markets: [], publish: { outcome: 'skipped' }, notes: ['Already imported'] };
    }
  }
  const sp = await provider.getProduct(input.externalId);
  if (!sp) throw new DomainError('Supplier product not found', 'NOT_FOUND', 404);
  // suppliers without variant lists sell a single standard variant (its id is the product id)
  if (!sp.variants.length) sp.variants = [{ sku: sp.externalId, label: 'Standard', options: {} }];
  const notes: string[] = [];

  const aiContent = await ctx.ai.productContent(sourceFor(sp));
  const content = aiContent.data;
  notes.push(...aiContent.notes);

  const { category, topCategory } = categorySlugFor(sp.category);
  const compliance = checkCompliance({
    title: sp.title, description: sp.description, category: sp.category, topCategory, tags: sp.tags, attributes: sp.attributes, safetyInfo: sp.safetyInfo,
    marketingText: JSON.stringify([content.description, content.bullets, content.social, content.adCopy]),
  });

  const slug = await uniqueSlug(sp.title);
  const intel = marketIntelFor(ctx, sp.externalId);
  const ops = await ctx.settings.get('ops');
  const competitorPrices: Record<string, number[]> = {};
  if (intel) {
    for (const c of Object.values(DEFAULT_COUNTRIES)) competitorPrices[c.code] = intel.competitorPricesUsd.map((u) => convertMinor(u, 'USD', c.currency, ops.fx));
  }
  const product = await Product.create({
    slug,
    sku: `ORV-${slugify(sp.externalId).toUpperCase().slice(0, 24)}-${Date.now().toString(36).toUpperCase()}`,
    title: sp.title,
    description: content.description,
    bullets: content.bullets,
    features: content.features,
    benefits: content.benefits,
    faqs: content.faqs,
    seo: { title: content.seoTitle, metaDescription: content.metaDescription, keywords: content.keywords },
    social: { instagram: content.social.instagram, tiktokScript: content.social.tiktokScript, facebookAd: content.social.facebookAd },
    images: usableImages(sp.images).map((url, i) => ({ url, alt: `${sp.title} — image ${i + 1}`, source: 'supplier', license: 'unknown' })),
    imageStatus: usableImages(sp.images).length ? 'READY' : 'MISSING',
    videos: sp.videos.map((url) => ({ url, licensed: true })),
    category,
    topCategory,
    tags: sp.tags,
    attributes: sp.attributes,
    state: 'DISCOVERED',
    stateHistory: [{ state: 'DISCOVERED', at: new Date(), by: actor.id, reason: `imported from ${supplier.code}` }],
    compliance: { status: compliance.status, flags: compliance.flags.map((f) => f.code), checkedAt: new Date(), safetyInfo: sp.safetyInfo ? { standards: sp.safetyInfo.standards, ageRange: sp.safetyInfo.ageRange } : undefined },
    intel: intel ? { source: 'mock', demand: intel.demand, trend: intel.trend, competition: intel.competition, video: intel.video, competitorPrices, cpcUsd: 0.8 } : undefined,
    stats: { trendScore: intel?.trend ?? 0 },
    isDemo: ctx.cfg.APP_ENV !== 'production' && supplier.isDemo,
  });
  const pid = String(product._id);

  await SupplierProduct.updateOne(
    { supplierId: supplier._id, externalId: sp.externalId },
    {
      $set: {
        productId: product._id, title: sp.title, description: sp.description, images: sp.images, videos: sp.videos, category: sp.category,
        attributes: sp.attributes, safetyInfo: sp.safetyInfo, variants: sp.variants, cost: sp.baseCostUsd, currency: 'USD', lastSyncAt: ctx.now(),
        importStatus: compliance.status === 'failed' ? 'rejected' : compliance.status === 'review' ? 'review' : 'imported',
      },
    },
    { upsert: true },
  );
  await ProductVariant.insertMany(
    sp.variants.map((v) => ({ productId: product._id, sku: `${slug}-${slugify(v.label)}`.toUpperCase().slice(0, 60), options: v.options, label: v.label, supplierSku: v.sku, image: usableImages([v.image, ...sp.images])[0] })),
    { ordered: false },
  ).catch(() => undefined);
  await transitionProduct(ctx, pid, 'ANALYZING', actor, 'compliance and economics analysis');
  await audit(ctx, actor, { action: 'product.imported', resource: 'product', resourceId: pid, newValue: { supplier: supplier.code, externalId: sp.externalId, contentSource: aiContent.source }, aiSummary: `Imported ${sp.title}; compliance ${compliance.status}` });

  // Hard reject on compliance failure: banned, not sellable, visible for audit.
  if (compliance.status === 'failed') {
    await transitionProduct(ctx, pid, 'BANNED', actor, `compliance failed: ${compliance.flags.map((f) => f.code).join(', ')}`);
    return { productId: pid, slug, state: 'BANNED', compliance, contentSource: aiContent.source, markets: [], publish: { outcome: 'blocked', problems: compliance.flags.map((f) => f.detail) }, notes };
  }

  // Host Orvia copies of the supplier photos (SSRF-safe download, validation, resize); never hot-link suppliers in production.
  if (sp.images.some((u) => /^https?:\/\//i.test(u))) await ctx.queue.enqueue('image_ingestion', { productId: pid }, { dedupeKey: `images:${pid}` });

  // Offers, markets, pricing.
  await syncProductOffers(ctx, pid);
  const refreshed = await refreshProductMarkets(ctx, pid);
  const score = await scoreProduct(ctx, pid);
  await transitionProduct(ctx, pid, 'APPROVED', actor, `analysis complete, opportunity ${score?.finalScore ?? 'n/a'}`);
  await transitionProduct(ctx, pid, 'DRAFT', actor, 'draft listing created');

  let publish: ImportResult['publish'];
  const imageGate = await Product.findById(pid).select('imageStatus').lean();
  if (imageGate?.imageStatus !== 'READY') {
    await syncProductStateForImages(ctx, pid, actor);
    await raiseException(ctx, {
      kind: 'MISSING_IMAGE', priority: 'medium', productId: pid, issue: `${sp.title} has no usable product image yet`,
      aiRecommendation: 'Wait for supplier image ingestion, or upload photos in Admin → Product → Images.', suggestedAction: 'Upload images', actionCode: 'review_product', dedupeKey: `noimage:${pid}`,
    });
  }
  if (compliance.status === 'review') {
    await raiseException(ctx, {
      kind: compliance.flags.some((f) => f.code.startsWith('KIDS') || f.code === 'INFANT_PRODUCT' || f.code === 'SMALL_PARTS') ? 'SAFETY' : 'COMPLIANCE',
      priority: 'medium', issue: `${sp.title} needs compliance review: ${compliance.flags.map((f) => f.detail).join('; ')}`, productId: pid,
      aiRecommendation: 'Obtain supplier safety documentation or reject the product.', suggestedAction: 'Review product and attach safety information, or archive', actionCode: 'review_product', dedupeKey: `compliance:${pid}`,
    });
    publish = { outcome: 'blocked', problems: compliance.flags.map((f) => f.detail) };
  } else {
    const gate = await canPublish(ctx, pid);
    if (!gate.ok) publish = { outcome: 'blocked', problems: gate.problems };
    else {
      publish = await proposePublish(ctx, pid, sp.title, refreshed.filter((m) => m.priced).length);
    }
  }
  const final = await Product.findById(pid).lean();
  return {
    productId: pid, slug, state: final?.state ?? 'DRAFT', compliance, contentSource: aiContent.source,
    markets: refreshed.map((m) => ({ country: m.country, price: m.price, priced: m.priced })), publish, score: score ? { finalScore: score.finalScore, action: score.action } : undefined, notes,
  };
}

/** Compute and persist a ProductScore from real economics, market intel, supplier quality and compliance. */
export async function scoreProduct(ctx: Ctx, productId: string) {
  const product = await Product.findById(productId).lean();
  if (!product) throw notFound('Product');
  const intel = (product.intel ?? {}) as { demand?: number; trend?: number; competition?: number; video?: boolean };
  const markets = product.markets.filter((m) => m.price > 0);
  const compliance = checkCompliance({ title: product.title, description: product.description ?? '', category: product.category ?? '', topCategory: product.topCategory ?? '', tags: product.tags, safetyInfo: product.compliance?.safetyInfo, attributes: product.attributes ? Object.fromEntries(Object.entries(product.attributes as unknown as Record<string, string>)) : {} });
  const best = markets.sort((a, b) => b.expectedMargin - a.expectedMargin)[0];
  const margin = best ? best.expectedMargin : 0;
  const bestPlanRows = best ? (await import('./offers')).compareSuppliers(ctx, productId, best.country as CountryCode) : null;
  const cmp = bestPlanRows ? await bestPlanRows : null;
  const top = cmp?.rows.find((r) => r.eligible);
  const analysis = await ctx.ai.analyzeProduct({ title: product.title, description: product.description ?? '', category: product.category ?? '', attributes: product.attributes ? Object.fromEntries(Object.entries(product.attributes as unknown as Record<string, string>)) : {}, tags: product.tags, safetyStandards: product.compliance?.safetyInfo?.standards ?? [], variants: [] });
  const clamp = (n: number) => Math.max(0, Math.min(100, n));
  const s = scoreOpportunity({
    demand: intel.demand ?? 50,
    trendVelocity: intel.trend ?? 50,
    competition: intel.competition ?? 50,
    supplierCost: top && best ? clamp((1 - top.productCost / Math.max(1, best.price)) * 120) : 40,
    shipping: top ? clamp(100 - (top.maxDays - 4) * 5) : 40,
    profitMargin: clamp((margin / 0.5) * 100),
    videoPotential: intel.video ? Math.max(80, analysis.data.videoPotential) : analysis.data.videoPotential,
    repeatPurchase: analysis.data.repeatPurchasePotential,
    supplierReliability: top?.reliability ?? 40,
    compliance: compliance.score,
  });
  await ProductScore.create({ productId, components: s.components, finalScore: s.finalScore, action: s.action, reasons: s.reasons, source: analysis.source });
  await Product.updateOne({ _id: productId }, { $set: { opportunity: { finalScore: s.finalScore, action: s.action, computedAt: new Date() } } });
  return s;
}

registerExecutor('publish_product', async (ctx, payload, actor) => {
  await publishProduct(ctx, String(payload['productId']), actor, 'approved publish');
  return { published: true };
});
