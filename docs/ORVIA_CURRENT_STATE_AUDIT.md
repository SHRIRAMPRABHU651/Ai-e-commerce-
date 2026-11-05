# ORVIA current-state audit (baseline before reinvention)

Audited commit: `48ac745` (branch `production`, 28 commits). Method: static reading of the code, docs and tests, plus the commands in section 2. Every claim cites a file. Nothing here was exercised against a live provider. The Mongo-backed test suite was **not run** (the MongoDB binary download is blocked in this sandbox); only DB-less unit tests were executed.

Evidence tags used in tables: **U** = covered by a DB-less unit test that was executed here and passed; **I** = covered by a Mongo-backed integration test that exists in the repo but was **not executed here** (CI runs it against a `mongo:7` service, `.github/workflows/ci.yml:12-30`); **-** = no automated test found.

## 1. Executive summary

- The product is a working single-tenant dropshipping engine (storefront, admin, queue/worker, supplier/payment/ads/AI adapters) that runs end to end **against mock providers**. No live adapter (CJ, Stripe, Razorpay, Meta, TikTok, Google Ads, Resend, Twilio, Gemini, S3) has ever run against a real or sandbox account (`docs/LIMITATIONS.md` #1, #13).
- Ten reinvention areas are **scaffold only**: types, models, routes, jobs and admin pages exist as empty stubs (`apps/api/src/routes/trust.ts` etc., `packages/core/src/domain/trust/index.ts`, `packages/database/src/models.trust.ts`, `apps/web/src/app/admin/(shell)/trust/page.tsx` renders only a title). They are classed Missing below.
- Highest-severity findings: (1) email is never verified before granting access to orders by email (`shop.ts:32-33`, `shop.ts:125`, `identity.ts:24-39`); (2) a customer can be charged for an order that was already auto-cancelled and nothing refunds or flags it (`orders.ts:172-177`, `661-665`); (3) refund bookkeeping treats provider `pending` as success and returns are marked `refunded` even when the refund is awaiting approval (`orders.ts:632`, `returns.ts:54-58`); (4) OPERATIONS can approve high-value refunds through the exception queue, bypassing `refunds:approve` (`adminOps.ts:318-340`); (5) the recommendations `$or` overwrite bug (section 6) is confirmed; (6) `TRUST_PROXY=true` is a boolean, so client-supplied `X-Forwarded-For` can spoof the IP used by rate limits and fraud scoring.
- No chargeback/dispute handling exists anywhere (`grep -ri "dispute\|chargeback"` finds only the `CHARGEBACK` exception-kind enum in `packages/types/src/enums.ts`).
- Doc drift: README says 195 tests, LIMITATIONS says 253; `docs/PAYMENTS.md` says the auto-refund limit is "$5,000" but the code default is `autoRefundLimitUsd: 5000` minor units = $50 (`packages/core/src/infra/settings.ts:155`).

## 2. Baseline verification

| Command | Result |
|---|---|
| `npm ci --no-audit --no-fund` | success (Node v22.22.0, npm 10.9.4) |
| `npm run lint` (`eslint . --max-warnings=0`) | exit 0, zero warnings |
| `npm run typecheck` (all workspaces) | exit 0 |
| DB-less unit tests: `vitest run` on `tests/unit/**` with a config that skips `tests/helpers/globalSetup.ts` | **9 files, 114 tests passed** |
| `npm test` (full suite, needs MongoDB) | **not run** (binary download blocked by network policy) |
| `npm audit --omit=dev` | network worked. 4 moderate, 0 high/critical: `glob` 9.0.0-14.0.1 and `@fastify/static` 7.0.0-10.1.8 (via `@fastify/swagger-ui`, only registered outside production, `plugins.ts:149`); `minimatch` 7.0.0-11.0.0 (transitive of glob); `qs` 6.7.0-6.16.0 (via `stripe@17.7.0`, DoS in `qs.stringify` comma format). All have `npm audit fix` available. CI gates only on `--audit-level=high` (`ci.yml:32`). |
| `npm run build`, Playwright E2E, Docker build, Terraform | not run (documentation-only task) |

Test inventory (counted from files): unit 9 files / 114 tests (static `it(` count 104, remainder from `it.each`); integration 20 files, static count 140 (docs claim 253 total, which matches 114 + ~139); E2E `tests/e2e/journey.spec.ts` and `responsive.spec.ts` (7 specs, run on desktop+mobile projects, docs say 42). Coverage floors lines 80 / branches 70 on `packages/core` are enforced only via `npm run test:coverage` (`vitest.config.ts`), so they were not measured here. No tests exist for: recommendations, chargebacks, unverified-email ownership, expired-order late payment, `decideReturn` with a pending refund, promotion redemption races, support-ticket ownership.

## 3. Architecture as implemented

```
Browser -> Next.js 16 (apps/web: storefront + /admin) -- runtime proxy /api/v1/* --> Fastify API (apps/api) --> MongoDB (Mongoose)
   server components fetch API with visitor cookies (apps/web/src/lib/server.ts)         |         Redis (optional: rate limits only)
                                                                                       Mongo-backed JobQueue <-- Worker (apps/worker)
```

- **apps/api**: `src/main.ts` (config, DB connect with `autoIndex` off in production, optional inline worker in dev), `src/server.ts` (registers 21 route modules), `src/plugins.ts` (helmet, CORS allow-list, cookies, global rate limit, swagger, raw-body JSON parser, request-id/country/session hook, `$`/dot key rejection, CSRF header check, metrics, error mapping), `src/http.ts` (`route()` helper: zod body/query validation, `auth: none|optional|user|staff` + `permission`).
- **apps/worker**: `src/main.ts` runs `registerJobs`, `ctx.queue.start({concurrency})`, the Scheduler, and a tiny HTTP server (`/health`, `/live`, `/metrics`).
- **apps/web**: App Router. Store pages under `src/app/(store)`; admin under `src/app/admin/(shell)` (35 pages, 8 are title-only stubs); `src/app/api/v1/[...path]/route.ts` is a runtime reverse proxy forwarding all request headers; `src/app/art/[id]/route.ts` draws demo SVG art.
- **Packages**: `types` (enums, zod schemas, countries, FX table, money), `config` (env schema + production guard, logger, metrics, `fetchJson`/retry/circuit breaker, KV store), `database` (all Mongoose models in `models.ts`, 1026 lines; ten empty `models.<area>.ts`), `auth` (scrypt, HS256 JWT via jose, RBAC matrix of 54 permissions, AES-256-GCM), `core` (domain engine, agents, jobs, infra), `analytics` (pricing, economics, supplier ranking, scoring), `suppliers` (mock/rest/cj + manual factory in core), `payments` (mock/stripe/razorpay), `ads` (mock/meta/tiktok/google + rules), `ai` (Gemini + deterministic template + guards), `notifications` (log/Resend/Twilio + templates), `shipping` (shipping options, delivery estimate, tax/duty ports), `ui` (design system).
- **Provider interfaces** (all with a mock or log implementation refused in production): `SupplierProvider` (`suppliers/src/types.ts:126`), `PaymentProvider` (`payments/src/types.ts:109`), `AdProvider` (`ads/src/types.ts:52`), `AIProvider` (`ai/src/provider.ts:18`), `NotificationProvider` (`notifications/src/index.ts:18`), `ObjectStorage` (`core/src/infra/storage.ts:7`), `KVStore` (`config/src/kv.ts:2`), `TaxProvider`/`DutyProvider` (`shipping/src/tax.ts`; only the estimating implementation exists and it is only used by the launch gate, `launch.ts:133`, not by checkout).
- **Context**: `buildCtx` (`core/src/infra/services.ts:263`) wires cfg, logger, AI, suppliers, payments, ads, notifier, queue, storage, settings.
- **Job model**: `JobQueue` (`core/src/infra/queue.ts`): `jobs` collection, at-least-once, dedupe key via partial unique index, lock lease 120 s with crash reclaim (no heartbeat), exponential backoff 2 s..10 min, `dead` state plus `onDead` hook (only `fulfill_order` becomes an exception, `orders.ts:433-442`). `Scheduler` claims each time slot atomically in `system_settings` (`queue.ts:185-206`). 30 schedules in `DEFAULT_SCHEDULES` (`core/src/jobs/index.ts:258`), admin-overridable (min 60 s).
- **Automation**: per-key `OFF|ASSISTED|AUTOMATIC` (`types/src/enums.ts:494`), enforced only in `proposeOrExecute` (`core/src/domain/automation.ts:172`). Production defaults: discovery/fulfilment ASSISTED, abandoned-cart OFF (`settings.ts:117-129`).
- **Agents**: 21 named specs (`core/src/agents/registry.ts`; the comment says 19). `tools` and `permissions` are documentation plus automation-key labels, not an enforced tool allow-list. At least seven are descriptive stubs that return a fixed string (ContentAgent, SEOAgent, CreativeAgent, OrderAgent, CustomerSupportAgent, FraudAgent, ComplianceAgent).
- **Money path**: cart priced server-side (`cart.ts:207`) -> `createOrderFromCart` (`orders.ts:44`, idempotent on client key) -> provider intent -> signed webhook (`orders.ts:120`) -> provider re-fetch -> atomic `PENDING_PAYMENT->PAID` (`orders.ts:172`) -> fraud check -> `requestFulfillment` by automation mode -> `fulfillOrder` (pending shipment row before supplier call, deterministic supplier idempotency key, failover, `orders.ts:263`) -> `syncTracking` (`orders.ts:492`) -> status derived by `recomputeOrderStatus` (`orderStatus.ts`).
- **Order state**: not a transition table; status is derived from payment and shipments, with direct writes by `raiseException` (`exceptions.ts:321`), `requestReturn` and `cancelOrder`.

## 4. Feature classification

Classes: **PV** Production implemented and verified; **CR** Implemented but requires real credentials or external validation; **PI** Partially implemented; **MD** Mock/demo only; **MS** Missing; **BU** Broken or unsafe. PV is used only where a test in the repo exercises the feature with no live service. Because most tests need Mongo, PV rows are marked I (not executed here) unless a unit test covers it.

| Feature | Class | Evidence (code; tests) |
|---|---|---|
| Auth, sessions | PI + BU | scrypt N=2^15 (`auth/src/index.ts:190`), JWT + server session row, lockout 5 fails/15 min (`identity.ts:10-11,55-94`), reset/verify tokens hashed. Tests U (`safety.test.ts` auth primitives), I (`security.test.ts`). Defects: email verification never enforced (7.1), no MFA, no idle timeout, register reveals `EMAIL_TAKEN` (`identity.ts:26-29`), locked state returns before password check (timing/enumeration). |
| RBAC | PV (I) | 7 roles, matrix `auth/src/index.ts:314-334`; `route()` enforces (`http.ts:58-67`). `tests/integration/security.test.ts`, `safety.test.ts` role matrix (U). Gaps: exception-queue actions bypass refund permissions (7.2); `ai:write` lets MARKETING run any agent (`adminOps.ts:192-197`); copilot returns cross-domain data to `copilot:use` roles (`copilot.ts`). |
| Catalogue (products, variants, states) | PV (I) | `catalog.ts`, `PRODUCT_TRANSITIONS` (`enums.ts:469`), `operations.test.ts` lifecycle. Categories are code constants (`CATEGORY_TREE`), no CRUD. |
| Search | PI | In-memory index, typo tolerance, TTL 30 s, `MAX_DOCS=5000` silently truncated (`search.ts:321-333`). Tests U (`safety.test.ts` search helpers). Per-process; no semantic/NL/image search. |
| Cart | PV (I) | `cart.ts`; `shop-flow.test.ts`. No stock reservation; variant stock not tracked (stock is per market). |
| Checkout | PI + BU | Server pricing, idempotent (`orders.ts:44-96`). Tests I (`shop-flow.test.ts`, `failures.test.ts`). Defects: client idempotency key not bound to cart/user, so a reused key returns a stale/other order and its `clientSecret` (`orders.ts:45`, `checkout/page.tsx:30`); promo redemption result ignored (`orders.ts:91`, `promotions.ts:410`). |
| Promotions | PI | Types, margin clamp, usage limits (`promotions.ts`); `operations.test.ts` I. Usage-limit race (redeem return value ignored); PATCH not audited; per-user limit keyed on raw email. |
| Orders / state machine | PI + BU | Derived status (`orderStatus.ts`); `raiseException` overwrites status even on DELIVERED/CANCELLED/REFUNDED (`exceptions.ts:321`), and recompute of a refunded/cancelled order yields `PENDING_PAYMENT` (`orderStatus.ts:84-87`). Late payment on cancelled order lost (7.3). Tests I. |
| Fulfilment | PV (I) with caveats | `orders.ts:263-428`; `failure-matrix.test.ts`, `supplier-ops.test.ts`, `export-gate.test.ts`. `onPaid` is not crash-safe (`orders.ts:203-224`); `order_sync` recovers only in AUTOMATIC mode (`jobs/index.ts:320-326`), production default is ASSISTED. |
| Supplier selection/routing | PV (I) | `offers.ts:206`, ranking `analytics/src/supplierRanking.ts` (U `analytics.test.ts`), `multi-supplier.test.ts`. Quotes always use the first variant (`offers.ts:224`); sequential live calls. |
| Supplier adapter: mock | MD | `suppliers/src/mock/*`; refused in production (`registry.ts:49-54`); U `providers.test.ts`. |
| Supplier adapter: rest | CR | `suppliers/src/rest.ts`; tested only against fake HTTP suppliers (`multi-supplier.test.ts`, I). No SSRF guard on admin-set `baseUrl` (7.7). |
| Supplier adapter: cj | CR | `suppliers/src/cj.ts`; mocked-HTTP test only (U `providers.test.ts:56`). Never run against CJ. USD only. |
| Supplier adapter: manual | PI | `domain/manualSupplier.ts`, `supplier-ops.test.ts` (I). API exists (`/admin/products/:id/manual-offer`, `/admin/orders/:id/manual-fulfillment`) with **no UI**. |
| Supplier health/validation/modes | PV (I) | `supplierOps.ts`, `capabilities.ts`; `supplier-ops.test.ts`. |
| Payments: mock | MD | `payments/src/mock.ts`; refused in production (`registry.ts:27,45`); U. |
| Payments: Stripe | CR | `payments/src/stripe.ts`; U signature test with the SDK (`providers.test.ts:100`). Only succeeded/failed events handled; `getPayment` maps `canceled` to pending (dead ternary, line 295). |
| Payments: Razorpay | CR | `payments/src/razorpay.ts`; U HMAC test (`providers.test.ts:112`). INR only; order creation not idempotent at the provider (`:352`). |
| Webhooks | PI | Signature, dedupe, provider re-fetch (`orders.ts:120-182`); `shop-flow.test.ts`, `failure-matrix.test.ts` (I). Event is recorded before processing, so a transient failure turns provider retries into `duplicate` (`orders.ts:124-132`). |
| Refunds | BU | `orders.ts:597-659`. `pending` treated as success (632); `failed` refund replayed as the same row forever (`:606-607`); concurrent distinct partial refunds can over-refund (amount computed before create); executeRefund non-atomic. Idempotency test I (`operations.test.ts`). |
| Returns | PI + BU | `returns.ts`; ownership/window tests I (`returns-edges.test.ts`). `decideReturn('refund')` sets `refunded` even if the refund is `pending_approval` (`:54-58`). Status `received` is never set anywhere; no return label/logistics; return emails reuse the `promotion` template (`:62`). |
| Shipping/tracking | PI | `syncTracking` (`orders.ts:492`), honest "no tracking" handling; `TRACKING_LABELS`. No carrier integration (supplier-provided only). `trackingUrl` rendered unvalidated (`order-view.tsx`). |
| Notifications | CR | Templates with HTML escaping (U `email-escaping.test.ts`), Resend/Twilio adapters unverified; log provider dev-only (`notifications/src/index.ts:96-100`). Email retry may duplicate sends. |
| Reviews | PI | `reviews.ts`; `operations.test.ts` (I). Auto-published, no moderation queue, image URLs arbitrary (`schemas.ts:400`), `verifiedPurchase` = any paid order, not delivered. Moderation PATCH unaudited. |
| Wishlist | PI | `shop.ts:151-170`; no test references wishlist (grep of tests/integration). Unbounded array. |
| Referrals, needs (recent) | PI | `referrals.ts`, `needs.ts`; `growth.test.ts` written but never run (LIMITATIONS #19). `needs` uses the correct `$and` pattern (`needs.ts:20`). Alias/household abuse undetected. |
| Recommendations | BU | `$or` overwrite bug (section 6). Untested. |
| SEO/sitemap | PI | JSON-LD on PDP with `<` escaped (`p/[slug]/page.tsx:41`), canonicals, `robots.ts`. Sitemap: first 100 newest products, US only, no needs pages, no hreflang (`sitemap.ts`). |
| Analytics events | PI | `POST /events` (`public.ts:124`), TTL 180 d, trend inputs. Unauthenticated, unsigned: can inflate `views`/trend (`marketing.ts:22-25`). No server-side Meta CAPI/GA4/TikTok. |
| Ads adapters | CR | Meta full chain paused, TikTok/Google campaign only (`docs/ADS.md`); U `providers.test.ts:178`. Meta `pixelId` accepted by registry but never configured (`services.ts:293`, no env var). |
| Ad rules / safe mode | PV (U) | `ads/src/rules.ts`, U `providers.test.ts:131-176`. |
| Market intelligence | PI | Robots-aware crawler, parsers, trend engine; `market.test.ts` I, `unit/market.test.ts` U (14). Only tested against a local fake site; no real source crawled. |
| Economics / pricing / FX | PI | Engine, CPA/refund provenance, publish gate: `economics.test.ts` I, `unit/economics.test.ts` U, `analytics.test.ts` U. FX is a static table never refreshed (`types/src/money.ts:240`); `ops.fx` has no edit route; country `fxPerUsd` edits do nothing (grep: unused by code). |
| Reporting | PI | `reporting.ts`, `operations.test.ts` overview (I). |
| AI: Gemini, guards | CR (guards PV U) | `ai/src/gemini.ts` unverified live; guards and fallback U (`safety.test.ts:53-115`). |
| AI: agents/automation modes | PI | Modes enforced (`operations.test.ts` OFF mode I); agent tool permissions unenforced; seven agents are stubs. |
| Copilot | PV (I) | `copilot.ts`, `support-copilot.test.ts`. Keyword-routed; data scope not tied to caller permissions. |
| Support chatbot | PI + BU | `support.ts`; `support-copilot.test.ts` I. `ticketId` accepted from anonymous callers without ownership check (`support.ts:144`); cancel via chat is attributed to `system` (`:104`). |
| Exceptions queue | PV (I) | `exceptions.ts`, dedupe unique index; many tests. |
| Audit log | PI | `infra/audit.ts`; swallows failures; no immutability/retention. Coverage gaps in 5.10. |
| Admin modules | see 5.4 | |
| Storage/image pipeline | PV (I) + CR | sharp validation, SSRF-safe fetch (`ssrf.ts`), `image-pipeline.test.ts` I. S3 never run on a real bucket. Transform rewrites same keys under `immutable` cache headers (`imagePipeline.ts:487`, `storage.ts:188`). |
| i18n/currency | PI | 3 countries/currencies, `Intl` formatting; English only; `minPrice*100` assumes 2-decimal currencies (`search.ts:394`). |
| Tax | PI | Estimated rate tables (US 5 states, CA 7 provinces, IN 18%) (`types/src/countries.ts`); no live tax engine; `TaxProvider` not used by checkout. |
| Compliance / export gate | PV (I) | `compliance.ts` (U `safety.test.ts:7-31`), `exportGate.ts`, `export-gate.test.ts`. Attestation has **no UI** (`/admin/compliance/export`). |
| Organic-claims gate | PV (U+I) | `organic.ts`, `unit/organic.test.ts`, `organic.test.ts`. |
| Launch readiness | PV (I) | `launch.ts`, `launch.test.ts`. |
| Infra: Docker | PI | Multi-stage, non-root (`infra/docker/Dockerfile`), CI builds images; never run in deployment. |
| Infra: Terraform | CR | Validated on a runner only, never planned/applied (LIMITATIONS #4). No remote backend, no WAF. |
| CI/CD | PI | `ci.yml` (lint, typecheck, coverage tests, build, audit high, E2E, docker, terraform validate). `deploy.yml` pushes SHA-tagged images but only `--force-new-deployment`s ECS without registering a task definition with the new tag; migrations step is an `echo` (`deploy.yml:24-30`). |
| Observability | PI | pino logs, in-process Prometheus metrics (`config/src/metrics.ts`, per process), `/health /live /ready /metrics`. No tracing; worker `/metrics` is open when `METRICS_TOKEN` is unset even in production (`worker/src/main.ts:21`). |
| Rate limiting | PI | Global 600/min per IP + route limits; in-memory when no Redis (per instance). IP spoofable (7.4). |
| Security controls | PI | helmet, CSRF header, operator-key rejection, zod everywhere, SSRF guard, AES-GCM; see section 7. |
| Chargebacks / disputes | MS | none. |
| Exchanges | MS | none. |
| Trust graph / passport, rescue, customer 360, finance ledger, creators/loyalty, events/CAPI, supplier network/portal, find (AI discovery), aftersales, agent framework | MS | empty stubs (`docs` section 1; routes 5 lines each; jobs register nothing: `domain/trust/index.ts:5`). |

## 5. Inventories

### 5.1 Mock/fake providers and production refusal

| Mock | Location | Production refusal |
|---|---|---|
| Mock supplier + 43 demo products | `suppliers/src/mock/provider.ts`, `mock/catalog.ts` | `suppliers/src/registry.ts:49-54`; supplier creation `adminCommerce.ts:246`; launch gate `launch.ts:111` |
| Mock payments (signed webhooks) | `payments/src/mock.ts` | `payments/src/registry.ts:27,45`; `config/src/index.ts:145` |
| Mock ads | `ads/src/mock.ts` | `ads/src/registry.ts:30`; `config/src/index.ts:146` |
| Log notifications | `notifications/src/index.ts:25` | router returns null in production (`:98`); `config/src/index.ts:147` |
| Demo market-intel signals | `core/src/domain/importer.ts:44` | only when `SUPPLIER_MODE=mock` and not production |
| Demo art SVG route | `apps/web/src/app/art/[id]/route.ts` | image policy rejects `/art/` in production (`images.ts:23`, `services.ts:269`); the route itself is still reachable |
| Template AI provider | `ai/src/template.ts` | legitimate production fallback (labelled `source: 'template'`) |
| Seed data and staff passwords (`Orvia-Demo-2026!`) | `scripts/lib/seed.ts:16` | `seed.ts:33` refuses production; `SEED_ON_START` forbidden; launch gate fails on demo users |
| `MockStore` KV, dev routes `/dev/*` | `database/models.ts`, `routes/system.ts:167+` | routes not registered in staging/production |

Staging gap: `assertSafeForEnvironment` runs only when `APP_ENV=production` (`config/src/index.ts:142`), so staging accepts the default JWT secret `dev-only-insecure-secret-...` (`:25`) even though cookies are secure.

### 5.2 Hardcoded or static values

- FX: `DEFAULT_FX = {USD:1, CAD:1.37, INR:84}` (`types/src/money.ts:240`), duplicated as `fxPerUsd` per country (`types/src/countries.ts:49,71,93`); no freshness timestamp, no refresh job.
- Tax/duty/shipping: regional tax tables, duty de-minimis and rates, shipping fees and free thresholds (`countries.ts:327-393`); legal notices with factual claims ("Orders under $800 ship duty-free", line 346).
- Payment fees: Stripe 2.9%+30, Razorpay 2% (`analytics/src/economics.ts:12-17`); the stored `payment.fee` is a model, not the processor's fee.
- Thresholds: `minMarginPct 0.2`, CAC scenarios 15/26/40 %, `autoRefundLimitUsd 5000` (=$50), `fraudHighScore 70`, `fraudMediumScore 40`, `highValueOrderUsd 30000` (=$300), supplier price spike 10 %, min selling prices, ad rules (`settings.ts:131-168`, `ads/src/rules.ts:25-40`), rank weights (`supplierRanking.ts:43`).
- Fraud: disposable-email list and signal weights (`fraud.ts:7,56-64`); `paymentCountry` signal is never supplied.
- Timings: tracking exception at 5 days, overdue at +3 days, payment verification window 3 min..6 h, unpaid expiry 120 min, referral hold 14 d, review request 3 d (`orders.ts:507,549,187,661,534`).
- Order numbers use `Date.now()` base36 plus 3 random bytes (`orders.ts:24`).
- Placeholders: `orvia.example` domains in config defaults (`config/src/index.ts:72,91`, `countries.ts` supportEmail), `NEXT_PUBLIC_SITE_URL` defaults to localhost (`web/src/lib/server.ts:35`). `.env.example` lists unused `PAYMENT_SECRET`, `SUPPLIER_API_KEY`, `AD_API_KEY`, `AD_API_SECRET`.

### 5.3 TODO/FIXME markers

A case-insensitive search for TODO, FIXME, XXX, HACK, "not implemented", "stub", "for now", "temporary" across `apps packages scripts infra .github tests` finds **no markers in code**. Placeholder behaviour is instead hidden in code: the seven descriptive agents (`agents/registry.ts:36-47`), empty scaffolds (section 1), the `echo` migration step (`deploy.yml:25`), and "return" emails sent with the `promotion` template (`returns.ts:62`).

### 5.4 Frontend vs API

Admin pages (35). Real-API-backed: Overview, Orders, Exceptions, Products (+[id]), Suppliers, Inventory, Customers, Market intel, Economics, Launch readiness, Marketing, Promotions, Analytics, Copilot, Automation, Countries, Payments, Shipping, Returns, Reviews, Support, Settings (pricing/ops only), Audit, Ads (settings and capabilities only), Categories (read-only; fed by `/admin/products` and code constants).
Title-only stubs with no backend: TrustGraph, Delivery Rescue, Customer 360, Finance, Creators & loyalty, Tracking & campaigns, Supplier network, AI agents (each 6 lines, e.g. `trust/page.tsx`).
APIs with no UI: `/admin/users` (create/disable staff), `/admin/compliance/export*` (the legal attestation gate), `/admin/settings/sourcing`, `/admin/products/:id/manual-offer`, `/admin/orders/:id/manual-fulfillment`, `/admin/products/:id/competitor-prices`, `/admin/marketing/campaigns/:id/launch`, `/admin/market/match`, `/admin/financials`, `/auth/sessions*` (session management), `/admin/automation/ai-tasks` partly. Permissions `categories:write` and the new `loyalty:*`, `creators:*` etc. are unused. Storefront: all pages reference real endpoints; forgot/reset/verify pages exist.

### 5.5 Duplicate or dead code

Dead models: `Coupon` (never imported outside `models.ts`), `Warehouse` (imported in `adminCommerce.ts:3`, never queried), `Order.attribution` (never written), stored `RoleModel` (read-only listing). `Stripe getPayment` identical ternary branches (`stripe.ts:295`). Duplicate ternaries `5 * (cond ? 1 : 1)` and `86_400_000 : 86_400_000 / ...` (`orders.ts:507,549`). `fxPerUsd` vs `ops.fx`. Meta `pixelId` plumbing without an env var. `RefundEvent` type `refund.succeeded` never emitted (`payments/src/types.ts:82`). Failed jobs status `failed` is never used (`models.ts` job enum). Agent count comment says 19, actual 21.

### 5.6 Broken or unsafe code (details in section 7)

Late payment on cancelled order; refund pending-as-success; return marked refunded while refund pending; exception raise overwriting terminal order status and recompute mapping refunded/cancelled to `PENDING_PAYMENT`; `onPaid` not retried; recommendations `$or`; inventory sync auto-pausing the catalogue during a supplier outage (`inventory.ts:364-403` with `inventory_sync` AUTOMATIC by default, `settings.ts:121`); CastError on malformed ids returns 500 (`shop.ts:144,165`, `auth.ts:444`, `media.ts:256`, no `objectId` validation on path params).

### 5.7 Missing validation

Path params are cast by Mongoose without zod (`/auth/sessions/:id`, `/account/addresses/:id`, `/account/wishlist/:productId`, `/reviews/:id/helpful`, `/products/:productId/reviews`, all `/admin/*/:id`), yielding 500 on bad ids (`plugins.ts:228-241` has no CastError mapping). Review `images` accept any URL (`schemas.ts:400`). `PATCH /admin/users/:id` accepts role `CUSTOMER` and any user id. `/support/chat` `ticketId` ownership unchecked. Promotion `percent` max differs between schema (0.9) and route (0.5). `/events` meta/category free text. `checkout.shippingMethod` free string falls back to the first option (`shipping/src/index.ts:19`). Wishlist unbounded.

### 5.8 Missing database indexes (from `packages/database/src/models.ts`)

| Query | Where | Declared index |
|---|---|---|
| `Shipment.find({orderId})` (order view, recompute, cancel, support, reconciliation) | `orderStatus.ts:13`, `shop.ts:14`, `orders.ts:561`, `support.ts:73` | **none usable**: `orderId` has no index; the only `orderId` index is a *partial* unique index (`models.ts` shipment, status filter) that the planner cannot use for queries without a status predicate |
| `Shipment.findOne({supplierOrderId})` | `manualSupplier.ts:63,71` | none |
| `Order.find({'items.productId'})` (PDP frequently-bought-together, every product page) | `recommendations.ts:41` | none (full scan) |
| `Order.countDocuments({couponCode})` | `referrals.ts:36`, `promotions.ts:372` | none |
| `Order.countDocuments({'fraud.ip', createdAt})` | `fraud.ts:419` | only `createdAt` |
| `ExceptionModel.countDocuments/find({orderId})` | `exceptions.ts:58`, `adminCommerce.ts:65`, `orders.ts:453` | none |
| `SupportTicket`/`ReturnRequest` by `userId` or `email` | `shop.ts:174,197` | none (returns only `orderId`,`status`) |
| `AnalyticsEvent.find({userId, productId exists})` | `recommendations.ts:53` | none; `country` aggregate (`:72`) not covered |
| Home testimonials `Review.find({status,rating,verifiedPurchase}).sort(helpful,createdAt)` | `public.ts:55` | index is `(productId,status,createdAt)` |
| `Job` by `name`+`status` sort `updatedAt` | `jobs/index.ts:402-404` (33 queries per admin overview) | `(status,runAt,queue)` only |
| `Payment`/`Refund`/`Shipment` admin lists by `status` + sort | `adminOps.ts:221-241` | `Payment.status`, `Refund.status` none |
| `Notification` by `userId`/`orderId` | model has none | n/a (no query found) |
| Regex product search for needs (`tags`/`title` `\b(...)\b`) | `needs.ts:12-15` | cannot use index |
| Admin order search `^email` with `i` flag | `adminCommerce.ts:45` | case-insensitive regex cannot use `email` index |
| `Product` text index `title/keywords/tags` | `models.ts` | declared but `$text` is never used (dead index) |

### 5.9 Ownership / tenant isolation per customer-data route

| Route | Check | Verdict |
|---|---|---|
| `GET /orders/lookup`, `POST /orders/:n/cancel` | `owns()` (`shop.ts:32`): user id match **or user email match**, or guest-supplied email | email match is unverified (7.1) |
| `GET /account/orders`, `/account/returns`, `/support/tickets` | `$or [userId, email]` (`shop.ts:125,174,197`) | same weakness |
| `POST /returns` | `requestReturn` (`returns.ts:12-13`): user id or email equals order email | same weakness; guests cannot request returns (route is `auth: 'user'`) |
| `/account/addresses*`, wishlist, sessions, referrals | `userId` scoped | OK |
| `POST /products/:id/reviews`, `/reviews/:id/helpful` | `userId` from session | OK |
| `POST /support/chat` | order lookup by number plus user/email (`support.ts:42-50`); `ticketId` appended without ownership | write-IDOR on tickets |
| Cart routes | opaque httpOnly cookie token | OK |
| Checkout idempotency | key looked up globally (`orders.ts:45`) | returns another party's order if key is known |
| Staff routes | `permission` per route; `exceptions:write` actions skip `refunds:*` | see 7.2 |
| Customer PII to staff | ANALYST has `orders:read`, `customers:read` (full address, `fraud.ip`) | least-privilege gap |

### 5.10 Audit-log coverage (money and permission actions)

Covered: order created/paid/cancelled/refunded (success), supplier order created, retry/change supplier, supplier create/update/mode/validation, settings (pricing, ads, ops, sourcing, legal), country update, automation mode and schedule, AI decisions, user create/update/login/password reset, return request/decisions, referral reward/reject, product transitions/edits/price/images/claims, export attestation, manual CPA, exception raise/resolve, support reply, copilot ask.
Gaps: promotion PATCH (`adminOps.ts:142`); review moderation (`:267`); refund creation, pending-approval and failure (`orders.ts:612,646-650`); payment failure webhook (`orders.ts:140-147`); order contact emails (`adminCommerce.ts:89`); chat-initiated cancellation recorded as actor `system` (`support.ts:104`); order delivery/shipping status changes (timeline only); staff role change does not record session revocation; late payment on cancelled order (nothing). `audit()` swallows write errors (`audit.ts:236`), and `AuditLog` is a normal mutable collection without TTL or immutability controls.

### 5.11 Retry and idempotency coverage

| Area | Mechanism | Gap |
|---|---|---|
| Order creation | unique `idempotencyKey` + duplicate-key recovery (`orders.ts:82-87`) | key not bound to cart/user; stale cart reuse (7.5) |
| Payment intent | unique `(provider,intentId)`; Stripe idempotency key; mock deterministic | Razorpay order create `idempotent:false` |
| Webhooks | `WebhookEvent` unique `(provider,eventId)` + provider re-fetch + atomic status update | event persisted before processing, so partial failure is swallowed; `payment_verification` recovers only orders 3 min..6 h old (`orders.ts:187`) and unpaid orders expire at 120 min |
| `onPaid` side effects | none | not retried; recovery only for AUTOMATIC fulfilment |
| Fulfilment | pending shipment row first, deterministic supplier key, partial unique shipment index, queue retries (`orders.ts:263-428`) | lock lease 120 s with no heartbeat, long jobs can run twice |
| Refunds | unique idempotency key + provider idempotency (Stripe, Razorpay) | key includes `already` refunded amount so it changes after each refund; failed row never retried; `processing` row stuck after crash |
| Notifications | unique `dedupeKey`, queue retry | provider send not idempotent |
| Jobs | dedupe key, backoff, dead state | only `fulfill_order` has a dead-letter hook; `ctx.queue` jobs `failed` status unused |
| Scheduler | atomic slot claim | OK (`failures.test.ts`, I) |

## 6. Known bug: recommendations `baseFilter`

Confirmed. `listableImageFilter()` returns `{ $or: [{ 'images.0.url': rx }, { 'markets.images.0': rx }] }` (`images.ts:38-45`). `baseFilter` spreads it and then `...extra` last (`recommendations.ts:16`). Any caller that passes its own `$or` replaces the image-visibility clause, so products without a usable (in production: Orvia-hosted) first image can be returned:

- `trending(country, limit, category)` when `category` is set (`recommendations.ts:20`),
- `similar` (`:37`, every PDP),
- `recommendedForYou` with seeds (`:60`, home page and `/home`).

`toStoreProduct` still sets `available:false` and an empty `images` list for such items (`catalog.ts:234`), so the leak is an incomplete listing, not a purchasable item, but it breaks the "no image, no listing" invariant and the policy comment in `images.ts:1-6`. No test covers it.

Other occurrences: a search of every `listableImageFilter` caller (`public.ts:48`, `needs.ts:20`, `search.ts:57`, `recommendations.ts:16,66`) shows only `baseFilter` has the collision. `needs.ts:20` already uses the safe `$and` pattern. `public.ts:48`, `search.ts:57`, `recommendations.ts:66` spread it next to keys that are not `$or`, which is safe today but fragile.

Suggested fix: never spread; compose with `$and`.

```ts
const baseFilter = (country: CountryCode, extra: Record<string, unknown> = {}) => ({
  $and: [
    { state: { $in: SELLABLE_STATES } },
    listableImageFilter(),
    { markets: { $elemMatch: { country, enabled: true, price: { $gt: 0 }, stock: { $gt: 0 } } } },
    extra,
  ],
});
```

Make `listableImageFilter()` return `{ $and: [...] }`-safe by documenting that callers must nest it, and add a unit test asserting `JSON.stringify(baseFilter('US', { $or: [...] }))` contains both `$or` clauses.

## 7. Security findings (ranked)

**High**
1. **Unverified email grants order access.** `registerCustomer` creates a usable session without verifying the email (`identity.ts:24-39`, `auth.ts:377-383`); `emailVerified` is read nowhere except display (grep). `owns()` and the account list queries match orders by `email` (`shop.ts:32-33,125,174,197`), and registration also overwrites `Customer.userId` for an existing email (`identity.ts:35`). Anyone can register with a victim's email and read their guest orders (address, items, tracking), cancel unshipped orders, and open returns. Fix: require `emailVerified` before email-based ownership or drop email matching for signed-in users; link guest orders only after verification; test it.
2. **Paid but cancelled order is silent.** `expireUnpaidOrders` cancels at 120 min (`orders.ts:661-665`) without cancelling the provider intent (no cancel method in `PaymentProvider`, `payments/src/types.ts:109-117`). A late successful payment fails the atomic `PENDING_PAYMENT` update and returns `duplicate` (`orders.ts:172-177`): money taken, no order, no exception, no refund. Fix: on a verified payment for a non-pending order raise a `PAYMENT_FAILURE` exception and auto-refund; cancel intents on expiry.
3. **Refund state errors.** Pending provider refunds recorded as succeeded (`orders.ts:632`); `decideReturn` marks `refunded` regardless (`returns.ts:54-58`); no lock against concurrent distinct refunds (`orders.ts:601-612`). Fix: persist `pending`, reconcile via provider, claim refunds with an atomic `findOneAndUpdate`, cap sum of refunds with a conditional update on `costs.refunded`.
4. **Permission bypass in the exception queue.** `POST /admin/exceptions/:id/action` requires only `exceptions:write` but can run `approve_refund`, `refund_order`, `cancel_order`, `approve_fulfillment` (force) (`adminOps.ts:318-340`). OPERATIONS holds `exceptions:write` but not `refunds:approve` (`auth/src/index.ts:322-327`). Fix: check the underlying permission per action.

**Medium**
5. **IP spoofing.** `trustProxy: ctx.cfg.TRUST_PROXY` is a boolean (`server.ts:282`); the web proxy forwards the client `X-Forwarded-For` unchanged (`api/v1/[...path]/route.ts`). Rate limits (login 10/min), fraud IP velocity (`fraud.ts:419`) and `fraud.ip` can be spoofed; the perf doc relies on this behaviour (`docs/PERFORMANCE.md`). Fix: trust a hop count or CIDR list and overwrite XFF at the proxy.
6. **Consent integrity.** `POST /cart/contact` stores any email with `marketingConsent:true` unauthenticated (`shop.ts:75-79`), and the abandoned-cart job emails it (`marketing.ts:36`): no double opt-in, a spam vector. Production default is OFF.
7. **SSRF via admin-defined supplier URL.** `RestSupplierProvider` uses `fetchJson` with `baseUrl` from admin config (`rest.ts:32,136-142`), not `guardedFetch`; error text includes 300 chars of the response body (`resilience.ts:129`) and surfaces in supplier test results. Staff-only (`suppliers:write`).
8. **Staging accepts default JWT secret** (5.1) and `/openapi.json` is exposed in production (`plugins.ts:150`).
9. **Support-ticket write IDOR** (5.9) and unbounded `messages` growth.
10. **No MFA, no idle timeout, 7-day sessions**, per-account lockout allows targeted lockout of staff (`identity.ts:68-75`); register/lock responses enable account enumeration.
11. **Web app has no CSP or HSTS** (`next.config.ts` sets four headers only); API has helmet CSP `default-src 'none'` and HSTS when secure (`plugins.ts:121-125`).
12. **Analytics poisoning**: unauthenticated `/events` increments `stats.views` and feeds trend/`countryTrending` (`public.ts:124`, `marketing.ts:22-25`, `recommendations.ts:70-76`); capped only by 240/min/IP (spoofable).
13. **Authorization scope of AI/agent surface**: `ai:write` can run any agent by name (`adminOps.ts:192-197`); copilot answers span permission domains.

**Low**
14. Supplier `trackingUrl` and crawled `sourceUrl` are rendered as `href` without scheme validation (`order-view.tsx`, `admin/market/page.tsx`); CJ/REST adapters do not restrict schemes (`rest.ts:264`).
15. Timing: `/metrics` and `/launch-gate` bearer compare is not constant-time (`system.ts:160`, `launch.ts:457`); worker `/metrics` is open in production without a token.
16. Review image URLs arbitrary (tracking pixels, hotlinks).
17. `isPrivateAddress` misses 198.18/15, 192.0.0.0/24 and NAT64/6to4 IPv6; DNS rebinding window acknowledged in `ssrf.ts:62`.
18. Supplier credential encryption key falls back to `JWT_SECRET` outside production (`supplierAccess.ts:286`); key rotation unsupported (single key, no key id), JWT has no `kid`.
19. Idempotency-key replay can disclose `clientSecret` of another order (`orders.ts:103-105`).
20. `/health` discloses environment and version (`system.ts:147`); `/meta` discloses payment mode.

Positive controls verified in code: raw-body HMAC webhook verification with timing-safe compare (`mock.ts:190`, `razorpay.ts:362-365`, Stripe SDK), provider re-fetch before marking paid, `$`/dot key blocking (`plugins.ts:110,191`), CSRF header plus Origin check for cookie sessions (`plugins.ts:199-207`), magic-byte image sniffing (`imagePipeline.ts:241`), HTML escaping in emails (`notifications/src/index.ts:147`), JSON-LD `<` escaping, secrets never returned (`integrationStatus`), SSRF-guarded image and crawler fetches, production config guard (`config/src/index.ts:141-159`).

## 8. Performance findings

- **Per-PDP full scan**: `frequentlyBoughtTogether` queries `Order` on `items.productId` with no index on every product page (`recommendations.ts:41`, `public.ts:96`).
- **Shipment lookups without a usable index** (5.8) on every order view and status recompute.
- **N+1 and sequential I/O**: `selectSupplierLive` calls suppliers sequentially with per-link `Supplier.findById` (`offers.ts:217-250`); `syncTracking` does 200 sequential supplier calls plus per-shipment `Supplier`/`Order` fetches (`orders.ts:495-546`); `syncInventory`/`syncProductOffers`/`refreshProductMarkets` nested loops (`inventory.ts`, `offers.ts:29-85`, `pricing.ts:133-182`, multiple full-document saves per country); `verifyPendingPayments` sequential (`orders.ts:189`); `fulfillOrder` per line queries and dynamic imports.
- **Unbounded or heavy scans**: `refreshMeasuredRefunds` loads every non-demo paid order of the last 90 days into memory (`economics.ts:153`) and runs inside the 15-minute `sync_ad_metrics` job (`jobs/index.ts:328`); `deals()` loads 200 documents per request (`recommendations.ts:30`); `/admin/overview` runs ~11 parallel analytics queries plus 33 `Job` queries uncached (`adminCommerce.ts:27`, `jobs/index.ts:392-413`); `/home` issues ~12 queries and an aggregate per load without caching (`public.ts:44-56`); `listNeeds` runs 18 regex queries per call (`needs.ts:262`); each page-1 search writes an analytics event (`public.ts:72`).
- **Search index limits**: in-process, rebuilt every 30 s per instance, hard cap 5000 documents with unordered `limit` (silent truncation, `search.ts:330-333`); `suggest` and spell correction iterate the full vocabulary per query (`search.ts:400`); `$text` index unused.
- **Unbounded growth**: `Job` dead records never expire (TTL only for completed), `AuditLog` no retention, `SupportTicket.messages`, `Order.timeline`, `Product.stateHistory`, `Wishlist.productIds`.
- **LLM cost**: `product_performance` runs two review analyses for up to 50 products hourly (`jobs/index.ts:331-338`).
- **Inventory outage amplification**: during a supplier outage offers are set unavailable (`offers.ts:54`) and the AUTOMATIC `inventory_sync` pauses products (`inventory.ts:397-403`).
- Measured baseline in `docs/PERFORMANCE.md` (p95 323 ms product list, 876 ms checkout journey at 50 connections on shared hardware) is a regression floor, not capacity evidence; not re-run here.

## 9. Documentation discrepancies

README 195 tests vs LIMITATIONS 253 vs counted 114 unit + ~140 integration; `PAYMENTS.md` "$5,000" vs $50 default; `DEPLOYMENT.md` says Terraform was not validated whereas `LIMITATIONS.md` #4 says it was on a runner; `OPERATIONS.md` says no real market-intel provider is wired while `MARKET_INTELLIGENCE.md` documents the crawler; "19 agents" vs 21; `SECURITY.md` says registration does not reveal whether an email is registered, but `identity.ts:26-29` returns 409.

## 10. Prioritized gap list versus the target vision

Priority 0 (fix before building on this base): items 1-4 of section 7, section 6 bug, missing `Shipment.orderId` index, refund and order-state corrections, a real order state machine, webhook-event retry semantics, `onPaid` made retryable (outbox), proper ownership model (verified email or token-based guest access).

| # | Target capability | Current state | Needed |
|---|---|---|---|
| P1 | Commerce finance ledger + FX freshness | MS. Money is integer minor units; contribution estimates per order (`orders.ts:420-423`); static FX; no double-entry ledger, no settlement/payout import, no processor-fee actuals | ledger models, journal on every money event, FX provider with timestamps and staleness gates, reconciliation against PSP balance transactions |
| P1 | Chargebacks / exchanges | MS (enum only) | dispute webhooks (Stripe `charge.dispute.*`), evidence workflow, exception + ledger entries; exchange flow reusing returns |
| P1 | Agent framework with tool permissions | PI. Specs exist but `tools`/`permissions` unenforced; automation modes work (`automation.ts`) | per-agent allow-listed tool registry checked at call time, caller-permission intersection, durable run/step log, human-approval hooks, budget limits |
| P1 | Marketing server-side events (Meta CAPI, GA4, TikTok) | MS. No pixel/CAPI; ads adapters campaign-only; `pixelId` plumbing dead | event outbox from order/cart events, consent-aware hashing, dedupe `event_id` shared with browser, per-platform adapters, delivery metrics |
| P1 | Supplier verification and network + supplier portal | PI. Capability registry, validation suite, health monitor, manual supplier (`supplierOps.ts`); no onboarding identity/KYB, no portal, no supplier-facing auth | supplier accounts and portal auth, verification workflow with provenance, scorecards from real outcomes, contract/SLA data |
| P2 | Product passport + trust graph | MS (stubs). Today only provenance fields on cost data and organic-claim evidence (`organic.ts`) | passport schema with `verified/supplier_provided/customer_reported/ai_suggested` provenance, evidence store, trust score with "insufficient data" |
| P2 | Autonomous delivery recovery | PI. Overdue/no-tracking exceptions only (`orders.ts:507-552`) | rescue policies, reship/refund decision engine (deterministic), supplier failover for in-flight orders, customer comms |
| P2 | Customer 360 / lifegraph / companion / price guard | MS. `Customer` has LTV/orders only; no consent ledger | unified profile from orders/events/support, consent and privacy controls, price-drop watching with honest data |
| P2 | Creator/affiliate/loyalty ecosystem | MS. Referral loop only (`referrals.ts`) | creator accounts, attribution links, payout ledger, loyalty points with fraud controls |
| P3 | AI product discovery (NL / semantic / image) | MS. Keyword/typo search in memory; AI used for content only | embedding index (Atlas Search/OpenSearch), NL query parsing with structured filters, image similarity, grounded explanations |
| P3 | Real integrations verified in staging | CR for everything external | sandbox runs for CJ, Stripe, Razorpay, Resend, Twilio, S3, Terraform apply |

Cross-cutting prerequisites for all of the above: replace boolean `TRUST_PROXY`, add idempotent event outbox, shared caching (Redis) for hot reads and search, move search off-process, add the missing indexes (5.8), and bring `docs` in line with code.

## 11. Appendix: API surface (v1)

Public: `/meta`, `/home`, `/products`, `/products/:slug`, `/products/:slug/reviews`, `/search/suggest`, `/recommendations/recently-viewed`, `/events`, `/preferences/country`, `/needs`, `/needs/:slug`, cart (`/cart`, `/cart/items`, `/cart/coupon`, `/cart/contact`), `/checkout`, `/webhooks/payments/:provider`, `/orders/lookup`, `/orders/:n/cancel`, `/support/chat`, `/referrals/claim`, `/media/*` (local only). Authenticated customer: `/auth/*` (register, login, logout, me, forgot/reset password, verify email, sessions), `/account/{orders,addresses,profile,wishlist,returns,referrals}`, `/returns`, `/products/:id/reviews`, `/reviews/:id/helpful`, `/support/tickets`. Staff: ~109 route definitions under `/admin/*` (see `adminCommerce.ts`, `adminOps.ts`, `market.ts`, `economics.ts`, `launch.ts`, `media.ts`) plus `/api/v1/launch-gate` (bearer). Ops: `/live`, `/health`, `/ready`, `/metrics`, `/openapi.json`. Dev only: `/dev/*`. The ten scaffold route modules register nothing.
