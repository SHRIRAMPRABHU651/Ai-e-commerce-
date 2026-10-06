import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));
const optStr = z.string().optional().transform((v) => (v && v.trim() !== '' ? v : undefined));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** DEV / STAGING / PRODUCTION separation. Mock providers are forbidden in `production`. */
  APP_ENV: z.enum(['development', 'test', 'staging', 'production']).optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  MONGODB_URI: z.string().default('mongodb://127.0.0.1:27017/orvia'),
  REDIS_URL: optStr,

  API_PORT: z.coerce.number().default(4000),
  API_HOST: z.string().default('0.0.0.0'),
  API_URL: z.string().default('http://localhost:4000'),
  WEB_URL: z.string().default('http://localhost:3000'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  TRUST_PROXY: bool.default(false),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(10).default(600), // global per-client-IP budget

  JWT_SECRET: z.string().default('dev-only-insecure-secret-change-me-please-0123456789'),
  COOKIE_SECURE: bool.optional(),
  SESSION_TTL_HOURS: z.coerce.number().default(24 * 7),
  ENCRYPTION_KEY: optStr, // 32-byte hex for encrypting stored provider credentials
  METRICS_TOKEN: optStr,

  // Provider modes: "mock" is only legal outside production.
  SUPPLIER_MODE: z.enum(['mock', 'live']).default('mock'),
  PAYMENT_MODE: z.enum(['mock', 'live']).default('mock'),
  ADS_MODE: z.enum(['mock', 'live']).default('mock'),
  NOTIFY_MODE: z.enum(['log', 'live']).default('log'),
  MOCK_TIME_SCALE: z.coerce.number().default(600), // 1 real second = N simulated seconds for mock tracking

  GEMINI_API_KEY: optStr,
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),
  GEMINI_TIMEOUT_MS: z.coerce.number().default(20_000),

  STRIPE_SECRET_KEY: optStr,
  STRIPE_PUBLISHABLE_KEY: optStr,
  STRIPE_WEBHOOK_SECRET: optStr,
  RAZORPAY_KEY_ID: optStr,
  RAZORPAY_KEY_SECRET: optStr,
  RAZORPAY_WEBHOOK_SECRET: optStr,
  MOCK_PAYMENT_WEBHOOK_SECRET: z.string().default('dev-mock-webhook-secret'),

  CJ_API_KEY: optStr,
  CJ_API_SECRET: optStr,

  META_ACCESS_TOKEN: optStr,
  META_APP_ID: optStr,
  META_APP_SECRET: optStr,
  META_AD_ACCOUNT_ID: optStr,
  META_PAGE_ID: optStr,
  TIKTOK_ACCESS_TOKEN: optStr,
  TIKTOK_ADVERTISER_ID: optStr,
  GOOGLE_ADS_CLIENT_ID: optStr,
  GOOGLE_ADS_CLIENT_SECRET: optStr,
  GOOGLE_ADS_REFRESH_TOKEN: optStr,
  GOOGLE_ADS_DEVELOPER_TOKEN: optStr,
  GOOGLE_ADS_CUSTOMER_ID: optStr,

  AWS_ACCESS_KEY_ID: optStr,
  AWS_SECRET_ACCESS_KEY: optStr,
  AWS_REGION: z.string().default('us-east-1'),
  S3_BUCKET: optStr,

  EMAIL_PROVIDER_KEY: optStr,
  EMAIL_FROM: z.string().default('Orvia <orders@orvia.example>'),
  TWILIO_ACCOUNT_SID: optStr,
  TWILIO_AUTH_TOKEN: optStr,
  TWILIO_FROM: optStr,

  // Media storage: customer-facing product images are served from Orvia-owned storage (never hotlinked from suppliers in production).
  OBJECT_STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),
  OBJECT_STORAGE_BUCKET: optStr,
  OBJECT_STORAGE_REGION: z.string().default('us-east-1'),
  OBJECT_STORAGE_ENDPOINT: optStr, // S3-compatible endpoint (R2, MinIO, Spaces…); omit for AWS S3
  OBJECT_STORAGE_ACCESS_KEY: optStr, // omit on AWS when the task/instance role provides credentials
  OBJECT_STORAGE_SECRET: optStr,
  CDN_BASE_URL: optStr, // public base URL that serves the bucket, e.g. https://cdn.example.com
  LOCAL_MEDIA_DIR: z.string().default('.media'), // dev-only local storage directory
  MEDIA_MAX_BYTES: z.coerce.number().int().min(100_000).default(10_000_000),
  MEDIA_MIN_DIMENSION: z.coerce.number().int().min(100).default(500),

  ALLOW_PRIVATE_FETCH: bool.default(false), // tests/dev only: lets the SSRF guard reach localhost fake servers
  LEGAL_REVIEW_REQUIRED: bool.default(true), // stays true until counsel has reviewed the legal pages (blocks the launch gate)
  MARKET_CRAWLER_CONTACT: z.string().default('https://orvia.example/bot'), // shown in the crawler User-Agent

  WORKER_CONCURRENCY: z.coerce.number().default(4),
  SCHEDULER_ENABLED: bool.default(true),
  SEED_ON_START: bool.default(false),
});

export type AppConfig = Omit<z.infer<typeof envSchema>, 'APP_ENV' | 'COOKIE_SECURE'> & {
  APP_ENV: 'development' | 'test' | 'staging' | 'production';
  COOKIE_SECURE: boolean;
  isProduction: boolean;
  isTest: boolean;
  corsOrigins: string[];
};

export class ConfigError extends Error {}

/** Load a local .env (development convenience). Real environment variables always win; no-op when absent. */
export function loadDotEnv(path = '.env'): void {
  try {
    (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile?.(path);
  } catch {
    /* no .env file — rely on the process environment */
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      'Invalid environment configuration: ' +
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }
  const raw = parsed.data;
  const appEnv =
    raw.APP_ENV ?? (raw.NODE_ENV === 'production' ? 'production' : raw.NODE_ENV === 'test' ? 'test' : 'development');
  const cfg: AppConfig = {
    ...raw,
    APP_ENV: appEnv,
    COOKIE_SECURE: raw.COOKIE_SECURE ?? (appEnv === 'production' || appEnv === 'staging'),
    isProduction: appEnv === 'production',
    isTest: appEnv === 'test',
    corsOrigins: raw.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  };
  assertSafeForEnvironment(cfg);
  return cfg;
}

/** Fail fast on configurations that would fake external success in production. */
export function assertSafeForEnvironment(cfg: AppConfig): void {
  if (cfg.APP_ENV !== 'production') return;
  const problems: string[] = [];
  if (cfg.SUPPLIER_MODE === 'mock') problems.push('SUPPLIER_MODE=mock is forbidden in production');
  if (cfg.PAYMENT_MODE === 'mock') problems.push('PAYMENT_MODE=mock is forbidden in production');
  if (cfg.ADS_MODE === 'mock') problems.push('ADS_MODE=mock is forbidden in production');
  if (cfg.NOTIFY_MODE === 'log') problems.push('NOTIFY_MODE=log is forbidden in production');
  if (cfg.JWT_SECRET.length < 32 || cfg.JWT_SECRET.startsWith('dev-only'))
    problems.push('JWT_SECRET must be a strong secret (>=32 chars) in production');
  if (!cfg.COOKIE_SECURE) problems.push('COOKIE_SECURE must be true in production');
  if (cfg.SEED_ON_START) problems.push('SEED_ON_START is forbidden in production');
  if (cfg.ALLOW_PRIVATE_FETCH) problems.push('ALLOW_PRIVATE_FETCH must be false in production (SSRF protection)');
  if (cfg.OBJECT_STORAGE_PROVIDER !== 's3') problems.push('OBJECT_STORAGE_PROVIDER must be s3 in production (customer images need durable object storage + CDN)');
  if (cfg.OBJECT_STORAGE_PROVIDER === 's3' && !cfg.OBJECT_STORAGE_BUCKET) problems.push('OBJECT_STORAGE_BUCKET is required in production');
  if (cfg.OBJECT_STORAGE_PROVIDER === 's3' && !cfg.CDN_BASE_URL) problems.push('CDN_BASE_URL is required in production');
  if (cfg.CDN_BASE_URL && !/^https:\/\//i.test(cfg.CDN_BASE_URL)) problems.push('CDN_BASE_URL must be https in production');
  if (!cfg.ENCRYPTION_KEY || !/^[0-9a-f]{64}$/i.test(cfg.ENCRYPTION_KEY)) problems.push('ENCRYPTION_KEY (64 hex chars) is required in production for stored supplier credentials');
  if (problems.length) throw new ConfigError('Unsafe production configuration: ' + problems.join('; '));
}

/** Which third-party integrations have credentials configured (never returns the secrets). */
export function integrationStatus(cfg: AppConfig): Record<string, { configured: boolean; mode: string }> {
  return {
    gemini: { configured: !!cfg.GEMINI_API_KEY, mode: cfg.GEMINI_API_KEY ? 'live' : 'template-fallback' },
    stripe: { configured: !!cfg.STRIPE_SECRET_KEY && !!cfg.STRIPE_WEBHOOK_SECRET, mode: cfg.PAYMENT_MODE },
    razorpay: { configured: !!cfg.RAZORPAY_KEY_ID && !!cfg.RAZORPAY_KEY_SECRET, mode: cfg.PAYMENT_MODE },
    cj_dropshipping: { configured: !!cfg.CJ_API_KEY, mode: cfg.SUPPLIER_MODE },
    meta_ads: { configured: !!cfg.META_ACCESS_TOKEN && !!cfg.META_AD_ACCOUNT_ID, mode: cfg.ADS_MODE },
    tiktok_ads: { configured: !!cfg.TIKTOK_ACCESS_TOKEN && !!cfg.TIKTOK_ADVERTISER_ID, mode: cfg.ADS_MODE },
    google_ads: {
      configured: !!cfg.GOOGLE_ADS_CLIENT_ID && !!cfg.GOOGLE_ADS_REFRESH_TOKEN && !!cfg.GOOGLE_ADS_DEVELOPER_TOKEN,
      mode: cfg.ADS_MODE,
    },
    email: { configured: !!cfg.EMAIL_PROVIDER_KEY, mode: cfg.NOTIFY_MODE },
    sms: { configured: !!cfg.TWILIO_ACCOUNT_SID && !!cfg.TWILIO_AUTH_TOKEN, mode: cfg.NOTIFY_MODE },
    s3: { configured: !!cfg.S3_BUCKET && !!cfg.AWS_ACCESS_KEY_ID, mode: 'live' },
    redis: { configured: !!cfg.REDIS_URL, mode: cfg.REDIS_URL ? 'live' : 'memory-fallback' },
  };
}

export * from './resilience';
export * from './logger';
export * from './metrics';
export * from './kv';
