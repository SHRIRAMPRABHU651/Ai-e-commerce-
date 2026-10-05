/**
 * DEV / TEST ONLY mock supplier. Deterministic, stateless across processes (state lives in a
 * MockStateStore), honours idempotency keys and supports fault injection so the failure paths
 * of the order engine can be exercised. Refused in production by config + registry.
 */
import { DEFAULT_COUNTRIES, DEFAULT_FX, convertMinor } from '@orvia/types';
import { MemoryKVStore, ProviderError } from '@orvia/config';
import type { KVStore } from '@orvia/config';
import type { CountryCode } from '@orvia/types';
import { MOCK_CATALOG } from './catalog';
import type {
  CreateSupplierOrderInput,
  InventoryInfo,
  PriceQuote,
  SearchParams,
  SearchResult,
  ShippingQuote,
  SupplierOrder,
  SupplierOrderStatus,
  SupplierProductSummary,
  SupplierProvider,
  SupplierRating,
  SupplierVariant,
  TrackingEvent,
  TrackingInfo,
} from '../types';

export type MockStateStore = KVStore;
export { MemoryKVStore as MemoryMockStore };

export interface MockProfile {
  code: string;
  name: string;
  warehouseCountry: string;
  costMult: number;
  rating: number;
  reliability: number;
  returnPolicyDays: number;
  stockMult: number;
  routes: Partial<Record<CountryCode, { shipUsd: number; minDays: number; maxDays: number }>>;
  carrier: string;
}

export const MOCK_PROFILES: MockProfile[] = [
  {
    code: 'mock-nova-us', name: 'Nova Fulfilment (US warehouse)', warehouseCountry: 'US', costMult: 1.18, rating: 4.7, reliability: 94,
    returnPolicyDays: 30, stockMult: 1.2, carrier: 'USPS (mock)',
    routes: { US: { shipUsd: 320, minDays: 3, maxDays: 6 }, CA: { shipUsd: 650, minDays: 5, maxDays: 9 } },
  },
  {
    code: 'mock-maple-ca', name: 'Maple Direct (CA warehouse)', warehouseCountry: 'CA', costMult: 1.22, rating: 4.5, reliability: 91,
    returnPolicyDays: 30, stockMult: 0.8, carrier: 'Canada Post (mock)',
    routes: { CA: { shipUsd: 310, minDays: 2, maxDays: 5 }, US: { shipUsd: 520, minDays: 4, maxDays: 8 } },
  },
  {
    code: 'mock-bharat-in', name: 'Bharat Fulfilment (IN warehouse)', warehouseCountry: 'IN', costMult: 1.0, rating: 4.3, reliability: 88,
    returnPolicyDays: 7, stockMult: 1.0, carrier: 'India Post (mock)',
    routes: { IN: { shipUsd: 90, minDays: 2, maxDays: 5 } },
  },
  {
    code: 'mock-globex-cn', name: 'Globex Global Sourcing (CN warehouse)', warehouseCountry: 'CN', costMult: 0.78, rating: 4.1, reliability: 78,
    returnPolicyDays: 14, stockMult: 3.0, carrier: 'Mock Global Logistics',
    routes: {
      US: { shipUsd: 520, minDays: 10, maxDays: 18 },
      CA: { shipUsd: 640, minDays: 12, maxDays: 20 },
      IN: { shipUsd: 480, minDays: 14, maxDays: 24 },
    },
  },
];

export interface MockFault {
  remaining: number;
  kind: 'http500' | 'timeout' | 'unavailable' | 'rate_limit';
}
export interface MockOverride {
  stock?: number;
  priceMult?: number;
  unavailable?: boolean;
}

const fnv = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};
const hex = (s: string) => fnv(s).toString(16).padStart(8, '0');

interface StoredOrder {
  supplierOrderId: string;
  idempotencyKey: string;
  externalId: string;
  sku: string;
  quantity: number;
  destination: CreateSupplierOrderInput['destination'];
  createdAt: string;
  cancelled?: boolean;
  route: { minDays: number; maxDays: number };
  cost: SupplierOrder['cost'];
  trackingNumber: string;
}

export class MockSupplierProvider implements SupplierProvider {
  readonly key: string;
  constructor(
    readonly profile: MockProfile,
    private readonly store: MockStateStore = new MemoryKVStore(),
    private readonly opts: { timeScale?: number; now?: () => number; catalog?: SupplierProductSummary[] } = {},
  ) {
    this.key = profile.code;
  }

  private get catalog(): SupplierProductSummary[] {
    return this.opts.catalog ?? MOCK_CATALOG;
  }
  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /* ------------------------- fault injection ------------------------- */
  async setFault(f: MockFault | null): Promise<void> {
    await this.store.set('fault', this.profile.code, f);
  }
  async setOverride(externalId: string, o: MockOverride | null): Promise<void> {
    await this.store.set('override', `${this.profile.code}:${externalId}`, o);
  }
  private async override(externalId: string): Promise<MockOverride> {
    return (await this.store.get<MockOverride>('override', `${this.profile.code}:${externalId}`)) ?? {};
  }
  private async maybeFault(op: string): Promise<void> {
    const f = await this.store.get<MockFault>('fault', this.profile.code);
    if (!f || f.remaining <= 0) return;
    await this.store.set('fault', this.profile.code, { ...f, remaining: f.remaining - 1 });
    const retryable = f.kind !== 'unavailable';
    throw new ProviderError(`Mock supplier ${this.profile.code} injected fault (${f.kind}) during ${op}`, {
      provider: this.profile.code,
      retryable,
      status: f.kind === 'http500' ? 500 : f.kind === 'rate_limit' ? 429 : undefined,
    });
  }

  /* ----------------------------- catalog ----------------------------- */
  private find(externalId: string): SupplierProductSummary {
    const p = this.catalog.find((c) => c.externalId === externalId);
    if (!p) throw new ProviderError(`Unknown product ${externalId}`, { provider: this.key, retryable: false, status: 404 });
    return p;
  }

  async searchProducts(p: SearchParams): Promise<SearchResult> {
    await this.maybeFault('searchProducts');
    const tokens = (p.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    let items = this.catalog.filter((c) => {
      const hay = `${c.title} ${c.category} ${c.tags.join(' ')}`.toLowerCase();
      return tokens.every((t) => hay.includes(t)) && (!p.category || c.category.toLowerCase().includes(p.category.toLowerCase()));
    });
    const start = p.cursor ? Number(p.cursor) : 0;
    const limit = p.limit ?? 20;
    items = items.slice(start, start + limit + 1);
    const hasMore = items.length > limit;
    return { items: items.slice(0, limit), nextCursor: hasMore ? String(start + limit) : undefined };
  }

  async getProduct(externalId: string): Promise<SupplierProductSummary | null> {
    await this.maybeFault('getProduct');
    return this.catalog.find((c) => c.externalId === externalId) ?? null;
  }
  async getVariants(externalId: string): Promise<SupplierVariant[]> {
    return this.find(externalId).variants;
  }

  /* ------------------------- price / inventory ------------------------- */
  private baseStock(externalId: string): number {
    const h = fnv(`${this.profile.code}|${externalId}`);
    if (h % 17 === 0) return 6; // a few low-stock items so the dashboard has something to show
    return Math.round((120 + (h % 900)) * this.profile.stockMult);
  }

  async getInventory(externalId: string, sku?: string): Promise<InventoryInfo> {
    await this.maybeFault('getInventory');
    this.find(externalId);
    const o = await this.override(externalId);
    const q = o.unavailable ? 0 : (o.stock ?? this.baseStock(externalId));
    return { externalId, sku, byWarehouse: [{ warehouseCountry: this.profile.warehouseCountry, quantity: q }], total: q };
  }

  async getPrice(externalId: string, destination: CountryCode, sku?: string): Promise<PriceQuote> {
    await this.maybeFault('getPrice');
    const p = this.find(externalId);
    const o = await this.override(externalId);
    const currency = DEFAULT_COUNTRIES[destination].currency;
    const usd = Math.round(p.baseCostUsd * this.profile.costMult * (o.priceMult ?? 1));
    return {
      externalId,
      sku,
      destination,
      currency,
      productCost: convertMinor(usd, 'USD', currency, DEFAULT_FX),
      fulfillmentFee: convertMinor(this.profile.warehouseCountry === 'CN' ? 0 : 50, 'USD', currency, DEFAULT_FX),
      warehouseCountry: this.profile.warehouseCountry,
    };
  }

  async getShippingQuote(externalId: string, destination: CountryCode, quantity: number): Promise<ShippingQuote> {
    await this.maybeFault('getShippingQuote');
    this.find(externalId);
    const route = this.profile.routes[destination];
    const currency = DEFAULT_COUNTRIES[destination].currency;
    const o = await this.override(externalId);
    if (!route) {
      return { externalId, destination, warehouseCountry: this.profile.warehouseCountry, currency, shippingCost: 0, minDays: 0, maxDays: 0, method: 'none', trackingAvailable: false, available: false };
    }
    const usd = route.shipUsd + Math.max(0, quantity - 1) * Math.round(route.shipUsd * 0.4);
    return {
      externalId,
      destination,
      warehouseCountry: this.profile.warehouseCountry,
      currency,
      shippingCost: convertMinor(usd, 'USD', currency, DEFAULT_FX),
      minDays: route.minDays,
      maxDays: route.maxDays,
      method: 'standard',
      trackingAvailable: true,
      available: !o.unavailable,
    };
  }

  /* ------------------------------- orders ------------------------------- */
  async createOrder(input: CreateSupplierOrderInput): Promise<SupplierOrder> {
    await this.maybeFault('createOrder');
    const p = this.find(input.externalId);
    const dest = input.destination.country;
    const route = this.profile.routes[dest];
    if (!route) throw new ProviderError(`Supplier does not ship to ${dest}`, { provider: this.key, retryable: false, status: 422 });
    const inv = await this.getInventory(input.externalId, input.sku);
    const existing = await this.store.get<StoredOrder>('order', input.idempotencyKey);
    if (existing) return this.toOrder(existing);
    if (inv.total < input.quantity) throw new ProviderError('Out of stock at supplier', { provider: this.key, retryable: false, status: 409 });
    const price = await this.getPrice(input.externalId, dest, input.sku);
    const ship = await this.getShippingQuote(input.externalId, dest, input.quantity);
    const rec: StoredOrder = {
      supplierOrderId: `MS-${hex(input.idempotencyKey)}${hex(this.profile.code + input.idempotencyKey)}`.toUpperCase(),
      idempotencyKey: input.idempotencyKey,
      externalId: p.externalId,
      sku: input.sku,
      quantity: input.quantity,
      destination: input.destination,
      createdAt: new Date(this.now()).toISOString(),
      route: { minDays: route.minDays, maxDays: route.maxDays },
      cost: { productCost: price.productCost * input.quantity, shippingCost: ship.shippingCost, duties: 0, currency: price.currency },
      trackingNumber: `MOCK${hex(input.idempotencyKey + 'trk').toUpperCase()}${dest}`,
    };
    const res = await this.store.setIfAbsent('order', input.idempotencyKey, rec);
    await this.store.set('orderById', res.data.supplierOrderId, { idempotencyKey: input.idempotencyKey });
    return this.toOrder(res.data);
  }

  private async load(supplierOrderId: string): Promise<StoredOrder> {
    const ref = await this.store.get<{ idempotencyKey: string }>('orderById', supplierOrderId);
    const rec = ref ? await this.store.get<StoredOrder>('order', ref.idempotencyKey) : null;
    if (!rec) throw new ProviderError(`Unknown supplier order ${supplierOrderId}`, { provider: this.key, retryable: false, status: 404 });
    return rec;
  }

  private simDays(rec: StoredOrder): number {
    const scale = this.opts.timeScale ?? 600;
    return ((this.now() - Date.parse(rec.createdAt)) / 1000) * scale / 86_400;
  }

  private stage(rec: StoredOrder): SupplierOrderStatus {
    if (rec.cancelled) return 'CANCELLED';
    const d = this.simDays(rec);
    const deliver = (rec.route.minDays + rec.route.maxDays) / 2;
    if (d >= deliver) return 'DELIVERED';
    if (d >= deliver - 0.5) return 'OUT_FOR_DELIVERY';
    if (d >= 1.5) return 'IN_TRANSIT';
    if (d >= 1) return 'SHIPPED';
    return 'CREATED';
  }

  private toOrder(rec: StoredOrder): SupplierOrder {
    const status = this.stage(rec);
    const shipped = status !== 'CREATED' && status !== 'CANCELLED';
    return {
      supplierOrderId: rec.supplierOrderId,
      status,
      trackingNumber: shipped ? rec.trackingNumber : undefined,
      carrier: shipped ? this.profile.carrier : undefined,
      cost: rec.cost,
      createdAt: rec.createdAt,
    };
  }

  async getOrder(supplierOrderId: string): Promise<SupplierOrder> {
    await this.maybeFault('getOrder');
    return this.toOrder(await this.load(supplierOrderId));
  }

  async cancelOrder(supplierOrderId: string): Promise<{ cancelled: boolean; reason?: string }> {
    await this.maybeFault('cancelOrder');
    const rec = await this.load(supplierOrderId);
    if (rec.cancelled) return { cancelled: true };
    if (this.simDays(rec) >= 1) return { cancelled: false, reason: 'Order already shipped' };
    await this.store.set('order', rec.idempotencyKey, { ...rec, cancelled: true });
    return { cancelled: true };
  }

  async getTracking(supplierOrderId: string): Promise<TrackingInfo> {
    await this.maybeFault('getTracking');
    const rec = await this.load(supplierOrderId);
    const status = this.stage(rec);
    const created = Date.parse(rec.createdAt);
    const at = (days: number) => new Date(created + (days * 86_400_000) / (this.opts.timeScale ?? 600) * 1000).toISOString();
    const deliver = (rec.route.minDays + rec.route.maxDays) / 2;
    const all: TrackingEvent[] = [
      { status: 'CREATED', description: 'Order received by supplier', at: at(0) },
      { status: 'SHIPPED', description: 'Parcel handed to carrier', location: `${this.profile.warehouseCountry} warehouse`, at: at(1) },
      { status: 'IN_TRANSIT', description: 'In transit', at: at(1.5) },
      { status: 'OUT_FOR_DELIVERY', description: 'Out for delivery', location: rec.destination.city, at: at(deliver - 0.5) },
      { status: 'DELIVERED', description: 'Delivered', location: rec.destination.city, at: at(deliver) },
    ];
    const order: SupplierOrderStatus[] = ['CREATED', 'SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED'];
    const reached = status === 'CANCELLED' ? 1 : order.indexOf(status) + 1;
    const events = all.slice(0, reached);
    const shipped = reached >= 2 && status !== 'CANCELLED';
    return {
      supplierOrderId,
      status,
      carrier: shipped ? this.profile.carrier : undefined,
      trackingNumber: shipped ? rec.trackingNumber : undefined,
      trackingUrl: shipped ? `https://tracking.mock.invalid/${rec.trackingNumber}` : undefined,
      estimatedDelivery: at(rec.route.maxDays),
      events,
      available: shipped,
    };
  }

  async getSupplierRating(): Promise<SupplierRating> {
    return {
      rating: this.profile.rating,
      reliability: this.profile.reliability,
      returnPolicyDays: this.profile.returnPolicyDays,
      trackingAvailable: true,
    };
  }

  async healthCheck(): Promise<{ ok: boolean; message: string }> {
    const f = await this.store.get<MockFault>('fault', this.profile.code);
    if (f && f.remaining > 0) return { ok: false, message: `Injected fault active (${f.kind})` };
    return { ok: true, message: 'Mock supplier (development only)' };
  }
}
