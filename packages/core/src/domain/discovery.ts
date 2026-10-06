import { providerFor } from './supplierAccess';
import { MarketTopic, Product, Supplier, SupplierProduct } from '@orvia/database';
import { scoreOpportunity } from '@orvia/analytics';
import { AnalyticsEvent } from '@orvia/database';
import type { Ctx } from '../infra/context';
import { proposeOrExecute, registerExecutor } from './automation';
import { checkCompliance } from './compliance';
import { importProduct, marketIntelFor } from './importer';

export interface DiscoverySummary {
  suppliersScanned: number;
  candidates: number;
  rejected: number;
  watch: number;
  imported: number;
  proposed: number;
  /** trending topics from the market index used as catalogue searches */
  trendQueries?: number;
  errors: string[];
}

/**
 * ProductDiscoveryAgent: scan each active supplier catalogue, pre-score candidates from supplier cost,
 * market signals and compliance, and import the strong ones (or propose them in ASSISTED mode).
 */
export async function runDiscovery(ctx: Ctx, opts: { perSupplier?: number } = {}): Promise<DiscoverySummary> {
  const sum: DiscoverySummary = { suppliersScanned: 0, candidates: 0, rejected: 0, watch: 0, imported: 0, proposed: 0, errors: [] };
  const suppliers = await Supplier.find({ active: true }).limit(20).lean();
  // search each catalogue broadly AND for products matching topics the market index has real evidence for
  const market = await ctx.settings.get('market');
  const hot = await MarketTopic.find({ status: { $in: ['TRENDING', 'RISING'] }, confidence: { $gte: market.minConfidence } }).sort({ trendScore: -1 }).limit(8).select('displayName normalizedName').lean();
  const plans: (string | undefined)[] = [undefined, ...hot.map((t) => t.displayName ?? t.normalizedName)];
  sum.trendQueries = hot.length;
  for (const s of suppliers) {
    let provider;
    try {
      provider = await providerFor(ctx, s);
    } catch (e) {
      sum.errors.push(`${s.code}: ${(e as Error).message}`);
      continue;
    }
    sum.suppliersScanned++;
    let cursor: string | undefined;
    let seen = 0;
    const cap = opts.perSupplier ?? 60;
    try {
      for (const plan of plans) {
      if (seen >= cap) break;
      cursor = undefined;
      do {
        const page = await provider.searchProducts({ limit: 20, cursor, query: plan });
        cursor = page.nextCursor;
        for (const item of page.items) {
          if (seen++ >= cap) {
            cursor = undefined;
            break;
          }
          const known = await SupplierProduct.findOne({ supplierId: s._id, externalId: item.externalId }).select('importStatus productId').lean();
          if (known) continue;
          sum.candidates++;
          const compliance = checkCompliance({ title: item.title, description: item.description, category: item.category, topCategory: String(item.attributes['Top category'] ?? '').toLowerCase(), tags: item.tags, attributes: item.attributes, safetyInfo: item.safetyInfo });
          const intel = await marketIntelFor(ctx, item.externalId, item.title);
          // quick economics: target-margin price from the supplier's reference cost vs observed competitor median
          const medianUsd = intel?.competitorPricesUsd.length ? [...intel.competitorPricesUsd].sort((a, b) => a - b)[Math.floor(intel.competitorPricesUsd.length / 2)]! : item.baseCostUsd * 3;
          const margin = Math.max(0, (medianUsd - item.baseCostUsd * 1.35 - medianUsd * 0.12) / medianUsd);
          const clamp = (n: number) => Math.max(0, Math.min(100, n));
          const score = scoreOpportunity({
            demand: intel?.demand ?? 50, trendVelocity: intel?.trend ?? 50, competition: intel?.competition ?? 50,
            supplierCost: clamp((1 - item.baseCostUsd / Math.max(1, medianUsd)) * 120), shipping: 70, profitMargin: clamp((margin / 0.5) * 100),
            videoPotential: intel?.video ? 85 : 55, repeatPurchase: 50, supplierReliability: s.reliability, compliance: compliance.score,
          });
          const baseUpdate = { title: item.title, images: item.images, category: item.category, cost: item.baseCostUsd, currency: 'USD', lastSyncAt: ctx.now() };
          if (score.action === 'REJECT') {
            sum.rejected++;
            await SupplierProduct.updateOne({ supplierId: s._id, externalId: item.externalId }, { $set: { ...baseUpdate, importStatus: 'rejected' } }, { upsert: true });
            continue;
          }
          if (score.action === 'WATCH') {
            sum.watch++;
            await SupplierProduct.updateOne({ supplierId: s._id, externalId: item.externalId }, { $set: { ...baseUpdate, importStatus: 'new' } }, { upsert: true });
            continue;
          }
          const out = await proposeOrExecute(ctx, {
            automationKey: 'product_discovery', agent: 'ProductDiscoveryAgent', kind: 'import_product', resource: 'supplier_product', resourceId: item.externalId,
            summary: `Import "${item.title}" from ${s.code} (opportunity ${score.finalScore} → TEST)`,
            payload: { supplierId: String(s._id), externalId: item.externalId, score: score.finalScore }, confidence: 0.7, dedupeKey: `import:${s._id}:${item.externalId}`,
          });
          if (out.status === 'executed') sum.imported++;
          else if (out.status === 'proposed') {
            sum.proposed++;
            await SupplierProduct.updateOne({ supplierId: s._id, externalId: item.externalId }, { $set: { ...baseUpdate, importStatus: 'new' } }, { upsert: true });
          }
        }
      } while (cursor);
      }
    } catch (e) {
      sum.errors.push(`${s.code}: ${(e as Error).message}`);
      ctx.log.error({ channel: 'supplier', supplier: s.code, err: (e as Error).message }, 'discovery scan failed');
    }
  }
  return sum;
}

registerExecutor('import_product', async (ctx, payload, actor) => {
  const r = await importProduct(ctx, { supplierId: String(payload['supplierId']), externalId: String(payload['externalId']) }, actor);
  return { productId: r.productId, state: r.state, publish: r.publish.outcome };
});

/** TrendAgent: trend score = recent behavioural velocity (views, add-to-carts, purchases) vs the prior window. */
export async function refreshTrends(ctx: Ctx): Promise<{ updated: number }> {
  const now = ctx.now().getTime();
  const d7 = new Date(now - 7 * 86_400_000);
  const d14 = new Date(now - 14 * 86_400_000);
  const rows = await AnalyticsEvent.aggregate<{ _id: string; recent: number; prior: number }>([
    { $match: { productId: { $exists: true }, ts: { $gte: d14 }, type: { $in: ['product_view', 'add_to_cart', 'purchase'] } } },
    {
      $group: {
        _id: '$productId',
        recent: { $sum: { $cond: [{ $gte: ['$ts', d7] }, { $switch: { branches: [{ case: { $eq: ['$type', 'purchase'] }, then: 8 }, { case: { $eq: ['$type', 'add_to_cart'] }, then: 3 }], default: 1 } }, 0] } },
        prior: { $sum: { $cond: [{ $lt: ['$ts', d7] }, { $switch: { branches: [{ case: { $eq: ['$type', 'purchase'] }, then: 8 }, { case: { $eq: ['$type', 'add_to_cart'] }, then: 3 }], default: 1 } }, 0] } },
      },
    },
    { $limit: 2000 },
  ]);
  const maxRecent = Math.max(1, ...rows.map((r) => r.recent));
  let updated = 0;
  for (const r of rows) {
    const velocity = r.prior > 0 ? Math.min(2, r.recent / r.prior) / 2 : r.recent > 0 ? 0.8 : 0;
    const volume = r.recent / maxRecent;
    const score = Math.round((volume * 0.6 + velocity * 0.4) * 100);
    await Product.updateOne({ _id: r._id }, { $set: { 'stats.trendScore': score } });
    updated++;
  }
  return { updated };
}
