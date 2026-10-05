import { Campaign, Inventory, Product, SupplierOffer } from '@orvia/database';
import { SELLABLE_STATES } from '@orvia/types';
import type { CountryCode, InventoryStatus, ProductState } from '@orvia/types';
import { getCountryConfigs } from '../infra/countries';
import { audit } from '../infra/audit';
import { aiActor } from '../infra/context';
import type { Ctx } from '../infra/context';
import { proposeOrExecute, registerExecutor } from './automation';
import { transitionProduct } from './catalog';
import { syncProductOffers } from './offers';
import { refreshProductMarkets } from './pricing';

export interface InventorySyncSummary {
  products: number;
  statusChanges: number;
  paused: number;
  restored: number;
  supplierSwitches: number;
  failures: number;
}

export async function syncInventory(ctx: Ctx, limit = 200): Promise<InventorySyncSummary> {
  const ops = await ctx.settings.get('ops');
  const sum: InventorySyncSummary = { products: 0, statusChanges: 0, paused: 0, restored: 0, supplierSwitches: 0, failures: 0 };
  const states: ProductState[] = [...SELLABLE_STATES, 'OUT_OF_STOCK'];
  const products = await Product.find({ state: { $in: states } }).select('_id title state markets').sort({ inventorySyncedAt: 1 }).limit(limit).lean();
  const countries = Object.values(await getCountryConfigs()).filter((c) => c.enabled);
  for (const p of products) {
    sum.products++;
    const id = String(p._id);
    await Product.updateOne({ _id: p._id }, { $set: { inventorySyncedAt: ctx.now() } });
    const before = new Map(p.markets.map((m) => [m.country, String(m.bestSupplierId ?? '')]));
    let syncRes;
    try {
      syncRes = await syncProductOffers(ctx, id);
      await refreshProductMarkets(ctx, id);
    } catch (e) {
      sum.failures++;
      ctx.log.error({ channel: 'supplier', productId: id, err: (e as Error).message }, 'inventory sync failed');
      continue;
    }
    sum.failures += syncRes.failures.length ? 1 : 0;
    const fresh = await Product.findById(id).select('markets state title').lean();
    if (!fresh) continue;
    let anyAvailable = false;
    for (const c of countries) {
      const offers = await SupplierOffer.find({ productId: id, destination: c.code }).select('stock available lastPriceChangePct supplierId').lean();
      const live = offers.filter((o) => o.available && o.stock > 0);
      const best = fresh.markets.find((m) => m.country === c.code);
      const available = best?.stock ?? 0;
      const spike = offers.some((o) => Math.abs(o.lastPriceChangePct ?? 0) >= ops.supplierPriceSpikePct);
      let status: InventoryStatus = 'IN_STOCK';
      if (!offers.length || (!live.length && syncRes.failures.length)) status = 'SUPPLIER_UNAVAILABLE';
      else if (!live.length) status = 'OUT_OF_STOCK';
      else if (available <= ops.lowStockThreshold) status = 'LOW_STOCK';
      else if (spike) status = 'PRICE_CHANGED';
      if (live.length) anyAvailable = true;
      const prev = await Inventory.findOneAndUpdate(
        { productId: id, country: c.code },
        { $set: { available, status, threshold: ops.lowStockThreshold, bestSupplierId: best?.bestSupplierId, syncedAt: ctx.now() } },
        { upsert: true, new: false },
      );
      if (!prev || prev.status !== status) sum.statusChanges++;
      if (best && before.get(c.code) && String(best.bestSupplierId ?? '') !== before.get(c.code)) {
        sum.supplierSwitches++;
        await audit(ctx, aiActor('InventoryAgent'), {
          action: 'supplier.switched', resource: 'product', resourceId: id,
          previousValue: before.get(c.code), newValue: String(best.bestSupplierId), reason: `Best supplier for ${c.code} changed after sync`,
        });
      }
      if ((status === 'OUT_OF_STOCK' || status === 'SUPPLIER_UNAVAILABLE' || status === 'LOW_STOCK') && (prev?.status ?? 'IN_STOCK') !== status) {
        await reduceAdvertising(ctx, id, c.code, fresh.title, status);
      }
    }
    if (!anyAvailable && (SELLABLE_STATES as readonly string[]).includes(fresh.state)) {
      const r = await proposeOrExecute(ctx, {
        automationKey: 'inventory_sync', agent: 'InventoryAgent', kind: 'pause_product', resource: 'product', resourceId: id,
        summary: `${fresh.title} is unavailable at every supplier in every market — mark out of stock`, payload: { productId: id, to: 'OUT_OF_STOCK', reason: 'All supplier offers unavailable' },
        confidence: 0.95, dedupeKey: `oos:${id}`,
      });
      if (r.status === 'executed') sum.paused++;
    } else if (anyAvailable && fresh.state === 'OUT_OF_STOCK') {
      const r = await proposeOrExecute(ctx, {
        automationKey: 'inventory_sync', agent: 'InventoryAgent', kind: 'pause_product', resource: 'product', resourceId: id,
        summary: `${fresh.title} is back in stock — republish`, payload: { productId: id, to: 'PUBLISHED', reason: 'Supplier stock restored' }, confidence: 0.9, dedupeKey: `restock:${id}`,
      });
      if (r.status === 'executed') sum.restored++;
    }
  }
  return sum;
}

/** Inventory trouble -> reduce ad pressure for that product/country (subject to ad_optimization mode). */
async function reduceAdvertising(ctx: Ctx, productId: string, country: CountryCode, title: string, status: InventoryStatus): Promise<void> {
  if (status === 'LOW_STOCK') return; // only warn on low stock; pause on genuine unavailability
  const camps = await Campaign.find({ productId, country, status: 'active' }).select('_id name').limit(20).lean();
  for (const c of camps) {
    await proposeOrExecute(ctx, {
      automationKey: 'ad_optimization', agent: 'InventoryAgent', kind: 'ad_action', resource: 'campaign', resourceId: String(c._id),
      summary: `Pause campaign "${c.name}" — ${title} is ${status.toLowerCase().replace('_', ' ')} in ${country}`,
      payload: { campaignId: String(c._id), action: 'PAUSE', reason: `Inventory status ${status}` }, confidence: 0.95, dedupeKey: `adpause-inv:${c._id}`,
    });
  }
}

registerExecutor('pause_product', async (ctx, payload, actor) => {
  const { productId, to, reason } = payload as { productId: string; to: ProductState; reason: string };
  await transitionProduct(ctx, productId, to, actor, reason);
  return { productId, state: to };
});
