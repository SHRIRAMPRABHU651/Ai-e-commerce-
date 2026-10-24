import { Product, SupplierProduct } from '@orvia/database';
import { usableImages } from './images';
import { computePrice, paymentFeeModelFor, productEconomics, evaluatePrice } from '@orvia/analytics';
import type { CpaSource, PricingResult, PricingStrategy, RankedOffer, ScenarioReport } from '@orvia/analytics';
import { convertMinor, SELLABLE_STATES } from '@orvia/types';
import type { CountryCode, Currency } from '@orvia/types';
import { audit } from '../infra/audit';
import { getCountry, getCountryConfigs } from '../infra/countries';
import { aiActor, DomainError, notFound } from '../infra/context';
import type { Actor, Ctx } from '../infra/context';
import { proposeOrExecute, registerExecutor } from './automation';
import { compareSuppliers } from './offers';
import type { SupplierComparison } from './offers';
import { raiseException } from './exceptions';
import { evaluateMarket, resolveCpa } from './economics';

export interface MarketPlan {
  country: CountryCode;
  currency: Currency;
  comparison: SupplierComparison;
  best: RankedOffer | null;
  pricing: PricingResult | null;
  strategy: PricingStrategy;
  competitorPrices: number[];
  compareAtPrice: number;
  economics: ReturnType<typeof productEconomics> | null;
  /** Provenance of the acquisition-cost figure used. `assumed` means no campaign data — an ESTIMATE. */
  cpa: { perOrder: number; source: CpaSource; sampleSize: number };
  scenarios: ScenarioReport | null;
}

/**
 * The provisional (pre-supplier-ranking) price is the cost-plus multiple implied by the configured margin
 * structure, not a magic number: landed ÷ (1 − target margin − assumed ad share − payment % − base refund).
 * Bounded so a pathological configuration cannot produce an absurd or infinite markup.
 */
export function provisionalMarkup(p: { targetMarginPct: number; assumedAdCostPct: number; paymentPct: number; baseRefundRate: number }): number {
  const keep = 1 - p.targetMarginPct - p.assumedAdCostPct - p.paymentPct - p.baseRefundRate;
  return Math.min(10, 1 / Math.max(0.1, keep));
}

export async function planMarket(ctx: Ctx, productId: string, country: CountryCode): Promise<MarketPlan> {
  const product = await Product.findById(productId).lean();
  if (!product) throw notFound('Product');
  const cfg = await getCountry(country);
  const pricing = await ctx.settings.get('pricing');
  const ops = await ctx.settings.get('ops');
  const currency = cfg.currency;
  const intel = (product.intel ?? {}) as { competitorPrices?: Partial<Record<CountryCode, number[]>>; demand?: number; cpcUsd?: number };
  const competitorPrices = (intel.competitorPrices?.[country] ?? []).filter((n) => n > 0);
  const strategy = (product.pricingConfig?.strategy ?? pricing.defaultStrategy) as PricingStrategy;

  const guardrails = {
    minMarginPct: pricing.minMarginPct,
    maxDiscountPct: pricing.maxDiscountPct,
    minSellingPrice: pricing.minSellingPrice[currency],
    targetProfitPerOrder: pricing.targetProfitPerOrder[currency],
    targetRoas: pricing.targetRoas,
  };
  const empty = (comparison: SupplierComparison): MarketPlan => ({ country, currency, comparison, best: null, pricing: null, strategy, competitorPrices, compareAtPrice: 0, economics: null, cpa: { perOrder: 0, source: 'assumed', sampleSize: 0 }, scenarios: null });

  // 1. provisional price from the cheapest in-stock offer so supplier ranking happens at a realistic price
  const rough = await compareSuppliers(ctx, productId, country, { sellingPrice: 1_000_000 });
  const cheapest = rough.rows.filter((r) => r.eligible).sort((a, b) => a.landedCost - b.landedCost)[0];
  if (!cheapest) return empty(rough);
  const baseInput = {
    currency,
    paymentFee: paymentFeeModelFor(country),
    guardrails,
    targetMarginPct: product.pricingConfig?.targetMarginPct ?? pricing.targetMarginPct,
    competitorPrices,
    demandIndex: Math.min(1, Math.max(0, (product.stats?.trendScore || intel.demand || 50) / 100)),
    conversionRate: product.stats?.conversionRate || undefined,
    cpc: intel.cpcUsd ? convertMinor(Math.round(intel.cpcUsd * 100), 'USD', currency, ops.fx) : undefined,
    currentPrice: product.markets.find((m) => m.country === country)?.price || undefined,
  };
  const provisional = computePrice({
    ...baseInput,
    strategy: 'target_margin',
    landedCost: cheapest.landedCost,
    refundRate: cheapest.refundRate,
    adCostPerOrder: Math.round(cheapest.landedCost * provisionalMarkup({ targetMarginPct: baseInput.targetMarginPct, assumedAdCostPct: pricing.assumedAdCostPct, paymentPct: baseInput.paymentFee.pct, baseRefundRate: pricing.baseRefundRate }) * pricing.assumedAdCostPct),
  });

  // 2. rank all offers at that price and take the best expected profit + customer experience
  const resolved = await resolveCpa(ctx, { productId, category: product.category ?? undefined, country, currency });
  const comparison = await compareSuppliers(ctx, productId, country, { sellingPrice: provisional.price, adCostPerOrder: resolved.perOrder ?? undefined });
  const best = comparison.rows.find((r) => r.eligible) ?? null;
  if (!best) return empty(comparison);

  // 3. final price using the chosen supplier's real landed cost, refund risk and ad cost
  const adCostPerOrder = resolved.perOrder ?? Math.round(provisional.price * pricing.assumedAdCostPct);
  const result = computePrice({ ...baseInput, strategy, landedCost: best.landedCost, refundRate: best.refundRate, adCostPerOrder });
  const sortedComps = [...competitorPrices].sort((a, b) => a - b);
  const medianComp = sortedComps.length ? sortedComps[Math.floor(sortedComps.length / 2)]! : 0;
  const compareAt = medianComp > result.price * 1.05 ? medianComp : 0;
  const economics = productEconomics({
    supplierCost: best.productCost,
    shippingCost: best.shippingCost,
    duties: best.duties,
    fulfillmentFee: best.fulfillmentFee,
    sellingPrice: result.price,
    paymentFee: paymentFeeModelFor(country),
    refundRate: best.refundRate,
    adCostPerOrder,
    conversionRate: product.stats?.conversionRate || undefined,
  });
  const view = await evaluateMarket(ctx, { country, price: result.price, landedCost: best.landedCost, cpa: resolved.perOrder ?? undefined, cpaSource: resolved.source, cpaSampleSize: resolved.sampleSize, refundRate: best.refundRate, refundSource: best.refundSource, refundSampleSize: best.refundSampleSize });
  return { country, currency, comparison, best, pricing: result, strategy, competitorPrices, compareAtPrice: compareAt, economics, cpa: { perOrder: adCostPerOrder, source: resolved.source, sampleSize: resolved.sampleSize }, scenarios: view.scenarios };
}

/** Persist where each cost figure came from so the publish gate and admin UI can tell measured from estimated. */
function applyProvenance(m: { cpa: number; cpaSource: string; cpaSampleSize: number; refundRate: number; refundSource: string; refundSampleSize: number }, plan: MarketPlan): void {
  m.cpa = plan.cpa.perOrder;
  m.cpaSource = plan.cpa.source;
  m.cpaSampleSize = plan.cpa.sampleSize;
  m.refundRate = plan.best?.refundRate ?? 0;
  m.refundSource = plan.best?.refundSource ?? 'estimated';
  m.refundSampleSize = plan.best?.refundSampleSize ?? 0;
}

export interface RefreshResult {
  country: CountryCode;
  priced: boolean;
  price?: number;
  stock?: number;
}

/**
 * Refresh market metadata (best supplier, landed cost, stock, ETA) from stored offers.
 * Sets the selling price only when the market has none yet — later changes go through the pricing agent.
 */
export async function refreshProductMarkets(ctx: Ctx, productId: string, opts: { forcePrice?: boolean } = {}): Promise<RefreshResult[]> {
  const configs = Object.values(await getCountryConfigs()).filter((c) => c.enabled);
  const out: RefreshResult[] = [];
  for (const cfg of configs) {
    const plan = await planMarket(ctx, productId, cfg.code);
    const product = await Product.findById(productId);
    if (!product) throw notFound('Product');
    let m = product.markets.find((x) => x.country === cfg.code);
    if (!plan.best || !plan.pricing) {
      if (m) {
        m.stock = 0;
        await product.save();
      }
      out.push({ country: cfg.code, priced: false });
      continue;
    }
    if (!m) {
      product.markets.push({ country: cfg.code, enabled: true, currency: cfg.currency } as never);
      m = product.markets[product.markets.length - 1]!;
    }
    const hadPrice = m.price > 0;
    if (!hadPrice || opts.forcePrice) {
      m.price = plan.pricing.price;
      m.compareAtPrice = plan.compareAtPrice;
    }
    m.currency = cfg.currency;
    m.pricingStrategy = plan.strategy;
    m.bestSupplierId = plan.best.supplierId as never;
    m.landedCost = plan.best.landedCost;
    applyProvenance(m, plan);
    m.shipsFrom = plan.best.warehouseCountry;
    m.minDays = plan.best.minDays;
    m.maxDays = plan.best.maxDays;
    m.stock = plan.best.stock;
    const link = await SupplierProduct.findOne({ productId, supplierId: plan.best.supplierId }).select('images').lean();
    m.images = usableImages(link?.images ?? []) as never;
    const cur = evaluatePrice(
      {
        strategy: plan.strategy, currency: cfg.currency, landedCost: plan.best.landedCost, paymentFee: paymentFeeModelFor(cfg.code), refundRate: plan.best.refundRate,
        adCostPerOrder: plan.economics?.estimated_ad_cost ?? 0,
        guardrails: { minMarginPct: 0, maxDiscountPct: 1, minSellingPrice: 0, targetProfitPerOrder: 0 },
      },
      m.price,
    );
    m.expectedProfit = cur.profit;
    m.expectedMargin = Math.round(cur.margin * 10_000) / 10_000;
    await product.save();
    out.push({ country: cfg.code, priced: true, price: m.price, stock: m.stock });
  }
  return out;
}

/** Pricing agent: propose/apply price updates; always protects the minimum margin. */
export async function runPricingAgent(ctx: Ctx, limit = 200): Promise<{ examined: number; changes: number; proposals: number; negativeMargin: number }> {
  const pricing = await ctx.settings.get('pricing');
  const products = await Product.find({ state: { $in: SELLABLE_STATES } }).select('_id slug title markets').limit(limit).lean();
  let changes = 0, proposals = 0, negativeMargin = 0;
  for (const p of products) {
    for (const m of p.markets) {
      if (!m.enabled || !m.price) continue;
      const plan = await planMarket(ctx, String(p._id), m.country as CountryCode);
      if (!plan.pricing || !plan.best) continue;
      const cur = evaluatePrice(
        { strategy: plan.strategy, currency: plan.currency, landedCost: plan.best.landedCost, paymentFee: paymentFeeModelFor(m.country), refundRate: plan.best.refundRate, adCostPerOrder: plan.economics?.estimated_ad_cost ?? 0, guardrails: { minMarginPct: 0, maxDiscountPct: 1, minSellingPrice: 0, targetProfitPerOrder: 0 } },
        m.price,
      );
      if (cur.margin < 0) {
        negativeMargin++;
        await raiseException(ctx, {
          kind: 'NEGATIVE_MARGIN', priority: 'high',
          issue: `${p.title} is selling at a negative contribution margin in ${m.country} (${(cur.margin * 100).toFixed(1)}%)`,
          productId: String(p._id),
          aiRecommendation: `Raise price to ${plan.pricing.price} or switch supplier.`, suggestedAction: 'Approve price change or pause product', actionCode: 'review_product',
          dedupeKey: `negmargin:${p._id}:${m.country}`,
        });
      }
      const delta = (plan.pricing.price - m.price) / m.price;
      const belowMin = cur.margin < pricing.minMarginPct;
      if (Math.abs(delta) < pricing.minPriceChangePct && !belowMin) continue;
      const out = await proposeOrExecute(ctx, {
        automationKey: 'dynamic_pricing', agent: 'PricingAgent', kind: 'price_change', resource: 'product', resourceId: String(p._id),
        summary: `${p.title} (${m.country}): ${m.price} → ${plan.pricing.price} — ${plan.pricing.explanation}`,
        payload: { productId: String(p._id), country: m.country, oldPrice: m.price, newPrice: plan.pricing.price, expectedMargin: plan.pricing.contributionMargin, reason: plan.pricing.explanation },
        confidence: plan.competitorPrices.length ? 0.8 : 0.6,
        dedupeKey: `price:${p._id}:${m.country}`,
      });
      if (out.status === 'executed') changes++;
      if (out.status === 'proposed') proposals++;
    }
  }
  return { examined: products.length, changes, proposals, negativeMargin };
}

registerExecutor('price_change', async (ctx, payload, actor) => {
  const { productId, country, oldPrice, newPrice, reason } = payload as { productId: string; country: CountryCode; oldPrice: number; newPrice: number; reason: string };
  // Re-validate at execution time: the world may have moved since the proposal.
  const plan = await planMarket(ctx, productId, country);
  if (!plan.pricing) throw new DomainError('No eligible supplier at execution time; price unchanged', 'NO_ELIGIBLE_SUPPLIER', 409);
  const floor = plan.pricing.floorPrice;
  const final = Math.max(newPrice, floor);
  const product = await Product.findById(productId);
  if (!product) throw notFound('Product');
  const m = product.markets.find((x) => x.country === country);
  if (!m) throw notFound('Market');
  const previous = m.price;
  m.price = final;
  m.compareAtPrice = plan.compareAtPrice;
  m.landedCost = plan.best!.landedCost;
  applyProvenance(m, plan);
  const ev = evaluatePrice(
    { strategy: plan.strategy, currency: plan.currency, landedCost: plan.best!.landedCost, paymentFee: paymentFeeModelFor(country), refundRate: plan.best!.refundRate, adCostPerOrder: plan.economics?.estimated_ad_cost ?? 0, guardrails: { minMarginPct: 0, maxDiscountPct: 1, minSellingPrice: 0, targetProfitPerOrder: 0 } },
    final,
  );
  m.expectedProfit = ev.profit;
  m.expectedMargin = Math.round(ev.margin * 10_000) / 10_000;
  await product.save();
  await audit(ctx, actor.type === 'ai' ? actor : aiActor('PricingAgent'), {
    action: 'price.changed', resource: 'product', resourceId: productId,
    previousValue: { country, price: previous }, newValue: { country, price: final },
    reason: reason ?? 'pricing agent', aiSummary: `Old price ${oldPrice} → new price ${final}. Expected contribution margin ${(ev.margin * 100).toFixed(1)}%.`,
  });
  return { country, previous, price: final, margin: ev.margin };
});

export async function setManualPrice(ctx: Ctx, productId: string, country: CountryCode, price: number, actor: Actor): Promise<void> {
  const plan = await planMarket(ctx, productId, country);
  if (!plan.pricing) throw new DomainError('No eligible supplier: cannot validate margin', 'NO_ELIGIBLE_SUPPLIER', 409);
  if (price < plan.pricing.floorPrice) throw new DomainError(`Price is below the margin floor (${plan.pricing.floorPrice})`, 'BELOW_FLOOR', 422);
  const product = await Product.findById(productId);
  if (!product) throw notFound('Product');
  const m = product.markets.find((x) => x.country === country);
  if (!m) throw notFound('Market');
  const prev = m.price;
  m.price = price;
  await product.save();
  await audit(ctx, actor, { action: 'price.manual', resource: 'product', resourceId: productId, previousValue: prev, newValue: price, reason: 'manual price update' });
}
