# ORVIA product vision

Scope: what ORVIA is for, the principles the code is held to, who it serves, what ORVIA owns versus what suppliers fulfil, and the rule for deciding which products may be sold. Every statement about behaviour cites the code or a sibling document; items that are policy rather than code are marked as manual. Nothing here has been verified against live payment, supplier or advertising accounts (see [ORVIA_LIMITATIONS_AND_NEXT_STEPS.md](ORVIA_LIMITATIONS_AND_NEXT_STEPS.md)).

## Vision

Make buying from a supplier-fulfilled store feel as safe as buying from a store that holds its own stock, by being honest about what is known, fast about what goes wrong, and present after the parcel arrives. ORVIA does not try to win on the lowest price or the widest catalogue. It tries to win on whether the shopper can trust the page, the promise and the recovery.

## Principles

1. **Real data only.** No fabricated specifications, certifications, delivery dates, availability, statistics, reviews, customers or supplier responses. Where a fact is missing the UI says so ("Not provided by the supplier yet").
2. **Provenance on every fact.** `verified` (checked by ORVIA or recorded by a person), `supplier_provided`, `customer_reported`, `ai_suggested`. Evidence expires; expired verified evidence degrades to supplier-provided. AI is never allowed to assert safety, certification or compliance (`packages/core/src/domain/trust/guard.ts`).
3. **Uncertainty is shown, not hidden.** Small samples produce "insufficient data" or a widened range, not a confident number (`trust/stats.ts`, `trust/scoring.ts`, `trust/delivery.ts`).
4. **Deterministic code decides.** Money, payment status, order transitions, tax, authorization, refund eligibility, settlement and inventory are decided by deterministic functions; AI suggests and words answers. Tools exposed to agents cannot call refund, payout, approval or permission functions (unit-tested, [ORVIA_AI_AGENTS.md](ORVIA_AI_AGENTS.md)).
5. **Consent first.** Personalisation (LifeGraph, Commerce Memory), marketing email and server-side tracking default to off and are checked at send time ([ORVIA_CUSTOMER_EXPERIENCE.md](ORVIA_CUSTOMER_EXPERIENCE.md), [ORVIA_MARKETING_AND_TRACKING.md](ORVIA_MARKETING_AND_TRACKING.md)).
6. **Safe by default.** Production refuses mock providers; automatic rescue execution is off; paid ad launches always need a human; products whose acquisition cost is only assumed cannot auto-publish.
7. **Auditable.** Sensitive actions write audit entries; rescue actions have an immutable timeline; ledger entries are append-only; trust scores are stored with their inputs and model version.

## Who it serves

| Party | What ORVIA gives them | Where |
|---|---|---|
| Consumers | Facts with sources, a delivery band, a return window, a total delivered price estimate, price history and alerts, recovery when delivery fails, a returns wizard, privacy controls | storefront, `/account/*` |
| Creators | A profile, collections of real sellable products, tracked share links, commissions with a hold, statements, payouts (recorded; money moves manually) | `/creator`, `/creators/[handle]` |
| Suppliers | A portal for orders to ship, documents, verification status, statements and disputes; SLA measured from real shipments | `/supplier` |
| Brands and manufacturers | A place for evidenced manufacturer identity on the passport (only if evidence is recorded) | `POST /admin/trust/evidence` |
| Logistics | Tracking comes from suppliers; delay and exception detection feeds Delivery Rescue. No carrier integration ships | `rescue_scan`, `sync_tracking` |
| Affiliates and referrers | Referral codes with one reward per invited email after delivery plus a 14-day hold | `referrals.ts`, creators docs |
| Payment providers | Signature-verified webhooks, idempotent processing, dispute and refund event ingestion (Stripe, Razorpay) | `orders.ts`, after-sales docs |
| Communities | Moderated comments on creator collections | `/admin/creators` Comments tab |
| Staff and AI intelligence | Admin console with audited actions; eleven governed agents with read-only staff tools | `/admin/*`, `/admin/ai-agents` |

## What ORVIA owns, what suppliers fulfil

| ORVIA owns | Suppliers fulfil |
|---|---|
| Storefront, content shown to the customer, price and promotions | Holding stock; picking, packing, dispatch |
| Checkout and the payment relationship (through Stripe or Razorpay; no card data touches ORVIA) | Supplier price and stock feed; order acceptance |
| Trust information: passport, reliability, purchase confidence | Supplier-provided specifications and documents (labelled as such) |
| Delivery promise display, tracking relay, Delivery Rescue decisions | The physical delivery and carrier tracking numbers |
| Returns policy, RMA workflow, refunds, chargeback handling | Accepting returns or replacements per their stated policy (unknown by default; staff decide) |
| Customer data, consent, support, loyalty, creator programme | Their own business records, uploaded in the portal |
| Ledger, FX, margin and cash decisions | Payables (ORVIA records and reconciles statements; it does not pay automatically) |
| Compliance gates (organic claims, export attestation, product filters) as software checks | Their own legal and product obligations; operator attests legal review |

ORVIA holds no inventory. Stock is per supplier offer and per market, refreshed by `inventory_sync` (every 5 minutes, rotating) and shown with a freshness label on the passport.

## Honest framing of the differentiation

The combination below is a set of design choices. This document does not claim any other retailer lacks any single item.

- Provenance labels, expiry of evidence and claim-stripping of AI text on the product page.
- Small-sample-aware supplier statistics and delivery bands, with destination-specific slices.
- An automated recovery path that asks the customer before changing terms and keeps an immutable timeline.
- A finance layer that labels every number as actual, mixed, estimated or unavailable and can answer "not reachable".
- Consent-gated personalisation and tracking with an auditable outbox.
- A supplier network where "the API responds" is not sufficient to receive production orders.

Whether shoppers value these choices, and whether they improve conversion or repeat rate, is **untested**: no live traffic has run on this build.

## Initial category focus

From [ORVIA_12_MONTH_GROWTH_STRATEGY.md](ORVIA_12_MONTH_GROWTH_STRATEGY.md); chosen for low regulatory load, supplier availability and repeat potential, not for size.

1. **Pet accessories and enrichment** (months 1 to 4). Avoid anything ingestible or health-claiming without verified documentation.
2. **Home and desk convenience** (months 4 to 7). Electrical items only with verified certifications for the destination.
3. **Learning and activity products with verified safety information** (months 7 to 10). Age grading, standards and certificates must be on the product record; the organic-claims gate (`domain/organic.ts`, used by `canPublish`) blocks unverified "non-toxic/eco/organic" claims.
4. **Personalised gifts and print-on-demand** (month 10 onward, later). Needs a supplier with reliable production lead times; refunds are harder to recover, so the refund-recovery input in the model should be set low. No Printful or Printify adapter exists; `rest` or `manual` would be used.

Market order is decided by measured delivery and settlement behaviour per market, not ambition.

## Product acceptance checklist and where it is enforced today

A product should be sold only if every row is satisfied. "Code" means software blocks or flags it; "manual" means an operator must do it and nothing stops a mistake.

| Check | Enforced in code today | Manual or not enforced |
|---|---|---|
| **Real supplier** | Mock supplier refused in production (`packages/suppliers/src/registry.ts`). With `SUPPLIER_ENFORCE_VERIFICATION` (default on when `APP_ENV=production`) only suppliers that are `approved` and `production_ready` receive orders (`domain/supplierAccess.ts: supplierRoutable`, `suppliernet/gating.ts`). Verification needs evidence, not just a responding API ([ORVIA_SUPPLIER_NETWORK.md](ORVIA_SUPPLIER_NETWORK.md) section 3). | Judging that a supplier is genuine rests on the evidence a person records or attests. |
| **Verified specifications** | Passport marks a spec `verified` only with matching, unexpired, person-recorded evidence; otherwise `supplier_provided` (`trust/passport.ts`, `trust/guard.ts`). Unverified safety/certification claims in the listing are a hard `canPublish` problem (`domain/organic.ts: claimViolations`). | Verification of other specifications is **not a publish gate**: a product can publish with supplier-provided specs only. |
| **Image and content rights** | `canPublish` requires a usable real image and a description of at least 20 characters; demo art and hotlinked images are rejected in production (`domain/images.ts`, `domain/imagePipeline.ts`, [IMAGE_PIPELINE.md](IMAGE_PIPELINE.md)). The passport reports image source and usage-rights status and says "Usage rights not confirmed" when unknown (`trust/passport.ts: usageRights`). | **Rights are reported, not enforced.** No check blocks publishing an image whose licence is unconfirmed; copy rights are not checked. |
| **Stock freshness** | `inventory_sync` refreshes stock and price on a rotation and proposes pause/restore (`domain/inventory.ts`); the passport labels stock fresh (24 h or less), aging (96 h or less) or stale (`trust/passport.ts`); manual offers expire. Mode is governed by the `inventory_sync` automation key. | No hard rule blocks the sale of a product only because its confirmation is stale; in ASSISTED mode a person approves pauses. |
| **Delivery feasibility** | A product needs a priced enabled market with a landed cost (`canPublish`); only suppliers that serve the destination are quoted (`supplierAccess.ts: servesCountry`, `offers.ts`); the delivery band is empirical or labelled unconfirmed (`trust/delivery.ts`); Delivery Rescue handles failures after the sale. | Realistic supplier ETAs depend on supplier honesty until deliveries accumulate. |
| **Destination compliance** | `canPublish` requires `compliance.status === 'passed'` (keyword filter, `domain/compliance.ts`); export attestation per destination is a hard problem when required (default on in production, `domain/exportGate.ts`) and holds fulfilment; organic claim evidence gate. | The keyword filter is not legal review. Attestation records that an operator says an adviser was consulted; it does not validate the advice. Destination product-safety rules beyond the filter are manual. |
| **Return feasibility** | The eligibility engine uses the supplier policy (accepts returns, windows, defect-only, replacement/exchange support); unknown policy leads to "request allowed, staff review" and no replacement is offered (`aftersales/eligibility.ts`, `policy.ts`). | **Not a publish gate.** Nothing stops publishing a product whose supplier return terms are unknown. Recording the supplier policy is manual. |
| **Positive contribution economics** | `canPublish` requires the expected-case margin to meet `minMarginPct` (default 20 percent) using measured CPA when available, otherwise a configured share of price; pessimistic losses are warnings; assumed CPA forces human approval (`domain/catalog.ts`, `domain/economics.ts`, [ECONOMICS.md](ECONOMICS.md)). Pricing proposals stay within margin guardrails. | The scenario fractions (15, 26, 40 percent) are assumptions until real campaign data exists. |
| **Differentiated value** | None. | Manual merchandising judgement: does the product give the shopper something a generic marketplace listing does not (verified information, a clear use case, better terms)? No code measures this. |

## Out of scope for this build

Owned inventory, a warehouse, a marketplace for third-party storefronts, automated supplier payment, and any claim that a product is safe or compliant that ORVIA has not evidenced.
