# ORVIA TrustGraph

TrustGraph turns real transaction data into honest trust signals: supplier reliability, product risk, a Digital Product Passport, a Purchase Confidence report and a Fair Deal ranking. Principles: real data only, no fabricated statistics, a numeric score is never shown as established when samples are too few, AI never makes a safety or compliance claim, deterministic code decides.

Status legend: **Implemented** unless marked otherwise.

## The chain

Product -> Manufacturer -> Supplier -> Order -> Shipment -> Delivery -> Feedback -> Return -> Refund. Each link is read from existing collections (`Shipment`, `Order`, `ReturnRequest`, `Refund`, `Review`, `SupplierOffer`, `Exception`); nothing is copied or invented. Manufacturer identity exists only as recorded evidence.

## Provenance

Every fact carries one of: `verified` (checked by Orvia: platform records or evidence recorded by a person), `supplier_provided`, `customer_reported`, `ai_suggested`. Evidence is stored in `trust_evidence` (`subject`, `kind`, `key`, `value`, `provenance`, `source`, `observedAt`, `expiresAt`, `supersededAt`). Expired evidence stops counting (verified degrades to supplier-provided). Superseded evidence is kept for audit. Only a person (not AI/system) can record `verified` evidence; `POST /admin/trust/evidence` is audited.

AI guard (`guard.ts`): `guardedField` refuses `ai_suggested` in claim positions (safety, certificate, compliance) and strips any sentence matching claim patterns (certified, compliant, non-toxic, CE/UL/EN71/FDA..., organic, safe...) from AI text. The listing description is shown labelled `ai_suggested` after stripping. `assertNoAiClaims` runs on the passport's documents.

## Supplier reliability (`scoring.ts`, `stats.ts`)

Components (weight): fulfilment success .20, on-time vs promised ETA (+1 day grace) .20, defect rate .12, satisfaction (reviews 4-5 stars) .10, cancellation .08, stock accuracy .08, return rate .08, refund response .06, dispute history .05, offer data freshness .03.

- Rate components use a Beta-Binomial posterior mean `(successes + prior*k) / (n + k)` with prior strength `k = 10` and documented priors (fulfilment .90, on-time .75, cancellation .95, stock .90, defect .95, return .90, refund response .70, satisfaction .75, dispute .97). Monotone in sample size: a perfect 2-of-2 never beats 200-of-200.
- Component `confidence = n/(n+k)`. Overall confidence = weight-averaged component confidence (components without data count as zero).
- Refund response: per-refund score `0.5^(median hours/72)`, shrunk the same way.
- Freshness: `0.5^(age/72h)` of the newest offer sync/confirmation; 0 after `expiresAt` for evidence.
- Score = weighted mean of components that have data, 0-100; range = approx. 90% interval from effective sample `n + k`.
- Attribution: returns/defects belong to a supplier when return SKUs match the supplier's shipments on that order; defect reasons are `damaged`, `not_as_described`, `wrong_item`; `not_delivered` and rejected returns are excluded; disputes are CHARGEBACK/SAFETY/AUTHENTICITY exceptions; stock issues are STALE_STOCK exceptions or failed shipments with stock errors.
- **Status thresholds**: `insufficient_data` below 5 resolved shipments (score is `null`, UI says "Not enough delivery history yet" plus what is known); `provisional` 5-29, or confidence < 0.55, or offer data older than 14 days; `established` at 30+ with confidence >= 0.55 and fresh data.
- **Destination-specific**: the same scorer runs per destination country, with the supplier's global component values as the prior (hierarchical shrinkage), so a thin destination slice leans on the supplier's overall record.

## Product risk

Components: evidence completeness .20 (verified 1.0, supplier-provided .6, customer .3, AI .2, absent 0), compliance .25, supplier reliability .20 (weakest scored supplier able to serve it), shipping history .15, feedback/returns/defects .15, destination restrictions .05. Output is a risk score 0-100 (higher = riskier) with level low (<25) / medium (<50) / high, plus `unknown` when insufficient. Restricted destination or failed/under-review compliance forces `high`. Status: `insufficient_data` when the product has < 5 transactions and no scoreable supplier; `established` at 20+ transactions with a scored supplier and confidence >= .55; otherwise `provisional`. Each component lists its evidence.

## Snapshots, recompute and how trust improves

`trust_supplier_snapshots` and `trust_product_risk_snapshots` store `inputs` (aggregated counts and sample sizes), `result` (components), `modelVersion` and `trigger`, so any score can be audited and reproduced. 180-day retention. Job `trust_recompute` (every 6h, `TRUST_SCHEDULES`, registered by `register_trust_Jobs`), `POST /admin/trust/recompute`, and on-demand refresh of supplier snapshots older than 6h by customer reads. As shipments deliver, returns and reviews arrive, sample sizes rise, shrinkage relaxes, statuses move insufficient -> provisional -> established with no manual step. A `Shipment {supplierId, createdAt}` index is declared in `models.trust.ts`.

## Digital Product Passport: `GET /api/v1/products/:slug/passport?country=`

Public. Returns: identity (supplier display name only; manufacturer only if evidenced), listing summary (`ai_suggested`, claim-stripped), specifications / materials / dimensions (supplier-provided from attributes; `verified` only with matching active verified evidence), images with source and usage rights (from the product image policy), certificates and documents (`compliance.safetyInfo`, `organic` evidence, evidence items; verified only if verified and unexpired), restrictions (market, compliance, export gate), stock freshness (fresh <=24h, aging <=96h, stale), price history, promised vs actual delivery, return/defect rates (shown only at >= 5 deliveries), risk with components, review summary, similar products, lifecycle. Output passes `toCustomerSafe` and a leak check (internal keys and supplier/offer ids); a leak returns 500.

Limits: price history is not recorded yet (the `find` workstream's snapshot collection is not read; `priceSnapshots` is an input ready for it), so only today's price is returned and compare-at is stated to be a reference price. Manufacturer identity needs evidence entries.

## Purchase Confidence: `GET /api/v1/products/:slug/confidence?country=&quantity=&region=`

Info completeness (verified vs supplier-provided share, missing facts), supplier reliability with label ("Not enough delivery history yet" / "Early signal" / "Established"), delivery band, return window (country config), total delivered price (price x quantity + standard shipping + estimated tax through `@orvia/shipping`; labelled estimate; import-charge note when shipping cross-border), restrictions, known limitations, and explicit uncertainty statements.

Delivery band (`delivery.ts`): >= 5 delivered orders for the product/destination: p10..p90 of order-to-delivery days with the upper end widened by `1 + 1/sqrt(n)`, plus a Wilson lower bound for share within the promised window. Fewer: the supplier estimate with max widened to `1.5*max + 2` and labelled unconfirmed. No data: no numbers. Never a guarantee.

## Fair Deal Engine (`fairDeal.ts`, `customer.ts`)

`rankOffersByFairValue(offers, { weights?, requestedProductId?, allowSubstitution? })` is pure and exported from `@orvia/core` for delivery rescue and the shopping assistant. Dimensions and default weights: total delivered price .30 (cheapest/price), supplier reliability .25 (established uses score; provisional is blended toward .5 by confidence), quality evidence .15, delivery confidence .15 (speed x confidence), return conditions .10 (window/30), warranty .05 (months/12). Unknown data scores 0.4 (below neutral) and is listed in `unknowns`; customer weights are normalised. Output: ranked list, per-dimension scores with notes, `isCheapest`, excluded offers. Ties break on price then id.

**Substitution**: it ranks offers for the *same* product. Offers for a different product throw `SubstitutionConsentError` unless the caller passes `allowSubstitution: true`, which must only follow explicit customer consent; such results are flagged `substitute: true`. `fairDealForCustomer` strips supplier refs. Service `fairDealForProduct(ctx, productId, country, qty, {priceMode})` loads offers; `landed_cost` (default, internal) compares Orvia's cost to deliver, `customer` uses the customer price (identical across offers, so quality drives the order). Staff route: `GET /admin/trust/products/:id/fair-deal?country=&quantity=`. Observed delivery history is product-level, not per supplier; warranty comes only from evidence key `warranty_months`.

## API

| Route | Auth |
| --- | --- |
| `GET /products/:slug/passport`, `GET /products/:slug/confidence` | public, rate-limited |
| `GET /admin/trust/suppliers`, `/suppliers/:id`, `/products`, `/products/:id`, `/products/:id/fair-deal` | `trust:read` |
| `POST /admin/trust/recompute`, `POST /admin/trust/evidence` | `trust:write`, audited |

Admin page `/admin/trust`: supplier trust table (score + range, status, confidence, samples, destinations; row detail with component evidence), product risk table with detail and evidence, recompute button. Customer components in `apps/web/src/components/trust.tsx`: `PurchaseConfidencePanel`, `ProductPassportPanel`, `TrustBadge`, `ProvenanceChip`.

## Limits

Scores are statistics over Orvia's own history, not certifications. Compliance screening is automated keyword rules. On-time uses supplier ETAs and tracking events, which can be late or missing. Tax is an estimate. Return attribution depends on SKU data. Integration tests (`tests/integration/trust.test.ts`) require MongoDB and were not run in the authoring sandbox.
