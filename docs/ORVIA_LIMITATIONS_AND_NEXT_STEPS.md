# ORVIA limitations and next steps

Consolidated, honest. It merges the "remaining gaps" of each workstream document, the baseline [audit](ORVIA_CURRENT_STATE_AUDIT.md), [LIMITATIONS.md](LIMITATIONS.md) and the [test report](ORVIA_TEST_REPORT.md). Where this file and a workstream document disagree, the discrepancy is stated rather than resolved silently.

## 1. What is not verified, and why

| Not verified | Why | Consequence |
|---|---|---|
| Any live provider: Stripe, Razorpay, CJ, any real supplier, Meta/TikTok/Google (ads and events), GA4, Gemini, Resend, Twilio, S3 and a CDN, Frankfurter, ExchangeRate-API | No credentials or accounts were available; adapters were written from public documentation | Field mappings, auth headers, rate limits and error shapes may need fixes in staging |
| Mongo-backed integration tests (30 files, about 220 cases by static count) | The MongoDB binary download is blocked in the authoring sandbox; nothing was downloaded or worked around | Route, ownership, idempotency and database-index behaviour is untested here. CI (`mongo:7` service) is meant to run them |
| Playwright browser tests (6 spec files, 106 entries) | Needs the MongoDB binary and Chromium | Browser journeys, responsive and accessibility basics, supplier portal flow are unexecuted |
| Docker image builds | Not run in the build session (CI job `docker` builds them) | Image contents and health checks untested here |
| Terraform | `validate` and `fmt -check` ran once on a hosted runner (LIMITATIONS #4); never `plan` or `apply` | IAM, networking, cost, and the deploy workflow's interaction with task definitions are unverified |
| Load and performance | Scripts written (`load-scenarios.mjs`, `load-jobs.ts`); needs MongoDB | No p95, throughput or capacity figure exists for the new endpoints. The only measurement is the older 3-endpoint baseline in `PERFORMANCE.md` |
| Backups and restore, monitoring, alerting | Not exercised | Recovery time and alert quality unknown |
| Statistical behaviour of trust scores, delivery bands, Fair Deal, Customer Advocate metrics on real data | No real transactions exist | Thresholds are design choices, not calibrated |
| Browser pixels, Merchant Center and Commerce Manager acceptance of feeds | Needs live accounts | |
| Screen-reader and visual quality | No axe or visual-regression run | |

Executed in the build session ([test report](ORVIA_TEST_REPORT.md)): typecheck, lint, 463 DB-less unit tests passed, production build, boot check, Playwright spec discovery, a production-only `npm audit` (0 high). The test report inventories 20 unit files; three more exist (`agents-framework`, `agents-logic`, `design-contrast`) that are not in that total, so the current unit total is not stated here.

## 2. External credentials and approvals

Exact list per provider. Nothing is verified live. Use sandbox or test credentials in staging first.

| Provider | What to obtain | Environment variables | Other external step |
|---|---|---|---|
| MongoDB | Atlas cluster (or any MongoDB 7), network access from API and worker | `MONGODB_URI` | enable continuous backup; run `npm run migrate` |
| Stripe (US, CA) | Account, secret and publishable keys, webhook signing secret | `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`, `PAYMENT_MODE=live` | register `https://<domain>/api/v1/webhooks/payments/stripe` for `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.amount_capturable_updated`, `charge.refund.updated`, `refund.updated`, `charge.dispute.created|updated|closed|funds_withdrawn|funds_reinstated`; tax setup (Stripe Tax or equivalent) |
| Razorpay (IN) | Key id and secret, webhook secret; account settings for auto-capture | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | register `.../webhooks/payments/razorpay` including `payment.dispute.*` |
| Suppliers | At least one real supplier agreement; CJ API key and secret if using `cj` (per-supplier credentials are stored encrypted) | `SUPPLIER_MODE=live`, `CJ_API_KEY`, `CJ_API_SECRET` (fallback), `ENCRYPTION_KEY`, optional `SUPPLIER_ENFORCE_VERIFICATION` | pass the verification checklist with evidence (sandbox or acknowledged live test order, cancellation, tracking probes) |
| FX | None for `frankfurter`; key for `exchangerate_api` | `FX_PROVIDER`, `FX_API_URL`, `FX_API_KEY`, `FX_WARN_HOURS`, `FX_HARD_LIMIT_HOURS`, `FX_REFRESH_MINUTES` | production refuses `FX_PROVIDER=static` |
| Meta | Pixel id, Conversions API token (Events Manager), Marketing API token for ads, ad account and page | `META_PIXEL_ID`, `META_CAPI_ACCESS_TOKEN`, `META_CAPI_TEST_EVENT_CODE`, `META_GRAPH_VERSION`, `META_ACCESS_TOKEN`, `META_APP_ID`, `META_APP_SECRET`, `META_AD_ACCOUNT_ID`, `META_PAGE_ID`, `NEXT_PUBLIC_META_PIXEL_ID` | ad account approval; catalogue feed upload |
| TikTok | Pixel code, Events API token, Marketing API token and advertiser id | `TIKTOK_PIXEL_CODE`, `TIKTOK_EVENTS_ACCESS_TOKEN`, `TIKTOK_EVENTS_TEST_CODE`, `TIKTOK_ACCESS_TOKEN`, `TIKTOK_ADVERTISER_ID`, `NEXT_PUBLIC_TIKTOK_PIXEL_ID` | |
| Google | GA4 measurement id and API secret; Ads OAuth client, refresh token, developer token, customer id, purchase conversion action | `GA4_MEASUREMENT_ID`, `GA4_API_SECRET`, `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_REFRESH_TOKEN`, `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CUSTOMER_ID`, `GOOGLE_ADS_PURCHASE_CONVERSION_ACTION_ID`, `GOOGLE_ADS_LOGIN_CUSTOMER_ID`, `GOOGLE_ADS_API_VERSION`, `NEXT_PUBLIC_GA4_MEASUREMENT_ID` | Merchant Center feed registration; Ads developer token approval |
| Events switch | | `EVENTS_MODE=live`, `EVENTS_PROVIDERS=meta,tiktok,ga4,google_ads` | production refuses `EVENTS_MODE=log` while providers are set or credentials are missing |
| Ads mode | | `ADS_MODE=live` | production refuses `mock` |
| Gemini | API key (Google AI) | `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_TIMEOUT_MS` | needed for image search, AI refinement, model wording; absent means deterministic templates |
| Email | Resend API key and verified sending domain | `NOTIFY_MODE=live`, `EMAIL_PROVIDER_KEY`, `EMAIL_FROM` | SPF and DKIM; marketing-email legal requirements |
| SMS | Twilio account | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | |
| Storage and CDN | Private S3-compatible bucket, https CDN | `OBJECT_STORAGE_PROVIDER=s3`, `OBJECT_STORAGE_BUCKET`, `OBJECT_STORAGE_REGION`, `OBJECT_STORAGE_ENDPOINT`, `OBJECT_STORAGE_ACCESS_KEY`, `OBJECT_STORAGE_SECRET`, `CDN_BASE_URL` | keep `suppliernet/docs/` and `aftersales/evidence/` private; the CDN is not provisioned by Terraform |
| Security | Random secrets | `JWT_SECRET`, `ENCRYPTION_KEY`, `METRICS_TOKEN`, `COOKIE_SECURE` | rotate on staff offboarding |
| Legal | Counsel review of terms, privacy, returns, shipping; tax registrations; export and destination advice per market | `LEGAL_REVIEW_REQUIRED` (keep true until reviewed) | export attestation per destination via the API (no admin UI) |

## 3. Remaining incomplete features and their blockers

| Area | Gap | Blocker |
|---|---|---|
| Payments | No live verification; Razorpay order creation not idempotent at the provider (baseline); Stripe `getPayment` maps `canceled` to pending (baseline, file not re-checked) | credentials |
| Payments | PSP payout and bank reconciliation | no payout feed |
| After-sales | No carrier return-label adapter | carrier credentials, vendor choice |
| After-sales | Replacement and exchange supplier orders are manual; no customer variant picker; one open return per order; multi-supplier orders use the first item's supplier for instructions | design work |
| After-sales | Dispute file evidence not uploaded to Stripe/Razorpay; text only | provider API verification |
| After-sales | Supplier claims have no dedicated create form | UI work |
| Rescue | No LLM explanation (`AIService` has no generic text method); replacement orders keep the original line item; a one-line refund in a multi-line order excludes shipping and tax; delay measured against supplier ETA because the checkout estimate is not stored on orders | design work |
| Rescue | Real supplier cancel and reorder behaviour | live supplier |
| TrustGraph | Passport has no price history input wired (Price Guard has it); manufacturer identity needs evidence; compliance screening is keyword rules; on-time uses supplier ETAs; return attribution depends on SKU data | data accumulation |
| Customer 360 | Reorder reminders; consent enforced inside existing senders (cart recovery); bounce and complaint suppression feed; legal-hold reasons; deletion confirmation email; automatic anonymization; staff UI to edit notes; loyalty and rescue read through defensive raw-collection readers whose names must match | design work |
| Find | Neural embeddings (interface only); 3,000-product catalogue cache per country; image search and AI refinement need Gemini | credentials, scale |
| Finance | `adsService.ts`, `importer.ts`, `pricing.ts`, `market/index.ts` still read the static FX table; dashboards convert at the current rate; chargeback fees and returns shipping are not separate model inputs; steady-state model, no seasonality, blended AOV and CAC; reads up to 5,000 orders per range | one-line swaps in files owned by other workstreams |
| Creators | Payouts recorded, money moves manually; no automated KYC, tax forms or provider dispute feed; creator emails not sent; avatars not moderated beyond technical checks; clawbacks detected by hourly scan | provider, legal |
| Marketing | Events: loyalty events are emitted only if code calls `emitMarketingEvent`; email opens, `List-Unsubscribe`, per-country URLs and hreflang, multi-touch attribution not built; experiment visitor id is the session id | design work |
| Ads | TikTok and Google create campaign only (no creative); Meta full chain paused; Pixel setup manual | live accounts |
| Supplier network | No named-vendor adapters; no image hashing; cancellations in SLA not attributed to initiator; no new-order email to suppliers; no profile self-edit; no multi-currency payout netting; some admin inputs use simple prompts | design work, vendor choice |
| AI agents | Real token usage not returned by the provider layer; regex intent detection; guest can open many conversations (per-IP route limit applies); replacement approval records a decision only; confirmation tokens live in tab memory | provider API |
| Design | No axe or visual regression; mobile 16px field font not global; homepage creator and supplier-trust sections absent (no public endpoint) | work |
| Admin | No UI for staff users, export attestation, manual offers and fulfilment, sourcing settings, competitor prices, market match, sessions | UI work |
| Security | No MFA, no idle session timeout; the global audit log is not immutable and swallows write failures (baseline); worker `/metrics` is open when `METRICS_TOKEN` is unset | design work |
| Tax | Estimates only; `TaxProvider` is not used by checkout | provider choice |
| Search | In-process, 5,000-document cap | scale |
| Deployment | `deploy.yml` force-redeploys ECS without registering a task definition for the new tag and its migrations step only echoes (baseline; file unchanged); no remote Terraform backend, no WAF | verification |

## 4. Baseline audit findings: status

The audit at commit `48ac745` listed six highest-severity findings. By `git log` and diff, since then: unverified accounts can no longer claim guest orders by email; exception-queue actions enforce refund permissions; a late payment on a cancelled order is recorded and escalated; the webhook event claim is crash-safe; the recommendations query fix and the ad-test human-approval fix were committed. **Not confirmed fixed** (files unchanged since the baseline: `returns.ts`, `orderStatus.ts`, `support.ts`): `decideReturn('refund')` marking a return refunded while the refund awaits approval, derived order status for refunded or cancelled orders, support-ticket ownership on `ticketId`. Not re-checked: client checkout idempotency key not bound to cart and user, promotion redemption race, concurrent partial refunds. `TRUST_PROXY` is still a boolean.

## 5. Risks

| Risk | Detail |
|---|---|
| Unit economics | CPA is assumed until real campaign data exists, so no product can auto-publish and the model's conservative placeholder case loses money per order. The stated revenue objective may be unreachable at any sensible spend; the finance model reports that rather than hiding it |
| Cash | Suppliers are typically paid before the PSP settles; ad spend precedes orders; PSPs may hold a rolling reserve |
| Disputes and refunds | Cross-border delivery times and personalised goods raise exposure; supplier recovery is uncertain |
| Supplier dependence | Cost changes, stock-outs, ETA slippage; alerts need a person |
| Platform | Ad accounts, PSP reviews and reserves can pause revenue |
| Compliance | Export, destination, product-safety, tax, consumer-law and advertising obligations are the operator's; software only gates. Attestation does not validate the advice |
| Data quality | Attribution is platform-reported; trust scores are only as good as recorded shipments, returns and evidence |
| Unexecuted tests | Defects in the Mongo-backed code paths may exist until CI runs them |
| Operations | Alert quality, backup restore and on-call process are untested |

## 6. Prioritized next steps

1. Run `npm run test:coverage` in CI (Mongo service) and fix what fails; run Playwright (`npm run e2e`) and fix what fails.
2. Stand up staging with `PAYMENT_MODE=live` on test keys; run pay, decline, refund, replayed webhook, authorize and capture, and a simulated dispute; register all webhook events; `npm run verify:staging`.
3. Onboard one real supplier through the verification checklist and place a sandbox or acknowledged test order; confirm tracking, cancellation and stock freshness.
4. Verify the FX provider live; finish the remaining static-FX swaps; confirm the ledger reconciles on test orders.
5. Run load scenarios and job throughput against a staging stack; record numbers in `PERFORMANCE.md`; adjust Atlas and API sizing.
6. Backups: enable Atlas PITR, perform a restore drill, set alerts on `/ready`, 5xx, queue depth and dead letters.
7. Legal and tax review per market; record export attestations; replace template legal pages.
8. Fix the open baseline items in section 4; add MFA and idle timeout; make the audit log append-only.
9. Add a UI for export attestation and staff user management (hard production prerequisites today are API-only).
10. Carrier label adapter; automatic dispute file evidence; price-history input on the passport; search engine upgrade; named-vendor adapters as suppliers require.
11. Fix `deploy.yml` so the deployed task definition references the new image tag and migrations actually run.

## Before accepting real customer payments

Do not take real money until every box is ticked with evidence.

- [ ] Stripe and/or Razorpay **sandbox** test transactions end to end: success, decline, 3-D Secure where applicable, refund (full and partial), replayed webhook, lost webhook (confirm `payment_verification` recovers it).
- [ ] Webhook subscriptions registered and delivering, **including dispute and refund events** (`charge.dispute.*`, `charge.refund.updated`, `refund.updated`, `payment.dispute.*`); a simulated dispute reaches `/admin/returns` chargebacks.
- [ ] Live FX provider running (`FX_PROVIDER` not `static`), rates `fresh` in `/admin/finance`.
- [ ] Supplier verification complete for every supplier that can receive orders, with recorded evidence; a test order placed, tracked and (if possible) cancelled.
- [ ] Tax and legal review per market; legal pages reviewed; `LEGAL_REVIEW_REQUIRED` set false only after counsel sign-off.
- [ ] Export attestation recorded for every destination in `legal.exportAttestations`.
- [ ] Mongo-backed CI green on the release commit (`npm run test:coverage`).
- [ ] Playwright green on the release commit (`npm run e2e`).
- [ ] Load tests run against staging with measured p50/p95/p99 and error rates recorded.
- [ ] Backup and restore drill completed; recovery time noted.
- [ ] Monitoring and alerts live (readiness, 5xx, queue depth, dead letters, FX staleness, webhook failures); someone is on call.
- [ ] Secrets rotated from any development values; `METRICS_TOKEN` set; `ENCRYPTION_KEY` backed up separately; `COOKIE_SECURE=true`.
- [ ] Email domain verified (SPF, DKIM); transactional email tested; unsubscribe and consent flows tested.
- [ ] `/admin/launch-readiness` shows no blocking FAIL; `npm run production-check` passes on the release commit.
- [ ] Staging rehearsal of the full rollout, rollback included.
- [ ] Support and returns staffed before demand is bought.
