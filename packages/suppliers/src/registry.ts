import { ProviderError } from '@orvia/config';
import { CjDropshippingProvider } from './cj';
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

  resolve(supplier: { provider: string; code: string }): SupplierProvider {
    const cached = this.cache.get(supplier.code);
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
      if (!this.cfg.cjApiKey) {
        throw new ProviderError('CJ_API_KEY is not configured', { provider: 'cj', retryable: false });
      }
      p = new CjDropshippingProvider(this.cfg.cjApiKey, { fetchImpl: this.cfg.fetchImpl });
    } else {
      throw new ProviderError(`No adapter registered for provider "${supplier.provider}"`, { provider: supplier.provider, retryable: false });
    }
    this.cache.set(supplier.code, p);
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
