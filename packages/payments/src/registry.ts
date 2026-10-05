import { ProviderError } from '@orvia/config';
import type { KVStore } from '@orvia/config';
import { MockPaymentProvider } from './mock';
import { RazorpayPaymentProvider } from './razorpay';
import { StripePaymentProvider } from './stripe';
import type { PaymentProvider } from './types';

export interface PaymentRegistryConfig {
  mode: 'mock' | 'live';
  isProduction: boolean;
  mockSecret: string;
  stripe?: { secretKey?: string; webhookSecret?: string; publishableKey?: string };
  razorpay?: { keyId?: string; keySecret?: string; webhookSecret?: string };
  fetchImpl?: typeof fetch;
}

export class PaymentRegistry {
  private cache = new Map<string, PaymentProvider>();
  constructor(
    private readonly cfg: PaymentRegistryConfig,
    private readonly store: KVStore,
  ) {}

  /** `preferred` comes from the country config (stripe for US/CA, razorpay for IN). */
  forCountry(preferred: string[]): PaymentProvider {
    if (this.cfg.mode === 'mock') {
      if (this.cfg.isProduction) throw new ProviderError('Mock payments are forbidden in production', { provider: 'mock', retryable: false });
      return this.get('mock');
    }
    for (const key of preferred) {
      try {
        return this.get(key);
      } catch {
        /* try next */
      }
    }
    throw new ProviderError(`No configured payment provider among: ${preferred.join(', ')}`, { provider: preferred[0] ?? 'none', retryable: false });
  }

  get(key: string): PaymentProvider {
    const c = this.cache.get(key);
    if (c) return c;
    let p: PaymentProvider;
    if (key === 'mock') {
      if (this.cfg.mode !== 'mock' || this.cfg.isProduction) throw new ProviderError('Mock payments disabled', { provider: 'mock', retryable: false });
      p = new MockPaymentProvider(this.cfg.mockSecret, this.store);
    } else if (key === 'stripe') {
      const s = this.cfg.stripe;
      if (!s?.secretKey || !s.webhookSecret) throw new ProviderError('Stripe is not configured (STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET)', { provider: 'stripe', retryable: false });
      p = new StripePaymentProvider(s.secretKey, s.webhookSecret, s.publishableKey);
    } else if (key === 'razorpay') {
      const r = this.cfg.razorpay;
      if (!r?.keyId || !r.keySecret || !r.webhookSecret) throw new ProviderError('Razorpay is not configured (RAZORPAY_KEY_ID / KEY_SECRET / WEBHOOK_SECRET)', { provider: 'razorpay', retryable: false });
      p = new RazorpayPaymentProvider(r.keyId, r.keySecret, r.webhookSecret, this.cfg.fetchImpl);
    } else {
      throw new ProviderError(`Unknown payment provider ${key}`, { provider: key, retryable: false });
    }
    this.cache.set(key, p);
    return p;
  }
}
