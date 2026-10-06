import { Shipment, Supplier, SupplierOffer, SupplierProduct } from '@orvia/database';
import { ProviderError } from '@orvia/config';
import type { CreateSupplierOrderInput, InventoryInfo, PriceQuote, SearchParams, SearchResult, ShippingQuote, SupplierOrder, SupplierProductSummary, SupplierProvider, SupplierRating, SupplierVariant, TrackingInfo } from '@orvia/suppliers';
import type { CountryCode } from '@orvia/types';

/**
 * Supplier without an API: offers are typed in by an operator and EXPIRE (they are never refreshed from thin air),
 * orders are placed by hand, and tracking is whatever the operator recorded. Nothing here fabricates data.
 */
/** Shared, refreshed from settings by the supplier-health job. */
export const manualOfferTtl = { hours: 72 };

export class ManualSupplierProvider implements SupplierProvider {
  readonly key = 'manual';
  constructor(private readonly code: string, private readonly ttlHours: () => number) {}

  private async supplierId() {
    const s = await Supplier.findOne({ code: this.code }).select('_id').lean();
    if (!s) throw new ProviderError(`Unknown supplier ${this.code}`, { provider: this.code, retryable: false });
    return s._id;
  }
  private async offer(externalId: string, destination: CountryCode) {
    const o = await SupplierOffer.findOne({ supplierId: await this.supplierId(), externalId, destination }).lean();
    if (!o) throw new ProviderError(`No manual offer entered for ${externalId} → ${destination}`, { provider: this.code, retryable: false, status: 404 });
    const ageH = (Date.now() - new Date(o.confirmedAt ?? o.syncedAt ?? 0).getTime()) / 3_600_000;
    if (ageH > this.ttlHours()) throw new ProviderError(`Manual offer for ${externalId} expired ${Math.round(ageH)}h after it was last confirmed — re-confirm stock and price`, { provider: this.code, retryable: false, status: 410 });
    return o;
  }

  async searchProducts(p: SearchParams): Promise<SearchResult> {
    const rows = await SupplierProduct.find({ supplierId: await this.supplierId(), ...(p.query ? { title: new RegExp(p.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') } : {}) }).limit(p.limit ?? 20).lean();
    return { items: rows.map((r) => this.summary(r as never)) };
  }
  private summary(r: { externalId: string; title?: string; description?: string; images?: string[]; category?: string; variants?: SupplierVariant[]; cost?: number }): SupplierProductSummary {
    return { externalId: r.externalId, title: r.title ?? '', description: r.description ?? '', images: r.images ?? [], videos: [], category: r.category ?? '', attributes: {}, variants: (r.variants ?? []).map((v) => ({ sku: v.sku, label: v.label, options: {} })), baseCostUsd: r.cost ?? 0, tags: [] };
  }
  async getProduct(externalId: string) {
    const r = await SupplierProduct.findOne({ supplierId: await this.supplierId(), externalId }).lean();
    return r ? this.summary(r as never) : null;
  }
  async getVariants(externalId: string) {
    return (await this.getProduct(externalId))?.variants ?? [];
  }
  async getInventory(externalId: string, sku?: string): Promise<InventoryInfo> {
    const offers = await SupplierOffer.find({ supplierId: await this.supplierId(), externalId }).lean();
    const fresh = offers.filter((o) => (Date.now() - new Date(o.confirmedAt ?? o.syncedAt ?? 0).getTime()) / 3_600_000 <= this.ttlHours());
    if (!fresh.length) throw new ProviderError(`Manual stock for ${externalId} has expired — re-confirm it`, { provider: this.code, retryable: false, status: 410 });
    const byWarehouse = fresh.map((o) => ({ warehouseCountry: o.warehouseCountry, quantity: o.stock }));
    return { externalId, sku, byWarehouse, total: byWarehouse.reduce((a, w) => a + w.quantity, 0) };
  }
  async getPrice(externalId: string, destination: CountryCode, sku?: string): Promise<PriceQuote> {
    const o = await this.offer(externalId, destination);
    return { externalId, sku, destination, currency: o.currency as never, productCost: o.productCost, fulfillmentFee: o.fulfillmentFee ?? 0, warehouseCountry: o.warehouseCountry };
  }
  async getShippingQuote(externalId: string, destination: CountryCode): Promise<ShippingQuote> {
    const o = await this.offer(externalId, destination);
    return { externalId, destination, warehouseCountry: o.warehouseCountry, currency: o.currency as never, shippingCost: o.shippingCost, minDays: o.minDays, maxDays: o.maxDays, method: 'manual', trackingAvailable: true, available: o.available };
  }
  async createOrder(_i: CreateSupplierOrderInput): Promise<SupplierOrder> {
    throw new ProviderError('This supplier has no ordering API: place the order with the supplier and record it in Admin → Exceptions', { provider: this.code, retryable: false });
  }
  async getOrder(supplierOrderId: string): Promise<SupplierOrder> {
    const s = await Shipment.findOne({ supplierOrderId }).lean();
    if (!s) throw new ProviderError('Unknown manual order', { provider: this.code, retryable: false, status: 404 });
    return { supplierOrderId, status: (s.status === 'PENDING_CREATE' ? 'CREATED' : s.status) as never, trackingNumber: s.trackingNumber ?? undefined, carrier: s.carrier ?? undefined, cost: { productCost: 0, shippingCost: 0, duties: 0, currency: 'USD' }, createdAt: new Date(s.createdAt).toISOString() };
  }
  async cancelOrder() {
    return { cancelled: false, reason: 'Manual supplier: cancel with the supplier directly' };
  }
  async getTracking(supplierOrderId: string): Promise<TrackingInfo> {
    const s = await Shipment.findOne({ supplierOrderId }).lean();
    if (!s || !s.trackingNumber) return { supplierOrderId, status: (s?.status ?? 'CREATED') as never, events: [], available: false };
    return { supplierOrderId, status: s.status as never, carrier: s.carrier ?? undefined, trackingNumber: s.trackingNumber, events: [], available: true };
  }
  async getSupplierRating(): Promise<SupplierRating> {
    return { rating: 4, reliability: 70, returnPolicyDays: 14, trackingAvailable: true };
  }
  async healthCheck() {
    return { ok: true, message: 'Manual supplier (no API to check)' };
  }
}
