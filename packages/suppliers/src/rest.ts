/**
 * Configurable REST supplier adapter ("rest"): lets an operator onboard any supplier that exposes a JSON HTTP API
 * by describing its endpoints and field paths in the supplier's `config` (no code change, no redeploy).
 * Credentials (apiKey) live encrypted on the supplier record, never in config.
 *
 * It covers the dropshipping essentials: catalogue search/product detail (with photos), destination-specific price,
 * stock and shipping, order placement (idempotent), status and tracking. If a supplier's API doesn't fit this
 * shape, write a dedicated adapter instead (see docs/SUPPLIERS.md).
 */
import { z } from 'zod';
import { CircuitBreaker, ProviderError, fetchJson } from '@orvia/config';
import { DEFAULT_FX, convertMinor } from '@orvia/types';
import type { CountryCode } from '@orvia/types';
import type {
  CreateSupplierOrderInput, InventoryInfo, PriceQuote, SearchParams, SearchResult, ShippingQuote, SupplierOrder,
  SupplierOrderStatus, SupplierProductSummary, SupplierProvider, SupplierRating, SupplierVariant, TrackingInfo,
} from './types';

const endpoint = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).default('GET'),
  /** Path with {id}, {sku}, {country}, {qty}, {query}, {page}, {limit} placeholders. */
  path: z.string().min(1),
  /** Extra query-string params (same placeholders). */
  query: z.record(z.string()).optional(),
  /** Request body template for POST/PUT: string values may use placeholders (and {idempotencyKey}, {orderRef}, {address.*}). */
  body: z.record(z.unknown()).optional(),
  /** Dot path to the payload inside the response (default: the whole response). */
  data: z.string().optional(),
});

export const restSupplierConfigSchema = z.object({
  baseUrl: z.string().url(),
  auth: z.object({
    type: z.enum(['bearer', 'header', 'query']).default('bearer'),
    /** Header or query-parameter name for type=header|query. */
    name: z.string().default('Authorization'),
  }).default({ type: 'bearer', name: 'Authorization' }),
  currency: z.enum(['USD', 'CAD', 'INR']).default('USD'),
  /** Supplier prices are decimals of the major unit (19.99) unless set to "minor". */
  priceUnit: z.enum(['major', 'minor']).default('major'),
  warehouseCountry: z.string().length(2).default('CN'),
  endpoints: z.object({
    search: endpoint,
    product: endpoint,
    quote: endpoint.optional(),
    stock: endpoint.optional(),
    createOrder: endpoint,
    order: endpoint,
    cancel: endpoint.optional(),
    health: endpoint.optional(),
  }),
  /** Dot paths into the supplier's JSON; arrays may be strings or objects with `url`/`src`. */
  fields: z.object({
    list: z.string().default('items'),
    id: z.string().default('id'),
    title: z.string().default('title'),
    description: z.string().default('description'),
    images: z.array(z.string()).default(['images']),
    category: z.string().default('category'),
    price: z.string().default('price'),
    variants: z.string().optional(),
    variantSku: z.string().default('sku'),
    variantLabel: z.string().default('name'),
    variantImage: z.string().optional(),
    quotePrice: z.string().default('price'),
    quoteShipping: z.string().default('shipping.cost'),
    quoteMinDays: z.string().default('shipping.minDays'),
    quoteMaxDays: z.string().default('shipping.maxDays'),
    quoteAvailable: z.string().optional(),
    quoteWarehouse: z.string().optional(),
    stock: z.string().default('stock'),
    orderId: z.string().default('id'),
    orderStatus: z.string().default('status'),
    trackingNumber: z.string().default('tracking.number'),
    carrier: z.string().default('tracking.carrier'),
    trackingUrl: z.string().optional(),
    estimatedDelivery: z.string().optional(),
    events: z.string().optional(),
  }).default({}),
  /** Map of supplier status strings (lower-case) → our statuses. */
  statusMap: z.record(z.enum(['CREATED', 'SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED', 'FAILED'])).default({
    pending: 'CREATED', processing: 'CREATED', created: 'CREATED', shipped: 'SHIPPED', in_transit: 'IN_TRANSIT', out_for_delivery: 'OUT_FOR_DELIVERY',
    delivered: 'DELIVERED', cancelled: 'CANCELLED', canceled: 'CANCELLED', failed: 'FAILED',
  }),
});
export type RestSupplierConfig = z.infer<typeof restSupplierConfigSchema>;

const get = (o: unknown, path: string | undefined): unknown => {
  if (!path) return o;
  return path.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), o);
};
const fill = (s: string, vars: Record<string, unknown>): string => s.replace(/\{([\w.]+)\}/g, (_, k: string) => String(get(vars, k) ?? ''));
const fillDeep = (v: unknown, vars: Record<string, unknown>): unknown => {
  if (typeof v === 'string') {
    const m = /^\{([\w.]+)\}$/.exec(v);
    return m ? get(vars, m[1]) ?? '' : fill(v, vars);
  }
  if (Array.isArray(v)) return v.map((x) => fillDeep(x, vars));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillDeep(x, vars)]));
  return v;
};

/** Photos from strings, arrays, JSON-encoded arrays or {url|src|imageUrl} objects; https only; deduped. */
export function collectImages(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) { v.forEach((x) => collectImages(x, out)); return out; }
  if (v && typeof v === 'object') { const o = v as Record<string, unknown>; return collectImages(o['url'] ?? o['src'] ?? o['imageUrl'], out); }
  if (typeof v !== 'string') return out;
  const t = v.trim();
  if (t.startsWith('[')) { try { return collectImages(JSON.parse(t), out); } catch { return out; } }
  if (/^https?:\/\//i.test(t)) { const u = t.replace(/^http:\/\//i, 'https://'); if (!out.includes(u)) out.push(u); }
  return out;
}

export class RestSupplierProvider implements SupplierProvider {
  readonly key: string;
  private readonly breaker: CircuitBreaker;
  constructor(
    private readonly code: string,
    private readonly cfg: RestSupplierConfig,
    private readonly apiKey: string,
    private readonly opts: { fetchImpl?: typeof fetch } = {},
  ) {
    this.key = code;
    this.breaker = new CircuitBreaker(code, { failureThreshold: 5, resetMs: 30_000 });
  }

  private minor(v: unknown): number {
    const n = Number(v ?? 0);
    if (!Number.isFinite(n)) return 0;
    return this.cfg.priceUnit === 'minor' ? Math.round(n) : Math.round(n * 100);
  }

  private async call(ep: z.infer<typeof endpoint>, vars: Record<string, unknown>, idempotent?: boolean): Promise<unknown> {
    const url = new URL(this.cfg.baseUrl.replace(/\/$/, '') + fill(ep.path, vars));
    for (const [k, v] of Object.entries(ep.query ?? {})) url.searchParams.set(k, fill(v, vars));
    const headers: Record<string, string> = {};
    if (this.cfg.auth.type === 'bearer') headers[this.cfg.auth.name || 'Authorization'] = `Bearer ${this.apiKey}`;
    else if (this.cfg.auth.type === 'header') headers[this.cfg.auth.name] = this.apiKey;
    else url.searchParams.set(this.cfg.auth.name, this.apiKey);
    const res = await fetchJson<unknown>(url.toString(), {
      provider: this.code, method: ep.method, headers, body: ep.body ? fillDeep(ep.body, vars) : undefined, idempotent, breaker: this.breaker, fetchImpl: this.opts.fetchImpl,
    });
    return get(res, ep.data);
  }

  private mapProduct(d: unknown): SupplierProductSummary {
    const f = this.cfg.fields;
    const images: string[] = [];
    for (const p of f.images) collectImages(get(d, p), images);
    const variants: SupplierVariant[] = f.variants
      ? ((get(d, f.variants) as unknown[]) ?? []).map((v) => ({
          sku: String(get(v, f.variantSku) ?? ''), label: String(get(v, f.variantLabel) ?? ''), options: {}, image: f.variantImage ? collectImages(get(v, f.variantImage))[0] : undefined,
        })).filter((v) => v.sku)
      : [];
    const cost = convertMinor(this.minor(get(d, f.price)), this.cfg.currency, 'USD', DEFAULT_FX);
    return {
      externalId: String(get(d, f.id)), title: String(get(d, f.title) ?? ''), description: String(get(d, f.description) ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
      images, videos: [], category: String(get(d, f.category) ?? ''), attributes: {}, variants, baseCostUsd: cost, tags: [],
    };
  }

  async searchProducts(p: SearchParams): Promise<SearchResult> {
    const page = p.cursor ? Number(p.cursor) : 1;
    const limit = Math.min(p.limit ?? 20, 50);
    const data = await this.call(this.cfg.endpoints.search, { query: p.query ?? '', page, limit, category: p.category ?? '' }, true);
    const list = (get(data, this.cfg.fields.list) ?? data) as unknown[];
    const items = Array.isArray(list) ? list.map((d) => this.mapProduct(d)) : [];
    return { items, nextCursor: items.length >= limit ? String(page + 1) : undefined };
  }

  async getProduct(externalId: string): Promise<SupplierProductSummary | null> {
    try {
      const d = await this.call(this.cfg.endpoints.product, { id: externalId }, true);
      return d ? this.mapProduct(d) : null;
    } catch (e) {
      if (e instanceof ProviderError && e.status === 404) return null;
      throw e;
    }
  }

  async getVariants(externalId: string): Promise<SupplierVariant[]> {
    return (await this.getProduct(externalId))?.variants ?? [];
  }

  private async quote(externalId: string, destination: CountryCode, qty: number, sku?: string): Promise<unknown> {
    const ep = this.cfg.endpoints.quote ?? this.cfg.endpoints.product;
    return this.call(ep, { id: externalId, sku: sku ?? '', country: destination, qty }, true);
  }

  async getInventory(externalId: string, sku?: string): Promise<InventoryInfo> {
    const ep = this.cfg.endpoints.stock ?? this.cfg.endpoints.quote ?? this.cfg.endpoints.product;
    const d = await this.call(ep, { id: externalId, sku: sku ?? '', country: '', qty: 1 }, true);
    const total = Math.max(0, Number(get(d, this.cfg.fields.stock) ?? 0));
    return { externalId, sku, byWarehouse: [{ warehouseCountry: this.cfg.warehouseCountry, quantity: total }], total };
  }

  async getPrice(externalId: string, destination: CountryCode, sku?: string): Promise<PriceQuote> {
    const d = await this.quote(externalId, destination, 1, sku);
    return {
      externalId, sku, destination, currency: this.cfg.currency, productCost: this.minor(get(d, this.cfg.fields.quotePrice)), fulfillmentFee: 0,
      warehouseCountry: String((this.cfg.fields.quoteWarehouse && get(d, this.cfg.fields.quoteWarehouse)) || this.cfg.warehouseCountry),
    };
  }

  async getShippingQuote(externalId: string, destination: CountryCode, quantity: number, sku?: string): Promise<ShippingQuote> {
    const d = await this.quote(externalId, destination, quantity, sku);
    const f = this.cfg.fields;
    const availableRaw = f.quoteAvailable ? get(d, f.quoteAvailable) : undefined;
    const ship = get(d, f.quoteShipping);
    const available = availableRaw === undefined ? ship !== undefined : Boolean(availableRaw);
    return {
      externalId, destination, warehouseCountry: String((f.quoteWarehouse && get(d, f.quoteWarehouse)) || this.cfg.warehouseCountry), currency: this.cfg.currency,
      shippingCost: this.minor(ship), minDays: Number(get(d, f.quoteMinDays) ?? 0), maxDays: Number(get(d, f.quoteMaxDays) ?? 0), method: 'standard', trackingAvailable: true, available,
    };
  }

  private status(raw: unknown): SupplierOrderStatus {
    return this.cfg.statusMap[String(raw ?? '').toLowerCase()] ?? 'CREATED';
  }

  async createOrder(i: CreateSupplierOrderInput): Promise<SupplierOrder> {
    const d = await this.call(this.cfg.endpoints.createOrder, {
      idempotencyKey: i.idempotencyKey, orderRef: i.orderRef, id: i.externalId, sku: i.sku, qty: i.quantity, address: i.destination, shippingMethod: i.shippingMethod ?? '',
    }, true); // the idempotency key is sent in the body/query template; suppliers must de-duplicate on it
    const id = String(get(d, this.cfg.fields.orderId) ?? '');
    if (!id) throw new ProviderError(`${this.code} createOrder returned no order id`, { provider: this.code, retryable: false });
    return { supplierOrderId: id, status: this.status(get(d, this.cfg.fields.orderStatus)), cost: { productCost: 0, shippingCost: 0, duties: 0, currency: this.cfg.currency }, createdAt: new Date().toISOString() };
  }

  async getOrder(supplierOrderId: string): Promise<SupplierOrder> {
    const d = await this.call(this.cfg.endpoints.order, { id: supplierOrderId }, true);
    const f = this.cfg.fields;
    const tn = get(d, f.trackingNumber);
    return {
      supplierOrderId, status: this.status(get(d, f.orderStatus)), trackingNumber: tn ? String(tn) : undefined, carrier: get(d, f.carrier) ? String(get(d, f.carrier)) : undefined,
      cost: { productCost: 0, shippingCost: 0, duties: 0, currency: this.cfg.currency }, createdAt: new Date().toISOString(),
    };
  }

  async cancelOrder(supplierOrderId: string): Promise<{ cancelled: boolean; reason?: string }> {
    if (!this.cfg.endpoints.cancel) return { cancelled: false, reason: 'Supplier API has no cancellation endpoint configured' };
    try {
      await this.call(this.cfg.endpoints.cancel, { id: supplierOrderId }, true);
      return { cancelled: true };
    } catch (e) {
      if (e instanceof ProviderError && !e.retryable) return { cancelled: false, reason: e.message };
      throw e;
    }
  }

  async getTracking(supplierOrderId: string): Promise<TrackingInfo> {
    const d = await this.call(this.cfg.endpoints.order, { id: supplierOrderId }, true);
    const f = this.cfg.fields;
    const tn = get(d, f.trackingNumber);
    const status = this.status(get(d, f.orderStatus));
    if (!tn) return { supplierOrderId, status, events: [], available: false }; // never invent tracking
    const events = ((f.events ? (get(d, f.events) as unknown[]) : []) ?? []).map((e) => ({
      status, description: String(get(e, 'description') ?? get(e, 'desc') ?? ''), location: get(e, 'location') ? String(get(e, 'location')) : undefined, at: new Date(String(get(e, 'at') ?? get(e, 'date') ?? Date.now())).toISOString(),
    }));
    return {
      supplierOrderId, status, carrier: get(d, f.carrier) ? String(get(d, f.carrier)) : undefined, trackingNumber: String(tn),
      trackingUrl: f.trackingUrl && get(d, f.trackingUrl) ? String(get(d, f.trackingUrl)) : undefined,
      estimatedDelivery: f.estimatedDelivery && get(d, f.estimatedDelivery) ? new Date(String(get(d, f.estimatedDelivery))).toISOString() : undefined, events, available: true,
    };
  }

  async getSupplierRating(): Promise<SupplierRating> {
    return { rating: 4, reliability: 75, returnPolicyDays: 14, trackingAvailable: true };
  }

  async healthCheck(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.call(this.cfg.endpoints.health ?? { ...this.cfg.endpoints.search, query: { ...(this.cfg.endpoints.search.query ?? {}) } }, { query: '', page: 1, limit: 1 }, true);
      return { ok: true, message: `${this.code} API reachable` };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }
}
