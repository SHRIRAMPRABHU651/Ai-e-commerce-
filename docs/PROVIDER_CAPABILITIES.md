# Provider capabilities

Every provider reports what it can do and what has been *verified*. Statuses never conflate the two.

## Suppliers
`packages/suppliers/src/capabilities.ts` declares per-adapter capabilities (catalog, product, inventory, price, shipping quote, order, tracking, cancel, refund/return). A supplier's `fulfillmentMode` is `MANUAL`, `ASSISTED` or `AUTOMATED`; **AUTOMATED is refused** until the validation suite has passed for connection, catalog, product, inventory, price, shipping, order and tracking (within 30 days). Unsupported operations fall back to operator exceptions, never to guesses. Health state (`HEALTHY/DEGRADED/FAILING`) is tracked by a scheduled monitor; FAILING suppliers are excluded from new orders and in-flight orders fail over without duplicate fulfillment (partial unique shipment index).

## Ads
`GET /admin/ads/capabilities` returns per platform: capability matrix (SUPPORTED = implemented in code) and status `NOT_CONFIGURED | UNVERIFIED | VERIFIED | ERROR`. Only a successful live check yields VERIFIED. Conversion tracking (pixel/CAPI) is **not implemented**, so `canAutoSpend` is always false and AI ad actions remain proposals.

## Payments / notifications / tax
Stripe and Razorpay: webhook-verified, idempotent. Email/SMS: HTML escaped. Tax/duty: provider ports in `packages/shipping/src/tax.ts`; the bundled implementation is an *estimate* and is labelled as such.

## Adding a provider
Implement the interface, declare capabilities truthfully, add a fake-server test, register it, and run the validation suite in staging.
