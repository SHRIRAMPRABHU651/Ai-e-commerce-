# ORVIA security and privacy review

A code review of the `production` branch, done by reading the source and running the DB-less checks listed in section 14. It is **not** a penetration test, a certification or a legal opinion. Nothing here claims compliance with any law or standard. Anything that needs a running database, a live provider or a deployed environment is marked unverified. Controls summary for operators: [SECURITY.md](SECURITY.md). Routes and permissions: [ORVIA_API_REFERENCE.md](ORVIA_API_REFERENCE.md). Data model: [ORVIA_DATABASE_DESIGN.md](ORVIA_DATABASE_DESIGN.md).

## 1. Findings

Severity is my judgement of impact times likelihood for this codebase. "Fixed in this build" means the change is in this branch with a DB-less unit test where the logic could be isolated; the Mongo-backed integration test added for it (`tests/integration/ownership-verified-email.test.ts`) was **not executed** (no MongoDB in the authoring sandbox).

| ID | Severity | Status | Finding | Evidence (file:line) |
|---|---|---|---|---|
| SEC-01 | High | Fixed in this build | **Unverified-email account takeover of guest records.** Registration signs the user in immediately (`routes/auth.ts:19-21`) while `emailVerified` stays false. Several customer routes treated `email == user.email` as ownership, so anyone could register with a victim's address and list the victim's guest returns, support tickets (message text), aftersales returns and evidence photos, delivery-recovery options, owned products, aftercare hub and purchase-derived LifeGraph. `/account/orders` and `GET /orders/lookup` already gated on `emailVerified` (`routes/shop.ts:38`, `130`); the other paths did not. Fix: email only counts once verified (`ownerEmail`, `ownerOr` in `apps/api/src/util.ts`; `ownerMatch` in `customer360/privacy.ts`). | before: `routes/shop.ts` `/account/returns`, `/returns`, `/support/tickets`; `routes/aftersales.ts` (all `email: user.email`); `routes/rescue.ts:53,58`; `customer360/service.ts` `deriveLifeGraph`, `listOwnedProducts`, `productCompanion`, `aftercareHub`. after: `shop.ts:180,184,203`, `aftersales.ts:54-78`, `rescue.ts:54,59`, `customer360/service.ts:177,542,584`. Test: `tests/unit/security-ownership.test.ts` |
| SEC-02 | High | Fixed in this build | **Privacy export and account anonymization matched records by unverified email.** `exportCustomerData` returned every order (name, address, phone), return, ticket, notification and customer record carrying the registrant's email, so the same takeover gave a full PII export of a victim's guest orders; `anonymizeAccount` could blank them. Referral rows by email had the same issue. | `customer360/service.ts:313,333` (export), `381-390` (anonymize); pure filters `ownerMatch`, `notificationOwnerMatch` in `customer360/privacy.ts`. Test: `tests/unit/security-ownership.test.ts` |
| SEC-03 | Medium | Fixed in this build | Public state-changing routes without their own rate limit: `POST /cart/coupon` (coupon-code guessing) and `POST /orders/:orderNumber/cancel` (guest cancel by order number + email). Both relied only on the global 600/min per-IP budget. Added 30/min and 10/min. | `routes/shop.ts:74,118` |
| SEC-04 | Medium | Fixed in this build | Missing indexes on ownership lookups used by customer routes, export and anonymization (collection scans; amplification risk on a public account route): `returns` (userId, email), `support_tickets` (userId, email), `notifications` (userId, to), `audit_logs` (actor), `analytics` (userId), `reviews` (userId). Additive indexes only. | `packages/database/src/models.ts` (see database document, section 6) |
| SEC-05 | Low | Fixed in this build | Security log lines wrote the full request URL including the query string; the consent, unsubscribe and recovery links carry tokens in the query. Now the path only. | `plugins.ts:103,140`, `http.ts:90` |
| SEC-06 | Low | Fixed in this build (docs) | `docs/API.md` said `Authorization: Bearer <jwt>` is accepted. Only the session cookie is read (`plugins.ts:89-97`); bearer is used only for `METRICS_TOKEN`. Corrected. | `docs/API.md:6` |
| SEC-07 | Medium | Open | **Client IP can be spoofed behind the web proxy.** `trustProxy` is the boolean `TRUST_PROXY` (`server.ts:37`); with `true` Fastify trusts every hop and takes the left-most `X-Forwarded-For` entry, and the Next.js proxy forwards the caller's own `X-Forwarded-For` unchanged (`apps/web/src/app/api/v1/[...path]/route.ts:14-21`; `web/src/lib/server.ts:23-25` forwards the visitor's header). A caller can pick any "IP", defeating per-IP rate limits (login 10/min, lookup, checkout) and falsifying `fraud.ip`. Account lockout (per account) is not affected. Remediation: make `TRUST_PROXY` a hop count or CIDR list, and have the edge (ALB/CDN) overwrite rather than append `X-Forwarded-For`. Not changed here because it alters deployment behaviour. | `plugins.ts:43-52`, `server.ts:37`, config `TRUST_PROXY: bool` |
| SEC-08 | Medium | Open | **Erasure and export do not cover the newer collections.** Not anonymized or exported: `aftersales_returns` (email, returnAddress), `rescue_cases` (email), `exceptions.customerEmail`, `orders.fraud.ip`, `events_campaign_recipients`, `events_sessions` (ip, user agent), `agents_*` (conversation text), `find_saved_searches`/`find_price_alerts`, `loyalty_*`, `creator_*`. The anonymization plan lists what is retained, not these. Needs a per-collection plan and DB-backed tests. | `customer360/service.ts:374-411`, `privacy.ts` plan; field inventory in the database document, section 5 |
| SEC-09 | Medium | Open | No multi-factor authentication for any account, including staff with `users:manage` / `refunds:approve`. Login failure counter is read-modify-write on the user document (`identity.ts:68-76`), so parallel guesses can exceed the 5-attempt limit slightly; lockout is per account (15 min), so it can be used to lock a victim out. | `identity.ts:10-11,64-78` |
| SEC-10 | Medium | Open | **Audit log is insert-only by convention.** No schema hook and no database-role separation; anyone with write access to MongoDB can alter it. The finance ledger and rescue timeline are protected at the ODM layer only (the native driver bypasses it). Remediation: separate DB user without update/delete on `audit_logs`, or forward to WORM storage. | `models.ts` `auditSchema`; `models.finance.ts:55-57`; `models.rescue.ts:66-70` |
| SEC-11 | Low | Open | The web app sets `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy` but **no Content-Security-Policy** and no HSTS (left to the CDN). The API has a strict CSP (`default-src 'none'`). The storefront has two inline scripts (`app/layout.tsx:21` theme init, JSON-LD) so a nonce-based CSP is needed. | `apps/web/next.config.ts:19-21` |
| SEC-12 | Low | Open | Account enumeration: `POST /auth/register` answers 409 `EMAIL_TAKEN` (rate limited 10/min); a locked account returns `ACCOUNT_LOCKED` before any password work, which also reveals existence. Password reset and unknown-user login are uniform. | `identity.ts:28,65` |
| SEC-13 | Low | Open | Key management: `JWT_SECRET` also keys the consent/unsubscribe/recovery HMAC tokens and the IP-hash HMAC (`customer360/service.ts:32`); `ENCRYPTION_KEY` falls back to `JWT_SECRET` outside production (`supplierAccess.ts:9`). Ciphertext has no key id, so rotating `ENCRYPTION_KEY` makes stored supplier credentials undecryptable until re-entered. Rotating `JWT_SECRET` logs everyone out and invalidates outstanding consent links. | `supplierAccess.ts:9-22`, `packages/auth/src/index.ts:166-180` |
| SEC-14 | Low | Open | `/metrics` and `/launch-gate` compare the bearer token with `!==` (not constant time). `/metrics` is open when `METRICS_TOKEN` is unset outside production (404 in production). | `routes/system.ts:26-29`, `routes/launch.ts:47-51` |
| SEC-15 | Low | Open | The seed password `Orvia-Demo-2026!` is a constant in the repository (`scripts/lib/seed.ts:16`); seeding refuses only `APP_ENV=production`, so a staging database could be seeded with known staff logins. The production-safety guard (mock providers, weak secret, etc.) applies only to `APP_ENV=production`, not `staging`. `MOCK_PAYMENT_WEBHOOK_SECRET` defaults to a public value (mock provider is refused in production). | `scripts/lib/seed.ts:16,33`, `packages/config/src/index.ts:206-215` |
| SEC-16 | Low | Open | Path-parameter ids are validated inconsistently (`checkId`/`objectId` on some routes, raw `req.params.id` on many). A malformed id is expected to reach Mongoose as a CastError, which the error handler has no case for, so it would be reported as a 500 rather than a 400. Not exercised here. 41 of 227 `POST/PUT/PATCH` routes declare no zod body (multipart uploads, raw-body webhook, id-only action endpoints). | `plugins.ts:130-152`; generated reference |
| SEC-17 | Low | Open | Supplier-portal domain functions take an optional `scopeSupplierId` and drop the tenant filter when it is empty (`...(scopeSupplierId ? { supplierId: scopeSupplierId } : {})`). Every portal caller passes the resolved supplier id, so there is no exploitable path today; a future caller that omits it would silently lose tenancy. | `suppliernet/ops.ts:113,163` |
| SEC-18 | Info | Open | SSRF guard resolves DNS before connecting; a DNS-rebinding race is possible in theory (acknowledged in the code). Run workers without access to internal networks. | `infra/ssrf.ts` (doc comment above `guardedFetch`) |
| SEC-19 | Info | Open | Uploaded files are type- and size-checked by magic bytes and served with `x-content-type-options: nosniff`, but there is no malware scanning. | `aftersales/evidence.ts:8-14`, `suppliernet/service.ts:97-103` |
| SEC-20 | Info | Unverified | Backups: documented as "Atlas continuous backup / PITR" (`docs/DEPLOYMENT.md:30`); no backup or restore configuration exists in `infra/terraform`, and no restore has been tested in this repository. | `docs/DEPLOYMENT.md:30-31`, `docs/OPERATIONS.md:26` |
| SEC-21 | Info | Open | Dependencies: see section 12 (17 moderate advisories, all dev-only; 0 in production dependencies). | `npm audit` |

## 2. Authentication

| Control | Implementation | Evidence |
|---|---|---|
| Password hashing | scrypt N=2^15, r=8, p=1, 64-byte key, per-password random 16-byte salt, NFKC normalisation, constant-time compare; unknown user still runs a dummy verification | `packages/auth/src/index.ts:6-33`, `identity.ts:55-58` |
| Password policy | 10-128 chars, needs upper, lower, digit; no breached-password check | `packages/types/src/schemas.ts:7-13` |
| Sessions | HS256 JWT (issuer `orvia`, `sub`, `sid`, expiry from `SESSION_TTL_HOURS`, default 168 h) **plus** a server-side `sessions` row checked on every request, so logout/revoke is immediate. Role is re-read from the user row each request (claim ignored). Disabled or deleted users fail `authenticate`. | `packages/auth/src/index.ts:47-66`, `identity.ts:101-111` |
| Cookies | `orvia_session`: httpOnly, `SameSite=Lax`, `Secure` when `COOKIE_SECURE` (forced true in production by the guard), path `/`. Cart cookie same attributes. | `routes/auth.ts:14`, `shop.ts` `ensureCart`, `config:215` |
| Lockout | 5 consecutive failures lock the account for 15 min; login/register/reset are rate limited 10/min per IP (forgot-password 5/min) | `identity.ts:10-11,64-78`, `routes/auth.ts:10,56` |
| Reset / verify tokens | 32 random bytes, only the SHA-256 is stored, 1 h / 48 h expiry, single use; a reset revokes all sessions | `identity.ts:119-141` |
| Staff login | Separate endpoint rejects CUSTOMER and SUPPLIER roles; supplier users have a random unusable password until they set one through onboarding | `identity.ts:79-82`, `suppliernet/service.ts:25` |
| Not present | MFA, password-breach checks, device/new-login alerts, step-up auth for refunds | see SEC-09 |

## 3. Authorization (RBAC)

The role-by-permission matrix (57 permissions × 8 roles) is generated from `packages/auth` into the API reference: [Permission by role matrix](ORVIA_API_REFERENCE.md#permission-by-role-matrix). Properties verified from the generated route table:

- Every one of the 275 `staff` routes names a permission (none is "any staff"). Every permission used by a route exists in `PERMISSIONS`. `ads:read`, `categories:write` and the two `supplierportal:*` permissions are not required by any `route()` (supplier portal checks run in a `guard()` helper in `routes/suppliernet.ts`).
- `route()` rejects `CUSTOMER` and `SUPPLIER` before the permission test for `staff` routes (`http.ts:85-93`), so the supplier portal permissions cannot open staff routes; staff roles do not hold the portal permissions (`packages/auth/src/index.ts:130-137`).
- Money and permission boundaries: `refunds:approve` is held only by SUPER_ADMIN and ADMIN; `users:manage` only by SUPER_ADMIN; a user cannot change their own role (`routes/adminOps.ts` `PATCH /admin/users/:id`). Refund execution goes through `refundOrder` with an approval limit.
- A role change or disable is effective on the next request because the role comes from the database.

## 4. Ownership and IDOR spot-check (customer, creator, supplier routes)

I traced these routes from handler to query predicate. "Pass" means the ownership key is in the database filter or checked before any data is returned.

| # | Route | Ownership predicate | Result |
|---|---|---|---|
| 1 | `GET /account/orders` | `userId`, or email only if `emailVerified` (`shop.ts:130`) | Pass |
| 2 | `DELETE /account/addresses/:id` | `deleteOne({ _id, userId })` (`shop.ts:149`) | Pass |
| 3 | `GET /orders/lookup`, `POST /orders/:orderNumber/cancel` | `owns()`: userId, verified email, or order number + matching email; same 404 for wrong email and unknown order (`shop.ts:38,113,121`) | Pass (cancel gained a rate limit, SEC-03) |
| 4 | `GET /account/returns`, `POST /returns` | previously `email == user.email` | **Fail, fixed** (SEC-01) |
| 5 | `GET /support/tickets` | previously `email == user.email` | **Fail, fixed** (SEC-01) |
| 6 | `GET /aftersales/returns`, `/returns/:id`, `/returns/:id/evidence[/:evidenceId]`, `/orders/:n/eligibility` | `isReturnOwner` by userId or email; route passed unverified email | **Fail, fixed** (SEC-01); evidence download 403 for non-owners is covered by the existing integration test |
| 7 | `GET /orders/:orderNumber/recovery`, `POST .../recovery/decision` | `authorizeViewer`: userId + (owner or email) or signed consent token; 404 for foreign orders | Fail for unverified email, **fixed**; token path pass |
| 8 | `GET /account/products`, `GET /account/products/:orderItemId` | `ownsOrder` matched email | **Fail, fixed** |
| 9 | `GET /account/aftercare`, `POST /account/lifegraph/derive` | `$or` userId/email | **Fail, fixed** |
| 10 | `GET /account/privacy/export`, deletion execution | email-keyed matching | **Fail, fixed** (SEC-02) |
| 11 | `PATCH/DELETE /account/saved-searches/:id` | `findOneAndUpdate({ _id, userId })`, `deleteOne({ _id, userId })` (`find/service.ts:318,323`) | Pass |
| 12 | `PATCH/DELETE /account/price-guard/alerts/:id` | `{ _id: id, userId }` (`find/service.ts:378,383`) | Pass |
| 13 | `DELETE /account/lifegraph/nodes/:id`, `POST .../nodes` (parent) | `findOneAndDelete({ _id, userId })`; parent looked up with `userId` (`customer360/service.ts:143,159`) | Pass |
| 14 | `PATCH/DELETE /account/memory/:id` | `{ _id: id, userId }` (`service.ts:222,229`) | Pass |
| 15 | `PATCH/DELETE /creator/collections/:id`, `DELETE /creator/links/:id` | `requireApprovedCreator(user.id)` then `{ _id, creatorId }` in the query (`creators/profiles.ts:151,173,214`) | Pass |
| 16 | `GET /creator/payouts/:id/statement` | `CreatorPayout.findOne({ _id, creatorId })` (`creators/payouts.ts:107`) | Pass |
| 17 | `GET /supplier/documents/:id/file` | portal supplier resolved from `Supplier.userIds`, then `{ _id, supplierId }` (`suppliernet/service.ts:122`) | Pass |
| 18 | `POST /supplier/shipments/:id/ship` | `Shipment.findOne({ _id, supplierId: s._id })`, 404 for other suppliers' shipments (`portal.ts:105`) | Pass |
| 19 | `POST /supplier/disputes/:id/respond`, `/returns/:id/decide` | scope id passed into `findOne({ _id, supplierId })` (`ops.ts:113,163`) | Pass (see SEC-17) |
| 20 | `GET/POST /supplier/*` with a foreign `supplierId` | `resolvePortalSupplier`: not in my `userIds` means 404, same as non-existent (`portal.ts:28-33`) | Pass; unit-tested in `tests/unit/suppliernet.test.ts` |
| 21 | `POST /assistant/outcomes/:id/rating`, `POST /assistant/confirm` | owner-only per route summary and service; confirm needs the one-time token bound to the user | Read, not traced end to end |
| 22 | `GET/DELETE /assistant/conversations/:sessionId` | owner account, or a guest holding the 128-bit session id (`agents/service.ts:83`, `types/agents.ts:35`) | Pass for accounts; guest ids are client-chosen (32 hex), so their secrecy depends on the client |

The tenant predicates are tested without a database in `tests/unit/security-ownership.test.ts` (verified/unverified email ownership filters) and `tests/unit/suppliernet.test.ts` (portal tenant filter). Mongo-backed behaviour is in the integration tests, which were not run here.

## 5. CSRF

Cookie-authenticated mutations must send `x-requested-with: orvia` and, if an `Origin` is present, it must be in `CORS_ORIGINS` (`plugins.ts:110-118`). Cross-site pages cannot add the custom header without a CORS preflight, which is denied for unknown origins (`plugins.ts:35-42`). Webhooks are exempt and signature-authenticated. `SameSite=Lax` is the second layer. Gaps: the check is skipped for requests with no session or cart cookie (intended; nothing to ride), and `GET` routes must stay side-effect free (the `GET /unsubscribe` link performs a state change by design, gated by a signed token). Unit/integration coverage: `tests/integration/security.test.ts` (not run here).

## 6. Rate limiting coverage

Global budget: `RATE_LIMIT_PER_MINUTE` (default 600) per client IP, `skipOnError` so a Redis outage never blocks the API; in-memory when Redis is absent (per process). Per-route limits exist on login, register, reset, verify, forgot, checkout, order lookup/cancel, coupon, search/Find, assistant, uploads, privacy export/deletion, creator and supplier-portal routes.

Unauthenticated state-changing routes still relying only on the global limit (after this review):

| Route | Why acceptable / note |
|---|---|
| `POST /auth/logout` | No effect without a session |
| `POST /cart/items`, `PATCH /cart/items`, `POST /cart/contact`, `PUT /preferences/country` | Cart/preference writes bounded by cart size limits; consider 120/min |
| `POST /webhooks/payments/:provider` | Signature verified before any work; a limit could drop real provider retries |

Authenticated mutations without their own limit: 35 of 56 mutating `user` routes (for example `PATCH /account/profile`, `POST /account/wishlist`, memory and LifeGraph edits); they are bounded by caps in the domain code (10 addresses, memory/LifeGraph limits) and the global limit. Because of SEC-07 every per-IP limit is only as strong as the IP the API sees.

## 7. Input validation

All routes are declared through `route()`, which validates `body` and `query` with zod and returns 400 with issue paths; Fastify's own ajv is disabled so zod is the only validator (`plugins.ts:63-64`, `http.ts` handler). Body limit 1 MB; multipart limited to 1 file, `MEDIA_MAX_BYTES`, 5 fields (`server.ts:36-39`). Email addresses are lower-cased and bounded; money is integer with validators in the models. Coverage gaps: 41 of 227 `POST/PUT/PATCH` routes have no JSON body schema (uploads, webhook, id-only actions, see SEC-16); path parameters are not zod-validated on most routes.

## 8. Injection, SSRF and XSS

**NoSQL injection.** A `preValidation` hook rejects any key containing `$` or `.` in body, query or params to depth 8 (`plugins.ts:100-106`), and zod types the values, so operator objects cannot reach a query. Every user-supplied regex is escaped: admin order/customer/product/audit/market search use `escapeRegex` (`adminCommerce.ts:45,107,386`, `adminOps.ts:390`, `market.ts:92`); other call sites escape inline or strip to an allow-list (`trust/service.ts:217,235`, `manualSupplier.ts:31`, `customer360/service.ts:448`, `creators/loyalty.ts:202`, `creators/ledger.ts:263`, `rescue/service.ts:598`, `agents/tools.customer.ts:174`, `aftersales/chargebacks.ts:80`). `images.ts` and `exportGate.ts` build regexes from server configuration/enums, not user input. I found no unescaped user regex and no `$where`/`$function`.

**SSRF.** Every server-side fetch of an operator- or supplier-supplied URL goes through `guardedFetch` (`infra/ssrf.ts`): http(s) only, no credentials in the URL, ports 80/443, DNS resolved and rejected for loopback/private/link-local/CGNAT/multicast/metadata ranges (IPv4 and IPv6), redirects re-validated per hop (max 3), size and time bounded. Call sites: supplier feed adapter (`suppliernet/adapters.ts:14`), image pipeline (`imagePipeline.ts:174`), market crawler (`market/fetcher.ts:46`). `ALLOW_PRIVATE_FETCH` is refused in production. The crawler also honours robots.txt. Customer-entered URLs (creator social links, dispute evidence `url`) are stored, never fetched. Residual: DNS rebinding window (SEC-18).

**XSS.** React escapes by default. `dangerouslySetInnerHTML` appears four times, all for JSON-LD or the theme bootstrap script, and the JSON is serialised with `<` and U+2028/9 escaped (`web/src/lib/structured-data.ts:39`, `creators/[handle]/page.tsx:30`, `[collection]/page.tsx:42`, `app/layout.tsx:21` with a constant string). Email templates escape all interpolated values and only allow http(s) links (`packages/notifications`, test `tests/unit/email-escaping.test.ts`). The creator payout statement HTML escapes every value (`creators/statement.ts:68-69`) and is served by the API under `default-src 'none'`. Stored text from customers (reviews, comments, tickets) is rendered as text. No CSP on the web app (SEC-11).

## 9. Webhooks

Payment webhooks verify the signature on the raw body before anything else: Stripe through the SDK `constructEvent`, Razorpay and mock with HMAC-SHA256 and `timingSafeEqual` (`packages/payments/src/{stripe,razorpay,mock}.ts`). Events are claimed by unique `{provider, eventId}` and the payment is re-fetched from the provider (amount and currency must match) before the single atomic `PENDING_PAYMENT → PAID` update (`orders.ts:127-217`). Late captures after cancellation become a refund task. There are no other inbound webhooks. The mock provider's secret is public and the provider is refused in production (SEC-15). Live Stripe/Razorpay behaviour is unverified.

## 10. Secrets and configuration

- `.env` and `.env.*` are git-ignored; only `.env.example` is tracked (`git ls-files | grep env` returns just that file; `.gitignore:11-14`).
- A grep over tracked files for `sk_live`, `sk_test`, AWS key ids, Google API keys, GitHub tokens, Slack tokens, private-key headers and `password|secret|api_key|token = "…"` literals found only test fixtures (`tests/**`) and the release-gate regexes in `scripts/production-check.mjs`. The one constant credential is the dev seed password (SEC-15). The `npm run production-check` release gate scans the web bundle for secret variable names.
- `assertSafeForEnvironment` refuses to boot in production with mock/log providers, a `JWT_SECRET` shorter than 32 characters or starting `dev-only`, insecure cookies, `SEED_ON_START`, static FX, `ALLOW_PRIVATE_FETCH`, non-S3 storage, or a missing 64-hex `ENCRYPTION_KEY` (`packages/config/src/index.ts:206-215`). Not guarded: `TRUST_PROXY`, `METRICS_TOKEN`, `STRIPE_WEBHOOK_SECRET` presence when `PAYMENT_MODE=live` (the payment registry fails separately; not re-verified here).
- Logger redacts `authorization`, `cookie`, `set-cookie`, `*.password`, `*.passwordHash`, `*.token`, `*.apiKey`, `*.secret`, `*.clientSecret`, `*.accessToken` (`packages/config/src/logger.ts:6-17`). Provider status endpoints return booleans, never values.

## 11. Encryption, uploads, logging, audit

- **Credentials at rest:** supplier credentials are AES-256-GCM with random 12-byte IV and auth tag, key from `ENCRYPTION_KEY` (64 hex); the field is `select: false` (`packages/auth/src/index.ts:166-180`, `models.ts:216`). No key id or rotation (SEC-13). Passwords are hashed, tokens stored as SHA-256. MongoDB encryption at rest and TLS are infrastructure concerns not defined in this repository.
- **Uploads:** customer evidence photos and supplier documents: size limit, MIME allow-list, magic-byte sniff, declared type must match content, photos re-encoded to strip EXIF, per-return file cap, per-route rate limits, private cache headers (`aftersales/evidence.ts`, `suppliernet/service.ts:97-103`). No malware scan (SEC-19).
- **PII in logs:** request logs carry method, path (query string removed), status, latency and request id, not bodies or emails. Login lockout and blocked-request logs include the client IP (needed for abuse response). The dev-only notification log prints the recipient (`notify.ts:60`, `NOTIFY_MODE=log` is refused in production). IPs stored in the database are salted HMACs in consent/click/rescue records, but raw IPs remain in `sessions.ip`, `orders.fraud.ip` and `events_sessions.client.ip`.
- **Audit coverage:** `audit()` is called for orders created/cancelled/refunded, refund approvals, payouts (approve/reject/paid), chargebacks, supplier credential and status changes, loyalty adjustments, finance settings/FX override/ledger backfill, settings updates, promotion creation, staff user creation and role changes, consent and deletion actions, customer 360 reveals and exports, agent conversations deletion. Failures to write an audit row are logged, not thrown (`infra/audit.ts:16-35`), so an audit outage does not block the action but leaves no row. Not audited: individual reads of order data by staff, and ledger postings (the ledger is itself the record).

## 12. Dependencies

`npm audit` on 2026-11-06: **17 moderate, 0 high, 0 critical**; `npm audit --omit=dev` reports **0 vulnerabilities**. All advisories are in development tooling (`@typescript-eslint/*` via `minimatch`/`glob`, `@cyclonedx/cyclonedx-npm` via `libxmljs2`/`node-gyp`, `autocannon` via `hyperid`/`uuid`). Fixing them requires major tool upgrades; none is reachable from the running API, worker or web app. An SBOM can be produced with `npm run sbom`.

## 13. Consent, export and deletion (Customer 360)

- **Consent:** append-only `customer360_consents` log with policy version, source, salted IP hash; current state is the latest row per kind; marketing email consent is mirrored to `Customer.marketingConsent`; tracking/event forwarding defaults to no consent; email campaigns filter on consent, unsubscribes and frequency caps. Withdrawing marketing consent is immediate.
- **Export:** `GET /account/privacy/export` (5/hour), JSON, audited; internal fraud scores are excluded; staff notes about the customer are included. Coverage gap in SEC-08.
- **Deletion:** request, cooling-off, staff review, then `anonymizeAccount` (orders keep money fields, PII blanked; consent log kept without IP hashes; credentials made unusable). Gap in SEC-08. Staff only see masked profiles unless they reveal with a reason, which is audited.
- **Retention:** see database document, section 4. There is no documented legal retention schedule.

## 14. PII inventory

| Data | Where | Source | Notes |
|---|---|---|---|
| Name, email, password hash, country, last login | `users`, `customers` | Customer | Hash is scrypt, `select: false` |
| Postal address, phone | `orders.address` (immutable), `addresses`, `aftersales_returns.returnAddress` | Checkout / account | Order address blanked on anonymization |
| Email on guest records | `orders, returns, support_tickets, carts, aftersales_returns, rescue_cases, exceptions, referrals, events_*` | Checkout | Ownership only when verified (SEC-01) |
| Free text | `support_tickets.messages, reviews, creator_comments, agents_conversations, find_saved_searches.query, C360 memory/LifeGraph` | Customer | Assistant input is neutralised for prompt injection before use |
| Photos | object storage (return evidence) | Customer | EXIF stripped |
| IP and user agent | `sessions, orders.fraud.ip, events_sessions` raw; `*ipHash` salted | Request | Raw values are not exported or erased (SEC-08) |
| Behaviour | `analytics`, `events_*`, `find_price_*`, loyalty and creator ledgers | Browser / system | Consent-gated for ad platforms |
| Supplier business data and documents | `suppliernet_*`, `suppliers` | Supplier | Credentials encrypted |
| Payment data | none stored: only provider intent ids and status | Provider | No card data in the repository's models; PCI scope depends on the provider integration used in the browser (not assessed) |

## 15. Per-market obligations checklist

This is a prompt list for counsel and compliance staff, **not** a statement that the product meets any of these, and not legal advice. Nothing below has been reviewed by a lawyer. The product operates US, CA and IN storefronts (`CountryConfig`), with cross-border dropshipping.

| Area | United States | Canada | India |
|---|---|---|---|
| Privacy | State consumer-privacy statutes (for example California), deletion/access/opt-out handling, children's data rules, privacy notice and cookie/tracking disclosure | Federal and provincial private-sector privacy law (including Quebec's), breach reporting, cross-border transfer notice | Digital personal data protection law and rules, consent managers, localisation and transfer limits, grievance officer |
| Marketing and consumer protection | Email marketing rules, FTC rules on endorsements/reviews and pricing claims, refund/return disclosure, automatic-renewal not applicable | Anti-spam law (express/implied consent records), competition law on price and drip-pricing claims, provincial consumer statutes | E-commerce consumer rules (seller details, grievance, cancellation/refund, country-of-origin display), advertising codes |
| Product safety | Federal consumer product safety rules and recalls, children's products testing, labelling | Consumer product safety act, children's product rules, bilingual labelling | Mandatory standards/certification orders, packaged-commodity (legal metrology) labelling |
| Payments | Card-network and processor rules; scope depends on integration; refund and chargeback timelines | Same | Payment aggregator/authorisation rules, card-data storage restrictions, refund timelines |
| Import / export | Customs entry, duty/tariff changes and low-value shipment rules, restricted goods, export controls and sanctions (the repository has an export-attestation gate for flagged destinations; it is a hold, not a legal determination) | Customs and duty rules, restricted goods | Import licensing, customs valuation, foreign-exchange rules, restricted goods |
| Tax | Sales/use tax registration thresholds by state | GST/HST/PST registration and collection on imports | GST registration and invoicing, e-commerce operator collection rules |

Items the code depends on that need a decision from the business: the retention schedule per market, the lawful basis and notice text behind each consent kind (`POLICY_VERSIONS` in `packages/types`), how tax is calculated (`packages/shipping/src/tax.ts` is an **estimate**, not a tax engine), and who is the importer of record for cross-border parcels.

## 16. Changes made in this build

| File | Change | Test |
|---|---|---|
| `apps/api/src/util.ts` | Added `ownerEmail` and `ownerOr` (verified-email ownership helpers) | `tests/unit/security-ownership.test.ts` |
| `apps/api/src/routes/shop.ts` | `/account/returns`, `/support/tickets` use `ownerOr`; `/returns` passes `ownerEmail`; rate limits on `/cart/coupon` (30/min) and `/orders/:orderNumber/cancel` (10/min) | unit + `tests/integration/ownership-verified-email.test.ts` (not run) |
| `apps/api/src/routes/aftersales.ts` | All customer calls pass `ownerEmail(user)` | same |
| `apps/api/src/routes/rescue.ts` | Recovery view/decision pass `ownerEmail` for signed-in users | same |
| `packages/core/src/domain/customer360/privacy.ts` | Added pure `ownerMatch`, `notificationOwnerMatch`; export note wording | `tests/unit/security-ownership.test.ts` |
| `packages/core/src/domain/customer360/service.ts` | Export, anonymization, `deriveLifeGraph`, `listOwnedProducts`, `productCompanion`, `aftercareHub`, rescue reader and referral matching use verified-email ownership | same |
| `packages/database/src/models.ts` | Additive indexes on `returns`, `support_tickets`, `notifications`, `audit_logs`, `analytics`, `reviews` | `npm run docs:db` regenerates the index list |
| `apps/api/src/plugins.ts`, `apps/api/src/http.ts` | Security logs record the path without the query string; `route()` records metadata in a module-level registry (read only by docs generators, no runtime effect) | `npm run boot-check`, typecheck |
| `docs/API.md` | Corrected the bearer-token claim, pointer to the generated reference | |

Behaviour change to be aware of: a customer who registers and does **not** verify their email no longer sees earlier guest orders' returns, tickets, aftercare or recovery pages that share the address, and the privacy export/deletion for such an account covers only records linked to the account id. Verifying the email restores access.

## 17. Verification performed

Run in the authoring sandbox (no MongoDB): `npm run typecheck`, `npm run lint` (zero warnings), the DB-less unit suite (`tests/unit/**`, 24 files, 574 tests passing), `npm run boot-check`, `npm run docs:api`, `npm run docs:db`, `npm audit`. **Not run:** Mongo-backed integration tests (including the new one), any live-provider call, any browser test, penetration testing, load or abuse testing, infrastructure review (TLS, WAF, network policy, MongoDB access control), and backup restore.
