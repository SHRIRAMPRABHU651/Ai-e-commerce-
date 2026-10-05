# Operations

## Daily
1. **Overview** → today's orders, *net revenue* vs *contribution profit*, open exceptions, AI insights. Revenue is never labelled profit; orders awaiting supplier placement are flagged because their costs aren't yet known.
2. **Exceptions** → the human queue. Kinds: `FRAUD, CHARGEBACK, SAFETY, COMPLIANCE, HIGH_VALUE_REFUND, SUPPLIER_FAILURE, PAYMENT_FAILURE, SUSPICIOUS_ORDER, AUTHENTICITY, PRICE_CHANGE, NEGATIVE_MARGIN, TRACKING`. Each shows the AI's recommendation and one-click actions (approve/cancel/retry).
3. **Automation → Approvals** → proposals from ASSISTED automations (price changes, publishing, ad changes, promotions). Approve applies, reject records why.

## Automation center
Per-automation mode `OFF / ASSISTED / AUTOMATIC` with run history, plus schedule intervals/enable toggles and agent "run now". Production defaults: discovery, publishing, pricing, fulfilment, ads, promotions = ASSISTED; abandoned-cart = OFF; inventory, tracking, support, reports = AUTOMATIC. Move an automation to AUTOMATIC only after reviewing its proposals for a while.

## Guardrails (Settings)
Minimum margin, max discount, per-country minimum price and target profit/order, target ROAS, fraud thresholds, low-stock threshold, supplier price-spike alert, fulfilment retry attempts. No automated action can violate pricing guardrails.

## Product lifecycle
`DISCOVERED → IMPORTED → REVIEW → READY → PUBLISHED → TESTING → WINNER → SCALING → PAUSED → ARCHIVED` (+ `BANNED` for compliance blocks). Opportunity score blends demand, margin, competition, shipping time, supplier reliability, compliance and (when available) review/ad performance. Market-intel signals in dev come from a mock source — **there is no real competitor/trend data provider wired in**; plug one in via `discovery.ts` before relying on scores for real buying decisions.

## Observability
JSON logs (pino) with request ids and channels (`app, order, payment, supplier, ads, ai`); Prometheus metrics at `/metrics`; `/live` `/ready` `/health`; audit log UI; dead-letter jobs become exceptions.

## Launch checklist
- [ ] Staging soak with live **sandbox** credentials for supplier, Stripe/Razorpay, one ad platform; place, fail, refund, replay-webhook scenarios.
- [ ] Real legal pages (terms, privacy, returns, shipping) reviewed by counsel for each country; the app ships templates.
- [ ] Tax setup (Stripe Tax/TaxJar), customs/duty policy and import registrations for IN/CA/US as applicable.
- [ ] Email/SMS provider domain verification (SPF/DKIM) and consent flows.
- [ ] Rotate all seed/demo credentials; create real staff users; remove `isDemo` data (production never seeds).
- [ ] Alarms subscribed; backup restore tested; on-call owner for the exception queue.
- [ ] `npm run production-check` passes on the release commit.
