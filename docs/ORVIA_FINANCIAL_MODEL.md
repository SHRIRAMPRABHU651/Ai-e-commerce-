# ORVIA financial model

What the finance workstream computes, how, and where it stops. Status words: **implemented** (code + unit tests), **partially implemented**, **requires external credentials**, **planned**. Admin UI: `/admin/finance` (`finance:read` to view, `finance:write` to change). API: `/api/v1/admin/finance/*`.

## 1. Definitions (never mix these)

| Term | Definition | Where |
|---|---|---|
| **GMV** | Sum of what customers were charged on paid orders: incl. tax and shipping, after discounts. | Overview tile |
| **Net sales** | Ex-tax revenue after refunds (ex-tax part) and recorded chargebacks. | Overview, ledger totals |
| **Gross profit** | Net revenue of cost-known orders − supplier product cost. | Overview |
| **Contribution** | Selling price (ex-tax, after discount) − supplier cost − shipping − payment fees − duties/taxes borne by Orvia − acquisition cost − refund reserve − chargeback reserve − customer-service cost − other variable costs. | Overview, P&L |
| **Net profit (estimate)** | Contribution − operating expenses. Always an ESTIMATE: opex is an assumption the admin sets (`monthlyOpex`). | P&L |

Sales tax collected is a liability, not revenue. "Refund reserve" in the aggregate view is the **actual** refunds issued so far (recent orders may still be refunded); the per-order engine `computeContribution` takes an estimated reserve as input.

### Provenance on every figure
`actual` (measured / quoted / set, the economics engine's labels), `mixed`, `estimated` (rests on an assumption), `unavailable` (not enough data: value is `null`, never a guess). Cost-based figures only cover **cost-known orders** (a supplier order has been placed); the coverage is shown. Customer-service and other-variable costs are admin assumptions (default 0). Chargebacks are an estimate until at least one is recorded in the ledger.

CAC = platform-reported ad spend ÷ first-time customers in range (blended; organic buyers are in the divisor, so it can **understate** true paid CAC). Falls back to the measured-CPA store; otherwise `unavailable`. Advertising contribution and ROAS use platform-reported, imperfectly attributed data.

## 2. Ledger (implemented)

Append-only double-entry journal, collection `finance_ledger` (`FinanceLedgerEntry`).

* One document = one balanced journal in one currency: `sum(debits) = sum(credits)`, integer minor units, enforced by `finalizeJournal` before insert.
* **Idempotency**: unique `idempotencyKey`, deterministic from the business object (`order_paid:<orderId>`, `refund:<refundId>`, `supplier_cost:<shipmentId>`, `ad_spend:<metricId>`, …). Reposting is a no-op.
* **Immutable**: schema rejects updates/deletes/replaces; corrections are reversal entries (`rev:<key>`). Cancelled/failed supplier orders get `supplier_cost_reversal:<shipmentId>`.
* **FX snapshot** per entry (`fx.perUsd`, source, asOf, `basis`): `posting_time`, or `backfill_current_rate` for history rebuilt later (historic rates are not available, so backfilled entries are labelled).

Accounts: `cash`, `psp_receivable`, `psp_reserve`, `revenue_product`, `revenue_shipping`, `discounts` (contra), `refunds` (contra), `chargebacks` (contra), `tax_payable`, `cogs_product`, `shipping_cost`, `duties_cost`, `payment_fees`, `supplier_payable`, `ad_spend`, `other_variable`.

| Event | Debit | Credit |
|---|---|---|
| Order paid | psp_receivable (total), discounts | revenue_product, revenue_shipping, tax_payable |
| Payment fee | payment_fees | psp_receivable |
| Supplier order | cogs_product, shipping_cost, duties_cost | supplier_payable |
| Refund | refunds (ex-tax), tax_payable (proportional) | psp_receivable |
| Chargeback | chargebacks, payment_fees | psp_receivable |
| PSP payout | cash | psp_receivable |
| Supplier payment | supplier_payable | cash |
| Ad spend | ad_spend | cash |
| Reserve hold / release | psp_reserve / psp_receivable | psp_receivable / psp_reserve |

**Sync** (`ledger_sync`, every 10 min, also *Sync now*): reads paid non-demo orders (by `createdAt` watermark + a 3-day sweep for late payments), shipments and refunds (by `updatedAt`), and ad metrics older than 2 days (platforms restate recent days; later restatements are **not** posted: the reconciliation shows drift). It never writes to orders/payments/refunds/shipments. **Backfill** resets the watermarks and replays; it is idempotent. Chargebacks, PSP payouts, supplier payments and manual ad spend have no source collection yet, so a person records them (`POST /admin/finance/ledger/entries`, audited, idempotent on `id`). **Partially implemented**: no PSP payout/dispute webhooks feed the ledger yet (planned; requires provider reports/credentials).

**Reconciliation** (`/admin/finance` → Reconciliation, job `ledger_reconciliation` daily): read-only comparison of ledger vs Orders, Refunds, Shipments and ad metrics (missing entries, amount mismatches, negative receivable/payable). It extends the existing `runReconciliation` (which is unchanged). It cannot verify payouts against a PSP/bank statement because none is available to this system.

## 3. FX policy (implemented; live adapters unverified)

* `FxProvider` interface; adapters: `frankfurter` (free, no key, ECB reference rates, default in production), `exchangerate_api` (keyed, `FX_API_KEY`), `static` (the old `DEFAULT_FX` table, **dev/test only**). The HTTP adapters follow the providers' public docs and **have not been run against the live services from this repo**.
* Env: `FX_PROVIDER`, `FX_API_URL`, `FX_API_KEY`, `FX_WARN_HOURS` (30), `FX_HARD_LIMIT_HOURS` (96), `FX_REFRESH_MINUTES`. Production config **refuses** `FX_PROVIDER=static` and a keyed provider without a key.
* Rates are stored (`finance_fx_rates`: rates per USD, source, provider date, `fetchedAt`). Job `fx_refresh` every 6 h; manual refresh in the FX tab (audited). A refresh that moves any rate > 15 % is rejected unless confirmed.
* Staleness: fresh < warn < expired. Warn only flags. In production, `liveFxTable(ctx, { forPricing: true })` / `fxSnapshotForPricing` **throw `FX_RATES_EXPIRED`** when rates are expired, unless an admin sets an audited override (max 24 h, reason ≥ 10 chars).
* Every conversion returns `{ amount, rate, source, asOf, stale }` (`convertFx`, `convertWithSnapshot`). `convertMinor(minor, from, to, fx)` is unchanged and keeps working; pass it `await liveFxTable(ctx)`.
* **Wired**: `economics.ts` (`resolveCpa`), all finance reporting, and (merge integration) `orders.ts` (fraud/refund USD value, supplier cost conversion), `offers.ts`, `reporting.ts` and the Delivery Rescue engine now read `await liveFxTable(ctx)`. **Still on the static table** (`settings.ops.fx`): `pricing.ts`, `adsService.ts`, `importer.ts`, `market/index.ts` (analysis/estimation paths, not checkout totals; checkout prices come from per-country price books, not FX conversion). Order-pricing paths do not yet pass `{ forPricing: true }`, so the production hard-limit refusal applies only where a caller opts in.

Dashboards convert each order at the **current** stored rate, not the rate at the time of sale; the banner says so. Ledger entries carry their own snapshot.

## 4. Cash flow (implemented, deliberately narrow)

Forecast = already-paid orders not yet settled (paid date + configured PSP delay per provider) − recorded supplier payables at their due date (FIFO against recorded supplier payments, terms from settings) − refund/chargeback reserve on those receipts (measured refund rate once ≥ `minOrdersForMeasured` orders, otherwise the setting, labelled) − PSP rolling reserve − trailing 14-day average ad spend − monthly opex assumption. **Future sales are not forecast.** Opening cash is a number the admin enters; the ledger cash account only reflects payouts and supplier payments someone recorded and is not a bank balance.

## 5. Objective model (₹38 crore) (implemented)

`scenarioModel(assumptions)` is a pure function (INR major units). The **target is an input** (`targetAmountInr`, basis `net_sales` or `gmv`, horizon months). Per scenario it derives: net price (AOV ÷ (1+tax)), refunded revenue, chargeback loss, landed cost (net of the share recovered on refunds), payment fee, acquisition cost per order (CAC × new-customer share), customer-service and other variable cost → **contribution per order**; then orders required (total, per day), sessions/day (conversion), new customers, GMV vs net sales, ad spend, opex, **net profit**, break-even orders/month, break-even CAC, and **working capital** at the required run-rate:

* supplier funding = orders/day × effective landed cost × max(0, settlement days − supplier payment lead days)
* ad funding = ad spend/day × (ad lead days + settlement days)
* reserve held = orders/day × AOV × reserve % × hold days
* refund/chargeback buffer = 30 days of refund + chargeback outflow (a modelling constant)

Verdicts: `consistent` (reachable *if the assumptions hold*), `needs_funding`, `exceeds_capacity`, `loss_making`, `not_reachable` (contribution per order ≤ 0: scaling burns cash). Sensitivity: CAC, conversion (through CAC), refund rate.

### How to read it
1. The model never says the target **will** be reached. "consistent" only means the arithmetic closes under the assumptions.
2. **Defaults are cautious placeholders, not forecasts**, all flagged "replace with measured data". The conservative placeholder set loses money per order and returns `not_reachable` by design; the base case has a thin margin; none exceeds a 35 % contribution margin (unit-tested).
3. With ≥ `minOrdersForMeasured` (30) paid orders in the last 90 days, measured AOV, refund rate, CAC, repeat share, and (with enough cost-known orders) landed-cost and fee shares replace placeholders in the **base** case; conservative is kept no better, aggressive no worse, than measured. Admin-entered values are never overwritten. Provenance (`placeholder` / `admin` / `measured`) is shown per field.
4. Edit assumptions in the UI (audited, `finance:write`); `maxOrdersPerDay`, `maxMonthlyAdSpend`, `availableWorkingCapital` turn on the capacity/funding checks. Leave them empty and those checks are skipped (and the output says so).

### Limits
Steady-state, not a month-by-month ramp (the ramp needs less working capital but loses money earlier); no seasonality; one blended AOV/CAC for all markets and categories; chargeback fees and returns shipping are not separate inputs; INR conversion of measured data uses the current rate; tax modelled as a single embedded rate.

## 6. Other limits
* Order costs are only known after the supplier order exists; profitability excludes the rest and says so.
* Supplier cost-change alerts compare landed cost actually paid per unit with `market.landedCost` on the product (the quote the price was set from); a very recent re-quote can mask drift.
* Dashboards read up to 5,000 orders per range (truncation is flagged); cohorts up to 20,000.
* Integration tests (`tests/integration/finance.test.ts`) were written but **not executed** in the authoring sandbox (no MongoDB); unit tests (`tests/unit/finance.test.ts`, 43) pass.
