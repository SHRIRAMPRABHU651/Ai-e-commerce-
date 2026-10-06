import { setImagePolicy } from '../domain/images';
import { AdsRegistry } from '@orvia/ads';
import { AIService } from '@orvia/ai';
import { createLogger, integrationStatus, loadConfig } from '@orvia/config';
import type { AppConfig, Logger } from '@orvia/config';
import { NotificationRouter } from '@orvia/notifications';
import { PaymentRegistry } from '@orvia/payments';
import { SupplierRegistry } from '@orvia/suppliers';
import type { Ctx } from './context';
import { MongoKVStore } from './mongoKV';
import { JobQueue } from './queue';
import { SettingsService } from './settings';

export interface BuildOptions {
  cfg?: AppConfig;
  service: string;
  log?: Logger;
  fetchImpl?: typeof fetch;
  overrides?: Partial<Ctx>;
}

export function buildCtx(o: BuildOptions): Ctx {
  const cfg = o.cfg ?? loadConfig();
  const log = o.log ?? createLogger({ level: cfg.LOG_LEVEL, service: o.service });
  const kv = new MongoKVStore();
  // demo art stands in for supplier photos only with the mock supplier outside production
  setImagePolicy({ allowDemoArt: cfg.SUPPLIER_MODE === 'mock' && !cfg.isProduction });
  const ctx: Ctx = {
    cfg,
    log,
    ai: new AIService({ geminiApiKey: cfg.GEMINI_API_KEY, geminiModel: cfg.GEMINI_MODEL, timeoutMs: cfg.GEMINI_TIMEOUT_MS, fetchImpl: o.fetchImpl, logger: log }),
    suppliers: new SupplierRegistry(
      { mode: cfg.SUPPLIER_MODE, isProduction: cfg.isProduction, cjApiKey: cfg.CJ_API_KEY, mockTimeScale: cfg.MOCK_TIME_SCALE, fetchImpl: o.fetchImpl },
      kv,
    ),
    payments: new PaymentRegistry(
      {
        mode: cfg.PAYMENT_MODE,
        isProduction: cfg.isProduction,
        mockSecret: cfg.MOCK_PAYMENT_WEBHOOK_SECRET,
        stripe: { secretKey: cfg.STRIPE_SECRET_KEY, webhookSecret: cfg.STRIPE_WEBHOOK_SECRET, publishableKey: cfg.STRIPE_PUBLISHABLE_KEY },
        razorpay: { keyId: cfg.RAZORPAY_KEY_ID, keySecret: cfg.RAZORPAY_KEY_SECRET, webhookSecret: cfg.RAZORPAY_WEBHOOK_SECRET },
        fetchImpl: o.fetchImpl,
      },
      kv,
    ),
    ads: new AdsRegistry(
      {
        mode: cfg.ADS_MODE,
        isProduction: cfg.isProduction,
        meta: { accessToken: cfg.META_ACCESS_TOKEN, adAccountId: cfg.META_AD_ACCOUNT_ID, pageId: cfg.META_PAGE_ID },
        tiktok: { accessToken: cfg.TIKTOK_ACCESS_TOKEN, advertiserId: cfg.TIKTOK_ADVERTISER_ID },
        google: {
          clientId: cfg.GOOGLE_ADS_CLIENT_ID,
          clientSecret: cfg.GOOGLE_ADS_CLIENT_SECRET,
          refreshToken: cfg.GOOGLE_ADS_REFRESH_TOKEN,
          developerToken: cfg.GOOGLE_ADS_DEVELOPER_TOKEN,
          customerId: cfg.GOOGLE_ADS_CUSTOMER_ID,
        },
        fetchImpl: o.fetchImpl,
      },
      kv,
    ),
    notifier: new NotificationRouter({
      mode: cfg.NOTIFY_MODE,
      isProduction: cfg.isProduction,
      emailKey: cfg.EMAIL_PROVIDER_KEY,
      emailFrom: cfg.EMAIL_FROM,
      twilio: { sid: cfg.TWILIO_ACCOUNT_SID, token: cfg.TWILIO_AUTH_TOKEN, from: cfg.TWILIO_FROM },
      fetchImpl: o.fetchImpl,
    }),
    queue: new JobQueue(log),
    settings: new SettingsService(cfg.isProduction),
    now: () => new Date(),
    ...o.overrides,
  };
  log.info({ channel: 'app', integrations: integrationStatus(cfg) }, 'services initialised');
  return ctx;
}
