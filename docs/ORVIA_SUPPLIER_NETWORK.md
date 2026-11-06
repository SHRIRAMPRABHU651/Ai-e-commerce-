# ORVIA Supplier Network

ORVIA owns the customer experience; suppliers fulfil. This document describes the supplier-network layer: onboarding, evidence-based verification, catalogue matching, quote comparison, SLAs, disputes, payables and the supplier portal. Code: `packages/core/src/domain/suppliernet/`, routes `apps/api/src/routes/suppliernet.ts`, admin `/admin/supplier-network`, portal `/supplier`.

Status legend: **Implemented** (code + unit tests), **Implemented, not executed here** (integration test written, needs MongoDB in CI), **Requires real supplier accounts**, **Planned**.

## 1. Adapter matrix (what covers which supplier type)

No adapter has been verified against a live vendor from this repository. "Covered" means the adapter can express the integration; it becomes trustworthy only after the verification checklist (section 3) is passed with evidence against the real supplier.

| Supplier type | Adapter(s) | Notes |
|---|---|---|
| `api` (any JSON/HTTP API) | `rest` (configurable mapping), `cj` | `rest` covers the generic supplier-API requirement for suppliers whose API fits its shape (bearer/header/query key, JSON, idempotent order creation, status/tracking). SOAP, signed requests, OAuth flows, GraphQL or CSV-only vendors do **not** fit and need a dedicated adapter. |
| `feed` | `feed` (new) | Read-only CSV/JSON catalogue, price, stock from a URL fetched through `infra/ssrf.ts`. Ordering goes through the manual order queue. |
| `manual` | `manual` | Operator-entered offers that expire; orders placed by hand (or by the supplier in the portal). |
| `manufacturer`, `wholesaler`, `regional_distributor`, `local_fulfilment` | `rest`, `feed` or `manual`, whichever the supplier actually offers | These are business types stored as metadata + declared capability flags; they are not adapters. |
| `print_on_demand` | `rest` if the vendor API fits, otherwise `manual` | No dedicated Printful/Printify adapter (listed as planned in `PLANNED_PROVIDERS`). |
| Named vendors (CJ) | `cj` | Written from public docs; never run against a live CJ account. |
| Named vendors (AliExpress, DSers, Spocket, Zendrop, Syncee, DropCommerce, Wholesale2B, Modalyst, Printful, Printify) | none | Planned; use `rest`/`manual`. |

The `feed` adapter: `packages/suppliers/src/feed.ts`. Schema mapping (`feedConfigSchema`): URL, format, delimiter/JSON list path, currency + price unit, column names for id/title/price/stock/shipping/images/GTIN/MPN/brand, defaults for shipping and delivery days. Rows with an invalid id, price, stock or delivery days are **rejected with a reason**, never guessed. Fetches are cached for `cacheSeconds`; a failing or stale feed is an error. `createOrder` always refuses; `getOrder`/`getTracking` read the shipment recorded by an operator or the supplier portal. Scheduled refresh: job `suppliernet_feed_refresh` (every 6 h) re-ingests all active feed suppliers; the existing `inventory_sync` job then refreshes offers for linked products. Feed and manual suppliers are always `MANUAL` fulfilment mode (`setFulfillmentMode` refuses otherwise).

## 2. Onboarding

States: `invited → profile_submitted → documents → technical_integration → verification → probation → approved`, plus `suspended`. Transitions are a fixed state machine with gates (`gating.ts: checkTransition`):

- `profile_submitted/documents` need a complete, schema-valid profile (legal name, country, contact, categories, shipping regions, lead times, return policy, warranty, SLA claims, declared capabilities).
- `technical_integration` needs every required document verified and unexpired (`business_registration`).
- `verification` needs a working adapter (health check passes; manual suppliers always pass).
- `probation` needs all pre-probation verification steps passed with evidence (catalogue, price accuracy, stock accuracy, test order, cancellation, tracking).
- `approved` needs `production_ready` (every required step, including delivery observed and, if the supplier accepts returns, return/refund handling) **and** at least 7 days of probation.
- `suspended` needs a reason. Reinstatement goes to `probation`/`verification`, never straight to `approved`.

Inviting a supplier (`POST /admin/supplier-network/suppliers`) creates the `Supplier` (inactive), a profile shell and a `SUPPLIER`-role user who sets a password through the normal password-reset email. `active` becomes true only in `probation`/`approved`. Suspension deactivates the supplier everywhere (all environments).

Documents: PDF/JPEG/PNG/WebP up to 8 MB, content-sniffed, stored under a random unguessable key in object storage and **served only through permission-checked routes** (staff `suppliers:read`, or the owning supplier). With S3, keep the `suppliernet/docs/` prefix private (do not serve it through the CDN): this repo cannot enforce bucket policy. Reviewers verify/reject; expiry is tracked and the daily sweep rejects expired documents.

Credentials: stored with the existing AES-GCM credential store; the rotate endpoint is write-only, audit logs record field names only, and `lastRotatedAt`/`rotatedBy`/rotation-due (default 180 days) are tracked.

## 3. Verification: "API responds" is not production-ready

Each supplier has a checklist (`suppliernet_verification_steps`):

| Step | Automated probe | Manual attestation needs |
|---|---|---|
| `catalogue_availability` | search + product detail + stock read | a reference (order/shipment/supplier order/document/external ref) |
| `price_quote_accuracy` | compares the quote taken before the test order with the cost the supplier reports for it (tolerance 2%) | `metrics.quotedMinor` and `metrics.chargedMinor`; pass/fail is **computed**, not trusted |
| `stock_accuracy_sample` | collects claimed stock for N products; the step finishes only when independently **observed** counts are submitted; accuracy is computed (≥ 90% over ≥ 5 samples) | observations with a source |
| `test_order_placement` | places a test order twice with the same idempotency key and requires the same supplier order id | supplier order id or linked order |
| `cancellation` | cancels the test order | supplier order id or cancellation reference |
| `shipment_tracking` | requires a real tracking number from the supplier (never invented) | shipment or supplier order id |
| `delivery_observed` | not automatable: link a `DELIVERED` shipment of that supplier | shipment or order |
| `return_refund_handling` | not automatable; required only if the profile says returns are accepted | RMA/refund reference or document |

Evidence per step: timestamp, operator, method (automated/manual), outcome, summary, **redacted** request/response (secrets and PII removed by `redact.ts`), linked order/shipment/supplier order, metrics. A step counts only while it is `passed`, unexpired, **and** has at least one passing evidence record. Validity windows: 60-365 days depending on the step; the daily sweep lapses expired readiness and raises an exception.

Safety: read-only probes may run against any configured supplier. A test order requires typing `PLACE TEST ORDER`; for a supplier without `sandbox=true` it requires typing `PLACE LIVE TEST ORDER` **and** `acknowledgeLiveCost=true` (a real paid order). Cancellation requires `CANCEL TEST ORDER`. Mock suppliers are refused by the registry in production.

Production routing guard: `supplierRoutable` (`supplierAccess.ts`), applied in `selectSupplierLive` (`offers.ts`). When enforced, only suppliers that are `approved` + `production_ready` with unexpired readiness receive new orders. Enforcement defaults to `APP_ENV=production`; override with `SUPPLIER_ENFORCE_VERIFICATION=true|false`. Dev/test behaviour is unchanged by default. **Deployment note:** existing suppliers have no verification record; turning enforcement on will exclude them until onboarded and verified (orders then fail visibly through the normal exception path, never silently). Probation suppliers receive orders only through explicit operator action (manual fulfilment), not automatic routing.

Re-verification and demotion: `suppliernet_verification_sweep` (daily) clears `production_ready` for lapsed suppliers. `suppliernet_sla` (every 6 h) demotes an `approved` supplier to `probation` on a **critical** SLA breach (never auto-suspends, never auto-promotes).

## 4. Catalogue ingestion and matching

`ingestSupplierCatalog` pages through the provider's `searchProducts` (bounded), upserts `SupplierProduct` rows and `suppliernet_catalog_items` (normalised title, brand, GTIN, MPN, attributes), then proposes matches. Matching is pure (`matching.ts`): normalised title (token Jaccard + bigram Dice), GTIN with GS1 check digit (identical = high confidence, differing = capped at 0.2), MPN + brand, brand conflict, measurement conflicts (500 ml vs 1 L), attribute conflicts (colour/size/...), optional 64-bit perceptual image hashes. Every candidate stores a score, confidence and human-readable reasons/conflicts. **A person approves each link**; approval links the `SupplierProduct` to the product (the existing multi-supplier model), syncs offers and refreshes markets. Candidates are never auto-merged. Image hashes are only used when present (`dHashFromGray9x8` is provided; no job computes them by default).

Quote comparison (`GET /admin/supplier-network/quotes?productId&country&live`): all linked suppliers for a destination from stored offers, or live via `fetchLiveOffer` with `live=true`. Each row labels freshness (`live` / `fresh` / `stale` / `unknown`, source, age), onboarding state, whether it is routable in production, measured SLA facts ("insufficient data" is shown as such), and the existing `compareSuppliers` ranking.

## 5. Performance and SLA

Per-supplier SLA targets (`PUT .../sla`; defaults: fulfilment 95%, on-time 90%, cancellation ≤ 5%, stock accuracy 90%, refunds ≤ 8%, defects ≤ 3%, response ≤ 8 s, 30-day window, min sample 10). Facts come from real data: shipments (fulfilment, cancellation, on-time vs ETA), refunds on delivered orders, defect/wrong-item disputes, stock checks, health-probe response time. A rate below its minimum sample is `null` ("insufficient data"), never zero. Caveat: cancellations are counted regardless of who initiated them. Snapshots are stored in `suppliernet_sla_snapshots`; breaches raise a `SUPPLIER_FAILURE` exception.

For the **trust** workstream: `getSupplierSlaFacts(supplierId)` (`ops.ts`) returns a plain serialisable `SupplierSlaFacts` (null = insufficient data); the pure shape/converter is `toSlaFacts` in `sla.ts`. This layer computes operational facts only, not a reliability score.

## 6. Disputes, returns, payables

- Disputes (`suppliernet_disputes`): late / defective / not_delivered / price_mismatch / wrong_item / other, with evidence from both sides and a state machine (`open → awaiting_supplier ⇄ awaiting_orvia → resolved_credit | resolved_no_action | rejected | escalated → closed`). Credits require an amount and a note.
- Return authorization: `requestReturnAuthorization(ctx, { shipmentId | orderId, reason, returnRef? }, actor)` is exported for the **aftersales** workstream. The supplier is derived from the shipment, idempotent per `(shipment, returnRef)`. `getReturnAuthorizationFor(returnRef)` reads the supplier's answer. Suppliers authorise (RMA number required), reject (reason required) and record receipt/refund in the portal. The supplier's answer does not move money.
- Payables: statements enter by CSV, manual entry or portal. Reconciliation is deterministic and record-only: lines are matched by supplier order id or ORVIA order number against recorded shipment costs (converted to the statement currency, wider tolerance when FX was applied), flagged as `amount_difference`, `unknown_order` or `duplicate`, and recorded-but-unbilled orders are listed. Over-billed lines can be disputed (tracks the disputed amount). Settlement records a reference and amount **only**: nothing initiates a payment, and it is refused while differences or disputes are unresolved.

## 7. Supplier portal (`/supplier`)

Separate layout and sign-in; only users with role `SUPPLIER` get in (the page shell checks the role; **the API enforces it again on every call**). New permissions `supplierportal:read|write` are held only by `SUPPLIER`; no staff role has them, `SUPPLIER` holds no staff permission, and staff routes now reject `SUPPLIER` (`http.ts`, staff login).

Tenant isolation: every portal function resolves the caller's supplier(s) from `Supplier.userIds` (set only by staff) via `resolvePortalSupplier`; an id in the URL/body is only checked for membership and a foreign id gets **404** (indistinguishable from a missing one). Shipments, documents, disputes, returns and statements are always filtered by the resolved supplier id. Customer addresses are shown only while a shipment still has to be shipped (name, address, phone; never email or payment data).

Features: dashboard (orders to ship, awaiting acceptance, open disputes/returns, SLA status), orders with fulfilment confirmation (mark shipped + validated tracking number; only for manual/feed suppliers, since API suppliers' tracking comes from their API; this also notifies the customer), acceptance of orders from the manual queue (records the supplier order reference via the existing `recordManualFulfillment`), price/stock CSV upload (manual suppliers only; products must already be linked; uses the manual-offer path so offers expire), documents, verification status (statuses and dates only), statements (CSV) and disputes/returns responses.

## 8. Admin (`/admin/supplier-network`)

Permission-gated by `suppliers:read|write`; every mutation is audited (`suppliernet.*` actions). Tabs: pipeline (+ invite, adapter matrix, enforcement state), supplier detail (verification checklist with evidence and probe/attest actions, gated state transitions, documents, credential rotation), matching queue, quote comparison, SLA board, disputes, payables.

## 9. What needs real supplier accounts / is not verified

- Every adapter (`rest`, `cj`, `feed`) against a real vendor: field mapping, rate limits, idempotency behaviour, sandbox availability.
- The verification probes against real endpoints (the test-order, cancellation and tracking probes are exercised only with fakes).
- Private-bucket policy for `suppliernet/docs/` in S3.
- Integration tests in `tests/integration/suppliernet.test.ts` were written but **not executed in the authoring sandbox** (no MongoDB); unit tests in `tests/unit/suppliernet.test.ts` were.

## 10. Remaining gaps

Image hashes are not computed automatically; cancellations in SLA are not attributed to who initiated them; the portal has no live-order notifications for suppliers (no email on new orders); suppliers cannot self-edit their profile in the portal (staff enter it); admin UI uses simple prompts for some inputs (test-order address, rejection reasons); no multi-currency payout netting.
