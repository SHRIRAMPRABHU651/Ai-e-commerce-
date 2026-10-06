/**
 * Provider capability registry. Every adapter declares what it can really do; the platform never assumes a
 * capability that is not declared, and never reports an integration as "verified" unless an operator's
 * validation run (or a live contract test) proved it.
 */
import { restSupplierConfigSchema } from './rest';

export const CAPABILITIES = [
  'catalog', 'productDetails', 'inventory', 'pricing', 'shippingQuotes', 'createOrder', 'cancelOrder', 'tracking', 'returns',
  'images', 'videos', 'variants', 'warehouses', 'singleUnit', 'dropshipping', 'webhooks',
] as const;
export type Capability = (typeof CAPABILITIES)[number];
export type CapabilityState = 'supported' | 'unsupported' | 'unknown';

/** What a human must do for orders on this supplier. AUTOMATED = we place and track via API. */
export type FulfillmentMode = 'AUTOMATED' | 'ASSISTED' | 'MANUAL';
export type IntegrationStatus = 'mock' | 'implemented_unverified' | 'configurable' | 'manual' | 'planned';

export interface ProviderDefinition {
  key: string;
  name: string;
  /** dropshipping, regional, print_on_demand, manufacturer, specialty, custom_api, manual */
  supplierType: string;
  supportedCountries: string[] | 'any';
  supportedCurrencies: string[] | 'any';
  auth: 'api_key' | 'oauth' | 'custom' | 'none';
  sandbox: boolean | 'unknown';
  rateLimit: string;
  credentialFields: string[];
  catalogMode: 'API' | 'MANUAL_IMPORT';
  orderingMode: 'API' | 'MANUAL';
  integrationStatus: IntegrationStatus;
  capabilities: Record<Capability, CapabilityState>;
  notes: string;
}

const caps = (supported: Capability[], unknown: Capability[] = []): Record<Capability, CapabilityState> =>
  Object.fromEntries(CAPABILITIES.map((c) => [c, supported.includes(c) ? 'supported' : unknown.includes(c) ? 'unknown' : 'unsupported'])) as Record<Capability, CapabilityState>;

export const PROVIDER_DEFINITIONS: ProviderDefinition[] = [
  {
    key: 'cj', name: 'CJ Dropshipping', supplierType: 'dropshipping', supportedCountries: 'any', supportedCurrencies: ['USD'], auth: 'api_key', sandbox: 'unknown',
    rateLimit: 'per CJ account (documented ~1 req/s on free plan; the adapter backs off on 429)', credentialFields: ['apiKey'], catalogMode: 'API', orderingMode: 'API', integrationStatus: 'implemented_unverified',
    capabilities: caps(['catalog', 'productDetails', 'inventory', 'pricing', 'shippingQuotes', 'createOrder', 'cancelOrder', 'tracking', 'images', 'variants', 'warehouses', 'singleUnit', 'dropshipping']),
    notes: 'Written from CJ’s public API docs; never exercised against a live CJ account from this repo. Verify with the supplier validation suite before enabling AUTOMATED fulfilment.',
  },
  {
    key: 'rest', name: 'Configurable REST supplier', supplierType: 'custom_api', supportedCountries: 'any', supportedCurrencies: ['USD', 'CAD', 'INR'], auth: 'custom', sandbox: 'unknown',
    rateLimit: 'configured per supplier (concurrency + retry/backoff in the adapter)', credentialFields: ['apiKey'], catalogMode: 'API', orderingMode: 'API', integrationStatus: 'configurable',
    // actual capabilities are derived from the supplier's own endpoint mapping (see capabilitiesForSupplier)
    capabilities: caps([], ['catalog', 'productDetails', 'inventory', 'pricing', 'shippingQuotes', 'createOrder', 'cancelOrder', 'tracking', 'images', 'variants', 'singleUnit', 'dropshipping']),
    notes: 'Any supplier with a JSON/HTTP API can be onboarded from the admin panel by describing its endpoints and fields. Capabilities are derived from the mapping you provide and proven by the validation suite.',
  },
  {
    key: 'manual', name: 'Manual / assisted supplier (no API)', supplierType: 'manual', supportedCountries: 'any', supportedCurrencies: 'any', auth: 'none', sandbox: false,
    rateLimit: 'n/a', credentialFields: [], catalogMode: 'MANUAL_IMPORT', orderingMode: 'MANUAL', integrationStatus: 'manual',
    capabilities: caps(['catalog', 'productDetails', 'inventory', 'pricing', 'shippingQuotes', 'images', 'variants', 'singleUnit', 'dropshipping']),
    notes: 'For suppliers without a reliable API: an operator enters offers (cost, shipping, stock, delivery) and places each order by hand; the platform raises a task per order and records the supplier order id and tracking you enter. Stock/price data goes stale and expires — it never pretends to be live.',
  },
  {
    key: 'mock', name: 'Mock supplier (development/testing only)', supplierType: 'mock', supportedCountries: ['US', 'CA', 'IN'], supportedCurrencies: ['USD', 'CAD', 'INR'], auth: 'none', sandbox: true,
    rateLimit: 'n/a', credentialFields: [], catalogMode: 'API', orderingMode: 'API', integrationStatus: 'mock',
    capabilities: caps(['catalog', 'productDetails', 'inventory', 'pricing', 'shippingQuotes', 'createOrder', 'cancelOrder', 'tracking', 'images', 'variants', 'warehouses', 'singleUnit', 'dropshipping']),
    notes: 'Refused outside development/test. Never counts toward launch readiness.',
  },
];

/**
 * Providers that are commonly used but for which this repo has NO adapter. They are listed so operators know the
 * honest status; onboard them through the configurable REST adapter if the supplier gives you API docs, or the manual provider otherwise.
 */
export const PLANNED_PROVIDERS = ['AliExpress (official programs)', 'DSers', 'Spocket', 'Zendrop', 'Syncee', 'DropCommerce', 'Wholesale2B', 'Modalyst', 'Printful', 'Printify'].map((name) => ({
  name,
  integrationStatus: 'planned' as const,
  note: 'No adapter in this repository and no verified API contract. Use the configurable REST adapter with the supplier’s API documentation, or the manual provider.',
}));

export const providerDefinition = (key: string): ProviderDefinition | undefined => PROVIDER_DEFINITIONS.find((p) => p.key === key);

/** The mapping a `rest` supplier uses determines which capabilities it can honestly claim. */
export function capabilitiesForRest(config: { endpoints?: Record<string, unknown>; fields?: Record<string, unknown> } | null | undefined): Record<Capability, CapabilityState> {
  const e = config?.endpoints ?? {};
  const has = (k: string) => !!e[k];
  const f = config?.fields ?? {};
  const s: Capability[] = [];
  if (has('search')) s.push('catalog');
  if (has('product')) s.push('productDetails', 'variants');
  if (has('product') && (Array.isArray(f['images']) ? (f['images'] as unknown[]).length : true)) s.push('images');
  if (has('quote') || has('product')) s.push('pricing', 'shippingQuotes', 'inventory');
  if (has('createOrder')) s.push('createOrder', 'singleUnit', 'dropshipping');
  if (has('cancel')) s.push('cancelOrder');
  if (has('order') && f['trackingNumber'] !== undefined) s.push('tracking');
  return caps(s);
}

export interface SupplierCapabilityView {
  provider: string;
  integrationStatus: IntegrationStatus;
  catalogMode: 'API' | 'MANUAL_IMPORT';
  orderingMode: 'API' | 'MANUAL';
  capabilities: Record<Capability, CapabilityState>;
}

export function capabilitiesForSupplier(s: { provider: string; config?: unknown }): SupplierCapabilityView | null {
  const def = providerDefinition(s.provider);
  if (!def) return null;
  let capabilities = def.capabilities;
  if (s.provider === 'rest') {
    const parsed = restSupplierConfigSchema.safeParse(s.config);
    capabilities = parsed.success ? capabilitiesForRest(parsed.data) : caps([]);
  }
  return { provider: def.key, integrationStatus: def.integrationStatus, catalogMode: def.catalogMode, orderingMode: def.orderingMode, capabilities };
}

/** The checks that must have passed before AUTOMATED fulfilment may be switched on. */
export const MANDATORY_FOR_AUTOMATION = ['connection', 'catalog', 'product', 'inventory', 'price', 'shipping', 'order', 'tracking'] as const;
export type SupplierTestKind = 'connection' | 'catalog' | 'product' | 'inventory' | 'price' | 'shipping' | 'order' | 'tracking' | 'cancel' | 'health';
export const SUPPLIER_TEST_KINDS: SupplierTestKind[] = ['connection', 'catalog', 'product', 'inventory', 'price', 'shipping', 'order', 'tracking', 'cancel', 'health'];
