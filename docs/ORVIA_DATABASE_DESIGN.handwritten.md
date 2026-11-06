## Hand-written review (verified against code on the date of this build)

Everything below was read from the cited files. Where a property is only a convention (no schema or database enforcement) it says so.

### 1. Identity and tenant isolation

There is one identity collection (`users`, `packages/database/src/models.ts`) with a `role` (`SUPER_ADMIN, ADMIN, MARKETING, OPERATIONS, SUPPORT, ANALYST, CUSTOMER, SUPPLIER`). The role is read from the database on every request (`authenticate` in `packages/core/src/domain/identity.ts`), not from the JWT claim, so a role change or disable takes effect immediately. There is no tenant id: ORVIA is a single-merchant platform with three kinds of external principals, each tied to data by a different key.

| Principal | Ownership key | Where it is stored | How a handler enforces it |
|---|---|---|---|
| Customer (account) | `userId` (ObjectId of `users`) | `Address, Cart, Wishlist, Session, Review, Notification, ReferralCode, FindSavedSearch, FindPriceAlert, LoyaltyAccount, LoyaltyLedger, LoyaltyRedemption, C360*` (all C360 collections), `Agents*` (`AgentsConversation, AgentsEscalation, AgentsOutcome, AgentsPending, AgentsReplacementRequest`) | `userId` placed **in the query filter** (`findOneAndUpdate({ _id, userId })`, `deleteOne({ _id, userId })`), see `find/service.ts`, `customer360/service.ts` |
| Customer (guest or pre-account) | order **email** (+ order number) | `Order.email`, `ReturnRequest.email`, `SupportTicket.email`, `AftersalesReturn.email`, `RescueCase.email`, `Cart.email`, `Customer.email` | Only counts once the account's email is **verified** (`ownerEmail`/`ownerOr` in `apps/api/src/util.ts`, `ownerMatch` in `customer360/privacy.ts`). Guests present order number + email to `GET /orders/lookup` (rate limited) |
| Creator | `creatorId` (= `CreatorProfile._id`; `CreatorProfile.userId` is unique and links to the account) | `CreatorCollection, CreatorLink, CreatorClick, CreatorLedger, CreatorPayout, CreatorFlag, CollectionComment.creatorId` | Handlers call `requireApprovedCreator(user.id)` and then filter by `creatorId` in the query (`creators/profiles.ts`, "ownership enforced in the query (IDOR)") |
| Supplier (portal user) | `supplierId` (= `Supplier._id`); membership is `Supplier.userIds` (array of user ids) | `Shipment.supplierId, SupplierProduct, SupplierOffer, Warehouse, AftersalesClaim, AftersalesSupplierPolicy, TrustSupplierSnapshot, Suppliernet*` (all) | `resolvePortalSupplier(userId, requestedId)` in `suppliernet/portal.ts`: the supplier is looked up through `Supplier.find({ userIds: userId })`; a requested `supplierId` that is not theirs returns 404 exactly like a missing one. Every portal query then uses the resolved `_id`, never the client value |
| Staff | none (global), gated by permission | everything | `route()` with `auth: 'staff'` and a `permission` (see the permission matrix in [ORVIA_API_REFERENCE.md](ORVIA_API_REFERENCE.md)); `CUSTOMER` and `SUPPLIER` roles are rejected before the permission check |

Notes:
- Collections with **no** per-user key are global reference or operational data: `Product, Category, CountryConfig, Coupon, Promotion, SystemSetting, MarketSource/Document/Topic, Finance*, Trust*(product), Events*(campaigns, outbox)`. They are reachable only through staff routes or public read routes that return curated views.
- Supplier credentials (`Supplier.credentialsEnc`) are `select: false` and AES-256-GCM encrypted (`packages/auth/src/index.ts` `encryptSecret`; key `ENCRYPTION_KEY`, required in production by `packages/config/src/index.ts`).
- Customer-visible Delivery Rescue and Digital Product Passport responses are built through allow-list views (no supplier ids, costs or margins) and the rescue ownership check returns 404 for foreign orders (`rescue/service.ts` `authorizeViewer`).

### 2. Append-only and immutable data

| Collection | Mechanism | Enforced by |
|---|---|---|
| `finance_ledger` | Fields `immutable: true`; `pre` hooks reject `updateOne/updateMany/findOneAndUpdate/findOneAndReplace/replaceOne/deleteOne/deleteMany/findOneAndDelete` and non-new `save` with "The finance ledger is append-only: post a reversal entry instead" (`models.finance.ts:55-57`). Corrections are reversal entries keyed `rev:<key>`. | Mongoose middleware only. The native driver (`Model.collection.*`) and DB users with write access bypass it. |
| `rescue_timeline` | Same pattern; update/delete throw "rescue_timeline is append-only" (`models.rescue.ts:66-70`) | Mongoose middleware only |
| `orders` financial fields (`items`, `amounts`, `email`, `country`, `currency`, `orderNumber`, `idempotencyKey`, `address`) | `immutable: true` (`models.ts` order schema). Account anonymization deliberately uses `Order.collection.updateMany` to blank PII while keeping money fields (`customer360/service.ts` `anonymizeAccount`) | Mongoose document/update casting only |
| `customer360_consents` | Append-only by design ("current state is the latest record per (userId, kind)", `models.customer360.ts:6`); the only update in code strips `ipHash` on account deletion (`customer360/service.ts:404`) | **Convention only**, no hook |
| `audit_logs` | Insert-only in code (no update/delete call exists anywhere; `timestamps:false, versionKey:false`) | **Convention only**: no schema hook and no database role separation. Anyone with Mongo write access can alter it. Recommended: a separate MongoDB user for the API without update/delete on `audit_logs`, or forward to WORM storage (not implemented) |
| `find_price_snapshots`, `trust_evidence` | Rows are never edited by code; evidence is superseded (`supersededAt`) rather than overwritten | Convention only |
| `creator_ledger`, `loyalty_ledger` | "Append-only except status transitions" (`models.creators.ts:96`): `status`, `remaining` and pre-payable amounts may change; `idempotencyKey` unique | Convention plus unique key |

### 3. Idempotency keys and uniqueness constraints

The generated section "Unique indexes" lists all of them. The ones that carry exactly-once guarantees:

| Guarantee | Constraint |
|---|---|
| Checkout replay returns the original order | `orders.idempotencyKey` unique; duplicate-key (11000) on create re-reads the order (`orders.ts` `createOrderFromCart`) |
| Payment webhook event processed once | `webhook_events { provider, eventId }` unique, claimed before processing (`aftersales/webhookClaim.ts`); one payment per `{ provider, intentId }` |
| Money never double-posted | `refunds.idempotencyKey`, `finance_ledger.idempotencyKey`, `creator_ledger.idempotencyKey`, `loyalty_ledger.idempotencyKey` unique; `creator_ledger` has `{ orderId, kind }` (non-unique) for lookups |
| Never two supplier orders for one order line | `shipments.idempotencyKey` unique and `shipments { orderId, lineKey }` unique **partial** (active statuses only), row inserted `PENDING_CREATE` before the supplier call (`orders.ts` `fulfillOrder`) |
| One active Delivery Rescue case per line; one action per option | `rescue_cases.dedupeKey` unique partial on active states; `rescue_actions.idempotencyKey` unique; `rescue_consents { caseId, round, optionId }` unique |
| Queue de-duplication | `jobs.dedupeKey` unique partial on `queued/active`; `exceptions.dedupeKey` unique partial on `open/in_progress`; `notifications.dedupeKey` unique partial |
| One conversion event per provider | `events_outbox { eventId, provider }` unique; `events_campaign_recipients { campaignId, email }` unique |
| One open payout per creator/currency | `creator_payouts { creatorId, currency }` unique partial on `requested/approved` |
| One referral reward per referee | `referrals.refereeEmail` unique |
| One review per user per product | `reviews { productId, userId }` unique |
| One pending assistant action per order line | `agents_pending_actions { orderId, sku, state }` unique partial on `pending` |
| One return record per core return | `aftersales_returns.returnId` and `rmaNumber` unique |

Money is stored as integer minor units with an integer validator (`money`/`signedMoney` in `helpers.ts`).

### 4. TTL and retention

TTL indexes are listed in the generated "TTL indexes" table. Retention that is **not** a TTL index (done by jobs or by hand):

| Data | Retention | Mechanism |
|---|---|---|
| Sessions | document expires 30 days after `expiresAt` | TTL on `sessions.expiresAt` (`models.ts:57`) |
| `trust_*_snapshots` | 180 days | `trust_recompute` job prunes (`trust/service.ts:192-194`) |
| Commerce Memory items | per-user `retentionDays` (0 = until deleted) | `customer360_sweep` job deletes expired rows (`customer360/*`); index on `expiresAt` is partial, **not** TTL |
| Assistant conversations / agent runs / usage | per-document `expiresAt` | TTL `expireAfterSeconds: 0` on `agents_*` (`models.agents.ts`) plus `agents_maintenance` job |
| Orders, payments, refunds, ledger, audit log, consent records | **no automatic expiry** | Retained deliberately (accounting and evidence); the anonymization path blanks PII only |
| `analytics` raw events | 180 days | TTL |
| `jobs` | completed jobs 14 days; dead jobs kept | partial TTL |
| `webhook_events` | 90 days | TTL |

There is no documented legal retention schedule per market; the periods above are engineering defaults and need legal review.

### 5. PII-bearing collections and the export / anonymization paths

PII (name, email, phone, postal address, IP, free text written by or about a customer) is held in: `users, customers, addresses, carts, orders (email, address, fraud.ip), returns, aftersales_returns (email, returnAddress), support_tickets (email, messages), reviews, notifications (to, body), sessions (ip, userAgent), referrals, referral_codes, rescue_cases (email), exceptions (customerEmail), events_campaign_recipients, events_unsubscribes, events_sessions (client.ip, userAgent), analytics (userId), agents_conversations (message text), agents_escalations (context), find_saved_searches (query), creator_comments, creator_profiles` and the Customer 360 collections. Hashed or salted identifiers (`ipHash`, `addressHash`, `phoneHash`) appear in `customer360_consents, rescue_consents, creator_clicks, referral_signals`.

- **Export** (`GET /api/v1/account/privacy/export`, rate limited 5/hour, `customer360/service.ts` `exportCustomerData`): assembles account, customer record, addresses, orders, returns, refunds, tickets, wishlist, reviews, referrals, consents, communication preferences, LifeGraph, memory, product interactions, loyalty, staff notes, deletion requests and notification metadata. It does **not** include: `aftersales_returns`, `rescue_cases`, assistant conversations, saved searches / price alerts, creator data, events sessions. Those holdings are not exported today (gap, listed in the security document).
- **Deletion** (`POST /account/privacy/deletion`, cooling-off then staff review; `anonymizeAccount`): blanks PII on orders, customer, returns, tickets, reviews, notifications, referrals; deletes addresses, wishlist, carts, sessions, analytics events, LifeGraph, memory, profile, staff notes; keeps order money fields and the consent log (without `ipHash`). Rows keyed by email are only matched when the account email is verified. **Not covered** (gap): `aftersales_returns`, `rescue_cases/consents`, `exceptions.customerEmail`, `orders.fraud.ip`, `events_campaign_recipients`, `events_sessions`, `agents_*`, `find_saved_searches/price_alerts`, `loyalty_*`, `creator_*`. The pure plan (`buildAnonymizationPlan`) lists what the executor does retain.
- Staff access to a customer profile is masked by default and audited when revealed (`customer360Profile`, `minimizeProfileForStaff`).

### 6. Index review

Reviewed by reading the query shapes of customer-facing and hot paths against `schema.indexes()` output.

**Added in this build** (additive, `packages/database/src/models.ts`; take effect when indexes are synced, e.g. `npm run migrate`):

| Index | Query it serves |
|---|---|
| `returns { userId, createdAt:-1 }`, `returns { email }` | `GET /account/returns` (`$or` userId/email), privacy export and anonymization. Previously only `orderId` and `status` were indexed, so the lookup was a collection scan |
| `support_tickets { userId, updatedAt:-1 }`, `{ email }` | `GET /support/tickets`, export, anonymization (previously only `status`) |
| `notifications { userId, createdAt:-1 }` (partial: userId exists), `{ to }` | privacy export and anonymization |
| `audit_logs { actor, timestamp:-1 }` | `GET /admin/audit?actor=` (previously only single-field `timestamp`, `action`, `resource`, `resourceId`) |
| `analytics { userId, ts:-1 }` (partial: userId exists) | privacy export (`AnalyticsEvent.find({ userId }).sort({ ts })`) and `deleteMany({ userId })` |
| `reviews { userId }` | export and anonymization (the existing unique index leads with `productId`) |

**Reviewed and left as is** (note, not a defect):
- Admin text search uses case-insensitive regexes (`adminCommerce.ts` orders / products / customers, `customer360/service.ts` customer search `name`): `/^prefix/i` and unanchored regexes cannot use a normal index efficiently. These are staff-only, paginated and escaped, so the cost is bounded but grows with collection size. If admin search becomes slow, add a lowercase normalized field or a text/Atlas Search index.
- Storefront search builds an in-process index from sellable products (`search.ts` `getIndex`, `MAX_DOCS` limit, TTL cache, invalidated by jobs). It is per process memory, not a database query; the Mongo text index on products exists but the hot path does not use it.
- `exceptions.customerEmail` and `rescue_cases.email` are matched by email in support and anonymization paths; `rescue_cases { email, orderNumber }` exists, `exceptions` has no `customerEmail` index. Exception volume is small and queue reads use `{ status, priority, createdAt }`.
- Ledger-style collections have the lookup indexes their sync and reconciliation jobs use (`finance_ledger { refs.orderId, kind }`, `{ lines.account, postedAt }`; `creator_ledger { creatorId, status, currency }`).
- Index creation in a live cluster depends on `autoIndex` / the `migrate` script. This review did not connect to a database, so the actual state of any deployed cluster is **unverified**.
