import type { Address, CountryCode } from '@orvia/types';

export type SupplierCurrency = 'USD' | 'CAD' | 'INR';

export interface SupplierProductSummary {
  externalId: string;
  title: string;
  description: string;
  images: string[];
  /** Only assets the supplier licenses for resale/marketing use. */
  videos: string[];
  category: string;
  attributes: Record<string, string>;
  safetyInfo?: { standards: string[]; ageRange?: string };
  variants: SupplierVariant[];
  /** Base cost in USD minor units (reference only; use getPrice for destination-specific cost). */
  baseCostUsd: number;
  tags: string[];
}

export interface SupplierVariant {
  sku: string;
  label: string;
  options: Record<string, string>;
  /** Variant-specific photo from the supplier, when it provides one. */
  image?: string;
}

export interface SearchParams {
  query?: string;
  category?: string;
  limit?: number;
  cursor?: string;
}
export interface SearchResult {
  items: SupplierProductSummary[];
  nextCursor?: string;
}

export interface InventoryInfo {
  externalId: string;
  sku?: string;
  /** stock by warehouse country */
  byWarehouse: { warehouseCountry: string; quantity: number }[];
  total: number;
}

export interface PriceQuote {
  externalId: string;
  sku?: string;
  destination: CountryCode;
  currency: SupplierCurrency;
  productCost: number;
  fulfillmentFee: number;
  warehouseCountry: string;
}

export interface ShippingQuote {
  externalId: string;
  destination: CountryCode;
  warehouseCountry: string;
  currency: SupplierCurrency;
  shippingCost: number;
  minDays: number;
  maxDays: number;
  method: string;
  trackingAvailable: boolean;
  available: boolean;
}

export interface CreateSupplierOrderInput {
  /** Provider MUST treat a repeated key as the same order (never create duplicates). */
  idempotencyKey: string;
  orderRef: string;
  externalId: string;
  sku: string;
  quantity: number;
  destination: Address;
  shippingMethod?: string;
}

export type SupplierOrderStatus =
  | 'CREATED'
  | 'SHIPPED'
  | 'IN_TRANSIT'
  | 'OUT_FOR_DELIVERY'
  | 'DELIVERED'
  | 'CANCELLED'
  | 'FAILED';

export interface SupplierOrder {
  supplierOrderId: string;
  status: SupplierOrderStatus;
  trackingNumber?: string;
  carrier?: string;
  cost: { productCost: number; shippingCost: number; duties: number; currency: SupplierCurrency };
  createdAt: string;
}

export interface TrackingEvent {
  status: SupplierOrderStatus;
  description: string;
  location?: string;
  at: string;
}

export interface TrackingInfo {
  supplierOrderId: string;
  status: SupplierOrderStatus;
  carrier?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  estimatedDelivery?: string;
  events: TrackingEvent[];
  /** false when the supplier has no tracking yet — callers must NOT invent any. */
  available: boolean;
}

export interface SupplierRating {
  rating: number; // 0-5
  reliability: number; // 0-100
  returnPolicyDays: number;
  trackingAvailable: boolean;
}

export interface SupplierProvider {
  readonly key: string;
  searchProducts(p: SearchParams): Promise<SearchResult>;
  getProduct(externalId: string): Promise<SupplierProductSummary | null>;
  getVariants(externalId: string): Promise<SupplierVariant[]>;
  getInventory(externalId: string, sku?: string): Promise<InventoryInfo>;
  getPrice(externalId: string, destination: CountryCode, sku?: string): Promise<PriceQuote>;
  getShippingQuote(externalId: string, destination: CountryCode, quantity: number): Promise<ShippingQuote>;
  createOrder(input: CreateSupplierOrderInput): Promise<SupplierOrder>;
  getOrder(supplierOrderId: string): Promise<SupplierOrder>;
  cancelOrder(supplierOrderId: string): Promise<{ cancelled: boolean; reason?: string }>;
  getTracking(supplierOrderId: string): Promise<TrackingInfo>;
  getSupplierRating(): Promise<SupplierRating>;
  healthCheck(): Promise<{ ok: boolean; message: string }>;
}

/** A complete, destination-specific offer assembled from price + shipping + inventory calls. */
export interface LiveOffer {
  externalId: string;
  sku?: string;
  destination: CountryCode;
  warehouseCountry: string;
  currency: SupplierCurrency;
  productCost: number;
  shippingCost: number;
  fulfillmentFee: number;
  minDays: number;
  maxDays: number;
  stock: number;
  available: boolean;
  trackingAvailable: boolean;
}

export async function fetchLiveOffer(
  p: SupplierProvider,
  externalId: string,
  destination: CountryCode,
  quantity = 1,
  sku?: string,
): Promise<LiveOffer> {
  const [price, ship, inv] = await Promise.all([
    p.getPrice(externalId, destination, sku),
    p.getShippingQuote(externalId, destination, quantity),
    p.getInventory(externalId, sku),
  ]);
  return {
    externalId,
    sku,
    destination,
    warehouseCountry: ship.warehouseCountry || price.warehouseCountry,
    currency: price.currency,
    productCost: price.productCost,
    shippingCost: ship.shippingCost,
    fulfillmentFee: price.fulfillmentFee,
    minDays: ship.minDays,
    maxDays: ship.maxDays,
    stock: inv.byWarehouse.filter((w) => w.warehouseCountry === ship.warehouseCountry).reduce((a, w) => a + w.quantity, 0) || inv.total,
    available: ship.available && inv.total > 0,
    trackingAvailable: ship.trackingAvailable,
  };
}
