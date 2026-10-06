/**
 * CJ Dropshipping adapter (official API v2.0 — https://developers.cjdropshipping.com).
 *
 * IMPORTANT: this adapter is implemented from the public API documentation and is covered by
 * mocked-HTTP tests only. Field names must be validated against a live CJ account before going
 * live (see docs/SUPPLIERS.md). By convention: externalId = CJ product id (pid), sku = CJ variant id (vid).
 */
import { CircuitBreaker, ProviderError, fetchJson } from '@orvia/config';
import { DEFAULT_COUNTRIES, DEFAULT_FX, convertMinor } from '@orvia/types';
import type { CountryCode } from '@orvia/types';
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
  TrackingInfo,
} from './types';

const BASE = 'https://developers.cjdropshipping.com/api2.0/v1';

interface CjEnvelope<T> {
  code: number;
  result?: boolean;
  message?: string;
  data: T;
}

const toMinorUsd = (v: unknown): number => Math.round(Number(v ?? 0) * 100);

/** Collect product photos from every field CJ uses (single URL, JSON-encoded array, or array), https only, deduped. */
export function extractImages(d: Record<string, unknown>): string[] {
  const out: string[] = [];
  const add = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(add);
    if (typeof v !== 'string') return;
    const t = v.trim();
    if (t.startsWith('[')) {
      try { return add(JSON.parse(t)); } catch { return; }
    }
    if (/^https?:\/\//i.test(t) && !out.includes(t)) out.push(t.replace(/^http:\/\//i, 'https://'));
  };
  add(d['productImageSet']);
  add(d['productImage']);
  add(d['bigImage']);
  add(d['image']);
  return out;
}

export class CjDropshippingProvider implements SupplierProvider {
  readonly key = 'cj';
  private token?: { value: string; expiresAt: number };
  private readonly breaker = new CircuitBreaker('cj', { failureThreshold: 5, resetMs: 30_000 });

  constructor(
    private readonly apiKey: string,
    private readonly opts: { fetchImpl?: typeof fetch; baseUrl?: string } = {},
  ) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const res = await fetchJson<CjEnvelope<{ accessToken: string; accessTokenExpiryDate?: string }>>(
      `${this.opts.baseUrl ?? BASE}/authentication/getAccessToken`,
      { provider: 'cj', method: 'POST', body: { apiKey: this.apiKey }, idempotent: true, fetchImpl: this.opts.fetchImpl, breaker: this.breaker },
    );
    if (!res.data?.accessToken) throw new ProviderError(`CJ auth failed: ${res.message ?? 'no token'}`, { provider: 'cj', retryable: false });
    const exp = res.data.accessTokenExpiryDate ? Date.parse(res.data.accessTokenExpiryDate) : Date.now() + 10 * 24 * 3600_000;
    this.token = { value: res.data.accessToken, expiresAt: Number.isFinite(exp) ? exp : Date.now() + 3600_000 };
    return this.token.value;
  }

  private async call<T>(path: string, o: { method?: string; body?: unknown; query?: Record<string, string>; idempotent?: boolean } = {}): Promise<T> {
    const token = await this.accessToken();
    const qs = o.query ? '?' + new URLSearchParams(o.query).toString() : '';
    const res = await fetchJson<CjEnvelope<T>>(`${this.opts.baseUrl ?? BASE}${path}${qs}`, {
      provider: 'cj',
      method: o.method,
      body: o.body,
      headers: { 'CJ-Access-Token': token },
      idempotent: o.idempotent,
      fetchImpl: this.opts.fetchImpl,
      breaker: this.breaker,
    });
    if (res.code !== 200 || res.result === false) {
      throw new ProviderError(`CJ ${path} error ${res.code}: ${res.message ?? 'unknown'}`, {
        provider: 'cj',
        retryable: res.code === 429 || res.code >= 500,
        status: res.code,
      });
    }
    return res.data;
  }

  private mapProduct(d: Record<string, unknown>): SupplierProductSummary {
    const images = extractImages(d);
    const cost = String(d['sellPrice'] ?? '0').split('--')[0];
    return {
      externalId: String(d['pid'] ?? d['id']),
      title: String(d['productNameEn'] ?? d['productName'] ?? ''),
      description: String(d['description'] ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(),
      images,
      videos: [], // CJ video licensing is not asserted; do not import videos automatically
      category: String(d['categoryName'] ?? ''),
      attributes: { Material: String(d['materialNameEn'] ?? '') },
      variants: [],
      baseCostUsd: toMinorUsd(cost),
      tags: [],
    };
  }

  async searchProducts(p: SearchParams): Promise<SearchResult> {
    const page = p.cursor ? Number(p.cursor) : 1;
    const limit = Math.min(p.limit ?? 20, 50);
    const data = await this.call<{ list: Record<string, unknown>[]; total: number }>('/product/list', {
      query: { pageNum: String(page), pageSize: String(limit), ...(p.query ? { productNameEn: p.query } : {}) },
      idempotent: true,
    });
    return { items: (data.list ?? []).map((d) => this.mapProduct(d)), nextCursor: page * limit < (data.total ?? 0) ? String(page + 1) : undefined };
  }

  async getProduct(externalId: string): Promise<SupplierProductSummary | null> {
    try {
      const d = await this.call<Record<string, unknown>>('/product/query', { query: { pid: externalId }, idempotent: true });
      const prod = this.mapProduct(d);
      prod.variants = await this.getVariants(externalId);
      return prod;
    } catch (e) {
      if (e instanceof ProviderError && e.status === 404) return null;
      throw e;
    }
  }

  async getVariants(externalId: string): Promise<SupplierVariant[]> {
    const list = await this.call<Record<string, unknown>[]>('/product/variant/query', { query: { pid: externalId }, idempotent: true });
    return (list ?? []).map((v) => ({
      sku: String(v['vid']),
      label: String(v['variantNameEn'] ?? v['variantKey'] ?? v['vid']),
      options: { Option: String(v['variantKey'] ?? '') },
      image: extractImages({ image: v['variantImage'] })[0],
    }));
  }

  async getInventory(externalId: string, sku?: string): Promise<InventoryInfo> {
    if (!sku) throw new ProviderError('CJ inventory requires a variant id (sku)', { provider: 'cj', retryable: false });
    const rows = await this.call<{ countryCode: string; storageNum: number }[]>('/product/stock/queryByVid', { query: { vid: sku }, idempotent: true });
    const byWarehouse = (rows ?? []).map((r) => ({ warehouseCountry: r.countryCode, quantity: Number(r.storageNum ?? 0) }));
    return { externalId, sku, byWarehouse, total: byWarehouse.reduce((a, w) => a + w.quantity, 0) };
  }

  async getPrice(externalId: string, destination: CountryCode, sku?: string): Promise<PriceQuote> {
    const variants = await this.call<Record<string, unknown>[]>('/product/variant/query', { query: { pid: externalId }, idempotent: true });
    const v = variants.find((x) => String(x['vid']) === sku) ?? variants[0];
    if (!v) throw new ProviderError('CJ variant not found', { provider: 'cj', retryable: false, status: 404 });
    const currency = DEFAULT_COUNTRIES[destination].currency;
    return {
      externalId,
      sku,
      destination,
      currency,
      productCost: convertMinor(toMinorUsd(v['variantSellPrice']), 'USD', currency, DEFAULT_FX),
      fulfillmentFee: 0,
      warehouseCountry: 'CN', // refined by getShippingQuote/getInventory (CJ reports warehouse via stock endpoint)
    };
  }

  async getShippingQuote(externalId: string, destination: CountryCode, quantity: number, sku?: string, fromCountry = 'CN'): Promise<ShippingQuote> {
    const currency = DEFAULT_COUNTRIES[destination].currency;
    const rows = await this.call<{ logisticName: string; logisticPrice: number; logisticAging: string }[]>('/logistic/freightCalculate', {
      method: 'POST',
      body: { startCountryCode: fromCountry, endCountryCode: destination, products: [{ quantity, vid: sku ?? externalId }] },
      idempotent: true,
    });
    const best = [...(rows ?? [])].sort((a, b) => a.logisticPrice - b.logisticPrice)[0];
    if (!best) {
      return { externalId, destination, warehouseCountry: fromCountry, currency, shippingCost: 0, minDays: 0, maxDays: 0, method: 'none', trackingAvailable: false, available: false };
    }
    const [min, max] = String(best.logisticAging).split('-').map((n) => Number(n));
    return {
      externalId,
      destination,
      warehouseCountry: fromCountry,
      currency,
      shippingCost: convertMinor(toMinorUsd(best.logisticPrice), 'USD', currency, DEFAULT_FX),
      minDays: min || 7,
      maxDays: max || min || 15,
      method: best.logisticName,
      trackingAvailable: true,
      available: true,
    };
  }

  async createOrder(i: CreateSupplierOrderInput): Promise<SupplierOrder> {
    // CJ de-duplicates on `orderNumber`; we pass our idempotency key so retries cannot double-order.
    const d = await this.call<{ orderId: string; orderStatus?: string }>('/shopping/order/createOrderV2', {
      method: 'POST',
      body: {
        orderNumber: i.idempotencyKey,
        shippingCountryCode: i.destination.country,
        shippingProvince: i.destination.region,
        shippingCity: i.destination.city,
        shippingAddress: [i.destination.line1, i.destination.line2].filter(Boolean).join(', '),
        shippingCustomerName: i.destination.fullName,
        shippingPhone: i.destination.phone,
        shippingZip: i.destination.postalCode,
        products: [{ vid: i.sku, quantity: i.quantity }],
        remark: i.orderRef,
      },
      idempotent: false,
    });
    return this.getOrder(d.orderId).catch(() => ({
      supplierOrderId: d.orderId,
      status: 'CREATED' as SupplierOrderStatus,
      cost: { productCost: 0, shippingCost: 0, duties: 0, currency: 'USD' as const },
      createdAt: new Date().toISOString(),
    }));
  }

  private mapStatus(s: string | undefined): SupplierOrderStatus {
    switch ((s ?? '').toUpperCase()) {
      case 'SHIPPED': return 'SHIPPED';
      case 'DELIVERED': return 'DELIVERED';
      case 'CANCELLED': return 'CANCELLED';
      default: return 'CREATED';
    }
  }

  async getOrder(supplierOrderId: string): Promise<SupplierOrder> {
    const d = await this.call<Record<string, unknown>>('/shopping/order/getOrderDetail', { query: { orderId: supplierOrderId }, idempotent: true });
    return {
      supplierOrderId,
      status: this.mapStatus(String(d['orderStatus'])),
      trackingNumber: d['trackNumber'] ? String(d['trackNumber']) : undefined,
      carrier: d['logisticName'] ? String(d['logisticName']) : undefined,
      cost: { productCost: toMinorUsd(d['productAmount']), shippingCost: toMinorUsd(d['postageAmount']), duties: 0, currency: 'USD' },
      createdAt: String(d['createDate'] ?? new Date().toISOString()),
    };
  }

  async cancelOrder(supplierOrderId: string): Promise<{ cancelled: boolean; reason?: string }> {
    try {
      await this.call('/shopping/order/deleteOrder', { method: 'DELETE', query: { orderId: supplierOrderId }, idempotent: true });
      return { cancelled: true };
    } catch (e) {
      if (e instanceof ProviderError && !e.retryable) return { cancelled: false, reason: e.message };
      throw e;
    }
  }

  async getTracking(supplierOrderId: string): Promise<TrackingInfo> {
    const order = await this.getOrder(supplierOrderId);
    if (!order.trackingNumber) return { supplierOrderId, status: order.status, events: [], available: false };
    const rows = await this.call<{ trackingNumber: string; logisticName?: string; trackingFrom?: string; trackingDetails?: { date?: string; desc?: string; area?: string }[] }[]>(
      '/logistic/trackInfo',
      { query: { trackNumber: order.trackingNumber }, idempotent: true },
    ).catch(() => []);
    const row = rows?.[0];
    const events = (row?.trackingDetails ?? []).map((e) => ({
      status: 'IN_TRANSIT' as SupplierOrderStatus,
      description: e.desc ?? '',
      location: e.area,
      at: e.date ? new Date(e.date).toISOString() : new Date().toISOString(),
    }));
    const delivered = events.some((e) => /deliver/i.test(e.description) && !/out for/i.test(e.description));
    return {
      supplierOrderId,
      status: delivered ? 'DELIVERED' : order.status === 'CREATED' ? 'SHIPPED' : order.status,
      carrier: row?.logisticName ?? order.carrier,
      trackingNumber: order.trackingNumber,
      events,
      available: true,
    };
  }

  async getSupplierRating(): Promise<SupplierRating> {
    // CJ does not expose a per-account rating API. Real reliability is computed from our own
    // shipment history (see core/supplierStats); these are neutral priors.
    return { rating: 4, reliability: 75, returnPolicyDays: 14, trackingAvailable: true };
  }

  async healthCheck(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.accessToken();
      return { ok: true, message: 'CJ authentication succeeded' };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }
}
