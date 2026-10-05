import { ProviderError } from '@orvia/config';
import type { KVStore } from '@orvia/config';
import { GoogleAdsProvider } from './google';
import { MetaAdsProvider } from './meta';
import { MockAdProvider } from './mock';
import { TikTokAdsProvider } from './tiktok';
import type { AdPlatform, AdProvider } from './types';

export interface AdsRegistryConfig {
  mode: 'mock' | 'live';
  isProduction: boolean;
  meta?: { accessToken?: string; adAccountId?: string; pageId?: string; pixelId?: string };
  tiktok?: { accessToken?: string; advertiserId?: string };
  google?: { clientId?: string; clientSecret?: string; refreshToken?: string; developerToken?: string; customerId?: string };
  fetchImpl?: typeof fetch;
}

export class AdsRegistry {
  private cache = new Map<string, AdProvider>();
  constructor(
    private readonly cfg: AdsRegistryConfig,
    private readonly store: KVStore,
  ) {}

  get(platform: AdPlatform): AdProvider {
    const hit = this.cache.get(platform);
    if (hit) return hit;
    let p: AdProvider;
    if (this.cfg.mode === 'mock') {
      if (this.cfg.isProduction) throw new ProviderError('Mock ads are forbidden in production', { provider: 'mock-ads', retryable: false });
      p = new MockAdProvider(this.store);
    } else if (platform === 'meta') {
      const m = this.cfg.meta;
      if (!m?.accessToken || !m.adAccountId) throw new ProviderError('Meta Ads not configured (META_ACCESS_TOKEN, META_AD_ACCOUNT_ID)', { provider: 'meta-ads', retryable: false });
      p = new MetaAdsProvider({ accessToken: m.accessToken, adAccountId: m.adAccountId, pageId: m.pageId, pixelId: m.pixelId, fetchImpl: this.cfg.fetchImpl });
    } else if (platform === 'tiktok') {
      const t = this.cfg.tiktok;
      if (!t?.accessToken || !t.advertiserId) throw new ProviderError('TikTok Ads not configured (TIKTOK_ACCESS_TOKEN, TIKTOK_ADVERTISER_ID)', { provider: 'tiktok-ads', retryable: false });
      p = new TikTokAdsProvider({ accessToken: t.accessToken, advertiserId: t.advertiserId, fetchImpl: this.cfg.fetchImpl });
    } else {
      const g = this.cfg.google;
      if (!g?.clientId || !g.clientSecret || !g.refreshToken || !g.developerToken || !g.customerId) {
        throw new ProviderError('Google Ads not configured (GOOGLE_ADS_*)', { provider: 'google-ads', retryable: false });
      }
      p = new GoogleAdsProvider({ clientId: g.clientId, clientSecret: g.clientSecret, refreshToken: g.refreshToken, developerToken: g.developerToken, customerId: g.customerId, fetchImpl: this.cfg.fetchImpl });
    }
    this.cache.set(platform, p);
    return p;
  }

  status(): Record<AdPlatform, { configured: boolean }> {
    const m = this.cfg.meta, t = this.cfg.tiktok, g = this.cfg.google;
    const mock = this.cfg.mode === 'mock' && !this.cfg.isProduction;
    return {
      meta: { configured: mock || !!(m?.accessToken && m.adAccountId) },
      tiktok: { configured: mock || !!(t?.accessToken && t.advertiserId) },
      google: { configured: mock || !!(g?.clientId && g.refreshToken && g.developerToken && g.customerId) },
    };
  }
}
