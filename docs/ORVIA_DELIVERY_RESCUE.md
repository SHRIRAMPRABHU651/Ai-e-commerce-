# ORVIA Delivery Rescue

Autonomous order recovery: detect a failing delivery, plan the safest recovery, ask the customer when terms change, execute idempotently, and leave a full audit trail. Area `rescue`, admin page `/admin/rescue`, permissions `rescue:read` / `rescue:write`.

Deterministic code decides everything (classification, options, money, authorization). AI never authorizes or triggers anything; the only AI slot is an optional `aiExplanation` text on a case, shown with an `ai suggested` label. **No LLM call is wired to fill it** (`AIService` has no generic text method); it stays empty until one is added.

## How it hooks in (no edits to `orders.ts`)
- Job `rescue_scan` (`RESCUE_SCHEDULES`, every 10 min, risk `high`) and `rescue_run_action`. The scan reads active orders (rotating `_id` cursor, bounded by `scanBatch`), their shipments and open exceptions, classifies each line, creates/updates cases, plans, expires consents and runs due actions.
- Existing functions called: `selectSupplierLive` (live quotes, health, destination), `providerFor` (cancel/create supplier orders), `refundOrder` (all money), `raiseException`/`resolveException`, `notify` (`custom` template, no change to `packages/notifications`), `recomputeOrderStatus`, `audit`.

## Case states
`detected` -> `planned` -> (`awaiting_customer` | `awaiting_staff` | auto) -> `executing` -> `monitoring` -> `resolved`; `escalated` (a human owns it, an exception is raised) and `closed` (staff). One ACTIVE case per order line (unique partial index on `dedupeKey`).

## Failure kinds (pure classifier, priority order)
supplier_cancellation, stock_shortage, supplier_acceptance_failure, failed_delivery, suspected_lost, carrier_exception, invalid_tracking, shipment_delay, unusual_delivery_pattern. One detection per line; lower-priority signals that also fired are kept as evidence. Every evidence item carries provenance (`verified`, `supplier_provided`, ...). Delay is measured against the supplier-provided ETA plus grace; when a shipment has no ETA a labelled **policy** fallback (default 21 days) is used and said so. `unusual_delivery_pattern` is advisory (internal only, never emailed to the customer, recommends a human).

## Options and impact
`continue_shipment`, `reorder_same_product_alt_supplier`, `offer_equivalent_replacement`, `offer_partial_refund`, `offer_full_refund`, `escalate_human`. Alternatives come from the existing live selection (approved suppliers serving the destination, healthy, not FAILING) and are re-ranked behind the `OfferRanker` interface (`setOfferRanker()`; default `local-v1`). The Fair Deal ranking from the trust workstream was not available here; swap it in with `setOfferRanker`. Suppliers in `ASSISTED`/`MANUAL` mode are listed as ineligible (staff would have to place those orders).
- **Same product** = another supplier linked to the same product (`SupplierProduct`). **Equivalent replacement** = a different product in the same category and similar price band; always a material change, never charged extra, and only offered when the same product is unavailable elsewhere. Equivalence is a category/price heuristic, not a verified spec match; the text tells the customer to check it suits them.
- Impact (order currency, minor units): `extraCost` (new landed cost minus recovered original; original cost is sunk if the parcel was dispatched), `refund`, `sunkCost`, `lostMargin`, `contributionDelta`, `exposure = max(0, extraCost) + refund`. The original cost basis is the real shipment cost, else the stored supplier quote (flagged), else unknown (flagged).
- Recommendation is a fixed ladder (continue for mild delays, then same-product reorder, replacement, partial refund, full refund, human).

## Authorization policy (stored in `system_settings` key `rescue_policy`, editable with `rescue:write`, audited)
Defaults (safe): detection on; **automatic execution off**; no pre-approved suppliers; per-case limit 1500 and per-day 10000 (USD cents); cost tolerance +25%; ETA worsening limit 3 days; partial refund default 20% (max 50%); consent valid 72 h; 4 attempts; 50 auto actions/day.
- Automatic: `continue_shipment` (no-op monitoring) always; `reorder_same_product_alt_supplier` only when automatic execution is on, the supplier is pre-approved, landed cost is within tolerance of a **known** original cost, no material change, within case/day limits and the daily action cap.
- Never automatic regardless of settings: refunds, replacements, escalation.
- Customer consent is required for any material change: different product, ETA worse than the threshold, any refund choice, cancelling the order. A full refund skips consent only when nothing can be fulfilled (then it needs staff approval). Staff cannot waive consent; approving a consent-gated option sends it to the customer.
- Staff approval is required when over limits, when the original parcel may still arrive (duplicate-risk acknowledgement), or when no automatic path applies.

## Consent
Signed HMAC token (key `ENCRYPTION_KEY` or `JWT_SECRET`), bound to case, round and recipient email, expiring (policy TTL), sent in the options email as `/orders/:orderNumber/recovery?token=...`. Re-planning bumps the round and invalidates old links. Each option has one consent row decided exactly once by an atomic `pending -> accepted|declined` update; the other options are revoked on accept. The terms the customer saw are stored with a hash. Access: signed-in owner, or valid token holder (guests with only an email are not accepted for decisions). Wrong/foreign access returns 404 (no ownership oracle); invalid or expired link returns 403. The page shows plain language only: no costs, margins or supplier names.

## Execution safeguards
- Idempotency: `RescueAction.idempotencyKey` unique (`rescue:<case>:<kind>:<hash(option)>`); supplier order key `rescue-ship:<order>:<line>:<case>` is both sent to the supplier and stored on the `Shipment` row (unique); refunds use a case-scoped key through `refundOrder`.
- Duplicate-order guard (pure, tested): refuses when this case already reordered, when a pending supplier order may exist at the supplier, when more than one active row exists, or when delivered; requires cancel-then-**confirmed**-cancel before reorder; refuses over a dispatched parcel unless staff acknowledge the risk; max 2 rescue reorders per line.
- Order of operations for a reorder: live re-quote (refuse if stock gone or price >15% above plan) -> guard -> cancel original (must be confirmed) -> pending row -> supplier call with idempotency key -> update costs/status/exceptions.
- Retries: exponential backoff (60 s doubling, cap 1 h), attempt cap from policy; non-retryable errors and exhaustion dead-letter: action `dead`, case `escalated`, an exception is raised in the existing queue (`dedupeKey rescue:<case>`), customer informed.
- Refunds only via `refundOrder` with its own approval limit; a refund waiting for approval keeps the action `waiting` (re-polled, 7-day timeout).
- Audit: immutable `rescue_timeline` (update/delete rejected at the ODM layer) with actor type (system/customer/staff), inputs, decisions and outputs, plus the global audit log for money/permission-relevant events.

## Customer messages
Detection, options offered, consent result, resolution, refund, escalation (via `notify` `custom`, deduped per case/stage/round).

## Admin and API
`/admin/rescue` (cases with filters and drilldown, options with computed impact and authorization reasons, approve/override/escalate/close/re-plan gated by `rescue:write`, KPIs, policy editor).
- Staff: `GET /api/v1/admin/rescue/cases`, `GET .../cases/:id`, `POST .../cases/:id/decision`, `GET .../kpis`, `GET|PUT .../policy`, `POST .../scan`.
- Customer: `GET /api/v1/orders/:orderNumber/recovery`, `POST .../recovery/decision`.

## KPIs (computed from real cases; "No data" when empty)
Detections by kind, auto-resolved %, average time to resolution, cost of recovery (actual extra cost + refunds, USD equivalent and per currency), consent acceptance rate with sample size.

## Limits
- Integration tests (`tests/integration/rescue.test.ts`) are written but were not run (no MongoDB in the sandbox); pure logic has 50 unit tests.
- The scan is polling-based; detection latency is up to the schedule interval plus tracking sync delay.
- Replacement orders keep the original order line; the replacement product is recorded on the shipment and case, not on the immutable order item.
- Full refund of one line in a multi-line order refunds the line value only (shipping/tax not apportioned).
- Order `EXCEPTION` status is only set when a case is escalated (existing `raiseException` behaviour).
- Supplier ETA is supplier-provided; the original checkout estimate is not stored on orders, so delay is measured against the shipment ETA or the policy fallback.
- Real supplier cancel/create behaviour depends on each provider adapter; verified only against the mock/fake providers' interface contract.
