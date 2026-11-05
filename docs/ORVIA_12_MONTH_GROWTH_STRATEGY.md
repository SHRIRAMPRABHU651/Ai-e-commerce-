# ORVIA 12-month execution roadmap

A plan tied to the financial model (`docs/ORVIA_FINANCIAL_MODEL.md`, `/admin/finance` → ₹38 crore model). It does not assume the ₹38 crore objective is achievable. Whether it is depends on measured unit economics that do not exist yet. Every gate below is a **measured** condition read from `/admin/finance`; if a gate is not met, the correct action is to hold or cut spend, not to relax the gate.

## Ground rules
1. **No spend scaling on assumptions.** Paid acquisition cost is `ASSUMED` until real campaign data exists (LIMITATIONS #17). Measured means ≥ the minimum sample in settings (`minOrdersForMeasured`, default 30 orders).
2. **Contribution per order, after acquisition, must be positive on measured data** before budgets increase. GMV growth with negative contribution is not progress.
3. **Trust before volume**: safety/spec claims are verified or omitted; delivery promises come from real supplier data; support and refunds are staffed before demand is bought.
4. **Cash is the binding constraint.** Working capital need (model output) must be covered by cash on hand *before* the volume that needs it.
5. Keep the target honest: re-run the model monthly with measured inputs and write down the verdict it gives (`consistent`, `needs_funding`, `loss_making`, `not_reachable`). If the answer is `not_reachable`, revise the target or the business model; do not edit assumptions to make it pass.

## Sequence of markets and categories
Order is chosen for low safety/compliance burden, supplier availability and repeat potential, not for the biggest revenue.

1. **Pet accessories and enrichment** (months 1–4): low regulatory load, strong repeat/consumable adjacency, content-friendly. Avoid anything ingestible or health-claiming without verified documentation.
2. **Home and desk convenience** (months 4–7): broad demand, price-comparable (watch competitor price and shipping time), electrical items only with verified certifications for the destination.
3. **Learning and activity products** (months 7–10): only products whose **safety information is verified** (age grading, standards, certificates held on the product record); no unverified "non-toxic/eco" claims (the organic-claims gate enforces this). Children's products carry the highest verification burden: add them as the evidence process proves out.
4. **Personalized gifts** (month 10+): needs a supplier with reliable production lead times and a returns policy for made-to-order goods; refunds on personalized items are harder to recover from suppliers, so the model's refund-cost recovery input must be set low.

Markets: start in the single market where supplier delivery times and payment settlement are best understood and operations can answer support in business hours; add the second only after the first meets the month-6 gate; the third after month 9. Country price books (`/admin/finance` → Costs & price books) and shipping times per market decide order, not ambition.

## Monthly gates
Each gate lists what must be true **at the end of the month** to proceed. "Measured" = shown as `actual` on `/admin/finance`, not `placeholder`/`estimated`.

| Month | Focus | Gate to proceed |
|---|---|---|
| 1 | Plumbing and trust: payments live, ledger syncing, FX provider live (not static), suppliers verified, legal pages reviewed, support/returns process. | Ledger reconciliation shows no critical findings on test orders; FX status `fresh` with a real provider; export/legal attestations recorded; delivery times quoted from real supplier data. |
| 2 | First real orders, tiny budget (test spend only). | ≥ 30 paid orders **or** stop: do not infer anything from fewer. Delivery success and refund rate measured. No unresolved cost-change alerts. |
| 3 | Measure unit economics. | Measured AOV, landed cost %, refund rate and CAC all `actual`. Contribution per order after CAC **> 0** in the measured base case. If not: fix price, supplier, or channel; do not scale. |
| 4 | Category 1 repeatability. | Refund rate at or below the level the model needs; chargeback rate recorded; repeat-purchase rate measured over ≥ 60 days. Working capital need at 2× current volume is covered by cash. |
| 5–6 | Controlled scale of what works (≤ 2× monthly ad budget per step). | Each step: contribution after CAC still > 0 at the new spend; CAC not drifting up faster than 20 % from the previous month; cash-flow forecast lowest projected balance stays above zero with opex included. |
| 6 | Mid-year review. | Re-run the objective model on measured data and record the verdict. Decision: continue, add category 2/market 2, or reduce scope. Observed 3-month LTV available for the first cohorts. |
| 7–8 | Category 2. | New category meets the month-3 gate on its own data before it receives more than test budget. |
| 9 | Market 2 / category 3 evidence. | Same gate per market; delivery success and refund rate **per market** measured. |
| 10–11 | Category 3, gifts pilot. | Verified-safety coverage 100 % of listed items; personalization refund-recovery assumption validated by real supplier terms. |
| 12 | Full-year review. | Compare actual net sales and net profit with the model's three cases. Report the gap plainly. |

## What must be true before scaling spend
* ≥ 30 paid orders in the channel being scaled, measured CAC (not assumed), and contribution per order after CAC > 0 with margin to spare (break-even CAC at least ~20 % above current CAC, shown in the model).
* Refund rate and delivery success measured, not estimated; support backlog under control.
* Reconciliation clean for the last full month; supplier cost-change alerts reviewed.
* Cash: the model's working-capital need at the *next* spend level (supplier funding + ad lead + reserves + refund buffer) is available, **plus** one month of opex. If PSP settlement is slow or a rolling reserve exists, the need rises: use the real settlement days in settings.

## Working capital
Dropship removes inventory but not funding: suppliers are typically paid at order time while the PSP pays out days later, ad spend precedes orders, and PSPs may hold a rolling reserve. The model's working-capital block quantifies these four items at the target run-rate. Planning rule: hold cash ≥ model need at the current run-rate × 1.5 until a month of settled-payout history exists. Where the model reports `needs_funding`, either reduce the pace, negotiate supplier terms/PSP payout speed, or arrange financing *before* scaling; do not scale into a cash gap.

## Risks (honest list)
* **Unit economics may not work.** The conservative placeholder case loses money per order; the base placeholder is thin. Real CAC for new cross-border brands is often above placeholder levels. If measured CAC exceeds break-even CAC, no amount of volume fixes it.
* **Refund and chargeback exposure** is higher for cross-border delivery times and personalized goods; supplier-side recovery is uncertain.
* **Supplier dependence**: cost changes, stock-outs, and delivery slippage hit margin and trust directly; alerts exist but need a person to act.
* **Platform risk**: ad accounts, PSP reserves or account reviews can pause revenue.
* **Compliance**: export/destination obligations and product safety are operator responsibilities that this software only gates (it cannot decide them).
* **Data limits**: attribution is platform-reported; FX adapters, PSP payout feeds and ad connectors are unverified against live accounts; the ledger is only as complete as what is posted.
* **The ₹38 crore figure** may be unreachable in 12 months at any sensible spend; the model will say so if the measured numbers imply it. Treat a `not_reachable`/`loss_making` verdict as information to act on, not as an error.

## Cadence
Weekly: reconciliation, cost alerts, FX freshness, cash-flow lowest balance. Monthly: gate review against this table, objective model re-run, record the verdict and any assumption changes (audited in settings). Quarterly: category/market sequence decision.
