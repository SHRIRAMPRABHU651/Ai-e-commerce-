# Payments

| Provider | Countries | Mode | Status |
|---|---|---|---|
| Mock | dev only | `PAYMENT_MODE=mock` | Delivers HMAC-signed webhooks through the same endpoint as live providers; supports failure/timeout simulation |
| Stripe (SDK) | US, CA | live | Payment Intents + webhook verification (`constructEvent`). **Not verified against a live/test Stripe account in this repo** |
| Razorpay (REST + HMAC) | IN | live | Orders API + signature verification (UPI, cards, netbanking, wallets). **Not verified against a Razorpay account in this repo** |

## Flow
1. `POST /checkout` recomputes totals server-side, runs the fraud score, creates the order (`PENDING_PAYMENT`) and a provider payment intent. Replaying the same `idempotencyKey` returns the same order/intent.
2. The browser completes payment with the provider's hosted/JS elements (card data never touches Orvia).
3. The provider calls `POST /api/v1/webhooks/payments/:provider`. We verify the signature on the raw body, dedupe by event id, **re-fetch the payment from the provider**, and only then atomically mark it `PAID` (a lost or forged webhook can't mark anything paid).
4. A `payment_verification` job (every 5 min) confirms stale unpaid orders directly with the provider, covering lost webhooks. Unpaid orders expire in housekeeping.
5. Paid orders enter fulfilment per the `order_fulfillment` automation mode.

Refunds: full/partial, idempotent, executed through the provider; refunds above the auto-approve limit (default $5,000 equivalent for admins; support/ops staff need approval for high-value refunds) become approval items. Returns follow a request → approve → refund flow within the country's return window.

## Going live
1. Create Stripe/Razorpay accounts; set keys + webhook secrets as secrets; register `https://<domain>/api/v1/webhooks/payments/stripe|razorpay`.
2. In staging with `PAYMENT_MODE=live` and **test keys**: place orders, fail a card, replay a webhook, refund. 
3. Only then switch to live keys. Tax: the app estimates tax for display/margin; use Stripe Tax/TaxJar for filing-grade tax.
