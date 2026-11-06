# ORVIA product requirements and status

Each requirement was checked against the code at the time of writing: a route in `apps/api/src/routes/*`, a page under `apps/web/src/app/**`, or a domain function under `packages/core/src/domain/**` exists. **Status words:**

- **Implemented**: code exists and, where the logic is pure, is unit-tested. It has not run against a live external provider and the Mongo-backed integration tests were not executed in the build session ([ORVIA_TEST_REPORT.md](ORVIA_TEST_REPORT.md)).
- **Partially**: some of the requirement exists; the gap is stated.
- **Requires external credentials**: implemented against public provider documentation, never run against a real or sandbox account.
- **Planned**: not built.

Nothing in this file means "verified in production".

## 1. Consumer commerce

| Requirement | Status | Evidence / gap |
|---|---|---|
| Catalogue, categories, product pages, typo-tolerant search | Implemented | `/c/[slug]`, `/p/[slug]`, `/search`; `domain/search.ts` (in-process, capped at 5,000 documents) |
| Cart with server-side pricing | Implemented | `domain/cart.ts`; no stock reservation |
| Idempotent checkout, guest and signed-in | Implemented | `POST /checkout`, `domain/orders.ts` |
| Order tracking and guest lookup | Implemented | `/track`, `/orders/[orderNumber]`; guest needs order number and email |
| Accounts, email verification, password reset | Implemented | `routes/auth.ts`; unverified accounts cannot claim guest orders by email (`routes/shop.ts`); no MFA |
| Wishlist, reviews | Implemented | reviews auto-publish; `verifiedPurchase` means any paid order (baseline audit; not re-checked) |
| Multi-country (US, CA, IN) pricing, currency, tax estimate | Partially | tax and duty are regional estimate tables, not filing-grade |

## 2. ORVIA Find

| Requirement | Status | Evidence / gap |
|---|---|---|
| Natural-language search with understanding panel | Implemented | `POST /find`, `domain/find/`, `/find` |
| AI refinement of the parse | Requires external credentials | `GEMINI_API_KEY`; fallback logic unit-tested |
| Image search | Requires external credentials | `POST /find/image`; returns `503 not_configured` without a key |
| Compare 2 to 4 products | Implemented | `POST /compare`, `/compare` |
| Gift, budget and need presets; alternatives | Implemented | `GET /find/presets`, `/find/alternatives/:productId` |
| Saved searches with new-match email | Implemented / Requires external credentials | `/account/saved-searches`; email delivery needs a provider |
| Neural embeddings | Planned | interface only (`find/semantic.ts`) |
| Catalogue above 3,000 products per country | Partially | cache limit; real search engine needed at scale |

## 3. Product Passport

| Requirement | Status | Evidence / gap |
|---|---|---|
| Public passport with provenance per fact | Implemented | `GET /products/:slug/passport`, `trust/passport.ts`, `ProductPassportPanel` on `/p/[slug]` |
| Person-recorded verified evidence with expiry | Implemented | `POST /admin/trust/evidence` (`trust:write`, audited) |
| Image source and usage-rights status | Partially | reported, not enforced |
| Price history on the passport | Partially | passport has an input for snapshots but returns today's price only; history is shown by Price Guard (`/find/price-history`) |
| Manufacturer identity | Partially | shown only when evidence is recorded |

## 4. TrustGraph

| Requirement | Status | Evidence / gap |
|---|---|---|
| Supplier reliability with confidence and small-sample handling | Implemented | `trust/scoring.ts`, `/admin/trust` |
| Per-destination slices | Implemented | hierarchical shrinkage to the global record |
| Product risk score | Implemented | `unknown` when insufficient |
| Snapshots with inputs and model version, 6-hourly recompute | Implemented | job `trust_recompute`, `POST /admin/trust/recompute` |
| Statistical validity at real volume | Planned | no real transactions exist yet; thresholds (5 and 30 resolved shipments) are design choices |

## 5. Supplier network and portal

| Requirement | Status | Evidence / gap |
|---|---|---|
| Adapter matrix: `rest`, `cj`, `feed`, `manual` | Implemented / Requires external credentials | none run against a real vendor |
| Named-vendor adapters (AliExpress, DSers, Spocket, Zendrop, Syncee, DropCommerce, Wholesale2B, Modalyst, Printful, Printify) | Planned | use `rest` or `manual` |
| Onboarding state machine with gates and evidence checklist | Implemented | `suppliernet/gating.ts`, `/admin/supplier-network` |
| Production routing only for approved, production-ready suppliers | Implemented | `supplierRoutable`, `SUPPLIER_ENFORCE_VERIFICATION` |
| Catalogue ingestion and matching queue | Implemented | `ingestSupplierCatalog`, `matching.ts` |
| Quote comparison with freshness labels | Implemented | `GET /admin/supplier-network/quotes` |
| SLA from real shipments | Implemented | job `suppliernet_sla` |
| Disputes, return authorization, payables reconciliation | Implemented | record-only; ORVIA does not pay suppliers |
| Supplier portal with tenant isolation | Implemented | `/supplier`, `routes/suppliernet.ts` |
| Supplier self-edit of profile, order notification email, image hashing | Planned | |

## 6. Delivery Rescue

| Requirement | Status | Evidence / gap |
|---|---|---|
| Detect failing deliveries (9 kinds) | Implemented | `rescue/` classifier, job `rescue_scan` every 10 minutes |
| Option generation with cost impact | Implemented | six options |
| Authorization policy; automatic execution off by default | Implemented | `rescue_policy`, `PUT /admin/rescue/policy` |
| Signed, expiring customer consent for material changes | Implemented | `GET|POST /orders/:orderNumber/recovery` |
| Idempotent execution, duplicate-order guard, immutable timeline | Implemented | |
| Real supplier cancel and reorder | Requires external credentials | verified only against mock and fake providers |
| LLM explanation of a case | Planned | `aiExplanation` slot exists, nothing fills it |
| Fair Deal ranking inside rescue | Partially | pluggable through `setOfferRanker()`; default `local-v1` ranker |

## 7. Customer 360 and LifeGraph

| Requirement | Status | Evidence / gap |
|---|---|---|
| Staff Customer 360 with masking, audit and reasoned PII reveal | Implemented | `/admin/customer-360`, `customer360:read|write` |
| LifeGraph opt-in, allow/deny guard, view/edit/export/delete | Implemented | `/account/preferences`, `/account/lifegraph*` routes |
| Consents and privacy centre, export, deletion request with staff processing | Implemented | `/account/privacy`; automatic anonymization without staff approval is Planned |
| Sender-level enforcement of consent in existing senders (cart recovery) | Partially | cart recovery still uses `Customer.marketingConsent` |
| Bounce and complaint suppression feed | Planned | |

## 8. Product Companion, Aftercare, Commerce Memory

| Requirement | Status | Evidence / gap |
|---|---|---|
| Product Companion per purchased item | Implemented | `/account/products/[orderItemId]` |
| Aftercare hub | Implemented | `/account/aftercare` |
| Commerce Memory with retention and master switch | Implemented | `/account/memory`, job `customer360_sweep` |
| Reorder reminders | Planned | |

## 9. Purchase Confidence, Fair Deal, Customer Advocate

| Requirement | Status | Evidence / gap |
|---|---|---|
| Purchase Confidence report | Implemented | `GET /products/:slug/confidence`; total price includes an estimated tax |
| Fair Deal ranking (same product; substitution needs consent) | Implemented | `rankOffersByFairValue`; staff route `GET /admin/trust/products/:id/fair-deal` |
| Customer-facing Fair Deal page | Partially | exposed through `fairDealForCustomer`; no dedicated storefront page was found |
| Customer Advocate recommendation and outcome metrics | Implemented | `POST /assistant/advocate`; metrics show insufficient data under 30 observations |
| Model wording of advocate explanations | Requires external credentials | |

## 10. Price Guard

| Requirement | Status | Evidence / gap |
|---|---|---|
| Daily snapshots written on change; honest history coverage | Implemented | job `find_price_snapshot`, `GET /find/price-history/:productId` |
| Alerts: drop, target, back in stock, better verified offer | Implemented | `/account/price-guard`, job `find_price_alerts` hourly |
| Alert email delivery | Requires external credentials | verified-account-only |
| Wired into the product page | Implemented | `TrackPriceButton`, `PriceHistoryPanel`, `BetterOfferNotice` in `pdp.tsx` and `p/[slug]/page.tsx` |

## 11. Operations, returns, payments, shipping

| Requirement | Status | Evidence / gap |
|---|---|---|
| Exception queue with permission-checked refund actions | Implemented | `/admin/exceptions` |
| Fulfilment with supplier failover and idempotency | Implemented | `domain/orders.ts`, `offers.ts` |
| Late payment on a cancelled order recorded and escalated | Implemented | `orders.ts` |
| Returns: eligibility engine, evidence upload (re-encoded, EXIF stripped), RMA workflow, partial refunds | Implemented | `/account/returns/*`, `/admin/returns`, `/aftersales/*` |
| Exchange / replacement | Partially | only where the supplier policy supports it; replacement supplier orders are placed manually; no customer variant picker |
| Return labels | Planned | `ReturnLabelProvider` interface; no carrier integration ships |
| Supplier recovery claims | Implemented | no dedicated create form (API plus transitions tab) |
| Chargebacks: ingestion, state machine, deadlines, reserve, rate | Implemented / Requires external credentials | Stripe `charge.dispute.*`, Razorpay `payment.dispute.*` |
| Dispute evidence submission to the provider | Partially | text fields only, stored as `submitted_unverified`; file evidence Planned |
| Stripe and Razorpay payment and refund flows | Requires external credentials | |
| Authorize then capture | Requires external credentials | `captureMode`, `capturePayment` |
| Provider reconciliation | Implemented / Requires external credentials | job `aftersales_provider_reconciliation` every 6 h |
| Shipping options and delivery estimate | Partially | supplier-provided ETAs and rate tables; no carrier rate API |
| Tracking | Partially | relayed from supplier; no carrier integration |

## 12. Finance

| Requirement | Status | Evidence / gap |
|---|---|---|
| Append-only double-entry ledger, idempotent, FX snapshot | Implemented | `finance_ledger`, job `ledger_sync` |
| Reconciliation of ledger with orders, refunds, shipments, ad metrics | Implemented | job `ledger_reconciliation` |
| Profit definitions with provenance; cost alerts | Implemented | `/admin/finance`, job `finance_cost_alerts` |
| FX providers and staleness policy | Requires external credentials | `frankfurter`, `exchangerate_api` not run live |
| FX wired into every pricing path | Partially | `liveFxTable` is now used in `orders.ts`, `offers.ts`, `reporting.ts`, `economics.ts` and the rescue engine (the finance doc still lists orders, offers and reporting as not yet wired: doc is stale); `adsService.ts`, `importer.ts`, `pricing.ts` and `market/index.ts` still read the static `ops.fx` table |
| Cash-flow forecast | Implemented | deliberately narrow; payables and settlement delays are settings |
| Scenario model for a revenue target | Implemented | the target is an input; answers `not_reachable` honestly |
| PSP payout and bank statement reconciliation | Planned | |

## 13. Growth, marketing, creators

| Requirement | Status | Evidence / gap |
|---|---|---|
| Consent-gated server-side events (Meta, TikTok, GA4, Google Ads) | Requires external credentials | outbox, retry, dead-letter implemented |
| Browser pixels after consent | Implemented | `components/tracking.tsx` |
| Segments, email campaigns, experiments, attribution | Implemented | `/admin/campaigns`; delivery needs an email provider |
| Product feeds (Google Merchant RSS, Meta CSV) | Implemented | acceptance by Merchant Center/Commerce Manager unverified |
| Paid ad creation | Requires external credentials | Meta full chain paused; TikTok and Google campaign only |
| Referral program | Implemented | alias-email abuse is not detected |
| Creator programme: apply, collections, public pages, links, commissions, payouts, fraud controls | Implemented | payout execution manual; no KYC or tax forms |
| Loyalty points and tiers | Implemented | `/account/loyalty` |
| Creator email notifications | Planned | |
| Multi-touch attribution; email opens; List-Unsubscribe | Planned | |

## 14. Admin modules

The original numbered list of 30 requested admin modules was not part of the material available to the docs-A workstream, so the lead should reconcile this table against it. Below is every admin area in the product scope mapped to its page, and the capabilities that exist only as API (marked Missing UI).

| Module | Page | Status |
|---|---|---|
| Overview dashboard | `/admin` | Implemented |
| Orders | `/admin/orders` | Implemented |
| Exceptions queue | `/admin/exceptions` | Implemented |
| Products and product detail (claims, images) | `/admin/products`, `/admin/products/[id]` | Implemented |
| Categories | `/admin/categories` | Partially (read-only; categories are code constants) |
| Suppliers | `/admin/suppliers` | Implemented |
| Supplier network | `/admin/supplier-network` | Implemented |
| Inventory | `/admin/inventory` | Implemented |
| TrustGraph / Product Intelligence | `/admin/trust` | Implemented |
| Delivery Rescue | `/admin/rescue` | Implemented |
| Returns, claims, supplier policies, chargebacks | `/admin/returns` | Implemented (`components/aftersales-admin.tsx`: returns, supplier policies, claims, analytics and chargebacks) |
| Refunds and approvals | `/admin/payments` | Implemented (refund approval calls `/admin/refunds/:id/approve`) |
| Payments | `/admin/payments` | Implemented |
| Shipping | `/admin/shipping` | Implemented |
| Customers | `/admin/customers` | Implemented |
| Customer 360 | `/admin/customer-360` | Implemented |
| Support | `/admin/support` | Implemented |
| Reviews | `/admin/reviews` | Implemented |
| Finance (ledger, FX, cash flow, objective model) | `/admin/finance` | Implemented |
| Economics | `/admin/economics` | Implemented |
| Promotions | `/admin/promotions` | Implemented |
| Marketing | `/admin/marketing` | Implemented |
| Tracking and campaigns | `/admin/campaigns` | Implemented |
| Ads | `/admin/ads` | Partially (settings and capabilities; ad creation by API) |
| Creators and loyalty | `/admin/creators` | Implemented |
| Market intelligence | `/admin/market` | Implemented |
| AI agents | `/admin/ai-agents` | Implemented |
| AI Copilot | `/admin/copilot` | Implemented |
| Automation | `/admin/automation` | Implemented |
| Launch readiness | `/admin/launch-readiness` | Implemented |
| Countries | `/admin/countries` | Implemented |
| Analytics | `/admin/analytics` | Implemented |
| Settings | `/admin/settings` | Partially (pricing and ops only) |
| Audit logs | `/admin/audit` | Implemented |
| Staff user management (`/admin/users`) | none | **Missing UI** (API only) |
| Export attestation (`/admin/compliance/export`) | none | **Missing UI** (API only; a hard publish gate in production) |
| Manual offer and manual fulfilment (`/admin/products/:id/manual-offer`, `/admin/orders/:id/manual-fulfillment`) | none | **Missing UI** (API only); partly covered by the supplier-network manual queue and supplier portal |
| Sourcing settings, competitor prices, market match, session management | none | **Missing UI** (API only) |
| Design system / theme management | none | Not applicable (code-level tokens) |

## 15. Design

| Requirement | Status | Evidence / gap |
|---|---|---|
| Tokens, light and dark theme without flash | Implemented | `packages/ui`, [ORVIA_DESIGN_SYSTEM.md](ORVIA_DESIGN_SYSTEM.md) |
| Contrast computed from tokens | Implemented | `tests/unit/design-contrast.test.ts` |
| Accessible components, touch targets, focus trap | Implemented | Playwright accessibility basics exist but were not executed |
| Automated axe and visual regression | Planned | |
| 16px mobile form font globally | Planned | |
| Creator collections and supplier trust on the homepage | Planned | no public listing endpoint |

## 16. AI agents

| Requirement | Status | Evidence / gap |
|---|---|---|
| 11 specs, typed tools, authorized execution, audit, budgets, kill switch | Implemented | `domain/agents/`, `/admin/ai-agents` |
| Confirmation-gated writes (return, replacement request, price alert, preference) | Implemented | `POST /assistant/confirm` |
| Shopping Assistant | Implemented | deterministic intents; `POST /assistant/message` |
| Model-chosen tools and wording | Requires external credentials | `GEMINI_API_KEY` |
| Real token accounting | Planned | budgets use an estimate |
| Streaming, voice, image input | Planned | |
| Original 21-agent stubs (ContentAgent etc.) | Partially | descriptive stubs from the baseline; tool allow-list not enforced for them (baseline audit) |

## 17. Security

| Requirement | Status | Evidence / gap |
|---|---|---|
| RBAC matrix, route permission enforcement | Implemented | `packages/auth`, `route()` |
| CSRF header, zod validation, operator-key rejection, SSRF guard | Implemented | |
| Webhook signature, dedupe with crash-safe claim, provider re-fetch | Implemented | `aftersales/webhookClaim.ts` |
| Encrypted supplier credentials | Implemented | AES-256-GCM, `ENCRYPTION_KEY` |
| Supplier-portal tenant isolation | Implemented | foreign id returns 404 |
| MFA, idle session timeout | Planned | |
| Immutable, retained audit log | Planned | rescue timeline and ledger are immutable; the global audit log is not |
| Rate-limit IP trust | Partially | `TRUST_PROXY` is a boolean; correct only behind a proxy that overwrites `X-Forwarded-For` |

## 18. Infrastructure

| Requirement | Status | Evidence / gap |
|---|---|---|
| Multi-stage Dockerfile (api, worker, web, seed), non-root, health checks | Implemented | CI builds; not built in the build session |
| Compose files for dev and single-host production | Implemented | |
| Terraform AWS reference | Requires external credentials | CI validate and fmt only; never planned or applied |
| CI: lint, typecheck, coverage tests, build, boot check, audit, E2E, docker, terraform | Implemented | `.github/workflows/ci.yml`; not run in the build session |
| Deploy workflow | Partially | pushes SHA-tagged images and force-redeploys ECS; Terraform task definitions take image variables, so the new tag is not applied by that step; the migrations step only echoes |
| Health, readiness, metrics | Implemented | `/live`, `/health`, `/ready`, `/metrics` |
| Tracing, distributed metrics | Planned | |
| Load test results | Planned | scripts exist; no numbers |
| Backups and restore drill | Planned | Atlas PITR assumed; not exercised |
