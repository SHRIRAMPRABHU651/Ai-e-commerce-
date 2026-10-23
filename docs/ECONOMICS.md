# Economics engine

Orvia sells only what clears a contribution-margin gate. This page explains how that gate is computed and, above all, which of its inputs are **measured** and which are **estimated**.

```
contribution/order = price − landed cost − payment fee − refund allowance − CAC
```

## Acquisition cost (CAC / CPA)

| `cpaSource` | Meaning | Auto-publish? |
|---|---|---|
| `measured` | real ad spend ÷ attributed orders for **this product** + country | yes |
| `category` | same, measured across the product's category | yes |
| `store` | same, measured across the whole store (country, else all countries) | yes |
| `assumed` | no campaign data: the configured scenario fractions of price | **no — a person must approve** |

A level is used only with at least `pricing.minCpaSample` attributed orders (default 5) inside `pricing.cpaWindowDays` (default 28); thinner data falls through to the next level. Demo ad metrics (`isDemo`) are never counted.

* `refreshMeasuredCpa` rebuilds the store from `AdMetric` (runs after `sync_ad_metrics`; also `POST /admin/economics/refresh`).
* `POST /admin/economics/cpa` records a measured CPA by hand (e.g. launch orders where spend is read from an ad dashboard). Manual entries are audited and never overwritten by the rebuild.

## Scenario band

`pricing.cacScenarios = { optimistic: 0.15, expected: 0.26, pessimistic: 0.40 }` (fractions of order value).

* **Publish only if the _expected_ case ≥ `minMarginPct`.** Otherwise `canPublish` rejects.
* The pessimistic case never blocks; it is returned as `warnings` ("below the minimum at pessimistic CAC", or "loses money") and shown on `/admin/economics`.
* With a known CPA the measurement *is* the expected case; the optimistic case is `min(configured, measured)` and the pessimistic case `max(configured, measured)`, so the band can never exclude what was observed.
* `break-even CAC` = pre-CAC margin − `minMarginPct`. With the documented 45% / 4% / 5% structure this is 0.46 − 0.20 = **26% of price**; the expected scenario sits exactly on it by design.

`minMarginPct` and the scenario fractions are changed only by an authenticated admin (`PUT /admin/settings/pricing`, audited, scenarios validated as optimistic ≤ expected ≤ pessimistic). Nothing in code lowers them to make a product pass.

## Refund allowance

Per offer: `supplierRefundRate(base, reliability, transit days)` — an **estimate**. Once `minRefundSample` (default 10) real, non-demo orders exist for a *product–supplier–destination* the measured rate (refunded value ÷ order value over `refundWindowDays`) replaces it. Each figure carries `refundSource` and `refundSampleSize`.

## Decision sheet

`/admin/economics` (API `GET /admin/economics`, `GET /admin/economics/export`) shows one row per product × market. Every figure is tagged:

* ● **measured** – realised from real orders / ad spend
* ◐ **quoted** – current supplier quote or published payment rate card
* ■ **set** – an operator decision (selling price)
* ◌ **ESTIMATED** – a model or assumption (duties on cross-border parcels, assumed CAC, estimated refunds, the optimistic/pessimistic band)

Derived figures (contribution, margin, break-even CAC) are `measured` only when CAC and refund rate are measured and duties are not estimated. The CSV repeats every figure with a `_basis` column; product titles are neutralised against spreadsheet formula injection.

## Export / destination attestation

`legal.requireExportAttestation` (ON in production). While a destination has no attestation, `canPublish` returns a hard problem for any product with a live market there and `fulfillOrder` holds the order (exception `EXPORT_ATTESTATION`) unless explicitly forced. Recording an attestation (`PUT /admin/compliance/export/:country`, people only) resolves the held orders' exceptions and re-queues them.
