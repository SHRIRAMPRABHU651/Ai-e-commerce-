# Architecture

```
 Browser ──► Next.js (storefront + /admin) ──rewrite /api/v1/*──► Fastify API ──► MongoDB
                      │ server components (cookie-forwarded)          │  ▲          Redis (optional: rate limits, cache)
                      ▼                                               ▼  │
              first-party cookies                              Mongo-backed durable JobQueue ◄── Worker (queue + scheduler)
                                                                      │
        provider interfaces: SupplierProvider · PaymentProvider · AdProvider · AIProvider · NotificationProvider
                    mock (dev/test only)  |  live adapters (CJ, Stripe, Razorpay, Meta, TikTok, Google, Gemini, Resend, Twilio)
```

## Principles
1. **Server owns the money path.** Prices, tax, shipping and discounts are recomputed server-side from the cart; the browser never sends a price. Payment status only changes from a *provider-verified* webhook (signature check, then re-fetch from the provider, then atomic `PENDING→PAID`).
2. **Every external call is a provider interface** with timeouts, bounded retries with jitter, a circuit breaker and typed errors (`retryable` vs not). Mock providers implement the same interface and can inject faults for tests.
3. **Idempotency everywhere that can double-charge or double-ship**: checkout idempotency key, webhook event dedupe, a unique `(orderId, lineKey)` shipment row inserted *before* calling the supplier, and a deterministic supplier idempotency key.
4. **Automation is a dial, not a switch.** Each automation (`product_discovery`, `auto_publishing`, `dynamic_pricing`, `inventory_sync`, `order_fulfillment`, `tracking`, `customer_support`, `ad_optimization`, `promotion_optimization`, `abandoned_cart`, `ai_reports`) is `OFF | ASSISTED | AUTOMATIC`. `proposeOrExecute` enforces it: OFF does nothing, ASSISTED writes a proposal to `ai_decisions` for human approval, AUTOMATIC executes — always inside guardrails, always audited. Production defaults keep sensitive automations ASSISTED (pricing, publishing, ads, promotions, fulfilment, discovery) and abandoned-cart OFF.
5. **Honest numbers.** Money is integer minor units. "Revenue" is never called "profit"; profit is tiered (gross → contribution → net) and unfulfilled orders' costs are flagged as unknown instead of guessed.
6. **No invented facts.** AI output is schema-validated and grounded; ungrounded specs/claims are rejected; tracking numbers only ever come from the supplier.

## Order lifecycle
`PENDING_PAYMENT → PAID → (fraud check) → fulfilment requested → supplier selected → SUPPLIER_ORDERED → SHIPPED → IN_TRANSIT → DELIVERED`, with `ON_HOLD` (exception queue), `CANCELLED`, `REFUNDED`, `PARTIALLY_REFUNDED`, and returns. Supplier selection ranks live offers by **expected profit blended with customer-experience** (delivery time, reliability, stock confidence) — not by cheapest price.

## Data & jobs
- MongoDB via Mongoose; money fields immutable after order creation; indexes declared with the models (`npm run migrate` creates them).
- `JobQueue`: Mongo-backed, dedupe key (partial unique index), lock lease with crash reclaim, exponential backoff, dead-letter → exception. `Scheduler` claims each time slot atomically in `system_settings`, so N workers fire a schedule once. Schedules (order sync, tracking, payment verification, inventory, abandoned cart, ad metrics/optimisation, pricing, discovery, scoring, daily brief, promotions, housekeeping) are listed and overridable in *Admin → Automation → Schedules*.
- Agents (`packages/core/src/agents`) are named, auditable units (ProductDiscovery, Inventory, Pricing, AdOptimization, Marketing, Support, …) with run history.

## Frontend
Next.js App Router. Server components fetch the API with the visitor's cookie; country comes from cookie → CDN geo header → US. A framework-free design system (`@orvia/ui`) provides tokens (light/dark), components and dependency-free SVG charts with tooltips, legends and table views. The browser only talks to its own origin (`/api/v1/*` is proxied), so cookies are first-party and no secret ever ships to the client.

## Added modules
`domain/{images,imagePipeline,offers,supplierOps,reconciliation,organic,launch}`, `market/*` (robots, fetcher, parsers, trend), `infra/{storage,ssrf}`, `packages/{ads/capabilities,shipping/tax}`. Jobs: supplier_health, reconciliation, market_crawl, market_index, image_ingestion.
