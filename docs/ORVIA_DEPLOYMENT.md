# ORVIA deployment

How to run ORVIA cheaply at first and how it grows. It complements the original [DEPLOYMENT.md](DEPLOYMENT.md) (AWS reference and release procedure). **Nothing here has been deployed from this repository**: Docker images were not built and Terraform was not planned or applied in the build session, and no live provider has been exercised. Items are called verified only where a command was actually run and its result is recorded in [ORVIA_TEST_REPORT.md](ORVIA_TEST_REPORT.md).

## 1. Architecture

### Low-cost initial architecture (single region)

```
Internet -> TLS proxy / CDN -> web (Next.js :3000) --runtime proxy /api/v1/*--> api (Fastify :4000)
                                                                                   |
  payment webhooks ------------------------------------------------------------>   +--> MongoDB Atlas (smallest dedicated tier, backups on)
                                                    worker (:4100, 1 replica) -----+--> object storage (private bucket) + https CDN
                                                    (queue + scheduler)            +--> Redis (optional)
```

- One small container each for `api`, `worker` and `web` (a single host with `docker-compose.prod.yml` is enough to start), one MongoDB, one private object-storage bucket with an https CDN in front. Production requires `OBJECT_STORAGE_PROVIDER=s3`, a bucket and an https `CDN_BASE_URL`.
- Redis is optional. Without it, rate limits are per API instance in memory, which is acceptable with one API replica.
- One worker is enough. Queue locks are lease-based (120 s) and the scheduler claims each time slot atomically, so more than one worker is safe.
- TLS terminates at a proxy (Caddy, nginx, ALB, a CDN). Set `TRUST_PROXY=true` on the API only if that proxy overwrites `X-Forwarded-For`.
- No cost or capacity figure is claimed; none has been measured.

### Scalable future architecture

API behind a load balancer with CPU autoscaling (the Terraform module scales the API from `desired_count` to 10 on CPU), Redis (ElastiCache in the module) for shared rate limits, more workers if queue latency demands it, Atlas with point-in-time restore on a dedicated tier, a dedicated search engine once the catalogue outgrows the in-process search ([LIMITATIONS.md](LIMITATIONS.md) #7), a CDN in front of the web origin, a WAF, and an external metrics and log store because metrics are per process (section 11). Split read-heavy and write-heavy paths only after load tests show the need.

## 2. Environment variables by group

`.env.example` is the template and `packages/config/src/index.ts` validates everything at start-up. [ENVIRONMENT.md](ENVIRONMENT.md) is older and omits FX, events and newer variables; this table is the current grouping. Secrets belong in a secret store, never in git.

| Group | Variables | Production requirement |
|---|---|---|
| Runtime | `NODE_ENV`, `APP_ENV` (`development`, `test`, `staging`, `production`), `LOG_LEVEL`, `TRUST_PROXY`, `APP_VERSION` (read by `/health`; not in `.env.example`) | `APP_ENV=production` turns the guard on |
| Network | `API_PORT`, `API_HOST`, `API_URL`, `WEB_URL`, `CORS_ORIGINS`, `WORKER_PORT`, `RATE_LIMIT_PER_MINUTE` | `API_URL` is read by the web server per request (runtime proxy); `CORS_ORIGINS` is an allow-list |
| Data | `MONGODB_URI` (secret), `REDIS_URL` (optional) | |
| Security | `JWT_SECRET` (secret, 32+ chars), `ENCRYPTION_KEY` (secret, 64 hex), `COOKIE_SECURE`, `SESSION_TTL_HOURS`, `METRICS_TOKEN` (secret) | `JWT_SECRET`, `ENCRYPTION_KEY`, secure cookies required |
| Modes | `SUPPLIER_MODE`, `PAYMENT_MODE`, `ADS_MODE` (`mock` or `live`), `NOTIFY_MODE` (`log` or `live`), `SUPPLIER_ENFORCE_VERIFICATION`, `MOCK_TIME_SCALE`, `MOCK_PAYMENT_WEBHOOK_SECRET` | all four modes live; mock settings are development only |
| AI | `GEMINI_API_KEY` (secret), `GEMINI_MODEL`, `GEMINI_TIMEOUT_MS` | optional |
| Payments | `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` (secrets) | at least one provider per sold market |
| Suppliers | `CJ_API_KEY`, `CJ_API_SECRET` (fallback; per-supplier credentials are stored encrypted) | |
| Ads | `META_ACCESS_TOKEN`, `META_APP_ID`, `META_APP_SECRET`, `META_AD_ACCOUNT_ID`, `META_PAGE_ID`, `TIKTOK_ACCESS_TOKEN`, `TIKTOK_ADVERTISER_ID`, `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_REFRESH_TOKEN`, `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CUSTOMER_ID` | only if ads are used |
| Conversion events | `EVENTS_MODE`, `EVENTS_PROVIDERS`, `META_PIXEL_ID`, `META_CAPI_ACCESS_TOKEN`, `META_CAPI_TEST_EVENT_CODE`, `META_GRAPH_VERSION`, `TIKTOK_PIXEL_CODE`, `TIKTOK_EVENTS_ACCESS_TOKEN`, `TIKTOK_EVENTS_TEST_CODE`, `GA4_MEASUREMENT_ID`, `GA4_API_SECRET`, `GOOGLE_ADS_PURCHASE_CONVERSION_ACTION_ID`, `GOOGLE_ADS_LOGIN_CUSTOMER_ID`, `GOOGLE_ADS_API_VERSION`, `EVENTS_EMAIL_DAILY_LIMIT` | start-up refuses `EVENTS_MODE=log` while `EVENTS_PROVIDERS` is set, and missing credentials for an enabled provider |
| Browser pixels | `NEXT_PUBLIC_META_PIXEL_ID`, `NEXT_PUBLIC_GA4_MEASUREMENT_ID`, `NEXT_PUBLIC_TIKTOK_PIXEL_ID`, `NEXT_PUBLIC_SITE_URL` | **Build-time in Next.js.** `components/tracking.tsx` reads the pixel ids from `process.env` at module level and the Dockerfile `build` stage declares no build arguments for them. Unverified, because no image was built here: make them available to `docker build`, or the pixels and the canonical site URL may fall back to empty or localhost. `NEXT_PUBLIC_SITE_URL` is not in `.env.example` |
| Notifications | `EMAIL_PROVIDER_KEY`, `EMAIL_FROM`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | an email provider for live mode |
| Storage | `OBJECT_STORAGE_PROVIDER`, `OBJECT_STORAGE_BUCKET`, `OBJECT_STORAGE_REGION`, `OBJECT_STORAGE_ENDPOINT`, `OBJECT_STORAGE_ACCESS_KEY`, `OBJECT_STORAGE_SECRET`, `CDN_BASE_URL`, `LOCAL_MEDIA_DIR`, `MEDIA_MAX_BYTES`, `MEDIA_MIN_DIMENSION` | `s3`, bucket and https CDN required. The config also keeps `S3_BUCKET` and `AWS_*`; the integration-status check for S3 reads `S3_BUCKET` and `AWS_ACCESS_KEY_ID`, so `/ready` may report S3 as not configured when only `OBJECT_STORAGE_*` is set (read from code, not run). Terraform sets both |
| FX | `FX_PROVIDER`, `FX_API_URL`, `FX_API_KEY`, `FX_WARN_HOURS`, `FX_HARD_LIMIT_HOURS`, `FX_REFRESH_MINUTES` | `static` refused; a keyed provider needs `FX_API_KEY`; hard limit not below warn limit |
| Safety and legal | `ALLOW_PRIVATE_FETCH`, `LEGAL_REVIEW_REQUIRED`, `MARKET_CRAWLER_CONTACT` | `ALLOW_PRIVATE_FETCH=false`; set a real crawler contact URL |
| Worker | `WORKER_CONCURRENCY` (default 4), `SCHEDULER_ENABLED` (default true), `SEED_ON_START` | `SEED_ON_START` forbidden |

`.env.example` also lists `PAYMENT_SECRET`, `SUPPLIER_API_KEY`, `AD_API_KEY` and `AD_API_SECRET` as placeholders the code does not read, and sets `GEMINI_API_KEY=your_gemini_api_key_here`, a non-empty value the code would treat as a configured key; blank it. `API_INLINE_WORKER` is a development-only switch ignored in production.

### Production guard (`assertSafeForEnvironment`)

With `APP_ENV=production` the process throws at start-up if any of these hold: a mock or log mode (`SUPPLIER_MODE`, `PAYMENT_MODE`, `ADS_MODE`, `NOTIFY_MODE`); `JWT_SECRET` shorter than 32 characters or the development default; cookies not secure; `SEED_ON_START`; `FX_PROVIDER=static`; `exchangerate_api` without a key; `FX_HARD_LIMIT_HOURS` below `FX_WARN_HOURS`; `ALLOW_PRIVATE_FETCH`; events misconfiguration; `OBJECT_STORAGE_PROVIDER` not `s3`, a missing bucket or CDN, or a non-https CDN; `ENCRYPTION_KEY` not 64 hex characters. `APP_ENV=staging` does **not** run this guard and accepts the development JWT default, so use strong values in staging too. Terraform sets `APP_ENV=staging` for any `environment` other than `production`.

## 3. Build and run commands

| Purpose | Command |
|---|---|
| Install | `npm ci` |
| Build all | `npm run build` (api and worker via esbuild, web via `next build`) |
| Build check without a database | `npm run boot-check` (run successfully in the build session) |
| API | `node apps/api/dist/main.js` (`npm run start -w @orvia/api`) |
| Worker | `node apps/worker/dist/main.js` (`npm run start -w @orvia/worker`) |
| Web | `node apps/web/server.js` in the standalone image; `npm run start -w @orvia/web` outside Docker |
| Indexes | `npm run migrate` |
| Release gate | `npm run production-check` (lint, typecheck, tests, build, config guard, secret scans, E2E) |
| Staging live checks | `npm run verify:staging`, then `npm run certify` |
| Image | `docker build -f infra/docker/Dockerfile --target <api, worker or web> -t orvia-<target> .` |

`npm run worker` runs the development watcher (`tsx watch`), not the built worker.

## 4. Docker and Terraform status

| Item | What exists | Validated | Not validated |
|---|---|---|---|
| `infra/docker/Dockerfile` | multi-stage; targets `api`, `worker`, `web` (Next standalone) and `seed` (development only); non-root user `orvia`; `HEALTHCHECK` on `/live` (api :4000, worker :4100) and `/` (web) | CI job `docker` builds the three images without pushing | not built in the build session; never run as a container |
| `docker-compose.yml` | development stack: mongo 7, redis 7, api, worker, web, `seed` profile | none | |
| `docker-compose.prod.yml` | api, worker, web from a registry; `env_file: .env.production`; `TRUST_PROXY=true` for the API; no Mongo, Redis or TLS | none | |
| `infra/terraform` | VPC (2 AZ) with NAT, ALB with ACM and Route53, ECS Fargate (api, web, worker), Cloud Map, ElastiCache Redis, encrypted private S3 bucket, Secrets Manager injection, CloudWatch logs (30 days), SNS alarms (ALB 5xx, worker not running), API autoscaling | `init -backend=false`, `validate` and `fmt -check` ran once on a hosted runner (LIMITATIONS #4) and are CI jobs; `npm run terraform:check` is a static check only | never `plan` or `apply`; IAM, cost, networking, Atlas connectivity; no remote state backend; no WAF; the CDN is not provisioned |
| `.github/workflows/deploy.yml` | manual, OIDC to AWS, builds and pushes SHA-tagged images, `force-new-deployment` per service, waits for stability | none | task definitions take image URIs from Terraform variables (`api_image` and others), so forcing a deployment does not move services to the new tag unless the variable is updated and applied; the migrations step only echoes an instruction |

Terraform note: `common_env` is fixed, so settings Terraform does not set (`FX_PROVIDER`, `EVENTS_MODE`, `EVENTS_PROVIDERS`, `OBJECT_STORAGE_ENDPOINT`, and so on) can only be injected through the `secret_arns` map.

## 5. Health, readiness and metrics endpoints

Verified by reading `apps/api/src/routes/system.ts` and `apps/worker/src/main.ts`; not exercised against a running deployment.

| Endpoint | Process | Behaviour |
|---|---|---|
| `GET /live` | API | `200 {"status":"alive"}`; exempt from rate limiting |
| `GET /health` | API | always `200`; `status` is `ok` or `degraded` by database connection state; includes env, `APP_VERSION`, uptime |
| `GET /ready` | API | pings MongoDB; `503 not_ready` if down; otherwise `200` with `ready`, or `degraded` when Redis is configured but down; returns queue stats and which integrations are configured (booleans only) |
| `GET /metrics` | API | Prometheus text. In production it is `404` unless `METRICS_TOKEN` is set, then requires `Authorization: Bearer <token>` |
| `GET /api/v1/launch-gate` | API | launch verdict, bearer `METRICS_TOKEN`; 200 for GO, 503 for NO_GO |
| `GET /live`, `GET /health` | worker (:4100) | 200, or 503 by database state |
| `GET /metrics` | worker | open when `METRICS_TOKEN` is unset (even in production); otherwise bearer |

`/live`, `/health`, `/ready` and `/metrics` are at the API root, not under `/api/v1`; the proxy or ALB health check must target them directly. Metric names present in code: `orvia_up`, `orvia_queue_jobs{status}`, `orvia_http_requests_total`, `orvia_http_errors_total`, `orvia_http_request_duration_seconds`, `orvia_jobs_total`, `orvia_job_duration_seconds`, `orvia_jobs_enqueued_total`, `orvia_queue_failures_total`, `orvia_orders_created_total`, `orvia_orders_paid_total`, `orvia_exceptions_total`, `orvia_login_total`, `orvia_supplier_orders_total`, `orvia_supplier_failures_total`, `orvia_webhook_duplicates_total`, `orvia_ai_tasks_total`, `orvia_ai_failures_total`.

## 6. Migrations and indexes

There are no data migrations. Production runs with `autoIndex` off (API and worker), so indexes are created only by `npm run migrate` (`scripts/migrate.ts`). For every registered model it creates the collection and indexes, reports stale indexes without dropping them, and ensures categories. Run it with the API image as a one-off task before the first start and before or after any release that adds indexes; it is idempotent. All area models (trust, rescue, customer360, find, finance, creators, events, suppliernet, aftersales, agents) are exported from `@orvia/database` and therefore registered. The code relies on unique and partial indexes, among them one active rescue case per order line, the finance ledger idempotency key and the `(eventId, provider)` outbox key. Before migrating a database created by the original release, drop the legacy `orderId_1_lineKey_1` Shipment index.

## 7. Workers and schedules

The worker consumes the MongoDB job queue (at-least-once, dedupe keys, exponential backoff from 2 s to 10 min, a `dead` state) and runs the scheduler when `SCHEDULER_ENABLED=true`. Admins can change intervals (minimum 60 s) and enable or disable schedules under Automation. The table lists `DEFAULT_SCHEDULES` from `packages/core/src/jobs/index.ts` merged with `TRUST_SCHEDULES`, `RESCUE_SCHEDULES`, `CUSTOMER360_SCHEDULES`, `FIND_SCHEDULES`, `FINANCE_SCHEDULES`, `CREATORS_SCHEDULES`, `EVENTS_SCHEDULES`, `SUPPLIERNET_SCHEDULES`, `AFTERSALES_SCHEDULES` and `AGENTS_SCHEDULES`: 41 entries. "Automation key" is the `OFF`, `ASSISTED` or `AUTOMATIC` dial that decides whether the job's actions run or become proposals.

| Schedule | Every | Job | Risk | Automation key | Purpose |
|---|---|---|---|---|---|
| `order_sync` | 5 min | `order_sync` | high | order_fulfillment | Re-request fulfilment for paid orders that have none queued |
| `supplier_health` | 10 min | `supplier_health` | low |  | Probe supplier APIs; failing suppliers are excluded from new orders |
| `tracking_sync` | 5 min | `sync_tracking` | low | tracking | Poll suppliers for shipment tracking and notify customers |
| `payment_verification` | 5 min | `payment_verification` | medium |  | Confirm stale unpaid orders directly with the payment provider |
| `inventory_sync` | 5 min | `sync_inventory` | medium | inventory_sync | Rotating supplier stock and price refresh; pause or restore products |
| `abandoned_cart` | 5 min | `abandoned_cart` | low | abandoned_cart | Consent-based cart recovery messages |
| `ad_metrics` | 15 min | `sync_ad_metrics` | low | ad_optimization | Pull ad platform metrics |
| `market_crawl` | 15 min | `market_crawl` | low |  | Crawl due public market sources (robots-aware, rate-limited) |
| `market_index` | 1 h | `market_index` | low |  | Recompute trend scores, confidence and competitor prices from collected evidence |
| `product_performance` | 1 h | `product_performance` | low |  | Trend scores, review sentiment |
| `campaign_performance` | 1 h | `optimize_ads` | high | ad_optimization | Evaluate campaigns against budget rules |
| `pricing_analysis` | 1 h | `pricing_analysis` | high | dynamic_pricing | Dynamic pricing proposals within margin guardrails |
| `reconciliation` | 1 d | `reconciliation` | low |  | Daily orders, payments, refunds and supplier orders consistency check |
| `housekeeping` | 1 h | `housekeeping` | low |  | Expire unpaid orders, refresh supplier reliability |
| `discovery` | 1 d | `discovery` | medium | product_discovery | Discover, score and import or propose products; start ad tests |
| `product_scoring` | 1 d | `score_products` | low |  | Recompute opportunity scores |
| `daily_brief` | 1 d | `daily_brief` | low | ai_reports | Generate the daily business brief |
| `promotion_analysis` | 1 d | `recommend_promotions` | medium | promotion_optimization | Recommend country promotions |
| `trust_recompute` | 6 h | `trust_recompute` | low |  | Recompute TrustGraph supplier reliability and product risk snapshots |
| `rescue_scan` | 10 min | `rescue_scan` | high |  | Delivery Rescue: detect failing deliveries, plan recovery, run due actions (bounded, deduped per order line) |
| `customer360_sweep` | 6 h | `customer360_sweep` | low |  | Delete expired Commerce Memory items; mark deletion requests past cooling-off as ready for staff review |
| `find_price_snapshot` | 1 d | `find_price_snapshot` | low |  | Price Guard: snapshot per-country prices (only changes, at most daily) |
| `find_price_alerts` | 1 h | `find_price_alerts` | low |  | Price Guard: evaluate alerts and notify the users who created them |
| `find_saved_search_alerts` | 1 d | `find_saved_search_alerts` | low |  | Notify users of new matches for saved searches they opted in to |
| `fx_refresh` | 6 h | `fx_refresh` | low |  | Refresh stored FX rates from the configured provider |
| `ledger_sync` | 10 min | `ledger_sync` | low |  | Post paid and refunded orders, supplier costs and ad spend to the ledger (idempotent) |
| `ledger_reconciliation` | 1 d | `ledger_reconciliation` | low |  | Compare the ledger with orders, payments, refunds and shipments |
| `finance_cost_alerts` | 6 h | `finance_cost_alerts` | low |  | Flag supplier costs above the cost the selling price was based on |
| `creator_ledger_settle` | 1 h | `creator_ledger_settle` | medium |  | Claw back refunded creator commissions, then release commissions whose hold has elapsed |
| `creator_ledger_deep_scan` | 1 d | `creator_ledger_settle` | low |  | Daily wide refund and clawback sweep for creator commissions (14-day window) |
| `loyalty_expire` | 1 d | `loyalty_expire` | low |  | Expire due loyalty points and restore unused redemption codes |
| `events_generate` | 5 min | `events_generate` | low |  | Create conversion events from paid and refunded orders (cursor and idempotency keys) |
| `events_deliver` | 1 min | `events_deliver` | low |  | Deliver the conversion-event outbox with retry, backoff and dead-letter |
| `events_campaign_dispatch` | 5 min | `events_campaign_dispatch` | medium |  | Start due scheduled email campaigns (consent-filtered) and close finished ones |
| `suppliernet_sla` | 6 h | `suppliernet_sla` | medium |  | Compute supplier SLA facts, flag breaches, demote suppliers with critical breaches |
| `suppliernet_verification_sweep` | 1 d | `suppliernet_verification_sweep` | low |  | Lapse expired verification and documents; raise re-verification tasks |
| `suppliernet_feed_refresh` | 6 h | `suppliernet_feed_refresh` | low |  | Re-ingest CSV and JSON feed suppliers (read-only catalogue, price, stock) |
| `aftersales_chargeback_deadlines` | 1 h | `aftersales_chargeback_deadlines` | low |  | Escalate chargebacks whose evidence deadline is near or passed |
| `aftersales_provider_reconciliation` | 6 h | `aftersales_provider_reconciliation` | medium |  | Compare recent payments with the payment provider (read-only) and flag discrepancies |
| `aftersales_refund_sync` | 15 min | `aftersales_refund_sync` | low |  | Complete returns whose pending refund was approved or finished |
| `agents_maintenance` | 1 d | `agents_maintenance` | low |  | Expire stale agent confirmations; delete assistant conversations past retention |

Other jobs are enqueued by events (fulfilment, rescue actions, creator commission accrual, loyalty earn, notifications, image processing). Schedule slots are claimed atomically in `system_settings`, so overlapping workers do not double-run a slot.

## 8. Backups and restore

MongoDB holds everything durable, including the job queue. Use Atlas continuous backup with point-in-time restore.

1. Enable continuous backup with a retention window that matches your obligations. Back up `ENCRYPTION_KEY` separately from the database: stored supplier credentials cannot be decrypted without it.
2. Restore procedure (not drilled): stop the worker (`SCHEDULER_ENABLED=false` or scale to zero); restore to a new cluster at the chosen time; point `MONGODB_URI` at it; start the API; run `npm run migrate`; check `/ready`; start the worker. Pending jobs come back with the database and idempotency keys prevent duplicate supplier orders on replay, but review the output of `payment_verification`, `ledger_sync` and the reconciliation jobs for the restore window.
3. Object storage: enable versioning and, if required, replication. Evidence and supplier documents live under private prefixes (`aftersales/evidence/`, `suppliernet/docs/`); keep them private.
4. Run a restore drill in staging and record the elapsed time. This has not been done.

## 9. Secrets management

Secrets are read only by the API and worker; the web app receives `API_URL` and `NEXT_PUBLIC_*` values only. Use AWS Secrets Manager (the Terraform module injects ECS secrets; values stay out of state), Docker or Swarm secrets, or your platform's equivalent. Never commit `.env`; a release gate scans the browser bundle for secret variable names. Rotation: changing `JWT_SECRET` logs everyone out, so rotate it on staff offboarding; changing `ENCRYPTION_KEY` makes stored supplier credentials unreadable until re-entered. Replace all seed and demo credentials (the seed refuses to run in production).

## 10. Webhook endpoint subscriptions

Payment webhooks are public routes verified by signature on the raw body, deduplicated by event id, and confirmed by re-fetching the payment from the provider.

| Provider | Endpoint | Events |
|---|---|---|
| Stripe | `https://<domain>/api/v1/webhooks/payments/stripe` | `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.amount_capturable_updated`, `charge.refund.updated`, `refund.updated`, `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed`, `charge.dispute.funds_withdrawn`, `charge.dispute.funds_reinstated` |
| Razorpay | `https://<domain>/api/v1/webhooks/payments/razorpay` | the payment events the adapter reads plus `payment.dispute.*`; confirm the exact list in the dashboard against `packages/payments/src/razorpay.ts` |

Without the dispute and refund subscriptions no disputes or refund failures arrive. The ALB rule in the Terraform module sends `/api/v1/webhooks/*` straight to the API. Ad and tracking providers receive data from ORVIA (outbox) and need no inbound webhook; their pixel and conversion-action setup is in [ORVIA_MARKETING_AND_TRACKING.md](ORVIA_MARKETING_AND_TRACKING.md).

## 11. Monitoring, logging, rate limits, limits

- **Logs**: pino JSON with request ids and channels (`app`, `order`, `payment`, `supplier`, `ads`, `ai`); ship stdout. The Terraform module creates CloudWatch log groups.
- **Metrics**: in-process per container; counters reset on restart and are not aggregated across replicas. Scrape each instance or add an aggregator. No tracing exists.
- **Alerts**: the repo configures only two (ALB 5xx, worker not running). Recommended additions: `/ready` failing, 5xx rate, queue depth and `dead` jobs (`orvia_queue_jobs`), FX stale or expired, webhook failures, outbox dead letters, ledger reconciliation findings. Chargeback deadlines and dead fulfilment jobs already raise exceptions in the admin queue.
- **Rate limits**: global `RATE_LIMIT_PER_MINUTE` per client IP (default 600; health endpoints exempt) plus per-route limits, for example ORVIA Find 30 per minute and image search 8, compare 60, assistant message 20, advocate 10, event tracking 240, creator application 5 per hour, return creation 20 per hour; checkout 20 per minute per IP ([PERFORMANCE.md](PERFORMANCE.md)). Redis shares limits across API instances; without it they are per instance. If Redis errors the limiter allows requests rather than failing the API. Client IP identity depends on `TRUST_PROXY`.
- **Graceful shutdown**: on `SIGTERM` or `SIGINT` the API closes Fastify (in-flight requests finish), disconnects Redis and MongoDB and exits; the worker stops the scheduler, calls `queue.stop()`, closes its HTTP server and disconnects. A job lock left by a hard kill is reclaimed after the 120 s lease and jobs are idempotent. The Terraform module sets no ECS stop timeout.
- **Resource limits**: Terraform defaults are API 512 CPU units and 1024 MiB, web 512 and 1024, worker 512 and 1024 with one task, API desired count 2 scaling to 10. They are starting values, not measurements. Request bodies are limited to 1,000,000 bytes; uploads are capped by `MEDIA_MAX_BYTES` (default 10,000,000); search and dashboards use documented caps (5,000 search documents, 5,000 orders per dashboard range, 20,000 customers per segment scan).

## Rollout checklist

1. [ ] Provision MongoDB with backups, private object storage with an https CDN, a secrets store, optionally Redis.
2. [ ] Generate `JWT_SECRET` and `ENCRYPTION_KEY`; store `ENCRYPTION_KEY` separately; set `METRICS_TOKEN`.
3. [ ] Set the four provider modes to live, the FX provider and the events configuration; use sandbox credentials and strong secrets in staging.
4. [ ] Build images (with `NEXT_PUBLIC_*` available at build time if browser pixels are wanted); deploy `api`, one `worker` and `web`; confirm `/live` and `/ready`.
5. [ ] Run `npm run migrate`; confirm the indexes and review any stale-index report.
6. [ ] Register payment webhooks (section 10); send test events; confirm delivery and idempotent replay.
7. [ ] Onboard and verify a supplier; place a test order; confirm tracking.
8. [ ] `npm run verify:staging`; review `/admin/launch-readiness`; resolve every blocking FAIL.
9. [ ] Run load scenarios against staging and record the numbers in [PERFORMANCE.md](PERFORMANCE.md).
10. [ ] Complete a restore drill; confirm alerts reach a monitored channel.
11. [ ] Record legal, tax and export attestations; set `LEGAL_REVIEW_REQUIRED=false` only after sign-off.
12. [ ] Promote to production (`APP_ENV=production`, live keys); smoke test one low-value order and a refund; watch metrics and the exception queue.
13. [ ] Rollback plan: redeploy the previous image tag; migrations never drop indexes.
