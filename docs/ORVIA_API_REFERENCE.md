# ORVIA API reference

> **Generated file. Do not edit by hand.** Regenerate with `npm run docs:api` (builds the API with no database and reads the route table; source: `scripts/gen-api-reference.ts`, metadata recorded by `route()` in `apps/api/src/http.ts`).
> Conventions (auth, CSRF, errors, idempotency, rate limits) are in [API.md](API.md). Interactive OpenAPI is served at `/docs` outside production.

Base path `/api/v1`. Body/query columns list property names from each route's zod schema (converted to JSON schema); `*` marks a required property. Auth modes: `none` public; `optional` works anonymous or signed-in; `user` any signed-in account (ownership is enforced inside the handler, see [ORVIA_SECURITY_AND_PRIVACY.md](ORVIA_SECURITY_AND_PRIVACY.md)); `staff` a non-customer, non-supplier role, plus the named permission from `packages/auth` where shown. "Rate limit" appears only when the route declares its own limit; every route is also covered by the global per-IP limit (`RATE_LIMIT_PER_MINUTE`). Cookie-authenticated mutations additionally need the `x-requested-with: orvia` header.

Totals: **440** routes declared via `route()` (56 none, 10 optional, 99 user, 275 staff) plus 9 raw Fastify routes. Dev/test-only helper routes (`/dev/*`) are registered only when `APP_ENV` is not production/staging; this build ran as `test`, so the list below includes them.

## Areas

- [Account](#account) (12)
- [Admin](#admin) (193)
- [Assistant](#assistant) (7)
- [Auth](#auth) (11)
- [Cart](#cart) (6)
- [Checkout](#checkout) (1)
- [Companion](#companion) (3)
- [Creators](#creators) (21)
- [Customer 360](#customer-360) (6)
- [Dev](#dev) (7)
- [Finance](#finance) (20)
- [Find](#find) (12)
- [LifeGraph](#lifegraph) (8)
- [Market](#market) (10)
- [Memory](#memory) (7)
- [Orders](#orders) (4)
- [Price Guard](#price-guard) (5)
- [Privacy](#privacy) (8)
- [Rescue](#rescue) (7)
- [Returns](#returns) (9)
- [Reviews](#reviews) (2)
- [Storefront](#storefront) (22)
- [SupplierNetwork](#suppliernetwork) (38)
- [SupplierPortal](#supplierportal) (16)
- [Support](#support) (2)
- [Trust](#trust) (2)
- [Webhooks](#webhooks) (1)
- [Raw Fastify routes](#raw-fastify-routes) (9)

## Account

| Method | Path | Auth | Summary | Rate limit | Body | Query |
|---|---|---|---|---|---|---|
| GET | `/api/v1/account/addresses` | user | My saved addresses |  |  |  |
| POST | `/api/v1/account/addresses` | user | Save an address |  | `fullName*, line1*, line2, city*, region*, postalCode*, country*, phone, isDefault` |  |
| DELETE | `/api/v1/account/addresses/:id` | user | Delete address |  |  |  |
| GET | `/api/v1/account/loyalty` | user | My loyalty points, tier and activity |  |  | `page, pageSize` |
| POST | `/api/v1/account/loyalty/redeem` | user | Redeem points for a single-use discount code | 10 / 1 hour | `points*` |  |
| GET | `/api/v1/account/orders` | user | My orders |  |  | `page, pageSize` |
| PATCH | `/api/v1/account/profile` | user | Update profile |  | `name*` |  |
| GET | `/api/v1/account/referrals` | user | My referral code, link and rewards |  |  |  |
| GET | `/api/v1/account/wishlist` | user | My wishlist |  |  |  |
| POST | `/api/v1/account/wishlist` | user | Add to wishlist |  | `productId*` |  |
| DELETE | `/api/v1/account/wishlist/:productId` | user | Remove from wishlist |  |  |  |
| GET | `/api/v1/account/wishlist/ids` | optional | My wishlist ids (for heart state) |  |  |  |

## Admin

| Method | Path | Auth | Summary | Rate limit | Body | Query |
|---|---|---|---|---|---|---|
| GET | `/api/v1/admin/ads/capabilities` | staff: `marketing:read` | Ad platform capability registry with honest status (NOT_CONFIGURED / UNVERIFIED / VERIFIED / ERROR) |  |  |  |
| GET | `/api/v1/admin/aftersales/analytics` | staff: `returns:read` | Return analytics from real data |  |  | `days` |
| GET | `/api/v1/admin/aftersales/chargebacks` | staff: `payments:read` | Chargebacks / disputes |  |  | `page, pageSize, state` |
| GET | `/api/v1/admin/aftersales/chargebacks/:id` | staff: `payments:read` | Chargeback detail |  |  |  |
| POST | `/api/v1/admin/aftersales/chargebacks/:id/accept` | staff: `refunds:approve` | Accept (do not contest) a dispute |  | `note` |  |
| POST | `/api/v1/admin/aftersales/chargebacks/:id/evidence` | staff: `refunds:approve` | Record evidence for a dispute |  | `text*, category` |  |
| POST | `/api/v1/admin/aftersales/chargebacks/:id/submit` | staff: `refunds:approve` | Send recorded evidence to the provider (unverified without live credentials) |  |  |  |
| GET | `/api/v1/admin/aftersales/chargebacks/metrics` | staff: `payments:read` | Chargeback rate, deadlines and reserve |  |  | `days` |
| GET | `/api/v1/admin/aftersales/chargebacks/reserve` | staff: `payments:read` | Chargeback reserve by currency (finance hook) |  |  |  |
| GET | `/api/v1/admin/aftersales/claims` | staff: `returns:read` | Supplier recovery claims |  |  | `page, pageSize, state` |
| POST | `/api/v1/admin/aftersales/claims` | staff: `returns:write` | Open a supplier claim |  | `returnId, orderId*, supplierId*, kind*, claimedAmount*, description` |  |
| POST | `/api/v1/admin/aftersales/claims/:id/transition` | staff: `returns:write` | Move a claim through its state machine |  | `to*, approvedAmount, recoveredAmount, note` |  |
| POST | `/api/v1/admin/aftersales/payments/:id/capture` | staff: `refunds:approve` | Capture an authorized payment (manual-capture providers) |  |  |  |
| POST | `/api/v1/admin/aftersales/payments/reconcile` | staff: `refunds:approve` | Run provider reconciliation now |  | `sinceHours` |  |
| GET | `/api/v1/admin/aftersales/policy` | staff: `returns:read` | After-sales policy (shipping/restocking/exclusions) |  |  |  |
| PUT | `/api/v1/admin/aftersales/policy` | staff: `settings:write` | Update after-sales policy |  | `excludedCategories, restockingFeeBps, defaultClaimWindowDays, shippingRefund, returnShippingDeduction` |  |
| GET | `/api/v1/admin/aftersales/returns` | staff: `returns:read` | RMA queue |  |  | `page, pageSize, state` |
| GET | `/api/v1/admin/aftersales/returns/:id` | staff: `returns:read` | RMA detail with refund preview |  |  |  |
| POST | `/api/v1/admin/aftersales/returns/:id/authorize` | staff: `returns:write` | Authorize the RMA |  | `note` |  |
| POST | `/api/v1/admin/aftersales/returns/:id/evidence` | staff: `returns:write` | Staff upload of a photo |  |  |  |
| POST | `/api/v1/admin/aftersales/returns/:id/inspect` | staff: `returns:write` | Record inspection outcome |  | `outcome*, acceptedItems, note` |  |
| POST | `/api/v1/admin/aftersales/returns/:id/label` | staff: `returns:write` | Record a supplier-provided return label |  | `url*, carrier, trackingNumber` |  |
| POST | `/api/v1/admin/aftersales/returns/:id/notes` | staff: `returns:write` | Add a dispute/handling note |  | `text*, internal` |  |
| POST | `/api/v1/admin/aftersales/returns/:id/received` | staff: `returns:write` | Mark goods received |  | `note` |  |
| POST | `/api/v1/admin/aftersales/returns/:id/refund` | staff: `refunds:write` | Execute the refund through the guarded refund function (approval limits apply) |  | `amount, note` |  |
| GET | `/api/v1/admin/aftersales/returns/:id/refund-preview` | staff: `returns:read` | Deterministic refund calculation |  |  |  |
| POST | `/api/v1/admin/aftersales/returns/:id/reject` | staff: `returns:write` | Reject the RMA |  | `note*` |  |
| POST | `/api/v1/admin/aftersales/returns/:id/replacement` | staff: `returns:write` | Approve replacement/exchange |  |  |  |
| POST | `/api/v1/admin/aftersales/returns/:id/replacement-shipment` | staff: `returns:write` | Record the replacement shipment |  | `supplierOrderRef, carrier, trackingNumber, delivered` |  |
| GET | `/api/v1/admin/aftersales/suppliers/:id/policy` | staff: `returns:read` | Supplier return handling |  |  |  |
| PUT | `/api/v1/admin/aftersales/suppliers/:id/policy` | staff: `returns:write` | Set supplier return handling |  | `supportsReturns*, supportsReplacement, supportsExchange, returnWindowDays, defectOnly, claimWindowDays, instructions, contactEmail, returnAddress, labelProvider` |  |
| GET | `/api/v1/admin/agents` | staff: `ai:write` | Agent catalogue: purpose, tools, limits, model chain, status and today's usage |  |  |  |
| POST | `/api/v1/admin/agents/:id/kill` | staff: `ai:write` | Kill switch: turn an agent off or on (audited) |  | `enabled*, reason*` |  |
| POST | `/api/v1/admin/agents/:id/run` | staff: `ai:write` | Run a staff-facing agent (read-only tools; audited) | 20 / 1 minute | `focus, days, limit, subjectId` |  |
| GET | `/api/v1/admin/agents/escalations` | staff: `ai:write` | Human escalation queue |  |  | `page, pageSize, status, agentId` |
| POST | `/api/v1/admin/agents/escalations/:id/resolve` | staff: `ai:write` | Resolve an escalation |  | `note*` |  |
| GET | `/api/v1/admin/agents/metrics/advocate` | staff: `ai:write` | Customer Advocate outcome metrics from stored records ("insufficient data" below the sample floor) |  |  |  |
| GET | `/api/v1/admin/agents/replacement-requests` | staff: `ai:write` | Replacement requests raised by the assistant, awaiting staff |  |  | `status, page, pageSize` |
| POST | `/api/v1/admin/agents/replacement-requests/:id/decide` | staff: `ai:write` | Approve or reject a replacement request (records the decision; fulfilment stays in the Returns console) |  | `decision*, note*` |  |
| GET | `/api/v1/admin/agents/runs` | staff: `ai:write` | Run log (redacted) |  |  | `page, pageSize, agentId, outcome, actorType, from, to` |
| GET | `/api/v1/admin/agents/runs/:id` | staff: `ai:write` | Run drilldown (redacted) |  |  |  |
| GET | `/api/v1/admin/agents/usage` | staff: `ai:write` | Token/cost usage per agent per day (estimates) |  |  | `days` |
| GET | `/api/v1/admin/analytics` | staff: `analytics:read` | Analytics bundle (financials, series, countries, products, funnel, categories) |  |  | `preset, from, to` |
| GET | `/api/v1/admin/audit` | staff: `audit:read` | Audit logs |  |  | `page, pageSize, actor, action, resource, actorType` |
| GET | `/api/v1/admin/automation` | staff: `automation:read` | Automation Center |  |  |  |
| PUT | `/api/v1/admin/automation/:key` | staff: `automation:write` | Set automation mode OFF / ASSISTED / AUTOMATIC |  | `mode*` |  |
| POST | `/api/v1/admin/automation/agents/:name/run` | staff: `ai:write` | Run an agent now |  | `input` |  |
| GET | `/api/v1/admin/automation/ai-tasks` | staff: `automation:read` | Agent run history |  |  | `page, pageSize` |
| GET | `/api/v1/admin/automation/decisions` | staff: `automation:read` | AI decisions (proposed / executed) |  |  | `page, pageSize, status` |
| POST | `/api/v1/admin/automation/decisions/:id/approve` | staff: `automation:write` | Approve + execute a proposed decision |  |  |  |
| POST | `/api/v1/admin/automation/decisions/:id/reject` | staff: `automation:write` | Reject a proposed decision |  | `reason` |  |
| PUT | `/api/v1/admin/automation/schedules/:name` | staff: `automation:write` | Customize a schedule interval / enable |  | `everyMinutes, enabled` |  |
| GET | `/api/v1/admin/brief` | staff: `overview:read` | Latest daily brief |  |  |  |
| POST | `/api/v1/admin/brief/generate` | staff: `copilot:use` | Generate a brief now |  | `date` |  |
| GET | `/api/v1/admin/campaigns/attribution` | staff: `marketing:read` | Channel attribution (first/last touch) with contribution-based guidance |  |  | `days, model` |
| GET | `/api/v1/admin/campaigns/email` | staff: `marketing:read` | Email campaigns |  |  | `page, pageSize` |
| POST | `/api/v1/admin/campaigns/email` | staff: `marketing:write` | Create a draft email campaign |  | `name*, segmentId*, subject*, message*, ctaLabel, ctaUrl, maxRecipients` |  |
| POST | `/api/v1/admin/campaigns/email/:id/cancel` | staff: `marketing:write` | Cancel a draft/scheduled/sending campaign (queued sends stop) |  |  |  |
| GET | `/api/v1/admin/campaigns/email/:id/results` | staff: `marketing:read` | Per-campaign results |  |  |  |
| POST | `/api/v1/admin/campaigns/email/:id/schedule` | staff: `marketing:write` | Schedule a draft campaign |  | `scheduledAt*` |  |
| POST | `/api/v1/admin/campaigns/email/:id/send` | staff: `marketing:write` | Send now (consent, unsubscribe list, frequency and daily caps enforced) |  |  |  |
| POST | `/api/v1/admin/campaigns/email/:id/test-send` | staff: `marketing:write` | Send a [TEST] copy to your own account email |  |  |  |
| GET | `/api/v1/admin/campaigns/experiments` | staff: `marketing:read` | Experiments |  |  |  |
| POST | `/api/v1/admin/campaigns/experiments` | staff: `marketing:write` | Create an experiment (draft) |  | `key*, name*, hypothesis, variants*, conversionEvent*` |  |
| GET | `/api/v1/admin/campaigns/experiments/:key/results` | staff: `marketing:read` | Experiment results with plain-language significance |  |  |  |
| POST | `/api/v1/admin/campaigns/experiments/:key/start` | staff: `marketing:write` | start an experiment (does not change the live site; a person ships any winner) |  |  |  |
| POST | `/api/v1/admin/campaigns/experiments/:key/stop` | staff: `marketing:write` | stop an experiment (does not change the live site; a person ships any winner) |  |  |  |
| GET | `/api/v1/admin/campaigns/feeds` | staff: `marketing:read` | Feed eligibility per country |  |  |  |
| GET | `/api/v1/admin/campaigns/health` | staff: `marketing:read` | Conversion-event integration health |  |  |  |
| GET | `/api/v1/admin/campaigns/lifecycle` | staff: `marketing:read` | Abandoned-cart lifecycle (existing consent-based sequence) |  |  |  |
| GET | `/api/v1/admin/campaigns/outbox` | staff: `marketing:read` | Event stream inspector (redacted) |  |  | `page, pageSize, status, provider` |
| POST | `/api/v1/admin/campaigns/outbox/retry` | staff: `marketing:write` | Retry dead-lettered events |  | `id, provider` |  |
| GET | `/api/v1/admin/campaigns/products` | staff: `marketing:read` | Product performance: views to carts to orders to net sales |  |  | `days` |
| GET | `/api/v1/admin/campaigns/segments` | staff: `marketing:read` | Segments + presets |  |  |  |
| POST | `/api/v1/admin/campaigns/segments` | staff: `marketing:write` | Create a segment |  | `name*, description, rules*` |  |
| DELETE | `/api/v1/admin/campaigns/segments/:id` | staff: `marketing:write` | Delete a segment not used by an active campaign |  |  |  |
| POST | `/api/v1/admin/campaigns/segments/preview` | staff: `marketing:read` | Compute a segment on demand (counts only; emails masked) |  | `rules*` |  |
| GET | `/api/v1/admin/compliance/export` | staff: `settings:read` | Export attestation status per destination |  |  |  |
| DELETE | `/api/v1/admin/compliance/export/:country` | staff: `settings:write` | Revoke an export attestation |  |  |  |
| PUT | `/api/v1/admin/compliance/export/:country` | staff: `settings:write` | Record that a qualified adviser established export + destination obligations for a country |  | `reference*` |  |
| POST | `/api/v1/admin/copilot` | staff: `copilot:use` | Ask the business copilot (answers come from database queries) | 30 / 1 minute | `question*, confirm` |  |
| GET | `/api/v1/admin/countries` | staff: `countries:read` | Country configs + performance |  |  |  |
| PUT | `/api/v1/admin/countries/:code` | staff: `countries:write` | Update country configuration |  | `enabled, defaultTaxRate, returnWindowDays, legalNotice, fxPerUsd, paymentMethods, regionTaxRates, shippingMethods` |  |
| GET | `/api/v1/admin/creators` | staff: `creators:read` | Creators with performance |  |  | `page, pageSize, status, q` |
| POST | `/api/v1/admin/creators/:id/adjustments` | staff: `creators:write` | Manual ledger adjustment (audited) |  | `amount*, currency*, note*` |  |
| POST | `/api/v1/admin/creators/:id/hold` | staff: `creators:write` | Hold or release payouts for a creator |  | `held*, reason` |  |
| POST | `/api/v1/admin/creators/:id/review` | staff: `creators:write` | Approve or reject an application |  | `decision*, note` |  |
| POST | `/api/v1/admin/creators/:id/status` | staff: `creators:write` | Suspend or reinstate a creator |  | `status*, reason` |  |
| PATCH | `/api/v1/admin/creators/:id/terms` | staff: `creators:write` | Commission override and payout checklist (collected flags and opaque references only) |  | `rateOverride, kycStatus, taxInfoCollected, kycReference, taxInfoReference, method` |  |
| GET | `/api/v1/admin/creators/comments` | staff: `creators:read` | Comment moderation queue |  |  | `page, pageSize, status, q` |
| POST | `/api/v1/admin/creators/comments/:id/moderate` | staff: `creators:write` | Publish, reject or remove a comment |  | `decision*` |  |
| GET | `/api/v1/admin/creators/flags` | staff: `creators:read` | Fraud review queue |  |  | `page, pageSize, status, q` |
| POST | `/api/v1/admin/creators/flags/:id/resolve` | staff: `creators:write` | Clear or confirm a fraud flag (confirmed reverses the commission) |  | `resolution*, note*` |  |
| POST | `/api/v1/admin/creators/orders/:id/chargeback` | staff: `creators:write` | Record a chargeback against an attributed order (claws back commission) |  | `note*` |  |
| GET | `/api/v1/admin/creators/overview` | staff: `creators:read` | Counts for the admin page |  |  |  |
| GET | `/api/v1/admin/creators/payouts` | staff: `creators:read` | Payout queue |  |  | `page, pageSize, status, q` |
| POST | `/api/v1/admin/creators/payouts/:id/approve` | staff: `creators:write` | Approve a payout (checklist enforced) |  |  |  |
| POST | `/api/v1/admin/creators/payouts/:id/paid` | staff: `creators:write` | Record that the transfer was executed manually |  | `method*, externalReference*` |  |
| POST | `/api/v1/admin/creators/payouts/:id/reject` | staff: `creators:write` | Reject a payout and release its ledger rows |  | `reason*` |  |
| GET | `/api/v1/admin/creators/referrals` | staff: `creators:read` | Referral programme overview (codes, rewards, rejections with reasons) |  |  | `page, pageSize, status, q` |
| GET | `/api/v1/admin/creators/rules` | staff: `creators:read` | Commission rules |  |  |  |
| PUT | `/api/v1/admin/creators/rules` | staff: `creators:write` | Update commission rules |  |  |  |
| GET | `/api/v1/admin/customers` | staff: `customers:read` | Customers |  |  | `page, pageSize, q` |
| GET | `/api/v1/admin/customers/:id` | staff: `customers:read` | Customer detail |  |  |  |
| GET | `/api/v1/admin/economics` | staff: `products:read` | Decision sheet: per product × market cost lines and contribution at three CAC scenarios; every figure carries its basis (measured / quoted / set / estimated) |  |  | `limit` |
| GET | `/api/v1/admin/economics/cpa` | staff: `products:read` | Measured CPA store |  |  |  |
| POST | `/api/v1/admin/economics/cpa` | staff: `settings:write` | Record a measured CPA by hand (real ad spend ÷ real attributed orders) |  | `scope*, key*, country*, channel, spend*, orders*, note` |  |
| GET | `/api/v1/admin/economics/export` | staff: `products:read` | Decision sheet as CSV (each figure followed by its basis column) |  |  |  |
| POST | `/api/v1/admin/economics/refresh` | staff: `settings:write` | Rebuild measured CPA and refund rates from real ad metrics and orders |  |  |  |
| GET | `/api/v1/admin/exceptions` | staff: `exceptions:read` | Exception queue |  |  | `page, pageSize, status, kind` |
| POST | `/api/v1/admin/exceptions/:id/action` | staff: `exceptions:write` | Execute the suggested action or resolve/dismiss |  | `action*, note` |  |
| GET | `/api/v1/admin/financials` | staff: `analytics:read` | Financial dashboard |  |  | `preset, from, to` |
| GET | `/api/v1/admin/inventory` | staff: `inventory:read` | Inventory statuses |  |  | `page, pageSize, status, country` |
| POST | `/api/v1/admin/inventory/sync` | staff: `inventory:write` | Run an inventory/price sync now |  |  |  |
| GET | `/api/v1/admin/launch-readiness` | staff: `launch:read` | Launch readiness: per-area PASS/WARN/FAIL, blockers, provider status (live=true runs read-only provider calls) | 12 / 1 minute |  | `live` |
| GET | `/api/v1/admin/loyalty/accounts` | staff: `loyalty:read` | Loyalty balances |  |  | `page, pageSize, status, q` |
| POST | `/api/v1/admin/loyalty/adjust` | staff: `loyalty:write` | Audited manual points adjustment |  | `userId*, points*, reason*` |  |
| GET | `/api/v1/admin/loyalty/rules` | staff: `loyalty:read` | Loyalty rules |  |  |  |
| PUT | `/api/v1/admin/loyalty/rules` | staff: `loyalty:write` | Update loyalty rules |  |  |  |
| GET | `/api/v1/admin/marketing` | staff: `marketing:read` | Marketing dashboard: campaigns, per-country/product/creative metrics |  |  | `preset, from, to` |
| GET | `/api/v1/admin/marketing/campaigns/:id` | staff: `marketing:read` | Campaign detail with creatives |  |  |  |
| POST | `/api/v1/admin/marketing/campaigns/:id/action` | staff: `ads:write` | Pause / resume / change budget (applied on the ad platform first) |  | `action*, dailyBudget, reason` |  |
| POST | `/api/v1/admin/marketing/campaigns/:id/launch` | staff: `ads:write` | Launch a drafted campaign (budget caps + compliance enforced) |  |  |  |
| POST | `/api/v1/admin/marketing/content` | staff: `marketing:write` | Generate marketing content (email / blog / push / social) from source product data |  | `productId*, kind*` |  |
| GET | `/api/v1/admin/orders` | staff: `orders:read` | Orders table |  |  | `page, pageSize, status, country, q, exception` |
| GET | `/api/v1/admin/orders/:id` | staff: `orders:read` | Order detail with costs, shipments, exceptions, audit |  |  |  |
| POST | `/api/v1/admin/orders/:id/cancel` | staff: `orders:write` | Cancel order (cancels at supplier, refunds if paid) |  | `reason*` |  |
| POST | `/api/v1/admin/orders/:id/change-supplier` | staff: `orders:write` | Cancel at current supplier and re-place with the next best |  | `lineKey*` |  |
| POST | `/api/v1/admin/orders/:id/contact` | staff: `orders:write` | Email the customer about this order |  | `subject*, message*` |  |
| POST | `/api/v1/admin/orders/:id/manual-fulfillment` | staff: `orders:write` | Record a supplier order placed by hand (manual/assisted suppliers) |  | `supplierId*, supplierOrderId*, trackingNumber, carrier, lineKey` |  |
| POST | `/api/v1/admin/orders/:id/refund` | staff: `refunds:write` | Refund order (full or partial) |  | `amount, reason*` |  |
| POST | `/api/v1/admin/orders/:id/retry-fulfillment` | staff: `orders:write` | Retry supplier order (idempotent) |  | `force` |  |
| GET | `/api/v1/admin/overview` | staff: `overview:read` | Dashboard overview (today vs yesterday, live, insights) |  |  | `preset, from, to` |
| GET | `/api/v1/admin/payments` | staff: `payments:read` | Payments |  |  | `page, pageSize, status` |
| GET | `/api/v1/admin/products` | staff: `products:read` | Products table |  |  | `page, pageSize, state, q, category, images` |
| GET | `/api/v1/admin/products/:id` | staff: `products:read` | Product detail: economics, supplier comparison, scores, campaigns |  |  |  |
| PATCH | `/api/v1/admin/products/:id` | staff: `products:write` | Edit product content / pricing config |  | `title, description, bullets, tags, pricingStrategy, targetMarginPct` |  |
| POST | `/api/v1/admin/products/:id/claim-evidence` | staff: `products:write` | Attach evidence for an organic / eco / non-toxic claim |  | `claim*, type*, body, certId, certUrl, sourceUrl, jurisdiction, expiresAt, verified, note` |  |
| DELETE | `/api/v1/admin/products/:id/claim-evidence/:index` | staff: `products:write` | Remove claim evidence |  |  |  |
| POST | `/api/v1/admin/products/:id/competitor-prices` | staff: `products:write` | Enter competitor prices for a country (minor units) |  | `country*, prices*` |  |
| GET | `/api/v1/admin/products/:id/images` | staff: `products:read` | Images and image status for a product |  |  |  |
| PATCH | `/api/v1/admin/products/:id/images` | staff: `products:write` | Reorder, set primary, edit alt text, assign to variant/country |  | `order, primaryId, alt, assign` |  |
| POST | `/api/v1/admin/products/:id/images` | staff: `products:write` | Upload a product image (multipart, field "file") | 40 / 1 minute |  |  |
| DELETE | `/api/v1/admin/products/:id/images/:assetId` | staff: `products:write` | Delete a product image |  |  |  |
| POST | `/api/v1/admin/products/:id/images/:assetId/transform` | staff: `products:write` | Rotate or square-crop a hosted image |  | `rotate, squareCrop` |  |
| POST | `/api/v1/admin/products/:id/images/ingest` | staff: `products:write` | Re-run supplier image ingestion |  |  |  |
| POST | `/api/v1/admin/products/:id/link-supplier` | staff: `products:write` | Source an existing product from another supplier (e.g. a different country) |  | `supplierId*, externalId*` |  |
| POST | `/api/v1/admin/products/:id/manual-offer` | staff: `products:write` | Enter/re-confirm a manual supplier offer (expires automatically) |  | `supplierId*, externalId, countries*, currency*, productCost*, shippingCost*, stock*, minDays*, maxDays*, warehouseCountry*, images` |  |
| POST | `/api/v1/admin/products/:id/price` | staff: `products:write` | Manually set a price (cannot go below the margin floor) |  | `country*, price*` |  |
| POST | `/api/v1/admin/products/:id/publish` | staff: `products:write` | Publish (runs compliance + margin gates) |  |  |  |
| POST | `/api/v1/admin/products/:id/refresh` | staff: `products:write` | Sync supplier offers, recompute markets and score |  |  |  |
| POST | `/api/v1/admin/products/:id/start-test` | staff: `ads:write` | Create an ad test plan (budget, creatives, criteria); optionally launch |  | `country*, platform*, launch` |  |
| POST | `/api/v1/admin/products/:id/transition` | staff: `products:write` | Change lifecycle state |  | `to*, reason*` |  |
| POST | `/api/v1/admin/products/import` | staff: `products:write` | Import a supplier product (AI content + compliance + pricing) |  | `supplierId*, externalId*` |  |
| GET | `/api/v1/admin/promotions` | staff: `promotions:read` | Promotions + AI recommendations awaiting approval |  |  |  |
| POST | `/api/v1/admin/promotions` | staff: `promotions:write` | Create promotion |  | `name*, type*, code, countries, percent, fixedAmount, minSubtotal, bxgy, startsAt, endsAt, usageLimit, perUserLimit, active` |  |
| PATCH | `/api/v1/admin/promotions/:id` | staff: `promotions:write` | Enable/disable or end a promotion |  | `active, endsAt` |  |
| POST | `/api/v1/admin/refunds/:id/approve` | staff: `refunds:approve` | Approve a high-value refund |  |  |  |
| GET | `/api/v1/admin/returns` | staff: `returns:read` | Return requests |  |  | `page, pageSize, status` |
| POST | `/api/v1/admin/returns/:id/decision` | staff: `returns:write` | Approve / reject / refund a return |  | `decision*, note` |  |
| GET | `/api/v1/admin/reviews` | staff: `reviews:read` | Reviews for moderation |  |  | `page, pageSize, status, maxRating` |
| PATCH | `/api/v1/admin/reviews/:id` | staff: `reviews:write` | Moderate a review |  | `status*` |  |
| GET | `/api/v1/admin/reviews/analysis/:id` | staff: `reviews:read` | AI review analysis for a product |  |  |  |
| GET | `/api/v1/admin/settings` | staff: `settings:read` | System settings (no secrets) |  |  |  |
| PUT | `/api/v1/admin/settings/ads` | staff: `settings:write` | Update ad budget rules (safe mode default) |  | `safeMode, minImpressions, minClicks, pauseNoPurchaseSpend, targetCpa, cpaReduceFactor, targetRoas, scaleStep, maxDailyBudget, minDailyBudget, maxRefundRate, negativeProfitMinSpend, dailyLimit, monthlyLimit` |  |
| GET | `/api/v1/admin/settings/legal` | staff: `launch:read` | Legal/business settings |  |  |  |
| PUT | `/api/v1/admin/settings/legal` | staff: `settings:write` | Business details and legal-review confirmation (required before launch) |  | `businessName*, registeredAddress*, supportEmail*, reviewConfirmed*, emailDomainVerified, taxRegistrations` |  |
| PUT | `/api/v1/admin/settings/ops` | staff: `settings:write` | Update operational thresholds |  | `lowStockThreshold, supplierPriceSpikePct, fraudHighScore, fraudMediumScore, highValueOrderUsd, fulfillmentMaxAttempts` |  |
| PUT | `/api/v1/admin/settings/pricing` | staff: `settings:write` | Update pricing guardrails |  | `minMarginPct, maxDiscountPct, minSellingPrice, targetProfitPerOrder, targetRoas, defaultStrategy, targetMarginPct, baseRefundRate, assumedAdCostPct, cacScenarios, minCpaSample, minRefundSample, minPriceChangePct` |  |
| PUT | `/api/v1/admin/settings/sourcing` | staff: `settings:write` | Supplier selection weights and data-freshness limits |  | `weights, staleAfterMinutes, manualOfferTtlHours, failingAfterChecks` |  |
| GET | `/api/v1/admin/shipping` | staff: `shipping:read` | Shipments |  |  | `page, pageSize, status` |
| POST | `/api/v1/admin/shipping/sync` | staff: `orders:write` | Sync tracking now |  |  |  |
| GET | `/api/v1/admin/suppliers` | staff: `suppliers:read` | Supplier dashboard + per-country coverage |  |  |  |
| POST | `/api/v1/admin/suppliers` | staff: `suppliers:write` | Add a supplier (its own credentials, countries and API mapping) |  | `code*, name*, provider*, sandbox, country, servesCountries, priority, returnPolicyDays, credentials, config` |  |
| PATCH | `/api/v1/admin/suppliers/:id` | staff: `suppliers:write` | Update supplier settings, countries, credentials or mapping |  | `active, name, returnPolicyDays, rating, sandbox, servesCountries, priority, credentials, config` |  |
| GET | `/api/v1/admin/suppliers/:id/catalog` | staff: `products:write` | Search a supplier catalogue (for import) |  |  | `q, cursor` |
| POST | `/api/v1/admin/suppliers/:id/check` | staff: `suppliers:write` | Run an API health check |  |  |  |
| PUT | `/api/v1/admin/suppliers/:id/fulfillment-mode` | staff: `suppliers:write` | Set AUTOMATED / ASSISTED / MANUAL fulfilment (AUTOMATED requires passed validation) |  | `mode*` |  |
| GET | `/api/v1/admin/suppliers/:id/offers` | staff: `suppliers:read` | Stored offers for a supplier |  |  | `page, pageSize` |
| POST | `/api/v1/admin/suppliers/:id/test/:kind` | staff: `suppliers:write` | Run a supplier validation check against its real API | 30 / 1 minute | `params` |  |
| GET | `/api/v1/admin/support/tickets` | staff: `support:read` | Support tickets |  |  | `page, pageSize, status` |
| GET | `/api/v1/admin/support/tickets/:id` | staff: `support:read` | Ticket |  |  |  |
| POST | `/api/v1/admin/support/tickets/:id/reply` | staff: `support:write` | Reply to a customer (emails them) |  | `text*, resolve` |  |
| POST | `/api/v1/admin/trust/evidence` | staff: `trust:write` | Record an item of product/supplier evidence with provenance (audited) |  | `subject*, subjectId*, kind*, key*, value*, provenance*, source*, sourceUrl, observedAt, expiresAt, jurisdiction, note` |  |
| GET | `/api/v1/admin/trust/products` | staff: `trust:read` | Product risk snapshots (overall), highest risk first |  |  | `page, pageSize, status, q` |
| GET | `/api/v1/admin/trust/products/:id` | staff: `trust:read` | Product risk detail with per-destination snapshots and the evidence behind them |  |  |  |
| GET | `/api/v1/admin/trust/products/:id/fair-deal` | staff: `trust:read` | Fair Deal ranking of supplier offers for this product (same product only) |  |  | `country*, quantity, priceMode` |
| POST | `/api/v1/admin/trust/recompute` | staff: `trust:write` | Recompute supplier trust and product risk now (audited) | 6 / 1 minute | `scope, supplierId, productId` |  |
| GET | `/api/v1/admin/trust/suppliers` | staff: `trust:read` | Supplier trust: score, status, confidence, sample sizes, components with evidence, destination breakdown |  |  | `page, pageSize, status, q` |
| GET | `/api/v1/admin/trust/suppliers/:id` | staff: `trust:read` | One supplier trust snapshot (recomputed if stale) |  |  |  |
| GET | `/api/v1/admin/users` | staff: `users:manage` | Staff users + roles matrix |  |  |  |
| POST | `/api/v1/admin/users` | staff: `users:manage` | Create a staff user |  | `email*, name*, password*, role*` |  |
| PATCH | `/api/v1/admin/users/:id` | staff: `users:manage` | Change role / disable a staff user |  | `role, disabled` |  |

## Assistant

| Method | Path | Auth | Summary | Rate limit | Body | Query |
|---|---|---|---|---|---|---|
| POST | `/api/v1/assistant/advocate` | user | Customer Advocate: the fairest policy-permitted resolution for a delayed/damaged/missing/wrong item (recommends only) | 10 / 1 minute | `orderNumber*, problem*, details` |  |
| POST | `/api/v1/assistant/confirm` | user | Confirm or cancel an action the assistant prepared (one-time token from the assistant reply; owner only) | 20 / 1 minute | `actionId*, token*, decision*` |  |
| DELETE | `/api/v1/assistant/conversations` | user | Delete all my assistant conversations | 5 / 1 minute |  |  |
| DELETE | `/api/v1/assistant/conversations/:sessionId` | optional | Delete a conversation (customer-controlled deletion) | 20 / 1 minute |  |  |
| GET | `/api/v1/assistant/conversations/:sessionId` | optional | Read a conversation (its owner, or a guest holding the session id) | 30 / 1 minute |  |  |
| POST | `/api/v1/assistant/message` | optional | Shopping Assistant message (optional auth; account actions need a signed-in, email-verified customer) | 20 / 1 minute | `message*, sessionId, country, email, orderNumber` |  |
| POST | `/api/v1/assistant/outcomes/:id/rating` | user | Rate how a resolved case went (owner only, after resolution) | 10 / 1 minute | `rating*, comment` |  |

## Auth

| Method | Path | Auth | Summary | Rate limit | Body | Query |
|---|---|---|---|---|---|---|
| POST | `/api/v1/auth/admin/login` | none | Staff sign in | 10 / 1 minute | `email*, password*` |  |
| POST | `/api/v1/auth/forgot-password` | none | Request a password reset email | 5 / 1 minute | `email*` |  |
| POST | `/api/v1/auth/login` | none | Customer sign in | 10 / 1 minute | `email*, password*` |  |
| POST | `/api/v1/auth/logout` | none | Sign out (revokes the server-side session) |  |  |  |
| GET | `/api/v1/auth/me` | optional | Current user |  |  |  |
| POST | `/api/v1/auth/register` | none | Create a customer account | 10 / 1 minute | `email*, password*, name*` |  |
| POST | `/api/v1/auth/reset-password` | none | Reset password with token | 10 / 1 minute | `token*, password*` |  |
| GET | `/api/v1/auth/sessions` | user | List my active sessions |  |  |  |
| DELETE | `/api/v1/auth/sessions/:id` | user | Revoke one session |  |  |  |
| POST | `/api/v1/auth/sessions/revoke-all` | user | Sign out everywhere |  |  |  |
| POST | `/api/v1/auth/verify-email` | none | Verify email address | 10 / 1 minute | `token*` |  |

## Cart

| Method | Path | Auth | Summary | Rate limit | Body | Query |
|---|---|---|---|---|---|---|
| GET | `/api/v1/cart` | none | Get priced cart |  |  | `region, shipping` |
| POST | `/api/v1/cart/contact` | none | Attach email + marketing consent to the cart |  | `email*, marketingConsent` |  |
| POST | `/api/v1/cart/coupon` | none | Apply or remove a coupon | 30 / 1 minute | `code*` |  |
| PATCH | `/api/v1/cart/items` | none | Change quantity (0 removes) |  | `productId*, sku*, quantity*` |  |
| POST | `/api/v1/cart/items` | none | Add to cart |  | `productId*, variantSku, quantity*` |  |
| POST | `/api/v1/referrals/claim` | none | Attach a friend’s referral code to the current cart | 30 / 1 minute | `code*` |  |

## Checkout

| Method | Path | Auth | Summary | Rate limit | Body | Query |
|---|---|---|---|---|---|---|
| POST | `/api/v1/checkout` | none | Create order + payment from cart (idempotent) | 20 / 1 minute | `email*, address*, shippingMethod, couponCode, idempotencyKey*` |  |

## Companion

| Method | Path | Auth | Summary | Rate limit | Body | Query |
|---|---|---|---|---|---|---|
| GET | `/api/v1/account/aftercare` | user | Open returns, refunds, tickets and delivery issues |  |  |  |
| GET | `/api/v1/account/products` | user | Products I received |  |  |  |
| GET | `/api/v1/account/products/:orderItemId` | user | Product companion (verified product data only) |  |  |  |

## Creators

| Method | Path | Auth | Summary | Rate limit | Body | Query |
|---|---|---|---|---|---|---|
| POST | `/api/v1/creator/apply` | user | Apply to become a creator | 5 / 1 hour | `handle*, displayName*, bio, socialLinks, audience, acceptTerms*` |  |
| POST | `/api/v1/creator/avatar` | user | Upload my avatar (multipart, field "file") | 10 / 1 hour |  |  |
| GET | `/api/v1/creator/collections` | user | My collections |  |  |  |
| POST | `/api/v1/creator/collections` | user | Create a collection |  | `title*, description, productIds, notes, published` |  |
| DELETE | `/api/v1/creator/collections/:id` | user | Delete a collection |  |  |  |
| PATCH | `/api/v1/creator/collections/:id` | user | Edit, reorder, publish or unpublish a collection |  | `title, description, productIds, notes, published` |  |
| GET | `/api/v1/creator/commissions` | user | My commission ledger |  |  | `page, pageSize` |
| GET | `/api/v1/creator/links` | user | My share links |  |  |  |
| POST | `/api/v1/creator/links` | user | Create a trackable share link for a product or collection |  | `label*, productId, collectionId` |  |
| DELETE | `/api/v1/creator/links/:id` | user | Remove a share link |  |  |  |
| GET | `/api/v1/creator/me` | user | My creator profile (null when not applied) |  |  |  |
| GET | `/api/v1/creator/payouts` | user | My payouts |  |  |  |
| POST | `/api/v1/creator/payouts` | user | Request a payout of my payable balance | 5 / 1 hour | `currency*, note` |  |
| GET | `/api/v1/creator/payouts/:id/statement` | user | Payout statement (json, csv or printable html) |  |  | `format` |
| GET | `/api/v1/creator/performance` | user | My performance and balances |  |  |  |
| PATCH | `/api/v1/creator/profile` | user | Update my creator profile |  | `displayName, bio, socialLinks` |  |
| GET | `/api/v1/creators/:handle` | none | Public creator page data | 120 / 1 minute |  |  |
| GET | `/api/v1/creators/:handle/collections/:slug` | none | Published creator collection with products and approved comments | 120 / 1 minute |  |  |
| POST | `/api/v1/creators/attribution` | optional | Record a creator landing (click) and attach first-party attribution to the cart | 60 / 1 minute | `handle, link, landing` |  |
| POST | `/api/v1/creators/collections/:id/comments` | user | Comment on a published collection (moderated) | 10 / 1 minute | `body*` |  |
| POST | `/api/v1/creators/comments/:id/report` | user | Report a comment | 20 / 1 minute | `reason*` |  |

## Customer 360

| Method | Path | Auth | Summary | Rate limit | Body | Query |
|---|---|---|---|---|---|---|
| GET | `/api/v1/admin/customer-360` | staff: `customer360:read` | Search customers (masked) |  |  | `q*, page` |
| GET | `/api/v1/admin/customer-360/:userId` | staff: `customer360:read` | Customer profile (PII-minimized, audited) |  |  | `reveal, reason` |
| POST | `/api/v1/admin/customer-360/:userId/consents/withdraw` | staff: `customer360:write` | Withdraw a consent on the customer's behalf (audited) |  | `kind*, reason*` |  |
| POST | `/api/v1/admin/customer-360/:userId/notes` | staff: `customer360:write` | Add a staff note |  | `body*` |  |
| GET | `/api/v1/admin/customer-360/deletion-requests` | staff: `customer360:read` | Deletion requests |  |  | `status, page` |
| POST | `/api/v1/admin/customer-360/deletion-requests/:id/process` | staff: `customer360:write` | Execute, reject, hold or release a deletion request |  | `action*, note*` |  |

## Dev

| Method | Path | Auth | Summary | Rate limit | Body | Query |
|---|---|---|---|---|---|---|
| POST | `/api/v1/dev/ads/fault` | none | [dev] Make the mock ad API fail N times |  | `remaining*` |  |
| POST | `/api/v1/dev/aftersales/simulate-dispute` | staff: `refunds:approve` | [dev] Simulate a card dispute webhook (PAYMENT_MODE=mock only) |  | `intentId*, status, amount, reason, disputeId, eventId` |  |
| POST | `/api/v1/dev/jobs/drain` | none | [dev] Process due jobs inline (when no worker is running) |  | `max` |  |
| POST | `/api/v1/dev/payments/:intentId/simulate` | none | [dev] Simulate the payment provider sending a signed webhook |  | `outcome*` |  |
| GET | `/api/v1/dev/state` | none | [dev] Mock-store + queue snapshot |  |  |  |
| POST | `/api/v1/dev/suppliers/:code/fault` | none | [dev] Inject supplier API failures |  | `remaining*, kind` |  |
| POST | `/api/v1/dev/suppliers/:code/override` | none | [dev] Change a mock supplier’s stock/price for a product |  | `externalId*, stock, priceMult, unavailable` |  |

## Finance

| Method | Path | Auth | Summary | Rate limit | Body | Query |
|---|---|---|---|---|---|---|
| GET | `/api/v1/admin/finance/cashflow` | staff: `finance:read` | Cash position and forecast from already-paid orders, payables, reserves and ad spend |  |  | `horizonDays` |
| GET | `/api/v1/admin/finance/cohorts` | staff: `finance:read` | Monthly cohorts: retention and contribution per customer |  |  | `months` |
| GET | `/api/v1/admin/finance/cost-alerts` | staff: `finance:read` | Supplier cost vs the cost the price was based on |  |  | `days` |
| GET | `/api/v1/admin/finance/fx` | staff: `finance:read` | Stored FX rates, freshness and policy |  |  |  |
| POST | `/api/v1/admin/finance/fx/override` | staff: `finance:write` | Allow pricing from expired rates for up to 24h in production (audited), or clear it |  | `hours*, reason*` |  |
| POST | `/api/v1/admin/finance/fx/refresh` | staff: `finance:write` | Fetch rates from the configured provider now |  | `acceptLargeMove` |  |
| GET | `/api/v1/admin/finance/ledger` | staff: `finance:read` | Ledger journal entries (paginated, filterable) |  |  | `page, pageSize, account, kind, orderId, currency, from, to` |
| POST | `/api/v1/admin/finance/ledger/backfill` | staff: `finance:write` | Rebuild ledger entries from existing paid orders (idempotent; queued) |  |  |  |
| GET | `/api/v1/admin/finance/ledger/balances` | staff: `finance:read` | Account balances per currency and derived totals |  |  | `from, to` |
| POST | `/api/v1/admin/finance/ledger/entries` | staff: `finance:write` | Record a money event with no source collection yet: chargeback, PSP payout, supplier payment or ad spend (idempotent on id) |  |  |  |
| GET | `/api/v1/admin/finance/ledger/export` | staff: `finance:read` | Ledger lines as CSV |  |  | `account, kind, orderId, currency, from, to` |
| POST | `/api/v1/admin/finance/ledger/sync` | staff: `finance:write` | Post new paid orders, supplier costs, refunds and ad spend to the ledger now (idempotent) |  |  |  |
| GET | `/api/v1/admin/finance/model` | staff: `finance:read` | Objective model: scenarios, measured overlay, sensitivity |  |  |  |
| PUT | `/api/v1/admin/finance/model` | staff: `finance:write` | Save objective-model assumptions (audited; edited fields become provenance "admin") |  | `conservative*, base*, aggressive*` |  |
| GET | `/api/v1/admin/finance/overview` | staff: `finance:read` | KPI tiles and P&L with provenance (actual / mixed / estimated / unavailable) |  |  | `preset, from, to` |
| GET | `/api/v1/admin/finance/price-books` | staff: `finance:read` | Country price books (read-only view of market pricing) |  |  | `country, page, pageSize` |
| GET | `/api/v1/admin/finance/profitability` | staff: `finance:read` | Profitability by product, supplier, country or order |  |  | `preset, from, to, by` |
| GET | `/api/v1/admin/finance/reconciliation` | staff: `finance:read` | Ledger vs orders / payments / refunds / shipments (read-only) |  |  | `sinceDays` |
| GET | `/api/v1/admin/finance/settings` | staff: `finance:read` | Finance assumptions (opex, settlement delays, reserves, opening cash) |  |  |  |
| PUT | `/api/v1/admin/finance/settings` | staff: `finance:write` | Update finance assumptions (audited) |  | `reportingCurrency, pspSettlementDays, pspSettlementDaysDefault, supplierPaymentTermsDays, pspRollingReservePct, assumedRefundRate, assumedChargebackRate, csCostPerOrder, otherVariablePerOrder, monthlyOpex, openingCash, openingCashAsOf, costChangeAlertPct, minOrdersForMeasured` |  |

## Find

| Method | Path | Auth | Summary | Rate limit | Body | Query |
|---|---|---|---|---|---|---|
| POST | `/api/v1/account/compare/remember` | user | Save this comparison to my memory (explicit action; honours the memory switch) | 20 / 1 minute | `ids*, country` |  |
| GET | `/api/v1/account/saved-searches` | user | My saved searches |  |  |  |
| POST | `/api/v1/account/saved-searches` | user | Save a search | 20 / 1 minute | `name*, query*, country, budgetMax, deliverBy, alertNewMatches, remember` |  |
| DELETE | `/api/v1/account/saved-searches/:id` | user | Delete a saved search |  |  |  |
| PATCH | `/api/v1/account/saved-searches/:id` | user | Rename a saved search or toggle its new-match alert |  | `name, alertNewMatches` |  |
| POST | `/api/v1/compare` | none | Side-by-side comparison of 2-4 products | 60 / 1 minute | `ids*, country` |  |
| POST | `/api/v1/find` | optional | Natural-language product search (deterministic intent parser, optional AI refinement) | 30 / 1 minute | `query*, country, budgetMax, budgetMin, deliverBy, inStockOnly, minRating, sort, useAI, limit` |  |
| GET | `/api/v1/find/alternatives/:productId` | none | Alternatives for an unavailable product | 60 / 1 minute |  |  |
| GET | `/api/v1/find/better-offer/:productId` | none | A cheaper equivalent product with comparable ratings, if one exists | 60 / 1 minute |  |  |
| POST | `/api/v1/find/image` | optional | Image search (multipart "file" + optional "query"). Needs an AI vision provider; 503 not_configured otherwise | 8 / 1 minute |  |  |
| GET | `/api/v1/find/presets` | none | Gift / budget / need discovery presets that currently have results | 60 / 1 minute |  |  |
| GET | `/api/v1/find/price-history/:productId` | none | Observed price history (only where we have snapshots) | 60 / 1 minute |  | `days, country` |

## LifeGraph

| Method | Path | Auth | Summary | Rate limit | Body | Query |
|---|---|---|---|---|---|---|
| DELETE | `/api/v1/account/lifegraph` | user | Erase my whole LifeGraph |  |  |  |
| GET | `/api/v1/account/lifegraph` | user | My LifeGraph |  |  |  |
| POST | `/api/v1/account/lifegraph/derive` | user | Suggest interests from my purchases (visible and deletable) |  |  |  |
| GET | `/api/v1/account/lifegraph/export` | user | Download my LifeGraph (JSON) |  |  |  |
| POST | `/api/v1/account/lifegraph/nodes` | user | Add something you want us to know |  | `kind*, value*, parentId` |  |
| DELETE | `/api/v1/account/lifegraph/nodes/:id` | user | Delete one LifeGraph item |  |  |  |
| PUT | `/api/v1/account/lifegraph/settings` | user | Turn LifeGraph on or off |  | `enabled*` |  |
| GET | `/api/v1/account/recommendations` | user | Suggestions, boosted by LifeGraph only when you opted in |  |  | `limit` |

## Market

| Method | Path | Auth | Summary | Rate limit | Body | Query |
|---|---|---|---|---|---|---|
| GET | `/api/v1/admin/market/match` | staff: `market:read` | Which topic does a product name match? |  |  | `title*` |
| GET | `/api/v1/admin/market/overview` | staff: `market:read` | Dashboard: trending, rising, declining, source health, internal demand, price movement |  |  |  |
| POST | `/api/v1/admin/market/recompute` | staff: `market:write` | Recompute trend scores now |  |  |  |
| GET | `/api/v1/admin/market/sources` | staff: `market:read` | Market sources with crawl health |  |  |  |
| POST | `/api/v1/admin/market/sources` | staff: `market:write` | Add a public market source |  | `name*, type*, baseUrl, country, category, enabled, crawlIntervalMinutes, robotsRequired, parserConfig, fetchProductPages` |  |
| DELETE | `/api/v1/admin/market/sources/:id` | staff: `market:write` | Delete a market source and its observations |  |  |  |
| PATCH | `/api/v1/admin/market/sources/:id` | staff: `market:write` | Edit/enable/disable a market source |  | `name, type, baseUrl, country, category, enabled, crawlIntervalMinutes, robotsRequired, parserConfig, fetchProductPages` |  |
| POST | `/api/v1/admin/market/sources/:id/crawl` | staff: `market:write` | Test / crawl a source now (robots-aware) | 20 / 1 minute |  |  |
| GET | `/api/v1/admin/market/topics` | staff: `market:read` | Trend topics with score, confidence and evidence |  |  | `page, pageSize, status, country, category, q, sort` |
| GET | `/api/v1/admin/market/topics/:id` | staff: `market:read` | Topic detail: components, windows, evidence and an evidence-only explanation |  |  |  |

## Memory

| Method | Path | Auth | Summary | Rate limit | Body | Query |
|---|---|---|---|---|---|---|
| DELETE | `/api/v1/account/memory` | user | Delete all my memory |  |  |  |
| GET | `/api/v1/account/memory` | user | My Commerce Memory |  |  | `page, pageSize` |
| POST | `/api/v1/account/memory` | user | Save a note, requirement or comparison |  | `kind*, title*, payload` |  |
| DELETE | `/api/v1/account/memory/:id` | user | Delete one memory item |  |  |  |
| PATCH | `/api/v1/account/memory/:id` | user | Edit or switch off one memory item |  | `title, payload, enabled` |  |
| GET | `/api/v1/account/memory/export` | user | Download my memory (JSON) |  |  |  |
| PUT | `/api/v1/account/memory/settings` | user | Memory on/off and retention |  | `enabled, retentionDays` |  |

## Orders

| Method | Path | Auth | Summary | Rate limit | Body | Query |
|---|---|---|---|---|---|---|
| POST | `/api/v1/orders/:orderNumber/cancel` | none | Cancel an unshipped order | 10 / 1 minute | `email, reason` |  |
| GET | `/api/v1/orders/:orderNumber/recovery` | optional | Recovery options for an order (owner or consent-link holder) | 30 / 1 minute |  | `token, email` |
| POST | `/api/v1/orders/:orderNumber/recovery/decision` | optional | Accept or decline one recovery option (single use) | 20 / 1 minute | `token, email, optionId*, decision*` |  |
| GET | `/api/v1/orders/lookup` | none | Guest order lookup (order number + email) or signed-in owner | 20 / 1 minute |  | `orderNumber*, email` |

## Price Guard

| Method | Path | Auth | Summary | Rate limit | Body | Query |
|---|---|---|---|---|---|---|
| GET | `/api/v1/account/price-guard/alerts` | user | My price alerts |  |  |  |
| POST | `/api/v1/account/price-guard/alerts` | user | Track a product (target price, drops, stock, better offers) | 30 / 1 minute | `productId*, country, targetPrice, dropPercent, notifyOnDrop, notifyOnStock, notifyOnBetterOffer` |  |
| DELETE | `/api/v1/account/price-guard/alerts/:id` | user | Stop tracking |  |  |  |
| PATCH | `/api/v1/account/price-guard/alerts/:id` | user | Change or pause a price alert |  | `targetPrice, dropPercent, notifyOnDrop, notifyOnStock, notifyOnBetterOffer, active` |  |
| GET | `/api/v1/account/price-guard/status` | user | Am I tracking this product? |  |  | `productId*, country` |

## Privacy

| Method | Path | Auth | Summary | Rate limit | Body | Query |
|---|---|---|---|---|---|---|
| GET | `/api/v1/account/preferences` | user | My communication preferences |  |  |  |
| PUT | `/api/v1/account/preferences` | user | Update communication preferences |  | `topics*, replenishmentOptIn` |  |
| GET | `/api/v1/account/privacy` | user | My consents, history, switches and deletion status |  |  |  |
| PUT | `/api/v1/account/privacy/consents/:kind` | user | Grant or withdraw a consent |  | `granted*, source` |  |
| DELETE | `/api/v1/account/privacy/deletion` | user | Cancel my deletion request |  |  |  |
| GET | `/api/v1/account/privacy/deletion` | user | My open deletion request |  |  |  |
| POST | `/api/v1/account/privacy/deletion` | user | Request account deletion (starts the cooling-off period) | 5 / 1 hour | `confirm*, reason` |  |
| GET | `/api/v1/account/privacy/export` | user | Download all data held about me (JSON) | 5 / 1 hour |  |  |

## Rescue

| Method | Path | Auth | Summary | Rate limit | Body | Query |
|---|---|---|---|---|---|---|
| GET | `/api/v1/admin/rescue/cases` | staff: `rescue:read` | Delivery Rescue cases |  |  | `page, pageSize, state, active, kind, severity, q` |
| GET | `/api/v1/admin/rescue/cases/:id` | staff: `rescue:read` | Case detail: timeline, options, actions, consents |  |  |  |
| POST | `/api/v1/admin/rescue/cases/:id/decision` | staff: `rescue:write` | Approve / override / escalate / close / re-plan a case | 60 / 1 minute | `action*, optionId, note*, acknowledgeDuplicateRisk` |  |
| GET | `/api/v1/admin/rescue/kpis` | staff: `rescue:read` | Rescue KPIs computed from real cases |  |  | `days` |
| GET | `/api/v1/admin/rescue/policy` | staff: `rescue:read` | Authorization and detection policy |  |  |  |
| PUT | `/api/v1/admin/rescue/policy` | staff: `rescue:write` | Edit the policy (audited) |  | `enabled, autoExecuteEnabled, autoActions, preApprovedSupplierIds, maxCostPerCaseUsd, maxCostPerDayUsd, costTolerancePct, maxEtaWorseningDays, maxPartialRefundPct, defaultPartialRefundPct, consentTtlHours, consentReminderEscalateHours, maxAttempts, scanBatch, +3` |  |
| POST | `/api/v1/admin/rescue/scan` | staff: `rescue:write` | Run one bounded detection pass now | 6 / 1 minute |  |  |

## Returns

| Method | Path | Auth | Summary | Rate limit | Body | Query |
|---|---|---|---|---|---|---|
| GET | `/api/v1/account/returns` | user | My return requests |  |  |  |
| GET | `/api/v1/aftersales/orders/:orderNumber/eligibility` | user | What can be returned from this order, and why not |  |  | `reason` |
| GET | `/api/v1/aftersales/orders/:orderNumber/status` | user | Return and refund status for an order (customer view) |  |  |  |
| GET | `/api/v1/aftersales/reasons` | none | Return reason taxonomy |  |  |  |
| GET | `/api/v1/aftersales/returns` | user | My returns |  |  |  |
| POST | `/api/v1/aftersales/returns` | user | Start a return (refund, replacement or exchange) | 20 / 1 hour | `orderId*, reason*, details, items*, resolution, exchangeSku` |  |
| GET | `/api/v1/aftersales/returns/:id` | user | One of my returns with refund timeline |  |  |  |
| POST | `/api/v1/aftersales/returns/:id/evidence` | user | Upload a photo for a return (multipart, field "file") | 30 / 1 hour |  |  |
| POST | `/api/v1/returns` | user | Request a return |  | `orderId*, reason*, details, itemSkus*` |  |

## Reviews

| Method | Path | Auth | Summary | Rate limit | Body | Query |
|---|---|---|---|---|---|---|
| POST | `/api/v1/products/:productId/reviews` | user | Write a review |  | `rating*, title, body*, images` |  |
| POST | `/api/v1/reviews/:id/helpful` | user | Mark a review helpful |  |  |  |

## Storefront

| Method | Path | Auth | Summary | Rate limit | Body | Query |
|---|---|---|---|---|---|---|
| POST | `/api/v1/events` | none | Track storefront event | 240 / 1 minute | `type*, sessionId*, productId, category, meta` |  |
| POST | `/api/v1/events/attribution` | none | Store UTM / click-id attribution first-party (only for sessions that granted consent) | 60 / 1 minute | `sessionId*, utm, clickIds, browserIds, referrerHost, landingPath` |  |
| POST | `/api/v1/events/consent` | none | Record the visitor’s tracking consent choice for this session | 60 / 1 minute | `sessionId*, analytics*, marketing*` |  |
| POST | `/api/v1/events/track` | none | Report a browser event with the shared dedupe id (consent-gated server-side forwarding) | 240 / 1 minute | `eventId*, name*, sessionId*, productId, searchString, sourceUrl` |  |
| GET | `/api/v1/experiments/:key/assign` | none | Deterministic variant for a visitor (no exposure recorded) | 120 / 1 minute |  | `visitorId*` |
| POST | `/api/v1/experiments/:key/convert` | none | Record a conversion for an exposed visitor | 120 / 1 minute | `visitorId*` |  |
| POST | `/api/v1/experiments/:key/expose` | none | Record that the visitor saw their variant | 120 / 1 minute | `visitorId*` |  |
| GET | `/api/v1/feeds/google/:country` | none | Google Merchant Center feed (RSS/XML) | 30 / 1 minute |  |  |
| GET | `/api/v1/feeds/meta/:country` | none | Meta catalogue feed (CSV) | 30 / 1 minute |  |  |
| GET | `/api/v1/home` | none | Homepage sections for the current country |  |  | `viewed` |
| GET | `/api/v1/meta` | none | Storefront bootstrap: countries, categories, payment mode |  |  |  |
| GET | `/api/v1/needs` | none | Shop-by-need collections that currently have products |  |  |  |
| GET | `/api/v1/needs/:slug` | none | Products for one need |  |  | `page, pageSize` |
| PUT | `/api/v1/preferences/country` | none | Set preferred country (cookie) |  | `country*` |  |
| GET | `/api/v1/products` | none | Search / browse products |  |  | `page, pageSize, q, category, minPrice, maxPrice, minRating, inStock, brand, sort, country` |
| GET | `/api/v1/products/:slug` | none | Product detail |  |  | `viewed` |
| GET | `/api/v1/products/:slug/reviews` | none | Product reviews |  |  | `page, pageSize` |
| GET | `/api/v1/r` | none | Signed campaign link redirect (counts the click) | 120 / 1 minute |  | `token*` |
| GET | `/api/v1/recommendations/recently-viewed` | none | Recently viewed products by id |  |  | `ids*` |
| GET | `/api/v1/search/suggest` | none | Search suggestions (typo tolerant) | 120 / 1 minute |  | `q*` |
| GET | `/api/v1/unsubscribe` | none | One-click unsubscribe from Orvia marketing email (signed token) | 30 / 1 minute |  | `token*` |
| POST | `/api/v1/unsubscribe` | none | RFC 8058 one-click unsubscribe | 30 / 1 minute |  | `token*` |

## SupplierNetwork

| Method | Path | Auth | Summary | Rate limit | Body | Query |
|---|---|---|---|---|---|---|
| GET | `/api/v1/admin/supplier-network/disputes` | staff: `suppliers:read` | Supplier disputes |  |  | `page, pageSize, state, supplierId` |
| POST | `/api/v1/admin/supplier-network/disputes` | staff: `suppliers:write` | Open a supplier dispute |  | `supplierId*, type*, orderId, shipmentId, statementId, amountMinor, currency, summary*` |  |
| POST | `/api/v1/admin/supplier-network/disputes/:id/evidence` | staff: `suppliers:write` | Add ORVIA evidence to a dispute |  | `note*, documentId, url` |  |
| POST | `/api/v1/admin/supplier-network/disputes/:id/transition` | staff: `suppliers:write` | Move a dispute through its state machine |  | `to*, note, creditedMinor` |  |
| POST | `/api/v1/admin/supplier-network/documents/:id/review` | staff: `suppliers:write` | Verify or reject a supplier document |  | `decision*, note` |  |
| GET | `/api/v1/admin/supplier-network/documents/expiring` | staff: `suppliers:read` | Verified documents expiring within 60 days |  |  |  |
| GET | `/api/v1/admin/supplier-network/ingestion-jobs` | staff: `suppliers:read` | Recent ingestion jobs |  |  | `supplierId` |
| GET | `/api/v1/admin/supplier-network/matches` | staff: `suppliers:read` | Match candidates awaiting human review |  |  | `page, pageSize, status` |
| POST | `/api/v1/admin/supplier-network/matches/:id/decide` | staff: `suppliers:write` | Approve (links the supplier product to the ORVIA product) or reject a match candidate |  | `note, decision*` |  |
| GET | `/api/v1/admin/supplier-network/overview` | staff: `suppliers:read` | Supplier network pipeline, adapter matrix and SLA board |  |  |  |
| GET | `/api/v1/admin/supplier-network/quotes` | staff: `suppliers:read` | Compare all linked suppliers for a product and destination (freshness labelled; live=true queries suppliers now) | 30 / 1 minute |  | `productId*, country*, live` |
| GET | `/api/v1/admin/supplier-network/return-authorizations` | staff: `suppliers:read` | Return authorizations requested from suppliers |  |  | `page, pageSize, state` |
| POST | `/api/v1/admin/supplier-network/return-authorizations` | staff: `suppliers:write` | Request a return authorization from the supplier of a shipment |  | `shipmentId, orderId, reason*, returnRef` |  |
| POST | `/api/v1/admin/supplier-network/return-authorizations/:id/decide` | staff: `suppliers:write` | Record the supplier’s answer on a return authorization (on their behalf) |  | `to*, rmaNumber, note, refundMinor` |  |
| GET | `/api/v1/admin/supplier-network/sla` | staff: `suppliers:read` | SLA board: latest snapshot per supplier |  |  |  |
| GET | `/api/v1/admin/supplier-network/statements` | staff: `suppliers:read` | Supplier statements and reconciliation status |  |  | `page, pageSize, status, supplierId` |
| GET | `/api/v1/admin/supplier-network/statements/:id` | staff: `suppliers:read` | Statement with line-level reconciliation |  |  |  |
| POST | `/api/v1/admin/supplier-network/statements/:id/dispute` | staff: `suppliers:write` | Dispute the over-billed lines of a statement |  | `summary*` |  |
| POST | `/api/v1/admin/supplier-network/statements/:id/settle` | staff: `suppliers:write` | Record settlement (record-only: no payment is initiated) |  | `reference*, amountMinor*, note` |  |
| POST | `/api/v1/admin/supplier-network/suppliers` | staff: `suppliers:write` | Invite a supplier (creates the supplier, profile shell and a SUPPLIER portal user) |  | `code*, name*, email*, contactName, supplierType*, provider, servesCountries` |  |
| GET | `/api/v1/admin/supplier-network/suppliers/:id` | staff: `suppliers:read` | Supplier network detail |  |  |  |
| POST | `/api/v1/admin/supplier-network/suppliers/:id/credentials/rotate` | staff: `suppliers:write` | Set/rotate encrypted supplier credentials (values are never returned) |  | `credentials*` |  |
| POST | `/api/v1/admin/supplier-network/suppliers/:id/documents` | staff: `suppliers:write` | Upload a supplier document (multipart: file + kind, title, expiresAt) | 30 / 1 minute |  |  |
| GET | `/api/v1/admin/supplier-network/suppliers/:id/documents/:docId/file` | staff: `suppliers:read` | Download a supplier document (permission-checked, never public) |  |  |  |
| PUT | `/api/v1/admin/supplier-network/suppliers/:id/feed-config` | staff: `suppliers:write` | Validate and save the CSV/JSON feed mapping (provider must be "feed") |  | `url*, format*, delimiter, listPath, currency, priceUnit, warehouseCountry, auth, cacheSeconds, maxRows, imageSeparator, fields, defaults` |  |
| POST | `/api/v1/admin/supplier-network/suppliers/:id/ingest` | staff: `suppliers:write` | Ingest the supplier catalogue through its adapter and propose product matches | 6 / 1 minute | `maxItems` |  |
| PUT | `/api/v1/admin/supplier-network/suppliers/:id/profile` | staff: `suppliers:write` | Save the supplier profile (submits it when the supplier is only invited) |  | `legalName*, tradingName, country*, registrationNumber, taxId, website, contact*, supplierType*, categories*, shippingRegions*, leadTimes*, returnPolicy*, warrantyTerms, declaredCapabilities, +1` |  |
| PUT | `/api/v1/admin/supplier-network/suppliers/:id/sla` | staff: `suppliers:write` | Define supplier SLA targets |  | `windowDays, minSample, minFulfilmentRate, minOnTimeRate, maxCancellationRate, minStockAccuracy, maxRefundRate, maxDefectRate, maxResponseMs, criticalMargin` |  |
| POST | `/api/v1/admin/supplier-network/suppliers/:id/sla/compute` | staff: `suppliers:write` | Compute SLA now (may demote on a critical breach) |  |  |  |
| POST | `/api/v1/admin/supplier-network/suppliers/:id/statements` | staff: `suppliers:write` | Enter a supplier statement manually |  | `number*, currency*, periodStart, periodEnd, lines*` |  |
| POST | `/api/v1/admin/supplier-network/suppliers/:id/statements/csv` | staff: `suppliers:write` | Upload a supplier statement as CSV text |  | `number*, currency*, periodStart, periodEnd, csv*` |  |
| POST | `/api/v1/admin/supplier-network/suppliers/:id/transition` | staff: `suppliers:write` | Move a supplier through the onboarding state machine (gated) |  | `to*, reason` |  |
| POST | `/api/v1/admin/supplier-network/suppliers/:id/users` | staff: `suppliers:write` | Link an existing SUPPLIER user to this supplier |  | `email*` |  |
| GET | `/api/v1/admin/supplier-network/suppliers/:id/verification` | staff: `suppliers:read` | Verification checklist with evidence and production-readiness |  |  |  |
| POST | `/api/v1/admin/supplier-network/suppliers/:id/verification/:kind/attest` | staff: `suppliers:write` | Record manual attestation with checkable evidence |  | `summary*, outcome*, orderId, shipmentId, supplierOrderId, documentId, externalReference, metrics` |  |
| POST | `/api/v1/admin/supplier-network/suppliers/:id/verification/:kind/probe` | staff: `suppliers:write` | Run an automated verification probe (order-creating probes need typed confirmation) | 20 / 1 minute | `country, externalId, sku, sampleSize, confirm, acknowledgeLiveCost, supplierOrderId, address` |  |
| POST | `/api/v1/admin/supplier-network/suppliers/:id/verification/delivery-from-shipment` | staff: `suppliers:write` | Use a DELIVERED shipment as delivery evidence |  | `shipmentId*` |  |
| POST | `/api/v1/admin/supplier-network/suppliers/:id/verification/stock-observations` | staff: `suppliers:write` | Submit independently observed stock counts for the open stock sample |  | `observations*, summary*` |  |

## SupplierPortal

| Method | Path | Auth | Summary | Rate limit | Body | Query |
|---|---|---|---|---|---|---|
| GET | `/api/v1/supplier/dashboard` | user | Supplier portal dashboard | 120 / 1 minute |  | `supplierId` |
| GET | `/api/v1/supplier/disputes` | user | Supplier portal: my disputes |  |  | `supplierId` |
| POST | `/api/v1/supplier/disputes/:id/respond` | user | Supplier portal: respond to a dispute |  | `note*, documentId, url, supplierId` |  |
| GET | `/api/v1/supplier/documents` | user | Supplier portal: my documents |  |  | `supplierId` |
| POST | `/api/v1/supplier/documents` | user | Supplier portal: upload a document (multipart) | 20 / 1 minute |  |  |
| GET | `/api/v1/supplier/documents/:id/file` | user | Supplier portal: download my document |  |  | `supplierId` |
| GET | `/api/v1/supplier/me` | user | Supplier portal: my supplier(s) | 120 / 1 minute |  |  |
| POST | `/api/v1/supplier/offers/upload` | user | Supplier portal: price/stock CSV (manual suppliers) | 10 / 1 minute | `supplierId, csv*` |  |
| GET | `/api/v1/supplier/orders` | user | Supplier portal: my orders | 120 / 1 minute |  | `page, pageSize, supplierId, status` |
| POST | `/api/v1/supplier/orders/accept` | user | Supplier portal: accept a queued order and record the supplier order reference | 60 / 1 minute | `supplierId, orderId*, lineKey*, supplierOrderId*` |  |
| GET | `/api/v1/supplier/returns` | user | Supplier portal: return authorization requests |  |  | `supplierId` |
| POST | `/api/v1/supplier/returns/:id/decide` | user | Supplier portal: authorise/reject a return |  | `supplierId, to*, rmaNumber, note, refundMinor` |  |
| POST | `/api/v1/supplier/shipments/:id/ship` | user | Supplier portal: mark shipped with tracking | 60 / 1 minute | `supplierId, trackingNumber*, carrier*` |  |
| GET | `/api/v1/supplier/statements` | user | Supplier portal: my statements |  |  | `supplierId` |
| POST | `/api/v1/supplier/statements` | user | Supplier portal: submit a statement (CSV) | 10 / 1 minute | `number*, currency*, periodStart, periodEnd, csv*, supplierId` |  |
| GET | `/api/v1/supplier/verification` | user | Supplier portal: verification status |  |  | `supplierId` |

## Support

| Method | Path | Auth | Summary | Rate limit | Body | Query |
|---|---|---|---|---|---|---|
| POST | `/api/v1/support/chat` | none | AI support assistant (grounded in orders, shipments and products) | 30 / 1 minute | `message*, email, orderNumber, ticketId, confirmCancel, country` |  |
| GET | `/api/v1/support/tickets` | user | My support tickets |  |  |  |

## Trust

| Method | Path | Auth | Summary | Rate limit | Body | Query |
|---|---|---|---|---|---|---|
| GET | `/api/v1/products/:slug/confidence` | none | Purchase Confidence report: honest completeness, reliability, delivery band, total delivered price and uncertainty | 120 / 1 minute |  | `country, quantity, region` |
| GET | `/api/v1/products/:slug/passport` | none | Digital Product Passport: structured product profile with provenance on every field | 120 / 1 minute |  | `country` |

## Webhooks

| Method | Path | Auth | Summary | Rate limit | Body | Query |
|---|---|---|---|---|---|---|
| POST | `/api/v1/webhooks/payments/:provider` | none | Payment provider webhook (signature verified) |  |  |  |

## Raw Fastify routes

Registered directly with `app.get` rather than `route()`, so they carry no zod schema and are hidden from OpenAPI. Auth was read from the handlers.

| Method | Path | Auth | Summary | Rate limit |
|---|---|---|---|---|
| GET | `/live` | none | Process liveness |  |
| GET | `/health` | none | Health summary (env, version, uptime) |  |
| GET | `/ready` | none | Readiness (Mongo reachable; Redis reported as degraded) |  |
| GET | `/metrics` | none; bearer `METRICS_TOKEN` when set; 404 in production without a token | Prometheus metrics |  |
| GET | `/openapi.json` | none | OpenAPI document (`/docs` UI only outside production) |  |
| GET | `/api/v1/media/*` | none | Serve a stored media object (only registered with the local storage provider; production uses the CDN/object store) |  |
| GET | `/api/v1/launch-gate` | bearer `METRICS_TOKEN`; 404 in production without a token | Machine-readable launch gate for CI/CD | 10 / 1 minute |
| GET | `/api/v1/aftersales/returns/:id/evidence/:evidenceId` | user (owner of the return) | Download return evidence image |  |
| GET | `/api/v1/admin/aftersales/returns/:id/evidence/:evidenceId` | staff: `returns:read` | Download return evidence image (staff) |  |

## Permission by role matrix

Generated from `PERMISSIONS` and `ROLE_PERMISSIONS` in `packages/auth/src/index.ts`. "Routes" is how many `route()` definitions require the permission. Roles without any staff permission (CUSTOMER) are shown for completeness; SUPPLIER only holds the supplier-portal permissions and `staff` routes reject CUSTOMER and SUPPLIER before the permission check.

| Permission | Routes | SUPER_ADMIN | ADMIN | MARKETING | OPERATIONS | SUPPORT | ANALYST | CUSTOMER | SUPPLIER |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `overview:read` | 2 | x | x | x | x | x | x |  |  |
| `orders:read` | 2 | x | x |  | x | x | x |  |  |
| `orders:write` | 6 | x | x |  | x |  |  |  |  |
| `refunds:write` | 2 | x | x |  | x | x |  |  |  |
| `refunds:approve` | 7 | x | x |  |  |  |  |  |  |
| `products:read` | 6 | x | x | x | x |  | x |  |  |
| `products:write` | 17 | x | x |  |  |  |  |  |  |
| `categories:write` | 0 | x | x |  |  |  |  |  |  |
| `suppliers:read` | 15 | x | x |  | x |  | x |  |  |
| `suppliers:write` | 30 | x | x |  | x |  |  |  |  |
| `inventory:read` | 1 | x | x |  | x |  | x |  |  |
| `inventory:write` | 1 | x | x |  | x |  |  |  |  |
| `customers:read` | 2 | x | x |  | x | x | x |  |  |
| `marketing:read` | 15 | x | x | x |  |  | x |  |  |
| `marketing:write` | 12 | x | x | x |  |  |  |  |  |
| `ads:read` | 0 | x | x | x |  |  | x |  |  |
| `ads:write` | 3 | x | x | x |  |  |  |  |  |
| `promotions:read` | 1 | x | x | x |  |  | x |  |  |
| `promotions:write` | 2 | x | x | x |  |  |  |  |  |
| `analytics:read` | 2 | x | x | x | x |  | x |  |  |
| `copilot:use` | 2 | x | x | x |  |  | x |  |  |
| `automation:read` | 3 | x | x | x | x |  | x |  |  |
| `automation:write` | 4 | x | x |  |  |  |  |  |  |
| `countries:read` | 1 | x | x | x | x |  | x |  |  |
| `countries:write` | 1 | x | x |  |  |  |  |  |  |
| `payments:read` | 5 | x | x |  | x |  |  |  |  |
| `shipping:read` | 1 | x | x |  | x | x | x |  |  |
| `returns:read` | 8 | x | x |  | x | x | x |  |  |
| `returns:write` | 13 | x | x |  | x | x |  |  |  |
| `reviews:read` | 2 | x | x | x |  | x | x |  |  |
| `reviews:write` | 1 | x | x |  |  | x |  |  |  |
| `support:read` | 2 | x | x |  |  | x | x |  |  |
| `support:write` | 1 | x | x |  |  | x |  |  |  |
| `exceptions:read` | 1 | x | x |  | x | x | x |  |  |
| `exceptions:write` | 1 | x | x |  | x |  |  |  |  |
| `settings:read` | 2 | x | x |  |  |  |  |  |  |
| `settings:write` | 10 | x | x |  |  |  |  |  |  |
| `audit:read` | 1 | x | x |  |  |  |  |  |  |
| `users:manage` | 3 | x |  |  |  |  |  |  |  |
| `ai:write` | 12 | x | x | x |  |  |  |  |  |
| `market:read` | 5 | x | x | x | x |  | x |  |  |
| `market:write` | 5 | x | x | x |  |  |  |  |  |
| `launch:read` | 2 | x | x |  | x |  |  |  |  |
| `trust:read` | 5 | x | x |  | x | x | x |  |  |
| `trust:write` | 2 | x | x |  |  |  |  |  |  |
| `rescue:read` | 4 | x | x |  | x | x | x |  |  |
| `rescue:write` | 3 | x | x |  | x | x |  |  |  |
| `customer360:read` | 3 | x | x |  |  | x | x |  |  |
| `customer360:write` | 3 | x | x |  |  |  |  |  |  |
| `finance:read` | 13 | x | x |  | x |  | x |  |  |
| `finance:write` | 7 | x | x |  |  |  |  |  |  |
| `creators:read` | 7 | x | x | x |  |  | x |  |  |
| `creators:write` | 12 | x | x | x |  |  |  |  |  |
| `loyalty:read` | 2 | x | x | x |  |  | x |  |  |
| `loyalty:write` | 2 | x | x | x |  |  |  |  |  |
| `supplierportal:read` | 0 |  |  |  |  |  |  |  | x |
| `supplierportal:write` | 0 |  |  |  |  |  |  |  | x |

Permissions defined: 57. Permissions with no route requiring them: `categories:write`, `ads:read`, `supplierportal:read`, `supplierportal:write`. Permissions used by routes but not in the list: none.
