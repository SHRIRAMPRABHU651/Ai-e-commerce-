# Phase 0 report — economics engine

Date: 2026-10-23 · Branch `claude/stoic-pascal-xk21ky` · baseline `ecfcb39`

## 1. Claimed before → proven now

| Before | Now |
|---|---|
| The publish gate checked a cached `expectedMargin` computed with an *assumed* 20% ad cost — just inside the 26% break-even — so nearly every product passed. | `canPublish` recomputes contribution from price, landed cost, refund rate and **CAC at three levels**; the **expected** case (measured CPA, else 26% of price) must clear `minMarginPct`. |
| CPA was a 14-day product+country lookup (≥5 orders) falling straight to the assumption; demo ad data was counted. | Measured-CPA store with product → category → store → assumed resolution; demo rows excluded; every market stores `cpaSource` + `cpaSampleSize`. |
| Provisional price used a magic `×3`. | `provisionalMarkup()` = 1 ÷ (1 − target margin − assumed ad share − payment % − base refund) (≈3.11 at defaults), bounded; unit-tested. |
| Refund rate always an estimate. | Measured refund rate per product–supplier–destination (≥10 real orders), otherwise `estimated`; carried as `refundSource`/`refundSampleSize` through ranking, markets and the sheet. |
| No view of per-product unit economics. | `/admin/economics` + `GET /admin/economics` + CSV export; every cell tagged ● measured / ◐ quoted / ■ set / ◌ ESTIMATED. |
| Auto-publish could proceed on assumed economics. | Assumed CAC ⇒ `needsHumanApproval`. `publishProduct` accepts approval only from a `user` actor; AUTOMATIC mode is forced into a proposal (`requireHuman`). |
| §9: no export gate. | Per-destination attestation; hard gate on publish and fulfilment (default ON in production); attesting releases held orders. |

## 2. Artifacts

| Claim | Artifact |
|---|---|
| Gate rejects when expected-case contribution < `minMarginPct` | `tests/integration/economics.test.ts` › "rejects when the EXPECTED-case margin is below the minimum" |
| Passes at 15%, passes at 26%, fails at 40% → flagged, not silent | same file › "passes at 15% CAC … FLAGGED"; `tests/unit/economics.test.ts` › "a product can pass at 15% CAC and fail at 40%" |
| Loses money at pessimistic CAC is called out | same file › "warns loudly when the product LOSES money" |
| `cpaSource: 'assumed'` cannot be auto-published; AI/system/webhook actors refused; AUTOMATIC mode still proposes; human approval publishes | same file › "assumed acquisition cost can NOT be auto-published…", "AUTOMATIC mode still routes assumed-CAC products to a human…" |
| CPA resolution order, thin samples ignored, demo data excluded, manual entries preserved | same file › "measured CPA store" |
| Measured refund rate replaces estimate only with enough orders | same file › "measured refund rate per product–supplier–destination" |
| `/admin/economics` renders, shows markers, exports | API: same file › "decision sheet API and CSV"; browser: `tests/e2e/responsive.spec.ts` › "/admin/economics: every figure is marked…" (desktop + mobile) |
| Export gate | same file › "export / destination attestation hard gate" |
| Whole gate | `npm run production-check` output — see §5 |

The E2E run found one real defect in my own page (horizontal page overflow from `sr-only` text inside a scroll container without `position: relative`); fixed and re-run green.

## 3. `LIMITATIONS.md`

Added #17 (CPA is **assumed** until campaign data exists; scenario fractions are assumptions; refund attribution method) and #18 (export attestation is an operator statement). #16 amended. **Nothing retired.**

## 4. Still estimated, not measured

Acquisition cost (every product today), refund rate (every product today), duties on cross-border parcels (regional rate table), the optimistic/pessimistic band itself, FX (static table). Supplier costs are *quoted*, not realised.

## 5. Gate checklist

- [x] `npm run lint && npm run typecheck && npm test && npm run build` — green (see phase-3 report for the final full `production-check` run)
- [x] `cpaSource: 'assumed'` cannot be auto-published
- [x] 15%-pass / 40%-fail product is flagged, not silently published
- [x] `canPublish` rejects when expected contribution < `minMarginPct`
- [x] `/admin/economics` renders and exports with measured/estimated markers
- [x] `LIMITATIONS.md` states CPA is assumed until real campaign data exists (#17)

## 6. Decisions worth a second look

- `minMarginPct` (0.20) and `assumedAdCostPct` (0.20) are **unchanged**. The gate now ignores `assumedAdCostPct` for the publish decision and uses `cacScenarios.expected` (0.26). Supplier *ranking/pricing* still use `assumedAdCostPct` for the assumed case, so a price can sit at the margin floor yet fail the (stricter) expected-case gate — that is the system working, and the sheet shows it.
- `PUT /admin/settings/pricing` can still lower `minMarginPct` or `cacScenarios` for an authenticated admin (audited). Nothing in code does it.
- The seed (dev only) passes `humanApproved: true` so the demo catalogue still publishes; production starts empty.
