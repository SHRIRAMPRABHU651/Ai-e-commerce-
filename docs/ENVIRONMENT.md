# Environment variables

All variables are validated at startup (`packages/config`); invalid or unsafe production settings stop the process. `.env.example` is the template. **Never commit `.env`.** Secrets are read only by the API/worker; the web app only receives `API_URL` (server-side, for the proxy) and publishable keys through the API's `/meta` response.

| Group | Variables | Notes |
|---|---|---|
| Runtime | `NODE_ENV`, `APP_ENV` (`development|test|staging|production`), `LOG_LEVEL`, `TRUST_PROXY` | `APP_ENV=production` enforces the guard below |
| Network | `API_PORT`, `API_HOST`, `API_URL`, `WEB_URL`, `CORS_ORIGINS`, `WORKER_PORT`, `RATE_LIMIT_PER_MINUTE` | CORS is an allow-list. `API_URL` is read by the web server **at runtime** (its `/api/v1` proxy), so one image serves every environment. Behind a load balancer set `TRUST_PROXY=true` on the API so rate limits are per visitor, not per web container |
| Data | `MONGODB_URI`, `REDIS_URL` | Redis optional; platform degrades to in-memory limits |
| Security | `JWT_SECRET` (≥32 chars), `ENCRYPTION_KEY` (64-hex), `COOKIE_SECURE`, `SESSION_TTL_HOURS`, `METRICS_TOKEN` | |
| Modes | `SUPPLIER_MODE`, `PAYMENT_MODE`, `ADS_MODE` = `mock|live`; `NOTIFY_MODE` = `log|live`; `MOCK_TIME_SCALE`; `MOCK_PAYMENT_WEBHOOK_SECRET` | mock/log forbidden in production |
| AI | `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_TIMEOUT_MS` | |
| Payments | `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | |
| Supplier | `CJ_API_KEY`, `CJ_API_SECRET` | Fallback only — each supplier stores its own encrypted credentials (set `ENCRYPTION_KEY`) |
| Ads | `META_*`, `TIKTOK_*`, `GOOGLE_ADS_*` | |
| Notifications | `EMAIL_PROVIDER_KEY`, `EMAIL_FROM`, `TWILIO_*` | |
| AWS | `AWS_*`, `S3_BUCKET` | |
| Worker | `WORKER_CONCURRENCY`, `SCHEDULER_ENABLED`, `SEED_ON_START` | `SEED_ON_START` forbidden in production |

`.env.example` also lists `PAYMENT_SECRET`, `SUPPLIER_API_KEY`, `AD_API_KEY`, `AD_API_SECRET` as documented placeholders; the code reads the concrete per-provider variables above.

## Production guard (`assertSafeForEnvironment`)
With `APP_ENV=production` the process refuses to start if: any `*_MODE` is mock/log, `JWT_SECRET` is short or the dev default, cookies aren't secure, or `SEED_ON_START` is set. The dev-only routes (`/dev/*`) are not registered in staging/production, and OpenAPI UI is disabled in production.
