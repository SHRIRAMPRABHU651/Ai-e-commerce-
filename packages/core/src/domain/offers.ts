import { providerFor, servesCountry } from './supplierAccess';
import { Product, Supplier, SupplierOffer, SupplierProduct } from '@orvia/database';
import { fetchLiveOffer } from '@orvia/suppliers';
import type { LiveOffer } from '@orvia/suppliers';
import { rankSupplierOffers, recommendSupplier, paymentFeeModelFor } from '@orvia/analytics';
import type { RankableOffer, RankedOffer } from '@orvia/analytics';
import { metrics } from '@orvia/config';
import { convertMinor } from '@orvia/types';
import type { CountryCode, Currency } from '@orvia/types';
import { getCountry, getCountryConfigs } from '../infra/countries';
import { DomainError } from '../infra/context';
import type { Ctx } from '../infra/context';
import { raiseException } from './exceptions';

export interface OfferSyncResult {
  productId: string;
  updated: number;
  failures: { supplierCode: string; error: string }[];
  spikes: { supplierCode: string; country: string; pct: number }[];
}

/** Pull fresh price/shipping/stock for a product from every linked supplier, for every enabled country. */
export async function syncProductOffers(ctx: Ctx, productId: string): Promise<OfferSyncResult> {
  const res: OfferSyncResult = { productId, updated: 0, failures: [], spikes: [] };
  const links = await SupplierProduct.find({ productId }).limit(20).lean();
  const countries = Object.values(await getCountryConfigs()).filter((c) => c.enabled);
  const ops = await ctx.settings.get('ops');
  for (const link of links) {
    const supplier = await Supplier.findById(link.supplierId);
    if (!supplier || !supplier.active) continue;
    let provider;
    try {
      provider = await providerFor(ctx, supplier);
    } catch (e) {
      supplier.apiStatus = 'unconfigured';
      supplier.apiStatusMessage = (e as Error).message;
      await supplier.save();
      res.failures.push({ supplierCode: supplier.code, error: (e as Error).message });
      continue;
    }
    let supplierOk = true;
    for (const c of countries) {
      if (!servesCountry(supplier, c.code)) continue; // this supplier doesn't serve that country
      let live: LiveOffer;
      try {
        live = await fetchLiveOffer(provider, link.externalId, c.code, 1, link.variants?.[0]?.sku ?? undefined);
      } catch (e) {
        supplierOk = false;
        metrics.inc('orvia_supplier_failures_total', { supplier: supplier.code });
        res.failures.push({ supplierCode: supplier.code, error: (e as Error).message });
        ctx.log.warn({ channel: 'supplier', supplier: supplier.code, err: (e as Error).message }, 'offer sync failed');
        // keep the stale offer but stop treating it as purchasable until a fresh sync succeeds
        await SupplierOffer.updateOne({ productId, supplierId: supplier._id, destination: c.code }, { $set: { available: false } });
        continue;
      }
      const prev = await SupplierOffer.findOne({ productId, supplierId: supplier._id, destination: c.code }).lean();
      const prevTotal = prev ? prev.productCost + prev.shippingCost : 0;
      const newTotal = live.productCost + live.shippingCost;
      const pct = prevTotal > 0 ? (newTotal - prevTotal) / prevTotal : 0;
      await SupplierOffer.updateOne(
        { productId, supplierId: supplier._id, destination: c.code },
        {
          $set: {
            supplierProductId: link._id,
            externalId: link.externalId,
            warehouseCountry: live.warehouseCountry,
            currency: live.currency,
            productCost: live.productCost,
            shippingCost: live.shippingCost,
            fulfillmentFee: live.fulfillmentFee,
            minDays: live.minDays,
            maxDays: live.maxDays,
            stock: live.stock,
            available: live.available,
            lastPriceChangePct: Math.round(pct * 1000) / 1000,
            syncedAt: ctx.now(),
          },
          $push: { priceHistory: { $each: [{ at: ctx.now(), productCost: live.productCost, shippingCost: live.shippingCost }], $slice: -30 } },
        },
        { upsert: true },
      );
      res.updated++;
      if (prev && Math.abs(pct) >= ops.supplierPriceSpikePct && live.available) res.spikes.push({ supplierCode: supplier.code, country: c.code, pct });
    }
    supplier.apiStatus = supplierOk ? 'ok' : 'degraded';
    supplier.apiStatusMessage = supplierOk ? undefined : 'Last sync had failures';
    supplier.lastSyncAt = ctx.now();
    await supplier.save();
  }
  for (const s of res.spikes) {
    if (s.pct > 0) {
      await raiseException(ctx, {
        kind: 'PRICE_CHANGE',
        priority: s.pct > 0.25 ? 'high' : 'medium',
        issue: `Supplier ${s.supplierCode} price changed ${(s.pct * 100).toFixed(0)}% for ${s.country}`,
        productId,
        aiRecommendation: 'Re-run pricing; if margin falls below minimum, pause or switch supplier.',
        suggestedAction: 'Review pricing and supplier comparison',
        actionCode: 'review_product',
        dedupeKey: `price:${productId}:${s.supplierCode}:${s.country}`,
      });
    }
  }
  return res;
}

export interface SupplierComparisonRow extends RankedOffer {
  supplierCode: string;
  currency: Currency;
  lastSyncAt?: Date;
}

export interface SupplierComparison {
  productId: string;
  country: CountryCode;
  currency: Currency;
  sellingPrice: number;
  rows: SupplierComparisonRow[];
  recommendation: { supplierId: string | null; supplierName: string | null; reason: string };
}

/** Stored offers -> ranked comparison for a country at a given selling price. */
export async function compareSuppliers(
  ctx: Ctx,
  productId: string,
  country: CountryCode,
  o: { sellingPrice?: number; quantity?: number; onlyFresh?: boolean } = {},
): Promise<SupplierComparison> {
  const cfg = await getCountry(country);
  const pricing = await ctx.settings.get('pricing');
  const product = await Product.findById(productId).select('markets').lean();
  if (!product) throw new DomainError('Product not found', 'NOT_FOUND', 404);
  const market = product.markets.find((m) => m.country === country);
  const offers = await SupplierOffer.find({ productId, destination: country }).limit(50).lean();
  const suppliers = await Supplier.find({ _id: { $in: offers.map((x) => x.supplierId) }, active: true }).lean();
  const sMap = new Map(suppliers.map((s) => [String(s._id), s]));
  const rankable: (RankableOffer & { code: string; cur: Currency; syncedAt?: Date })[] = [];
  for (const off of offers) {
    const s = sMap.get(String(off.supplierId));
    if (!s) continue;
    const cur = off.currency as Currency;
    rankable.push({
      supplierId: String(s._id),
      supplierName: s.name,
      warehouseCountry: off.warehouseCountry,
      productCost: off.productCost,
      shippingCost: off.shippingCost,
      fulfillmentFee: off.fulfillmentFee,
      minDays: off.minDays,
      maxDays: off.maxDays,
      stock: off.stock,
      rating: s.rating,
      reliability: s.reliability,
      returnPolicyDays: s.returnPolicyDays,
      trackingAvailable: s.trackingAvailable,
      available: off.available && s.apiStatus !== 'down',
      code: s.code,
      cur,
      syncedAt: off.syncedAt ?? undefined,
    });
  }
  const price = o.sellingPrice ?? market?.price ?? 0;
  const ranked = rankSupplierOffers(rankable, {
    sellingPrice: price,
    quantity: o.quantity ?? 1,
    country: cfg,
    paymentFee: paymentFeeModelFor(country),
    baseRefundRate: pricing.baseRefundRate,
    adCostPerOrder: Math.round(price * pricing.assumedAdCostPct),
    minMargin: Math.max(0, pricing.minMarginPct - 0.1), // supplier eligibility is looser than the publish gate
  });
  const meta = new Map(rankable.map((r) => [r.supplierId, r]));
  const rec = recommendSupplier(ranked);
  return {
    productId,
    country,
    currency: cfg.currency,
    sellingPrice: price,
    rows: ranked.map((r) => ({ ...r, supplierCode: meta.get(r.supplierId)!.code, currency: meta.get(r.supplierId)!.cur, lastSyncAt: meta.get(r.supplierId)!.syncedAt })),
    recommendation: { supplierId: rec.best?.supplierId ?? null, supplierName: rec.best?.supplierName ?? null, reason: rec.reason },
  };
}

export interface LiveSelection {
  best: RankedOffer & { supplierCode: string; externalId: string; sku?: string; currency: Currency };
  all: SupplierComparisonRow[];
  reason: string;
  failures: { supplierCode: string; error: string }[];
}

/**
 * Fulfilment-time supplier selection: re-queries each supplier LIVE (price, shipping, stock), ranks by
 * expected profit + customer experience at the ACTUAL order price, and returns the winner.
 * A supplier whose API fails is skipped; if none respond the caller retries later.
 */
export async function selectSupplierLive(
  ctx: Ctx,
  p: { productId: string; sku?: string; country: CountryCode; quantity: number; unitPrice: number; excludeSupplierIds?: string[] },
): Promise<LiveSelection> {
  const cfg = await getCountry(p.country);
  const pricing = await ctx.settings.get('pricing');
  const fx = (await ctx.settings.get('ops')).fx;
  const links = await SupplierProduct.find({ productId: p.productId }).limit(20).lean();
  const failures: LiveSelection['failures'] = [];
  const rankable: (RankableOffer & { code: string; externalId: string; sku?: string; cur: Currency })[] = [];
  for (const link of links) {
    if (p.excludeSupplierIds?.includes(String(link.supplierId))) continue;
    const s = await Supplier.findById(link.supplierId).lean();
    if (!s || !s.active || !servesCountry(s, p.country)) continue;
    try {
      const provider = await providerFor(ctx, s);
      const sku = link.variants?.[0]?.sku ?? undefined;
      const live = await fetchLiveOffer(provider, link.externalId, p.country, p.quantity, sku);
      // convert into the market currency if the supplier quoted otherwise
      const conv = (n: number) => convertMinor(n, live.currency, cfg.currency, fx);
      rankable.push({
        supplierId: String(s._id),
        supplierName: s.name,
        warehouseCountry: live.warehouseCountry,
        productCost: conv(live.productCost),
        shippingCost: conv(live.shippingCost),
        fulfillmentFee: conv(live.fulfillmentFee),
        minDays: live.minDays,
        maxDays: live.maxDays,
        stock: live.stock,
        rating: s.rating,
        reliability: s.reliability,
        returnPolicyDays: s.returnPolicyDays,
        trackingAvailable: live.trackingAvailable && s.trackingAvailable,
        available: live.available,
        code: s.code,
        externalId: link.externalId,
        sku,
        cur: cfg.currency,
      });
    } catch (e) {
      failures.push({ supplierCode: s.code, error: (e as Error).message });
      metrics.inc('orvia_supplier_failures_total', { supplier: s.code });
    }
  }
  if (!rankable.length) {
    const msg = failures.length ? `All suppliers failed: ${failures.map((f) => `${f.supplierCode}: ${f.error}`).join('; ')}` : 'No supplier is linked to this product';
    throw Object.assign(new DomainError(msg, failures.length ? 'SUPPLIERS_UNAVAILABLE' : 'NO_SUPPLIER', failures.length ? 503 : 422), { retryable: failures.length > 0 });
  }
  const ranked = rankSupplierOffers(rankable, {
    sellingPrice: p.unitPrice,
    quantity: p.quantity,
    country: cfg,
    paymentFee: paymentFeeModelFor(p.country),
    baseRefundRate: pricing.baseRefundRate,
    adCostPerOrder: Math.round(p.unitPrice * pricing.assumedAdCostPct),
    // Customer already paid: only refuse a supplier that loses money outright after ads are ignored.
    minMargin: -1,
  });
  const meta = new Map(rankable.map((r) => [r.supplierId, r]));
  const rec = recommendSupplier(ranked);
  const rows = ranked.map((r) => ({ ...r, supplierCode: meta.get(r.supplierId)!.code, currency: meta.get(r.supplierId)!.cur }));
  // if some suppliers errored we could not evaluate them: that is transient, not a definitive 'no supplier'
  if (!rec.best) throw Object.assign(new DomainError(failures.length ? `${rec.reason} (${failures.length} supplier API(s) failed)` : rec.reason, failures.length ? 'SUPPLIERS_UNAVAILABLE' : 'NO_ELIGIBLE_SUPPLIER', failures.length ? 503 : 409), { retryable: failures.length > 0 });
  const b = rows.find((r) => r.supplierId === rec.best!.supplierId)!;
  const m = meta.get(b.supplierId)!;
  return { best: { ...b, externalId: m.externalId, sku: m.sku }, all: rows, reason: rec.reason, failures };
}
