# Phase 2 report — sell something

**Status: NOT STARTED. This phase has no code deliverable and cannot be performed by an engineering session.**

Phase 2 requires 10–20 real orders through a verified live path (Phase 1, which is itself blocked). No order data exists, so:

- no measured CPA exists — every product resolves to `cpaSource: 'assumed'` and cannot be auto-published;
- no measured refund rate exists — every refund allowance is `estimated`;
- no estimated-vs-actual comparison can be written.

Nothing here is claimed. The tooling that Phase 2 feeds is ready and tested (see phase-0 report):

| Step | How |
|---|---|
| Record real ad spend ÷ orders per product/category/store | `POST /admin/economics/cpa` (audited) or the ad-metrics sync + `POST /admin/economics/refresh` |
| Real refund rates | derived from paid orders + shipments by `refreshMeasuredRefunds` (needs ≥ `minRefundSample` orders per product–supplier–destination) |
| Re-run the decision sheet | `/admin/economics` — cells flip from ◌ ESTIMATED to ● measured as data arrives |

**Stop rule (unchanged):** if no product clears `minMarginPct` on measured data, change the product, supplier or destination. Do not proceed to scale.

## Gate checklist
- [ ] 10 orders fulfilled end to end — deferred
- [ ] Positive contribution on a product using measured CPA — deferred
- [ ] `cpaSource` = `measured` for ≥ 1 product–country — deferred (mechanism tested with synthetic data only)
- [ ] Estimated-vs-actual on all four cost lines — deferred
