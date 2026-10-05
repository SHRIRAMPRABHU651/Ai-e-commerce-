# API

Base path `/api/v1`. JSON in/out. Interactive OpenAPI UI at `/docs` and the raw spec at `/docs/json` (development/staging only — disabled in production; export the spec in CI if you need to publish it). Every route is declared with a zod schema, so request validation, error shape and OpenAPI come from the same source.

## Conventions
- **Auth**: cookie session `orvia_session` (httpOnly, SameSite=Lax, Secure in staging/prod) or `Authorization: Bearer <jwt>`. Staff routes check a role→permission matrix (`SUPER_ADMIN, ADMIN, MARKETING, OPERATIONS, SUPPORT, ANALYST`; customers have none).
- **CSRF**: cookie-authenticated mutations must send `x-requested-with: orvia` and a same-site `Origin`. Webhooks are exempt (they are authenticated by signature).
- **Errors**: `{ "error": { "code", "message", "details?", "requestId" } }`. Codes include `VALIDATION`, `UNAUTHENTICATED`, `FORBIDDEN`, `CSRF`, `NOT_FOUND`, `RATE_LIMITED`, `CONFLICT`, `CART_CHANGED`, `EMPTY_CART`, `NO_STOCK`, `NOT_PAID`, `LIMIT`, `ILLEGAL_TRANSITION`.
- **Idempotency**: `POST /checkout` requires `idempotencyKey`; replays return the original order.
- **Money**: integer minor units + ISO currency. Country via `?country=US|CA|IN` (or cookie).
- **Rate limits**: global per-IP, tighter on auth, search, lookup and checkout; `429` with `Retry-After`.
- **Request ids**: `x-request-id` is accepted/generated and echoed on every response and log line.
- **Health**: `GET /live` (process), `GET /ready` (Mongo reachable; Redis reported as degraded, not failed), `GET /health`, `GET /metrics` (Prometheus text; bearer `METRICS_TOKEN` if set).

## Webhooks
`POST /api/v1/webhooks/payments/:provider` — raw body is signature-verified (Stripe `Stripe-Signature`, Razorpay `X-Razorpay-Signature`, mock HMAC). Events are de-duplicated by provider event id, and the payment is **re-fetched from the provider** before an order is marked paid.

## Endpoints
<!-- endpoints:start -->
### Account

| Method | Path | Summary |
|---|---|---|
| GET | `/api/v1/account/addresses` | My saved addresses |
| POST | `/api/v1/account/addresses` | Save an address |
| DELETE | `/api/v1/account/addresses/{id}` | Delete address |
| GET | `/api/v1/account/orders` | My orders |
| PATCH | `/api/v1/account/profile` | Update profile |
| GET | `/api/v1/account/wishlist` | My wishlist |
| POST | `/api/v1/account/wishlist` | Add to wishlist |
| DELETE | `/api/v1/account/wishlist/{productId}` | Remove from wishlist |
| GET | `/api/v1/account/wishlist/ids` | My wishlist ids (for heart state) |

### Admin

| Method | Path | Summary |
|---|---|---|
| GET | `/api/v1/admin/analytics` | Analytics bundle (financials, series, countries, products, funnel, categories) |
| GET | `/api/v1/admin/audit` | Audit logs |
| GET | `/api/v1/admin/automation` | Automation Center |
| PUT | `/api/v1/admin/automation/{key}` | Set automation mode OFF / ASSISTED / AUTOMATIC |
| POST | `/api/v1/admin/automation/agents/{name}/run` | Run an agent now |
| GET | `/api/v1/admin/automation/ai-tasks` | Agent run history |
| GET | `/api/v1/admin/automation/decisions` | AI decisions (proposed / executed) |
| POST | `/api/v1/admin/automation/decisions/{id}/approve` | Approve + execute a proposed decision |
| POST | `/api/v1/admin/automation/decisions/{id}/reject` | Reject a proposed decision |
| PUT | `/api/v1/admin/automation/schedules/{name}` | Customize a schedule interval / enable |
| GET | `/api/v1/admin/brief` | Latest daily brief |
| POST | `/api/v1/admin/brief/generate` | Generate a brief now |
| POST | `/api/v1/admin/copilot` | Ask the business copilot (answers come from database queries) |
| GET | `/api/v1/admin/countries` | Country configs + performance |
| PUT | `/api/v1/admin/countries/{code}` | Update country configuration |
| GET | `/api/v1/admin/customers` | Customers |
| GET | `/api/v1/admin/customers/{id}` | Customer detail |
| GET | `/api/v1/admin/exceptions` | Exception queue |
| POST | `/api/v1/admin/exceptions/{id}/action` | Execute the suggested action or resolve/dismiss |
| GET | `/api/v1/admin/financials` | Financial dashboard |
| GET | `/api/v1/admin/inventory` | Inventory statuses |
| POST | `/api/v1/admin/inventory/sync` | Run an inventory/price sync now |
| GET | `/api/v1/admin/marketing` | Marketing dashboard: campaigns, per-country/product/creative metrics |
| GET | `/api/v1/admin/marketing/campaigns/{id}` | Campaign detail with creatives |
| POST | `/api/v1/admin/marketing/campaigns/{id}/action` | Pause / resume / change budget (applied on the ad platform first) |
| POST | `/api/v1/admin/marketing/campaigns/{id}/launch` | Launch a drafted campaign (budget caps + compliance enforced) |
| POST | `/api/v1/admin/marketing/content` | Generate marketing content (email / blog / push / social) from source product data |
| GET | `/api/v1/admin/orders` | Orders table |
| GET | `/api/v1/admin/orders/{id}` | Order detail with costs, shipments, exceptions, audit |
| POST | `/api/v1/admin/orders/{id}/cancel` | Cancel order (cancels at supplier, refunds if paid) |
| POST | `/api/v1/admin/orders/{id}/change-supplier` | Cancel at current supplier and re-place with the next best |
| POST | `/api/v1/admin/orders/{id}/contact` | Email the customer about this order |
| POST | `/api/v1/admin/orders/{id}/refund` | Refund order (full or partial) |
| POST | `/api/v1/admin/orders/{id}/retry-fulfillment` | Retry supplier order (idempotent) |
| GET | `/api/v1/admin/overview` | Dashboard overview (today vs yesterday, live, insights) |
| GET | `/api/v1/admin/payments` | Payments |
| GET | `/api/v1/admin/products` | Products table |
| GET | `/api/v1/admin/products/{id}` | Product detail: economics, supplier comparison, scores, campaigns |
| PATCH | `/api/v1/admin/products/{id}` | Edit product content / pricing config |
| POST | `/api/v1/admin/products/{id}/competitor-prices` | Enter competitor prices for a country (minor units) |
| POST | `/api/v1/admin/products/{id}/price` | Manually set a price (cannot go below the margin floor) |
| POST | `/api/v1/admin/products/{id}/publish` | Publish (runs compliance + margin gates) |
| POST | `/api/v1/admin/products/{id}/refresh` | Sync supplier offers, recompute markets and score |
| POST | `/api/v1/admin/products/{id}/start-test` | Create an ad test plan (budget, creatives, criteria); optionally launch |
| POST | `/api/v1/admin/products/{id}/transition` | Change lifecycle state |
| POST | `/api/v1/admin/products/import` | Import a supplier product (AI content + compliance + pricing) |
| GET | `/api/v1/admin/promotions` | Promotions + AI recommendations awaiting approval |
| POST | `/api/v1/admin/promotions` | Create promotion |
| PATCH | `/api/v1/admin/promotions/{id}` | Enable/disable or end a promotion |
| POST | `/api/v1/admin/refunds/{id}/approve` | Approve a high-value refund |
| GET | `/api/v1/admin/returns` | Return requests |
| POST | `/api/v1/admin/returns/{id}/decision` | Approve / reject / refund a return |
| GET | `/api/v1/admin/reviews` | Reviews for moderation |
| PATCH | `/api/v1/admin/reviews/{id}` | Moderate a review |
| GET | `/api/v1/admin/reviews/analysis/{id}` | AI review analysis for a product |
| GET | `/api/v1/admin/settings` | System settings (no secrets) |
| PUT | `/api/v1/admin/settings/ads` | Update ad budget rules (safe mode default) |
| PUT | `/api/v1/admin/settings/ops` | Update operational thresholds |
| PUT | `/api/v1/admin/settings/pricing` | Update pricing guardrails |
| GET | `/api/v1/admin/shipping` | Shipments |
| POST | `/api/v1/admin/shipping/sync` | Sync tracking now |
| GET | `/api/v1/admin/suppliers` | Supplier dashboard |
| POST | `/api/v1/admin/suppliers` | Add a supplier |
| PATCH | `/api/v1/admin/suppliers/{id}` | Update supplier settings |
| GET | `/api/v1/admin/suppliers/{id}/catalog` | Search a supplier catalogue (for import) |
| POST | `/api/v1/admin/suppliers/{id}/check` | Run an API health check |
| GET | `/api/v1/admin/suppliers/{id}/offers` | Stored offers for a supplier |
| GET | `/api/v1/admin/support/tickets` | Support tickets |
| GET | `/api/v1/admin/support/tickets/{id}` | Ticket |
| POST | `/api/v1/admin/support/tickets/{id}/reply` | Reply to a customer (emails them) |
| GET | `/api/v1/admin/users` | Staff users + roles matrix |
| POST | `/api/v1/admin/users` | Create a staff user |
| PATCH | `/api/v1/admin/users/{id}` | Change role / disable a staff user |

### Auth

| Method | Path | Summary |
|---|---|---|
| POST | `/api/v1/auth/admin/login` | Staff sign in |
| POST | `/api/v1/auth/forgot-password` | Request a password reset email |
| POST | `/api/v1/auth/login` | Customer sign in |
| POST | `/api/v1/auth/logout` | Sign out (revokes the server-side session) |
| GET | `/api/v1/auth/me` | Current user |
| POST | `/api/v1/auth/register` | Create a customer account |
| POST | `/api/v1/auth/reset-password` | Reset password with token |
| GET | `/api/v1/auth/sessions` | List my active sessions |
| DELETE | `/api/v1/auth/sessions/{id}` | Revoke one session |
| POST | `/api/v1/auth/sessions/revoke-all` | Sign out everywhere |
| POST | `/api/v1/auth/verify-email` | Verify email address |

### Cart

| Method | Path | Summary |
|---|---|---|
| GET | `/api/v1/cart` | Get priced cart |
| POST | `/api/v1/cart/contact` | Attach email + marketing consent to the cart |
| POST | `/api/v1/cart/coupon` | Apply or remove a coupon |
| POST | `/api/v1/cart/items` | Add to cart |
| PATCH | `/api/v1/cart/items` | Change quantity (0 removes) |

### Checkout

| Method | Path | Summary |
|---|---|---|
| POST | `/api/v1/checkout` | Create order + payment from cart (idempotent) |

### Dev

| Method | Path | Summary |
|---|---|---|
| POST | `/api/v1/dev/ads/fault` | [dev] Make the mock ad API fail N times |
| POST | `/api/v1/dev/jobs/drain` | [dev] Process due jobs inline (when no worker is running) |
| POST | `/api/v1/dev/payments/{intentId}/simulate` | [dev] Simulate the payment provider sending a signed webhook |
| GET | `/api/v1/dev/state` | [dev] Mock-store + queue snapshot |
| POST | `/api/v1/dev/suppliers/{code}/fault` | [dev] Inject supplier API failures |
| POST | `/api/v1/dev/suppliers/{code}/override` | [dev] Change a mock supplier’s stock/price for a product |

### Orders

| Method | Path | Summary |
|---|---|---|
| POST | `/api/v1/orders/{orderNumber}/cancel` | Cancel an unshipped order |
| GET | `/api/v1/orders/lookup` | Guest order lookup (order number + email) or signed-in owner |

### Returns

| Method | Path | Summary |
|---|---|---|
| GET | `/api/v1/account/returns` | My return requests |
| POST | `/api/v1/returns` | Request a return |

### Reviews

| Method | Path | Summary |
|---|---|---|
| POST | `/api/v1/products/{productId}/reviews` | Write a review |
| POST | `/api/v1/reviews/{id}/helpful` | Mark a review helpful |

### Storefront

| Method | Path | Summary |
|---|---|---|
| POST | `/api/v1/events` | Track storefront event |
| GET | `/api/v1/home` | Homepage sections for the current country |
| GET | `/api/v1/meta` | Storefront bootstrap: countries, categories, payment mode |
| PUT | `/api/v1/preferences/country` | Set preferred country (cookie) |
| GET | `/api/v1/products` | Search / browse products |
| GET | `/api/v1/products/{slug}` | Product detail |
| GET | `/api/v1/products/{slug}/reviews` | Product reviews |
| GET | `/api/v1/recommendations/recently-viewed` | Recently viewed products by id |
| GET | `/api/v1/search/suggest` | Search suggestions (typo tolerant) |

### Support

| Method | Path | Summary |
|---|---|---|
| POST | `/api/v1/support/chat` | AI support assistant (grounded in orders, shipments and products) |
| GET | `/api/v1/support/tickets` | My support tickets |

### Webhooks

| Method | Path | Summary |
|---|---|---|
| POST | `/api/v1/webhooks/payments/{provider}` | Payment provider webhook (signature verified) |
<!-- endpoints:end -->
