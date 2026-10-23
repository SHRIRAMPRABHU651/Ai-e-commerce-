# Phase 1 report — minimum live path

**Status: NOT COMPLETE — blocked on external accounts. Nothing in this phase is claimed as verified.**
Date: 2026-10-23 · Branch `claude/stoic-pascal-xk21ky`

## What was claimed before, what is proven now

| Claim | Before | Now | Artifact |
|---|---|---|---|
| CJ catalog / price / order / tracking against a real account | unverified | **still unverified** | none — no CJ credentials exist in this environment |
| Stripe/Razorpay: success, decline, duplicate webhook, out-of-order, refunds, dispute | unverified | **still unverified against the real provider** | none — no sandbox keys |
| S3Storage against a real bucket | unverified | **still unverified** | none — no AWS credentials |
| `terraform apply` / `destroy` | unapplied | **still unapplied**; `terraform` binary is not installed here, so not even `validate` ran locally | CI job `terraform` runs `init`/`validate`/`fmt`; `production-check` now FAILS on CI when the binary is missing and prints an explicit `SKIPPED … NOT validated` locally |
| Failure matrix | 7 + 2 cases | **+5 cases, against the IN-REPO mock supplier/payment adapters** (not sandbox) | `tests/integration/failure-matrix.test.ts` |

## Failure-matrix additions (mock adapters — they prove Orvia's handling, not any vendor's behaviour)

1. Payment captured, every supplier rejects → order held with exception, zero supplier orders, retries exhausted, a refund settles the ledger and reconciliation is clean.
   **Finding:** there is no *automatic* refund path. An operator must refund. The test pins today's behaviour so adding auto-refund is a deliberate change. Not built (Phase 1.5 asked for an "automatic refund path"; that is new customer-money behaviour and needs a decision, not a guess).
2. Supplier ships, customer fully refunded → **new** reconciliation finding `refunded_after_shipment` (raised once, deduplicated). This was a real gap.
3. Partial fulfilment (one line sourceable, one not) → `fulfillment.state = partial`, exception open, a forced retry never duplicates the shipped line.
4. Webhook replay: identical delivery → `duplicate` (exactly one PAID transition); re-signed delivery with a new event id outside the timestamp tolerance → `WebhookSignatureError`.
5. Currency mismatch between provider payment and order → `rejected`, order not paid, no shipment, one `PAYMENT_FAILURE` exception.

## `LIMITATIONS.md` entries retired

None. #1, #4, #6, #13 remain exactly as written; their preconditions (real sandbox runs, a real bucket, an applied Terraform plan) did not happen.

## Still estimated rather than measured

Everything in Phase 0's list (see phase-0 report) plus every supplier/payment/storage payload shape.

## Gate checklist

- [ ] `npm run verify:staging` green against real sandboxes — **deferred: no credentials**
- [ ] Transcripts under `docs/evidence/` — **deferred: nothing to transcribe**
- [ ] Terraform applied and destroyed once — **deferred: no AWS account, no binary**
- [x] Failure matrix extended and green (mock adapters; sandbox variant deferred)
- [ ] `LIMITATIONS.md` #1/#4/#6/#13 retired — **deferred**

## What the operator must do to finish this phase

1. Put CJ (or chosen supplier) sandbox credentials and Stripe test keys in `.env`; run `npm run verify:staging`; commit the redacted transcripts under `docs/evidence/phase-1/`.
2. For each transcript, diff the real payload against `packages/suppliers/src/cj.ts` and fix the mapping — do not add a silent fallback.
3. `terraform apply` to a throwaway account, commit the plan output, `terraform destroy`.
