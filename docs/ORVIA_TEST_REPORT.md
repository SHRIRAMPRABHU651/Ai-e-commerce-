# ORVIA test report (this build)

An inventory of every test file and an honest record of what was and was not executed for this build. **Nothing in the "Not executed" table is claimed to pass.** The authoring sandbox could not download or run the MongoDB binary (blocked by network policy; nothing was downloaded or worked around), so every Mongo-backed test and every browser journey was written and read carefully but **not run here**. They run in CI (`.github/workflows/ci.yml`).

Counts are computed from the files: unit and Playwright counts come from the tools (`vitest run --reporter=json`, `playwright test --list`); integration counts come from counting `it(`/`test(` lines (static, so a parametrised or generated case may be under-counted).

## Executed vs not executed

### Executed in this build (real results)

| Check | Command | Result |
|---|---|---|
| Type check (all workspaces) | `npm run typecheck` | exit 0 |
| Lint (zero warnings, whole repo incl. new scripts and specs) | `npm run lint` | exit 0 |
| Unit tests, DB-less | `npx vitest run --config <outside-repo>/vitest.nodb.config.mjs` (include `tests/unit/**/*.test.ts`, `NODE_ENV=test`) | **20 files, 463 tests, 463 passed, 0 failed** (5.2 s) |
| Production build of API, worker and web | `npm run build` | exit 0 |
| Boot check (API builds with every route and job handler registered; no database) | `npm run boot-check` | `boot-check ok` (~388 route lines) |
| Playwright spec discovery | `npx playwright test --list` | works with the repo config and no browser: **106 test entries in 6 files** (53 per project x 2 projects) |
| Dependency audit, production deps only (new CI step) | `npm audit --omit=dev --audit-level=high` | exit 0 (4 moderate, 0 high) |
| Load script plumbing | `node scripts/load-scenarios.mjs --target http://127.0.0.1:<stub>` against a throw-away local HTTP stub (not the ORVIA API) | all six scenarios issued the intended method/path/body/cookie sequence; the stub's latency numbers were discarded and are not performance data |
| `load-jobs.ts` safety guard | `MONGODB_URI=.../orvia npx tsx scripts/load-jobs.ts` | refused as designed (database name must end in `_load`/`_perf`); the measurement itself did not run |

Two findings from running the checks, not caused by this change:

- `npm audit --audit-level=high` (all dependencies, the pre-existing CI step) currently **exits 1**: one high-severity advisory in `follow-redirects` 1.16.0-1.16.1 (dev tooling, GHSA-mrwp-f3q8-3g9p; `npm audit fix` offers a fix, not applied here because it rewrites the lockfile). The new production-only audit step passes. The lead should decide whether to bump the lockfile or relax the old step.
- `npx tsc -p scripts/tsconfig.json --noEmit` (not part of `npm run typecheck`) reports 5 errors in files this workstream did not touch: `tests/integration/market.test.ts(165)`, `tests/unit/creators.test.ts(60,61,70)`, `tests/unit/find-engine.test.ts(125)`. The new files add none.

### Not executed in this build

| Suite | Why not | Exact command to run it |
|---|---|---|
| Mongo-backed integration tests (29 files, about 220 cases) | needs MongoDB (`tests/helpers/globalSetup.ts` starts one; CI uses a `mongo:7` service container via `TEST_MONGO_URI`) | CI: `npm run test:coverage`. Local with Docker: `docker run -d -p 27017:27017 mongo:7 && TEST_MONGO_URI=mongodb://127.0.0.1:27017/ npm test` |
| Coverage thresholds (lines 80 / branches 70 on `packages/core`) | part of the same run | `npm run test:coverage` |
| Playwright browser E2E (6 spec files, 106 entries) | needs the E2E stack (ephemeral MongoDB + seed + built API/worker/web) and a Chromium | `npx playwright install --with-deps chromium && npm run build && npm run e2e` (CI job `e2e`). One spec: `npm run e2e -- tests/e2e/customer-lifecycle.spec.ts --project=desktop` |
| Scenario load tests (search, browse, ORVIA Find, cart, checkout, support) | needs a running API with a database | local: `npm run load`; staging: `node scripts/load-scenarios.mjs --target https://<staging-api> [--allow-writes]`; or the manual GitHub workflow `Load test (manual)`. See `docs/PERFORMANCE.md` |
| Job throughput test (order intake, fulfilment drain, tracking update, supplier sync) | needs MongoDB | `MONGODB_URI=mongodb://127.0.0.1:27017/orvia_load npm run load:jobs -- --orders 100` |
| Older perf baseline | needs MongoDB | `npm run build && npm run perf` |
| Docker image builds, Terraform validate/fmt, secret scan of the browser bundle | tools / network not available or outside this task | CI jobs `docker`, `terraform`, and the `production-check --scan-only` step in `verify` |
| Real payment, supplier, ads and tracking providers | require credentials we do not have | not testable here; the mock providers are covered by the suites above, see `docs/LIMITATIONS.md` |

No pass/fail, latency or throughput number is reported for anything in this table.

## Inventory

### Unit tests (`tests/unit`, DB-less, executed: 463 passed)

| File | Tests | Covers |
|---|---:|---|
| `aftersales.test.ts` | 28 | return eligibility rules, refund maths, return/refund state machines |
| `analytics.test.ts` | 16 | unit economics, supplier ranking, pricing engine |
| `certification.test.ts` | 4 | an unrun check is never recorded as PASS; skipped Terraform recorded as SKIP |
| `creators.test.ts` | 30 | handle validation, commission maths, hold and clawback |
| `customer360.test.ts` | 24 | LifeGraph allowlist/deny guard, personalisation signals, `canContact` consent |
| `economics.test.ts` | 7 | CAC scenario band, derived (not invented) markup, measured refund rate |
| `email-escaping.test.ts` | 3 | HTML escaping in emails |
| `events.test.ts` | 36 | hashing/normalisation vectors, event ids and dedupe, consent gating |
| `finance.test.ts` | 43 | FX policy, double-entry ledger builders, contribution maths |
| `find-engine.test.ts` | 27 | delivery assessment never over-promises, ranking and "why matched", semantic index |
| `find-intent.test.ts` | 27 | budget parsing, delivery deadlines, needs/categories/gifts/attributes |
| `find-priceguard.test.ts` | 13 | price snapshots, honest history coverage, alert decisions |
| `market.test.ts` | 14 | robots.txt, entity normalisation, source parsers |
| `needs.test.ts` | 5 | shop-by-need definitions, referral terms |
| `organic.test.ts` | 5 | organic/eco claims need evidence |
| `providers.test.ts` | 24 | mock supplier, CJ adapter (mocked HTTP), payment providers |
| `rescue.test.ts` | 50 | delivery-rescue classifier, ranker, option generation |
| `safety.test.ts` | 36 | compliance filter, address validation, search helpers |
| `suppliernet.test.ts` | 39 | verification gating, production routing guard, onboarding transitions |
| `trust.test.ts` | 32 | small-sample statistics, supplier trust scoring, aggregation |
| **Total** | **463** | |

### Integration tests (`tests/integration`, Mongo-backed, NOT executed here)

| File | Cases | Covers |
|---|---:|---|
| `aftersales.test.ts` | 6 | returns (eligibility, evidence upload, RMA, partial refund), webhooks (duplicates, crashes, chargebacks) |
| `creators.test.ts` | 9 | applications/handles, collections, attribution, commission and clawback |
| `customer360.test.ts` | 10 | auth on every customer route, ownership/IDOR, consent and preferences |
| `domain-edges.test.ts` | 8 | manual (API-less) supplier, marketing, discovery |
| `economics.test.ts` | 15 | publish gate at three CAC levels, measured CPA and refund rate |
| `events.test.ts` | 6 | outbox, browser capture + consent + unsubscribe, campaigns respect consent |
| `export-gate.test.ts` | 2 | export attestation cannot be bypassed |
| `failure-matrix.test.ts` | 5 | failure matrix across mock adapters |
| `failures.test.ts` | 7 | durable queue, payment failures, infrastructure failures |
| `finance.test.ts` | 4 | append-only idempotent ledger, sync/backfill/reconciliation, FX |
| `find.test.ts` | 11 | `POST /find`, `/compare`, alternatives, Price Guard ownership and limits |
| `growth.test.ts` | 5 | shop by need, referral loop |
| `image-pipeline.test.ts` | 8 | upload validation, image gating, supplier image ingestion |
| `images.test.ts` | 3 | product images come from the supplier |
| `launch.test.ts` | 5 | launch readiness gate |
| `market.test.ts` | 10 | polite crawling, trend engine on collected evidence |
| `multi-supplier.test.ts` | 6 | different suppliers for different countries |
| `operations.test.ts` | 24 | admin dashboard/analytics, dynamic pricing approval, inventory protection |
| `organic.test.ts` | 4 | organic claims never invented |
| `reconciliation.test.ts` | 2 | daily reconciliation |
| `rescue.test.ts` | 9 | delivery-rescue detection, idempotency/restarts, consent |
| `returns-edges.test.ts` | 2 | return eligibility and decisions |
| `security.test.ts` | 12 | authentication, RBAC, web security |
| `seed.test.ts` | 1 | seed runs through real domain flows (counts 4 suppliers: the e2e fixtures deliberately live outside the seed) |
| `shop-flow.test.ts` | 4 | discover, cart, checkout, pay, fulfil, track, deliver |
| `supplier-ops.test.ts` | 11 | capability registry, ASSISTED approval, supplier health and failover |
| `suppliernet.test.ts` | 15 | role separation, tenant isolation (cross-supplier IDOR), verification gating |
| `support-copilot.test.ts` | 6 | support answers grounded in real data, business copilot confirmations |
| `trust.test.ts` | 10 | Digital Product Passport, Purchase Confidence, TrustGraph admin |
| **Total (static count)** | **about 220** | |

### Browser E2E (`tests/e2e`, Playwright, NOT executed here; listing verified)

Projects: `desktop` (1366x800) and `mobile` (390x844). The new specs create real orders, so their long serial flows run on `desktop` only (they `test.skip` on `mobile`); listing therefore shows each twice.

| File | Tests (per project) | Covers |
|---|---:|---|
| `journey.spec.ts` (existing, unchanged) | 2 | discover, cart, checkout, pay, fulfilment to DELIVERED, tracking; wrong email reveals nothing |
| `responsive.spec.ts` (existing, unchanged) | 22 | overflow + accessibility basics on storefront and admin pages, mobile drawer, keyboard skip link, economics page |
| `discovery-compare.spec.ts` (new) | 9 | typo-tolerant search, empty search state, category page, ORVIA Find (understanding panel, "why matched", examples, photo search without a vision service), compare tray to side-by-side table, compare by URL ids, compare with fewer than two products |
| `customer-lifecycle.spec.ts` (new, serial, desktop) | 12 | registration (weak password, duplicate email), add to cart and cart operations, checkout validation, duplicate submit makes one order, declined card then successful retry (mock provider, signed webhook), replayed webhook is idempotent, support assistant (refund status; guest asked for an order number), order tracking, return refused before delivery, return wizard, staff authorise/receive/inspect/refund, refund progress visible to the customer |
| `admin-orders.spec.ts` (new, serial, desktop) | 4 | bad staff password, order search + status filter + empty state, order drawer sections and "Contact customer", cancel an unpaid order |
| `supplier-portal.spec.ts` (new, serial, desktop) | 4 | anonymous redirect, customer account refused, SUPPLIER sign-in + dashboard + bad tracking number rejected + mark shipped, sign-out |
| `support.ts` (helper, not a spec) | n/a | API base URLs, staff API session (cached: `/auth/*` allows 10 requests/min/IP), order creation through the public API, status polling |

Supporting changes: `scripts/lib/e2e-fixtures.ts` + `scripts/e2e-seed.ts` add one SUPPLIER-role user (`supplier@e2e.orvia.test`), a MANUAL supplier and one shipment waiting to ship, applied by `scripts/e2e.mjs` after the normal seed. `scripts/lib/seed.ts` is untouched, so `seed.test.ts` still sees exactly 4 suppliers.

What the browser specs do not cover (honest gaps): real Stripe/Razorpay payment sheets (mock provider only), real supplier APIs, email delivery (log mode), the Next.js storefront on a phone beyond the existing responsive checks, and any flow behind credentials we lack. The `/dev/*` simulation endpoints the specs rely on do not exist when `APP_ENV` is `staging` or `production`, so these specs cannot be pointed at staging; use the load scripts and manual verification there (`npm run verify:staging`).

Selector verification: every locator was checked against the component source (ids, `aria-label`s, headings, button text, dialog titles) rather than guessed. Notable consequence: the `Field` component only binds its label to a control when `htmlFor` is passed, so several forms (return wizard selects, supplier ship form, modal inputs) are located by their adjacent label or position, not `getByLabel`. Because they were not run, expect to fix small selector or timing details on first CI execution.

### Load and performance (NOT executed here)

| File | Covers |
|---|---|
| `scripts/perf.mjs` (existing) | 3-endpoint local baseline; committed evidence in `docs/evidence/perf-2026-10-23.json` |
| `scripts/load-scenarios.mjs` (new) | search, browse, ORVIA Find, cart operations, checkout/order creation, support assistant; p50/p95/p99, RPS, error rate and 429 share per scenario; writes `perf-results.json` (key `load`); local or `--target` staging |
| `scripts/load-jobs.ts` (new) | in-process throughput of order intake, fulfilment job drain, tracking update (`syncTracking`) and supplier offer sync (`syncProductOffers`) with mock suppliers; refuses databases not named `_load`/`_perf` |
| `.github/workflows/load.yml` (new) | manual (`workflow_dispatch`) wrapper; never runs automatically |

Targets are documented in `docs/PERFORMANCE.md` as hypotheses to be validated. Results: pending until run.

## CI changes (additive)

`.github/workflows/ci.yml`: `verify` gained `npm run boot-check` (after the build) and a production-only `npm audit --omit=dev --audit-level=high` step; the existing all-dependency audit step is unchanged (and currently fails, see above). The `e2e` job runs `npm run e2e`, which now also applies the e2e fixtures and runs the four new specs; its timeout was raised from 30 to 45 minutes to allow for them. New `load.yml` is manual only. No existing job was removed or weakened.
