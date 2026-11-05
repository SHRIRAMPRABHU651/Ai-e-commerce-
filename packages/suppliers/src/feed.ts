/**
 * Generic CSV/JSON feed adapter ("feed"): READ-ONLY catalogue, price and stock from a supplier-hosted file.
 *
 * - The URL is fetched through an injected SSRF-safe fetcher (the core wires `guardedFetch`); this package never
 *   opens sockets to arbitrary hosts itself.
 * - Ordering is NOT possible: `createOrder` always refuses. Orders for feed suppliers go through the same manual order
 *   queue as `manual` suppliers (MANUAL_FULFILLMENT exception -> `recordManualFulfillment`), and order status/tracking
 *   are whatever was recorded on the shipment.
 * - Nothing is invented: a stale or unreachable feed is an error, never a guess.
 * Never exercised against a live supplier feed from this repository.
 */
import { ProviderError } from '@orvia/config';
import { DEFAULT_FX, convertMinor, feedConfigSchema } from '@orvia/types';
import type { CountryCode, FeedConfig } from '@orvia/types';
import { parseCsv } from './csv';
import type {
  CreateSupplierOrderInput, InventoryInfo, PriceQuote, SearchParams, SearchResult, ShippingQuote, SupplierOrder,
  SupplierOrderStatus, SupplierProductSummary, SupplierProvider, SupplierRating, SupplierVariant, TrackingInfo,
} from './types';

export { feedConfigSchema };

export interface FeedItem {
  externalId: string;
  title: string;
  description: string;
  images: string[];
  category: string;
  brand?: string;
  gtin?: string;
  mpn?: string;
  priceMinor: number;
  shippingMinor: number;
  stock: number;
  minDays: number;
  maxDays: number;
  variantSku?: string;
}

const getPath = (o: unknown, path: string): unknown => path.split('.').reduce<unknown>((a, k) => (a && typeof a === 'object' ? (a as Record<string, unknown>)[k] : undefined), o);
const str = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'string' ? v.trim() : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');

/** "$1,299.50", "19,99" (decimal comma), "1299" -> minor units. Returns null for anything that is not a plain non-negative amount. */
export function parseMoney(raw: string, unit: 'major' | 'minor'): number | null {
  let s = raw.replace(/[^\d.,-]/g, '');
  if (!s || s === '-') return null;
  if (/,\d{1,2}$/.test(s) && !/\./.test(s)) s = s.replace(',', '.'); // decimal comma
  else s = s.replace(/,/g, '');
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return unit === 'minor' ? Math.round(n) : Math.round(n * 100);
}

export function parseInteger(raw: string): number | null {
  if (!/^\d{1,9}$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

/** Pure: raw text -> flat rows. */
export function readFeedRows(text: string, cfg: FeedConfig): { rows: Record<string, unknown>[]; errors: string[] } {
  if (cfg.format === 'csv') {
    const r = parseCsv(text, { delimiter: cfg.delimiter, maxRows: cfg.maxRows });
    return { rows: r.rows, errors: r.errors };
  }
  let json: unknown;
  try { json = JSON.parse(text); } catch { return { rows: [], errors: ['Feed is not valid JSON'] }; }
  const list = cfg.listPath ? getPath(json, cfg.listPath) : json;
  if (!Array.isArray(list)) return { rows: [], errors: [`No array found at "${cfg.listPath ?? '(root)'}"`] };
  return { rows: list.slice(0, cfg.maxRows).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object'), errors: list.length > cfg.maxRows ? [`More than ${cfg.maxRows} rows: the rest was ignored`] : [] };
}

/** Pure: apply the supplier's schema mapping to one raw row. Rejected rows carry an error and are never ingested. */
export function mapFeedRow(row: Record<string, unknown>, cfg: FeedConfig): { item?: FeedItem; error?: string } {
  const f = cfg.fields;
  const id = str(getPath(row, f.id));
  const title = str(getPath(row, f.title));
  if (!id) return { error: `missing "${f.id}"` };
  if (!title) return { error: `${id}: missing "${f.title}"` };
  const price = parseMoney(str(getPath(row, f.price)), cfg.priceUnit);
  if (price === null) return { error: `${id}: invalid price "${str(getPath(row, f.price))}"` };
  const stockRaw = str(getPath(row, f.stock));
  const stock = parseInteger(stockRaw);
  if (stock === null) return { error: `${id}: invalid stock "${stockRaw}"` };
  const shipRaw = f.shippingCost ? str(getPath(row, f.shippingCost)) : '';
  const ship = shipRaw ? parseMoney(shipRaw, cfg.priceUnit) : Math.round(cfg.defaults.shippingCost * (cfg.priceUnit === 'minor' ? 1 : 100));
  if (ship === null) return { error: `${id}: invalid shipping cost "${shipRaw}"` };
  const minRaw = f.minDays ? str(getPath(row, f.minDays)) : '';
  const maxRaw = f.maxDays ? str(getPath(row, f.maxDays)) : '';
  const minDays = minRaw ? parseInteger(minRaw) : cfg.defaults.minDays;
  const maxDays = maxRaw ? parseInteger(maxRaw) : cfg.defaults.maxDays;
  if (minDays === null || maxDays === null || maxDays < minDays) return { error: `${id}: invalid delivery days` };
  const imgRaw = f.images ? getPath(row, f.images) : undefined;
  const images = (Array.isArray(imgRaw) ? imgRaw.map(str) : str(imgRaw).split(cfg.imageSeparator)).map((s) => s.trim()).filter((u) => /^https:\/\//i.test(u)).slice(0, 12);
  const gtinRaw = f.gtin ? str(getPath(row, f.gtin)).replace(/\D/g, '') : '';
  return {
    item: {
      externalId: id, title: title.slice(0, 300), description: f.description ? str(getPath(row, f.description)).slice(0, 5000) : '', images,
      category: f.category ? str(getPath(row, f.category)).slice(0, 100) : '', brand: f.brand ? str(getPath(row, f.brand)) || undefined : undefined,
      gtin: [8, 12, 13, 14].includes(gtinRaw.length) ? gtinRaw : undefined, mpn: f.mpn ? str(getPath(row, f.mpn)) || undefined : undefined,
      priceMinor: price, shippingMinor: ship, stock, minDays, maxDays, variantSku: f.variantSku ? str(getPath(row, f.variantSku)) || undefined : undefined,
    },
  };
}

export function parseFeed(text: string, cfg: FeedConfig): { items: FeedItem[]; errors: string[]; rowCount: number } {
  const { rows, errors } = readFeedRows(text, cfg);
  const items: FeedItem[] = [];
  for (const r of rows) {
    const m = mapFeedRow(r, cfg);
    if (m.item) items.push(m.item);
    else if (errors.length < 50) errors.push(m.error!);
  }
  return { items, errors, rowCount: rows.length };
}

export interface FeedDeps {
  /** SSRF-safe fetch of the feed URL. Must refuse private/loopback addresses. */
  fetchText(url: string, headers: Record<string, string>): Promise<{ status: number; text: string }>;
  /** Shipment facts recorded by operators (the feed itself has no order API). */
  shipmentLookup?: (supplierOrderId: string) => Promise<{ status: string; trackingNumber?: string; carrier?: string; createdAt: Date } | null>;
  now?: () => number;
}

interface FeedCache { at: number; items: FeedItem[]; byId: Map<string, FeedItem[]>; errors: string[]; rowCount: number }

export class FeedSupplierProvider implements SupplierProvider {
  readonly key = 'feed';
  private cache?: FeedCache;
  private inflight?: Promise<void>;
  private readonly cfg: FeedConfig;

  constructor(private readonly code: string, config: unknown, private readonly apiKey: string | undefined, private readonly deps: FeedDeps) {
    const parsed = feedConfigSchema.safeParse(config);
    if (!parsed.success) {
      throw new ProviderError(`Supplier ${code}: invalid feed mapping — ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, { provider: code, retryable: false });
    }
    this.cfg = parsed.data;
  }

  private now(): number { return (this.deps.now ?? Date.now)(); }

  /** Fetches (or reuses a fresh copy of) the feed. Never serves data older than `cacheSeconds` when the refresh fails. */
  async load(force = false): Promise<FeedCache> {
    const c = this.cache;
    if (!force && c && this.now() - c.at < this.cfg.cacheSeconds * 1000) return c;
    if (!this.inflight) {
      this.inflight = (async () => {
        const headers: Record<string, string> = { accept: this.cfg.format === 'csv' ? 'text/csv, text/plain, */*' : 'application/json, */*' };
        let url = this.cfg.url;
        if (this.cfg.auth.type !== 'none') {
          if (!this.apiKey) throw new ProviderError(`Supplier ${this.code}: feed API key not set`, { provider: this.code, retryable: false });
          if (this.cfg.auth.type === 'bearer') headers['authorization'] = `Bearer ${this.apiKey}`;
          else if (this.cfg.auth.type === 'header') headers[this.cfg.auth.name.toLowerCase()] = this.apiKey;
          else { const u = new URL(url); u.searchParams.set(this.cfg.auth.name, this.apiKey); url = u.toString(); }
        }
        let res;
        try { res = await this.deps.fetchText(url, headers); } catch (e) { throw new ProviderError(`Feed fetch failed: ${(e as Error).message}`, { provider: this.code, retryable: true, cause: e }); }
        if (res.status < 200 || res.status >= 300) throw new ProviderError(`Feed returned HTTP ${res.status}`, { provider: this.code, retryable: res.status >= 500 || res.status === 429, status: res.status });
        const parsed = parseFeed(res.text, this.cfg);
        if (!parsed.items.length) throw new ProviderError(`Feed contained no valid rows (${parsed.errors.slice(0, 3).join('; ') || 'empty'})`, { provider: this.code, retryable: false });
        const byId = new Map<string, FeedItem[]>();
        for (const it of parsed.items) byId.set(it.externalId, [...(byId.get(it.externalId) ?? []), it]);
        this.cache = { at: this.now(), items: parsed.items, byId, errors: parsed.errors, rowCount: parsed.rowCount };
      })().finally(() => { this.inflight = undefined; });
    }
    await this.inflight;
    return this.cache!;
  }

  private async rows(externalId: string, sku?: string): Promise<FeedItem[]> {
    const rows = (await this.load()).byId.get(externalId);
    if (!rows?.length) throw new ProviderError(`Product ${externalId} is not in the feed`, { provider: this.code, retryable: false, status: 404 });
    const bySku = sku ? rows.filter((r) => (r.variantSku ?? r.externalId) === sku) : [];
    return bySku.length ? bySku : rows;
  }

  private toUsd(minor: number): number { return this.cfg.currency === 'USD' ? minor : convertMinor(minor, this.cfg.currency, 'USD', DEFAULT_FX); }

  private summary(rows: FeedItem[]): SupplierProductSummary {
    const r = rows[0]!;
    const variants: SupplierVariant[] = rows.some((x) => x.variantSku) ? rows.map((x) => ({ sku: x.variantSku ?? x.externalId, label: x.variantSku ?? x.title, options: {} })) : [{ sku: r.externalId, label: 'Default', options: {} }];
    return {
      externalId: r.externalId, title: r.title, description: r.description, images: r.images, videos: [], category: r.category,
      attributes: { ...(r.brand ? { brand: r.brand } : {}), ...(r.gtin ? { gtin: r.gtin } : {}), ...(r.mpn ? { mpn: r.mpn } : {}) }, variants,
      baseCostUsd: this.toUsd(Math.min(...rows.map((x) => x.priceMinor))), tags: [],
    };
  }

  async searchProducts(p: SearchParams): Promise<SearchResult> {
    const { byId } = await this.load();
    const q = p.query?.toLowerCase().trim();
    const all = [...byId.values()].filter((rows) => (!q || rows[0]!.title.toLowerCase().includes(q)) && (!p.category || rows[0]!.category === p.category));
    const start = Math.max(0, Number(p.cursor ?? 0) || 0);
    const limit = Math.min(p.limit ?? 20, 100);
    const page = all.slice(start, start + limit);
    return { items: page.map((r) => this.summary(r)), nextCursor: start + limit < all.length ? String(start + limit) : undefined };
  }
  async getProduct(externalId: string) {
    const rows = (await this.load()).byId.get(externalId);
    return rows ? this.summary(rows) : null;
  }
  async getVariants(externalId: string) { return (await this.getProduct(externalId))?.variants ?? []; }
  async getInventory(externalId: string, sku?: string): Promise<InventoryInfo> {
    const rows = await this.rows(externalId, sku);
    const total = rows.reduce((a, r) => a + r.stock, 0);
    return { externalId, sku, byWarehouse: [{ warehouseCountry: this.cfg.warehouseCountry, quantity: total }], total };
  }
  async getPrice(externalId: string, destination: CountryCode, sku?: string): Promise<PriceQuote> {
    const r = (await this.rows(externalId, sku))[0]!;
    return { externalId, sku, destination, currency: this.cfg.currency, productCost: r.priceMinor, fulfillmentFee: 0, warehouseCountry: this.cfg.warehouseCountry };
  }
  async getShippingQuote(externalId: string, destination: CountryCode): Promise<ShippingQuote> {
    const rows = await this.rows(externalId);
    const r = rows[0]!;
    return { externalId, destination, warehouseCountry: this.cfg.warehouseCountry, currency: this.cfg.currency, shippingCost: r.shippingMinor, minDays: r.minDays, maxDays: r.maxDays, method: 'feed', trackingAvailable: true, available: rows.some((x) => x.stock > 0) };
  }
  async createOrder(_i: CreateSupplierOrderInput): Promise<SupplierOrder> {
    throw new ProviderError('Feed suppliers are read-only: place the order with the supplier and record it in Admin → Exceptions (manual order queue)', { provider: this.code, retryable: false });
  }
  async getOrder(supplierOrderId: string): Promise<SupplierOrder> {
    const s = await this.deps.shipmentLookup?.(supplierOrderId);
    if (!s) throw new ProviderError('Unknown order for this feed supplier (orders are recorded manually)', { provider: this.code, retryable: false, status: 404 });
    return { supplierOrderId, status: (s.status === 'PENDING_CREATE' ? 'CREATED' : s.status) as SupplierOrderStatus, trackingNumber: s.trackingNumber, carrier: s.carrier, cost: { productCost: 0, shippingCost: 0, duties: 0, currency: 'USD' }, createdAt: s.createdAt.toISOString() };
  }
  async cancelOrder() { return { cancelled: false, reason: 'Feed supplier: cancel with the supplier directly' }; }
  async getTracking(supplierOrderId: string): Promise<TrackingInfo> {
    const s = await this.deps.shipmentLookup?.(supplierOrderId);
    if (!s?.trackingNumber) return { supplierOrderId, status: (s?.status ?? 'CREATED') as SupplierOrderStatus, events: [], available: false };
    return { supplierOrderId, status: s.status as SupplierOrderStatus, carrier: s.carrier, trackingNumber: s.trackingNumber, events: [], available: true };
  }
  async getSupplierRating(): Promise<SupplierRating> { return { rating: 4, reliability: 70, returnPolicyDays: 14, trackingAvailable: true }; }
  async healthCheck() {
    try {
      const c = await this.load(true);
      return { ok: true, message: `Feed OK: ${c.items.length} valid row(s) of ${c.rowCount}${c.errors.length ? `, ${c.errors.length} rejected` : ''}` };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }
}
