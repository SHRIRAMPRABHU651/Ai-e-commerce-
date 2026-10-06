import { ProviderError } from '@orvia/config';
import { CjDropshippingProvider } from './cj';
import { RestSupplierProvider, restSupplierConfigSchema } from './rest';
import { MOCK_PROFILES, MockSupplierProvider } from './mock/provider';
import type { MockStateStore } from './mock/provider';
import type { SupplierProvider } from './types';

export interface SupplierRegistryConfig {
  mode: 'mock' | 'live';
  isProduction: boolean;
  cjApiKey?: string;
  mockTimeScale?: number;
  fetchImpl?: typeof fetch;
}

export interface AdapterInfo {
  provider: string;
  label: string;
  requiresCredentials: string[];
  configured: boolean;
  usable: boolean;
  note: string;
}

/** Resolves a supplier DB record to a concrete provider. Mock adapters are refused outside dev/test. */
export class SupplierRegistry {
  private cache = new Map<string, SupplierProvider>();
  constructor(
    private readonly cfg: SupplierRegistryConfig,
    private readonly store: MockStateStore,
  ) {}

  /**
   * `credentials` (decrypted `apiKey`/`apiSecret`) and `config` come from the supplier record so every supplier can have
   * its own keys; `rev` (e.g. updatedAt) invalidates the cache when they change.
   */
  resolve(supplier: { provider: string; code: string; credentials?: Record<string, string>; config?: unknown; rev?: string }): SupplierProvider {
    const cacheKey = `${supplier.code}:${supplier.rev ?? ''}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    let p: SupplierProvider;
    if (supplier.provider === 'mock') {
      if (this.cfg.mode !== 'mock' || this.cfg.isProduction) {
        throw new ProviderError('Mock supplier adapters are disabled (SUPPLIER_MODE=live / production)', {
          provider: supplier.code,
          retryable: false,
        });
      }
      const profile = MOCK_PROFILES.find((m) => m.code === supplier.code);
      if (!profile) throw new ProviderError(`Unknown mock supplier ${supplier.code}`, { provider: supplier.code, retryable: false });
      p = new MockSupplierProvider(profile, this.store, { timeScale: this.cfg.mockTimeScale });
    } else if (supplier.provider === 'cj') {
      const key = supplier.credentials?.['apiKey'] ?? this.cfg.cjApiKey;
      if (!key) {
        throw new ProviderError('CJ_API_KEY is not configured', { provider: 'cj', retryable: false });
      }
      p = new CjDropshippingProvider(key, { fetchImpl: this.cfg.fetchImpl });
    } else if (supplier.provider === 'rest') {
      const key = supplier.credentials?.['apiKey'];
      if (!key) throw new ProviderError(`Supplier ${supplier.code}: API key not set`, { provider: supplier.code, retryable: false });
      const parsed = restSupplierConfigSchema.safeParse(supplier.config);
      if (!parsed.success) {
        throw new ProviderError(`Supplier ${supplier.code}: invalid API mapping — ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, { provider: supplier.code, retryable: false });
      }
      p = new RestSupplierProvider(supplier.code, parsed.data, key, { fetchImpl: this.cfg.fetchImpl });
    } else {
      throw new ProviderError(`No adapter registered for provider "${supplier.provider}"`, { provider: supplier.provider, retryable: false });
    }
    this.cache.set(cacheKey, p);
    return p;
  }

  adapters(): AdapterInfo[] {
    return [
      {
        provider: 'cj',
        label: 'CJ Dropshipping (official API)',
        requiresCredentials: ['CJ_API_KEY'],
        configured: !!this.cfg.cjApiKey,
        usable: !!this.cfg.cjApiKey,
        note: 'Set CJ_API_KEY then create a supplier with provider "cj". See docs/SUPPLIERS.md.',
      },
      {
        provider: 'rest',
        label: 'Configurable REST supplier (any JSON API)',
        requiresCredentials: ['apiKey (stored encrypted per supplier)'],
        configured: true,
        usable: true,
        note: 'Describe the supplier API endpoints/fields in the supplier mapping; no code needed. See docs/SUPPLIERS.md.',
      },
      {
        provider: 'mock',
        label: 'Mock suppliers (development/testing only)',
        requiresCredentials: [],
        configured: true,
        usable: this.cfg.mode === 'mock' && !this.cfg.isProduction,
        note: 'Disabled automatically in production.',
      },
    ];
  }
}
