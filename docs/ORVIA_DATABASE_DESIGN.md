# ORVIA database design

> The model reference below (sections "Model index" and "Model reference") is **generated** from the registered Mongoose models by `scripts/gen-db-design.ts`. Regenerate with `npm run docs:db`. The review sections after it are hand-written from the code (source file: `docs/ORVIA_DATABASE_DESIGN.handwritten.md`) and every claim cites a file; they are not regenerated.
>
> 116 models across 11 model files (15 domains). MongoDB via Mongoose; money is integer minor units (`money`/`signedMoney` helpers in `packages/database/src/helpers.ts`). Index lists include field-level `index/unique` options as Mongoose reports them through `schema.indexes()`; whether they exist in a live cluster depends on `autoIndex`/`syncIndexes` (see `packages/database/src/connect.ts` and `scripts/migrate.ts`).

## Model index

- Core commerce (`packages/database/src/models.ts`): Address, Cart, Category, CountryConfig, Coupon, Customer, Exception, Inventory, Order, OrderItem, Payment, Product, ProductAsset, ProductScore, ProductVariant, Promotion, Referral, ReferralCode, Refund, Return, Review, Shipment, SupportTicket, Warehouse, Wishlist
- Identity, audit and platform (`packages/database/src/models.ts`): AuditLog, Job, MockStore, Notification, Report, Role, Session, SystemSetting, User, WebhookEvent
- Suppliers (core) (`packages/database/src/models.ts`): Supplier, SupplierOffer, SupplierProduct
- Ads, growth and analytics (`packages/database/src/models.ts`): AdAccount, AdCreative, AdMetric, AnalyticsEvent, Campaign, MeasuredCpa, MeasuredRefund
- Market intelligence and AI operations (`packages/database/src/models.ts`): AiDecision, AiTask, MarketDocument, MarketSource, MarketTopic
- After-sales (`packages/database/src/models.aftersales.ts`): AftersalesChargeback, AftersalesClaim, AftersalesConfig, AftersalesReturn, AftersalesSupplierPolicy
- TrustGraph (`packages/database/src/models.trust.ts`): TrustEvidence, TrustProductRiskSnapshot, TrustSupplierSnapshot
- Delivery Rescue (`packages/database/src/models.rescue.ts`): RescueAction, RescueCase, RescueConsent, RescueTimeline
- Customer 360 (`packages/database/src/models.customer360.ts`): C360Consent, C360DeletionRequest, C360LifeNode, C360Memory, C360Profile, C360StaffNote
- Find (search and discovery) (`packages/database/src/models.find.ts`): FindPriceAlert, FindPriceSnapshot, FindSavedSearch
- Finance ledger (`packages/database/src/models.finance.ts`): FinanceFxRate, FinanceLedgerEntry, FinanceState
- Creators and loyalty (`packages/database/src/models.creators.ts`): CollectionComment, CreatorClick, CreatorCollection, CreatorFlag, CreatorLedger, CreatorLink, CreatorPayout, CreatorProfile, CreatorProgramConfig, LoyaltyAccount, LoyaltyLedger, LoyaltyRedemption, ReferralSignal
- Events and marketing outbox (`packages/database/src/models.events.ts`): EventsCampaign, EventsCampaignRecipient, EventsCursor, EventsExperiment, EventsExperimentEvent, EventsOutbox, EventsSegment, EventsSession, EventsUnsubscribe
- Supplier network and portal (`packages/database/src/models.suppliernet.ts`): SuppliernetCatalogItem, SuppliernetDispute, SuppliernetDocument, SuppliernetIngestionJob, SuppliernetMatchCandidate, SuppliernetProfile, SuppliernetReturnAuth, SuppliernetSla, SuppliernetSlaSnapshot, SuppliernetStatement, SuppliernetStockCheck, SuppliernetVerificationStep
- AI agents (`packages/database/src/models.agents.ts`): AgentsConfig, AgentsConversation, AgentsEscalation, AgentsOutcome, AgentsPending, AgentsReplacementRequest, AgentsRun, AgentsUsage

## Unique indexes (idempotency and integrity keys)

| Model | Unique key | Condition |
|---|---|---|
| Cart | `{ token }` |  |
| Category | `{ slug }` |  |
| CountryConfig | `{ code }` |  |
| Coupon | `{ code }` |  |
| Customer | `{ userId }` | sparse |
| Customer | `{ email }` |  |
| Exception | `{ dedupeKey }` | partial {"dedupeKey":{"$type":"string"},"status":{"$in":["open","in_progress"]}} |
| Inventory | `{ productId, country }` |  |
| Order | `{ orderNumber }` |  |
| Order | `{ idempotencyKey }` |  |
| Payment | `{ provider, intentId }` |  |
| Product | `{ slug }` |  |
| Product | `{ sku }` |  |
| ProductVariant | `{ sku }` |  |
| Promotion | `{ code }` | partial {"code":{"$type":"string"}} |
| Referral | `{ refereeEmail }` |  |
| ReferralCode | `{ userId }` |  |
| ReferralCode | `{ code }` |  |
| Refund | `{ idempotencyKey }` |  |
| Review | `{ productId, userId }` |  |
| Shipment | `{ idempotencyKey }` |  |
| Shipment | `{ orderId, lineKey }` | partial {"status":{"$in":["PENDING_CREATE","CREATED","SHIPPED","IN_TRANSIT","OUT_FOR_DELIVERY","DELIVERED","RETURNED"]}} |
| Warehouse | `{ supplierId, code }` |  |
| Wishlist | `{ userId }` |  |
| Job | `{ dedupeKey }` | partial {"dedupeKey":{"$type":"string"},"status":{"$in":["queued","active"]}} |
| MockStore | `{ kind, key }` |  |
| Notification | `{ dedupeKey }` | partial {"dedupeKey":{"$type":"string"}} |
| Report | `{ kind, date }` |  |
| Role | `{ name }` |  |
| SystemSetting | `{ key }` |  |
| User | `{ email }` |  |
| WebhookEvent | `{ provider, eventId }` |  |
| Supplier | `{ code }` |  |
| SupplierOffer | `{ productId, supplierId, destination }` |  |
| SupplierProduct | `{ supplierId, externalId }` |  |
| AdAccount | `{ platform, accountId }` |  |
| AdMetric | `{ campaignId, creativeId, date }` |  |
| Campaign | `{ platform, externalId }` | partial {"externalId":{"$type":"string"}} |
| MeasuredCpa | `{ scope, key, country, channel }` |  |
| MeasuredRefund | `{ productId, supplierId, country }` |  |
| MarketDocument | `{ sourceId, urlHash, day }` |  |
| AftersalesChargeback | `{ provider, disputeId }` |  |
| AftersalesClaim | `{ claimNumber }` |  |
| AftersalesConfig | `{ key }` |  |
| AftersalesReturn | `{ returnId }` |  |
| AftersalesReturn | `{ rmaNumber }` |  |
| AftersalesSupplierPolicy | `{ supplierId }` |  |
| RescueAction | `{ idempotencyKey }` |  |
| RescueCase | `{ dedupeKey }` | partial {"state":{"$in":["detected","planned","awaiting_customer","awaiting_staff","executing","monitoring","escalated"]}} |
| RescueConsent | `{ caseId, round, optionId }` |  |
| C360LifeNode | `{ userId, kind, value }` |  |
| C360Profile | `{ userId }` |  |
| FindPriceAlert | `{ userId, productId, country }` |  |
| FinanceLedgerEntry | `{ idempotencyKey }` |  |
| FinanceState | `{ key }` |  |
| CreatorCollection | `{ creatorId, slug }` |  |
| CreatorFlag | `{ dedupeKey }` |  |
| CreatorLedger | `{ idempotencyKey }` |  |
| CreatorLink | `{ code }` |  |
| CreatorPayout | `{ creatorId, currency }` | partial {"status":{"$in":["requested","approved"]}} |
| CreatorProfile | `{ userId }` |  |
| CreatorProfile | `{ handle }` |  |
| CreatorProgramConfig | `{ key }` |  |
| LoyaltyAccount | `{ userId }` |  |
| LoyaltyLedger | `{ idempotencyKey }` |  |
| LoyaltyRedemption | `{ code }` |  |
| ReferralSignal | `{ orderId }` |  |
| EventsCampaignRecipient | `{ campaignId, email }` |  |
| EventsCursor | `{ key }` |  |
| EventsExperiment | `{ key }` |  |
| EventsExperimentEvent | `{ experimentKey, visitorId, kind }` |  |
| EventsOutbox | `{ eventId, provider }` |  |
| EventsSession | `{ sessionId }` |  |
| EventsUnsubscribe | `{ email }` |  |
| SuppliernetCatalogItem | `{ supplierId, externalId }` |  |
| SuppliernetDispute | `{ number }` |  |
| SuppliernetMatchCandidate | `{ supplierProductId, productId }` |  |
| SuppliernetProfile | `{ supplierId }` |  |
| SuppliernetReturnAuth | `{ number }` |  |
| SuppliernetSla | `{ supplierId }` |  |
| SuppliernetStatement | `{ supplierId, number }` |  |
| SuppliernetVerificationStep | `{ supplierId, kind }` |  |
| AgentsConfig | `{ agentId }` |  |
| AgentsConversation | `{ sessionId }` |  |
| AgentsEscalation | `{ dedupeKey }` | partial {"dedupeKey":{"$type":"string"},"status":"open"} |
| AgentsOutcome | `{ orderId, problem }` |  |
| AgentsReplacementRequest | `{ orderId, sku, state }` | partial {"state":"pending"} |
| AgentsUsage | `{ agentId, day }` |  |

## TTL indexes (automatic expiry)

| Model | Field | Expires after | Only when |
|---|---|---|---|
| Job | `{ completedAt }` | 1209600s (14 d) | {"status":"completed"} |
| Session | `{ expiresAt }` | 2592000s (30 d) |  |
| WebhookEvent | `{ createdAt }` | 7776000s (90 d) |  |
| AnalyticsEvent | `{ ts }` | 15552000s (180 d) |  |
| MarketDocument | `{ observedAt }` | 10368000s (120 d) |  |
| FindPriceSnapshot | `{ observedAt }` | 63072000s (730 d) |  |
| CreatorClick | `{ at }` | 15552000s (180 d) |  |
| EventsOutbox | `{ updatedAt }` | 7776000s (90 d) | {"status":{"$in":["sent","suppressed","skipped"]}} |
| EventsSession | `{ lastSeenAt }` | 7776000s (90 d) |  |
| SuppliernetSlaSnapshot | `{ computedAt }` | 31536000s (365 d) |  |
| SuppliernetStockCheck | `{ checkedAt }` | 34560000s (400 d) |  |
| AgentsConversation | `{ expiresAt }` | 0s (0 d) |  |
| AgentsRun | `{ expiresAt }` | 0s (0 d) |  |
| AgentsUsage | `{ expiresAt }` | 0s (0 d) |  |

## Model reference

### Core commerce

Owner file: `packages/database/src/models.ts`

#### Address  (collection `addresses`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `userId` | ObjectId->User | required |
| `fullName` | String |  |
| `line1` | String |  |
| `line2` | String |  |
| `city` | String |  |
| `region` | String |  |
| `postalCode` | String |  |
| `country` | String | enum(US/CA/IN) |
| `phone` | String |  |
| `isDefault` | Boolean | default false |

Indexes:
- `{ userId:1 }`

#### Cart  (collection `carts`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `token` | String | required |
| `userId` | ObjectId->User |  |
| `email` | String |  |
| `country` | String | enum(US/CA/IN) |
| `items` | [subdoc: productId, sku, quantity] |  |
| `couponCode` | String |  |
| `marketingConsent` | Boolean | default false |
| `creatorAttribution` | Embedded |  |
| `convertedOrderId` | ObjectId->Order |  |
| `abandonment.stage` | Number | default 0 |
| `abandonment.lastSentAt` | Date |  |
| `abandonment.stopped` | Boolean | default false |
| `lastActivityAt` | Date |  |

Indexes:
- `{ token:1 }` UNIQUE
- `{ userId:1 }`
- `{ lastActivityAt:1 }`

#### Category  (collection `categories`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `slug` | String | required |
| `name` | String | required |
| `parentSlug` | String |  |
| `path` | [String] |  |
| `dynamic` | Boolean | default false |
| `position` | Number | default 0 |
| `image` | String |  |

Indexes:
- `{ slug:1 }` UNIQUE
- `{ parentSlug:1 }`

#### CountryConfig  (collection `country_configs`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `code` | String | required; enum(US/CA/IN) |
| `config` | Mixed |  |

Indexes:
- `{ code:1 }` UNIQUE

#### Coupon  (collection `coupons`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `code` | String | required |
| `promotionId` | ObjectId->Promotion | required |
| `redemptions` | [subdoc: orderId, email, at] |  |

Indexes:
- `{ code:1 }` UNIQUE

#### Customer  (collection `customers`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `userId` | ObjectId->User |  |
| `email` | String | required |
| `name` | String |  |
| `country` | String | enum(US/CA/IN) |
| `ordersCount` | Number | default 0 |
| `lifetimeValue` | Number | min 0; default 0 |
| `lastOrderAt` | Date |  |
| `marketingConsent` | Boolean | default false |
| `riskFlags` | [String] |  |
| `isDemo` | Boolean | default false |

Indexes:
- `{ userId:1 }` UNIQUE, sparse
- `{ email:1 }` UNIQUE

#### Exception  (collection `exceptions`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `kind` | String | required; enum(FRAUD/CHARGEBACK/SAFETY/COMPLIANCE/HIGH_VALUE_REFUND/SUPPLIER_FAILURE/PAYMENT_FAILURE/SUSPICIOUS_ORDER/AUTHENTICITY/PRICE_CHANGE/NEGATIVE_MARGIN/TRACKING/MISSING_IMAGE/MANUAL_FULFILLMENT/RECONCILIATION/STOCK_STALE/ORGANIC_CLAIM/MARKET_SOURCE/EXPORT_ATTESTATION/OTHER) |
| `priority` | String | enum(low/medium/high/critical); default "medium" |
| `status` | String | enum(open/in_progress/resolved/dismissed); default "open" |
| `issue` | String | required |
| `orderId` | ObjectId->Order |  |
| `productId` | ObjectId->Product |  |
| `customerEmail` | String |  |
| `aiRecommendation` | String |  |
| `suggestedAction` | String |  |
| `actionCode` | String |  |
| `details` | Mixed |  |
| `dedupeKey` | String |  |
| `resolvedBy` | String |  |
| `resolvedAt` | Date |  |
| `resolution` | String |  |

Indexes:
- `{ kind:1 }`
- `{ status:1 }`
- `{ dedupeKey:1 }` UNIQUE, partial {"dedupeKey":{"$type":"string"},"status":{"$in":["open","in_progress"]}}
- `{ status:1, priority:1, createdAt:-1 }`

#### Inventory  (collection `inventory`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `productId` | ObjectId->Product | required |
| `country` | String | required; enum(US/CA/IN) |
| `available` | Number | default 0 |
| `threshold` | Number | default 10 |
| `status` | String | enum(IN_STOCK/LOW_STOCK/OUT_OF_STOCK/SUPPLIER_UNAVAILABLE/PRICE_CHANGED); default "IN_STOCK" |
| `bestSupplierId` | ObjectId->Supplier |  |
| `syncedAt` | Date |  |

Indexes:
- `{ status:1 }`
- `{ productId:1, country:1 }` UNIQUE

#### Order  (collection `orders`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `orderNumber` | String | required |
| `idempotencyKey` | String | required |
| `userId` | ObjectId->User |  |
| `email` | String | required |
| `country` | String | required; enum(US/CA/IN) |
| `currency` | String | required |
| `items` | [subdoc: productId, sku, title, image, quantity, unitPrice, lineKey] |  |
| `address` | Embedded |  |
| `shippingMethod` | String |  |
| `amounts` | Embedded |  |
| `couponCode` | String |  |
| `status` | String | enum(PENDING_PAYMENT/PAID/SUPPLIER_PROCESSING/SHIPPED/IN_TRANSIT/DELIVERED/CANCELLED/REFUND_REQUESTED/REFUNDED/EXCEPTION); default "PENDING_PAYMENT" |
| `timeline` | [subdoc: status, at, note, actor] |  |
| `payment.provider` | String |  |
| `payment.intentId` | String |  |
| `payment.status` | String | enum(pending/succeeded/failed/refunded/partially_refunded); default "pending" |
| `payment.paidAt` | Date |  |
| `payment.fee` | Number | min 0; default 0 |
| `fraud.score` | Number |  |
| `fraud.level` | String | enum(low/medium/high) |
| `fraud.signals` | [String] |  |
| `fraud.ip` | String |  |
| `fulfillment.state` | String | enum(none/queued/processing/placed/partial/failed); default "none" |
| `fulfillment.attempts` | Number | default 0 |
| `fulfillment.lastError` | String |  |
| `costs.supplierCost` | Number | min 0; default 0 |
| `costs.shippingCost` | Number | min 0; default 0 |
| `costs.duties` | Number | min 0; default 0 |
| `costs.paymentFee` | Number | min 0; default 0 |
| `costs.refunded` | Number | min 0; default 0 |
| `profit.contribution` | Number | default 0 |
| `profit.margin` | Number | default 0 |
| `attribution.campaignId` | ObjectId->Campaign |  |
| `attribution.utmSource` | String |  |
| `creatorAttribution` | Embedded |  |
| `exceptionOpen` | Boolean | default false |
| `cancelledAt` | Date |  |
| `deliveredAt` | Date |  |
| `isDemo` | Boolean | default false |

Indexes:
- `{ orderNumber:1 }` UNIQUE
- `{ idempotencyKey:1 }` UNIQUE
- `{ userId:1 }`
- `{ email:1 }`
- `{ status:1 }`
- `{ exceptionOpen:1 }`
- `{ country:1, createdAt:-1 }`
- `{ status:1, createdAt:-1 }`
- `{ payment.intentId:1 }`
- `{ createdAt:-1 }`
- `{ items.productId:1 }`
- `{ creatorAttribution.creatorId:1, createdAt:-1 }` sparse

#### OrderItem  (collection `order_items`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `orderId` | ObjectId->Order | required |
| `productId` | ObjectId->Product |  |
| `sku` | String |  |
| `title` | String |  |
| `quantity` | Number |  |
| `unitPrice` | Number | min 0; default 0 |
| `country` | String | enum(US/CA/IN) |

Indexes:
- `{ orderId:1 }`
- `{ productId:1 }`
- `{ createdAt:1 }`
- `{ productId:1, createdAt:-1 }`

#### Payment  (collection `payments`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `orderId` | ObjectId->Order | required |
| `provider` | String | required |
| `intentId` | String | required |
| `clientSecret` | String |  |
| `amount` | Number | min 0; default 0 |
| `currency` | String |  |
| `status` | String | enum(pending/succeeded/failed/refunded/partially_refunded); default "pending" |
| `failureReason` | String |  |
| `refundedAmount` | Number | min 0; default 0 |

Indexes:
- `{ orderId:1 }`
- `{ provider:1, intentId:1 }` UNIQUE

#### Product  (collection `products`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `slug` | String | required |
| `sku` | String | required |
| `title` | String | required |
| `brand` | String | default "Orvia" |
| `description` | String |  |
| `bullets` | [String] |  |
| `features` | [String] |  |
| `benefits` | [String] |  |
| `faqs` | [subdoc: q, a] |  |
| `seo.title` | String |  |
| `seo.metaDescription` | String |  |
| `seo.keywords` | [String] |  |
| `social.instagram` | String |  |
| `social.tiktokScript` | String |  |
| `social.facebookAd` | String |  |
| `images` | [subdoc: url, alt, card, thumb, zoom, assetId, source, license] |  |
| `imageStatus` | String | enum(MISSING/PENDING/READY/FAILED); default "MISSING" |
| `organic.sourceTitle` | String |  |
| `organic.removedClaims` | [String] |  |
| `organic.evidence` | [subdoc: claim, type, body, certId, certUrl, sourceUrl, observedAt, jurisdiction, ...] |  |
| `videos` | [subdoc: url, licensed] |  |
| `category` | String |  |
| `topCategory` | String |  |
| `tags` | [String] |  |
| `attributes` | Map |  |
| `attributes.$*` | String |  |
| `state` | String | enum(DISCOVERED/ANALYZING/APPROVED/DRAFT/IMAGE_REQUIRED/COMPLIANCE_REVIEW/SUPPLIER_REVIEW/PRICING_REVIEW/READY/PUBLISHED/TESTING/WINNER/SCALING/DECLINING/PAUSED/OUT_OF_STOCK/BANNED/ARCHIVED); default "DRAFT" |
| `stateHistory` | [subdoc: state, at, by, reason] |  |
| `markets` | [subdoc: country, enabled, currency, price, compareAtPrice, pricingStrategy, expectedProfit, expectedMargin, ...] |  |
| `stats.ratingAvg` | Number | default 0 |
| `stats.ratingCount` | Number | default 0 |
| `stats.soldCount` | Number | default 0 |
| `stats.views` | Number | default 0 |
| `stats.trendScore` | Number | default 0 |
| `stats.conversionRate` | Number | default 0 |
| `stats.refundRate` | Number | default 0 |
| `opportunity.finalScore` | Number |  |
| `opportunity.action` | String |  |
| `opportunity.computedAt` | Date |  |
| `compliance.status` | String | enum(pending/passed/failed/review); default "pending" |
| `compliance.flags` | [String] |  |
| `compliance.checkedAt` | Date |  |
| `compliance.safetyInfo.standards` | [String] |  |
| `compliance.safetyInfo.ageRange` | String |  |
| `compliance.safetyInfo.certificateUrl` | String |  |
| `intel` | Mixed |  |
| `sourceSupplierProductId` | ObjectId->SupplierProduct |  |
| `pricingConfig.strategy` | String | default "target_margin" |
| `pricingConfig.targetMarginPct` | Number | default 0.4 |
| `inventorySyncedAt` | Date |  |
| `isDemo` | Boolean | default false |
| `deletedAt` | Date |  |

Indexes:
- `{ slug:1 }` UNIQUE
- `{ sku:1 }` UNIQUE
- `{ imageStatus:1 }`
- `{ category:1 }`
- `{ topCategory:1 }`
- `{ state:1 }`
- `{ title:text, seo.keywords:text, tags:text }`
- `{ state:1, topCategory:1, stats.trendScore:-1 }`
- `{ state:1, category:1, createdAt:-1 }`
- `{ state:1, stats.soldCount:-1 }`
- `{ markets.country:1, state:1 }`

#### ProductAsset  (collection `product_assets`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `productId` | ObjectId->Product | required |
| `kind` | String | enum(image); default "image" |
| `source` | String | required; enum(supplier/admin) |
| `sourceUrl` | String |  |
| `supplierId` | ObjectId->Supplier |  |
| `status` | String | required; enum(ready/failed) |
| `error` | String |  |
| `sha256` | String |  |
| `dhash` | String |  |
| `width` | Number |  |
| `height` | Number |  |
| `bytes` | Number |  |
| `format` | String |  |
| `hasAlpha` | Boolean |  |
| `variants.thumb` | String |  |
| `variants.card` | String |  |
| `variants.page` | String |  |
| `variants.zoom` | String |  |
| `variants.og` | String |  |
| `keys` | [String] |  |
| `alt` | String |  |
| `position` | Number | default 0 |
| `isPrimary` | Boolean | default false |
| `variantSku` | String |  |
| `countries` | [String] |  |
| `license` | String | enum(unknown/supplier_provided/owned); default "unknown" |
| `createdBy` | String |  |

Indexes:
- `{ productId:1 }`
- `{ productId:1, sha256:1 }`
- `{ productId:1, sourceUrl:1 }`

#### ProductScore  (collection `product_scores`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `productId` | ObjectId->Product | required |
| `components` | Mixed |  |
| `finalScore` | Number |  |
| `action` | String |  |
| `reasons` | [String] |  |
| `source` | String |  |
| `computedAt` | Date |  |

Indexes:
- `{ productId:1, computedAt:-1 }`

#### ProductVariant  (collection `product_variants`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `productId` | ObjectId->Product | required |
| `sku` | String | required |
| `options` | Map |  |
| `options.$*` | String |  |
| `label` | String |  |
| `image` | String |  |
| `priceDelta` | Number | default 0 |
| `supplierSku` | String |  |
| `active` | Boolean | default true |

Indexes:
- `{ productId:1 }`
- `{ sku:1 }` UNIQUE

#### Promotion  (collection `promotions`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `name` | String | required |
| `type` | String | required; enum(percentage/fixed/free_shipping/bxgy/first_order/cart/flash_sale/seasonal) |
| `code` | String |  |
| `countries` | [String] |  |
| `percent` | Number | min 0; max 0.9; default 0 |
| `fixedAmount` | Map |  |
| `fixedAmount.$*` | Number |  |
| `minSubtotal` | Map |  |
| `minSubtotal.$*` | Number |  |
| `bxgy.buy` | Number |  |
| `bxgy.get` | Number |  |
| `bxgy.productIds` | [ObjectId] |  |
| `productIds` | [ObjectId] |  |
| `startsAt` | Date |  |
| `endsAt` | Date |  |
| `usageLimit` | Number | default 0 |
| `usedCount` | Number | default 0 |
| `perUserLimit` | Number | default 1 |
| `active` | Boolean | default true |
| `automated` | Boolean | default false |
| `public` | Boolean | default false |
| `recommendedBy` | String |  |

Indexes:
- `{ code:1 }` UNIQUE, partial {"code":{"$type":"string"}}
- `{ active:1, startsAt:1, endsAt:1 }`

#### Referral  (collection `referrals`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `referrerUserId` | ObjectId->User | required |
| `referrerEmail` | String | required |
| `refereeEmail` | String | required |
| `orderId` | ObjectId->Order | required |
| `code` | String | required |
| `status` | String | required; enum(rewarded/rejected) |
| `reason` | String |  |
| `rewardCode` | String |  |

Indexes:
- `{ referrerUserId:1 }`
- `{ refereeEmail:1 }` UNIQUE

#### ReferralCode  (collection `referral_codes`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `userId` | ObjectId->User | required |
| `email` | String | required |
| `code` | String | required |
| `promotionId` | ObjectId->Promotion | required |

Indexes:
- `{ userId:1 }` UNIQUE
- `{ code:1 }` UNIQUE

#### Refund  (collection `refunds`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `orderId` | ObjectId->Order | required |
| `paymentId` | ObjectId->Payment |  |
| `amount` | Number | min 0; default 0 |
| `currency` | String |  |
| `reason` | String |  |
| `status` | String | enum(pending_approval/processing/succeeded/failed/rejected); default "processing" |
| `providerRefundId` | String |  |
| `idempotencyKey` | String | required |
| `requestedBy` | String |  |
| `failureReason` | String |  |

Indexes:
- `{ orderId:1 }`
- `{ idempotencyKey:1 }` UNIQUE

#### Return  (collection `returns`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `orderId` | ObjectId->Order | required |
| `userId` | ObjectId->User |  |
| `email` | String |  |
| `reason` | String |  |
| `details` | String |  |
| `itemSkus` | [String] |  |
| `status` | String | enum(requested/approved/rejected/received/refunded/resolved); default "requested" |
| `refundId` | ObjectId->Refund |  |
| `resolutionNote` | String |  |

Indexes:
- `{ orderId:1 }`
- `{ status:1 }`
- `{ userId:1, createdAt:-1 }`
- `{ email:1 }`

#### Review  (collection `reviews`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `productId` | ObjectId->Product | required |
| `userId` | ObjectId->User | required |
| `authorName` | String |  |
| `orderId` | ObjectId->Order |  |
| `rating` | Number | required; min 1; max 5 |
| `title` | String |  |
| `body` | String |  |
| `images` | [String] |  |
| `verifiedPurchase` | Boolean | default false |
| `helpfulVotes` | Number | default 0 |
| `votedBy` | [ObjectId] |  |
| `status` | String | enum(published/pending/rejected); default "published" |
| `sentiment` | String | enum(positive/neutral/negative) |
| `isDemo` | Boolean | default false |

Indexes:
- `{ productId:1, status:1, createdAt:-1 }`
- `{ productId:1, userId:1 }` UNIQUE
- `{ userId:1 }`

#### Shipment  (collection `shipments`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `orderId` | ObjectId->Order | required |
| `lineKey` | String | required |
| `productId` | ObjectId->Product |  |
| `sku` | String |  |
| `quantity` | Number |  |
| `supplierId` | ObjectId->Supplier | required |
| `idempotencyKey` | String | required |
| `supplierOrderId` | String |  |
| `status` | String | enum(PENDING_CREATE/CREATED/SHIPPED/IN_TRANSIT/OUT_FOR_DELIVERY/DELIVERED/FAILED/CANCELLED/RETURNED); default "PENDING_CREATE" |
| `carrier` | String |  |
| `trackingNumber` | String |  |
| `trackingUrl` | String |  |
| `estimatedDelivery` | Date |  |
| `events` | [subdoc: status, description, location, at] |  |
| `cost.productCost` | Number | min 0; default 0 |
| `cost.shippingCost` | Number | min 0; default 0 |
| `cost.duties` | Number | min 0; default 0 |
| `cost.currency` | String |  |
| `attempts` | Number | default 0 |
| `lastError` | String |  |
| `lastTrackedAt` | Date |  |
| `notified` | [String] | default [] |

Indexes:
- `{ idempotencyKey:1 }` UNIQUE
- `{ status:1 }`
- `{ orderId:1, lineKey:1 }` UNIQUE, partial {"status":{"$in":["PENDING_CREATE","CREATED","SHIPPED","IN_TRANSIT","OUT_FOR_DELIVERY","DELIVERED","RETURNED"]}}
- `{ status:1, lastTrackedAt:1 }`
- `{ orderId:1 }`
- `{ supplierId:1, createdAt:-1 }`

#### SupportTicket  (collection `support_tickets`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `userId` | ObjectId->User |  |
| `email` | String |  |
| `orderId` | ObjectId->Order |  |
| `subject` | String |  |
| `messages` | [subdoc: from, text, at, meta] |  |
| `status` | String | enum(open/pending/escalated/resolved); default "open" |
| `priority` | String | enum(low/normal/high); default "normal" |

Indexes:
- `{ status:1 }`
- `{ userId:1, updatedAt:-1 }`
- `{ email:1 }`

#### Warehouse  (collection `warehouses`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `supplierId` | ObjectId->Supplier | required |
| `code` | String | required |
| `name` | String |  |
| `country` | String | required |

Indexes:
- `{ supplierId:1 }`
- `{ supplierId:1, code:1 }` UNIQUE

#### Wishlist  (collection `wishlists`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `userId` | ObjectId->User | required |
| `productIds` | [ObjectId->Product] |  |

Indexes:
- `{ userId:1 }` UNIQUE

### Identity, audit and platform

Owner file: `packages/database/src/models.ts`

#### AuditLog  (collection `audit_logs`)

no automatic timestamps; version key `false`

| Field | Type | Constraints |
|---|---|---|
| `timestamp` | Date |  |
| `actor` | String | required |
| `actorType` | String | required; enum(user/ai/system/webhook/anonymous) |
| `action` | String | required |
| `resource` | String |  |
| `resourceId` | String |  |
| `previousValue` | Mixed |  |
| `newValue` | Mixed |  |
| `reason` | String |  |
| `aiSummary` | String |  |
| `provider` | String |  |
| `requestId` | String |  |

Indexes:
- `{ timestamp:1 }`
- `{ action:1 }`
- `{ resource:1 }`
- `{ resourceId:1 }`
- `{ actor:1, timestamp:-1 }`

#### Job  (collection `jobs`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `queue` | String | required |
| `name` | String | required |
| `payload` | Mixed |  |
| `dedupeKey` | String |  |
| `status` | String | enum(queued/active/completed/failed/dead); default "queued" |
| `runAt` | Date |  |
| `attempts` | Number | default 0 |
| `maxAttempts` | Number | default 5 |
| `lockedBy` | String |  |
| `lockedUntil` | Date |  |
| `lastError` | String |  |
| `result` | Mixed |  |
| `completedAt` | Date |  |

Indexes:
- `{ status:1, runAt:1, queue:1 }`
- `{ dedupeKey:1 }` UNIQUE, partial {"dedupeKey":{"$type":"string"},"status":{"$in":["queued","active"]}}
- `{ completedAt:1 }` TTL 1209600s, partial {"status":"completed"}

#### MockStore  (collection `mock_store`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `kind` | String | required |
| `key` | String | required |
| `data` | Mixed |  |

Indexes:
- `{ kind:1, key:1 }` UNIQUE

#### Notification  (collection `notifications`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `userId` | ObjectId->User |  |
| `orderId` | ObjectId->Order |  |
| `to` | String |  |
| `channel` | String | required; enum(email/sms/push/whatsapp) |
| `template` | String |  |
| `subject` | String |  |
| `body` | String |  |
| `status` | String | enum(queued/sent/failed/logged_dev/skipped); default "queued" |
| `provider` | String |  |
| `providerMessageId` | String |  |
| `error` | String |  |
| `dedupeKey` | String |  |

Indexes:
- `{ status:1 }`
- `{ dedupeKey:1 }` UNIQUE, partial {"dedupeKey":{"$type":"string"}}
- `{ createdAt:-1 }`
- `{ userId:1, createdAt:-1 }` partial {"userId":{"$exists":true}}
- `{ to:1 }`

#### Report  (collection `reports`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `kind` | String | default "daily_brief" |
| `date` | String | required |
| `data` | Mixed |  |
| `narrative` | String |  |
| `source` | String |  |

Indexes:
- `{ kind:1, date:1 }` UNIQUE

#### Role  (collection `roles`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `name` | String | enum(SUPER_ADMIN/ADMIN/MARKETING/OPERATIONS/SUPPORT/ANALYST/CUSTOMER/SUPPLIER) |
| `description` | String |  |
| `permissions` | [String] |  |

Indexes:
- `{ name:1 }` UNIQUE

#### Session  (collection `sessions`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `userId` | ObjectId->User | required |
| `userAgent` | String |  |
| `ip` | String |  |
| `expiresAt` | Date | required |
| `revokedAt` | Date |  |

Indexes:
- `{ userId:1 }`
- `{ expiresAt:1 }` TTL 2592000s

#### SystemSetting  (collection `system_settings`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `key` | String | required |
| `value` | Mixed |  |
| `updatedBy` | String |  |

Indexes:
- `{ key:1 }` UNIQUE

#### User  (collection `users`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `email` | String | required |
| `passwordHash` | String | required |
| `name` | String | required |
| `role` | String | enum(SUPER_ADMIN/ADMIN/MARKETING/OPERATIONS/SUPPORT/ANALYST/CUSTOMER/SUPPLIER); default "CUSTOMER" |
| `emailVerified` | Boolean | default false |
| `verifyTokenHash` | String |  |
| `verifyTokenExpires` | Date |  |
| `resetTokenHash` | String |  |
| `resetTokenExpires` | Date |  |
| `failedLogins` | Number | default 0 |
| `lockUntil` | Date |  |
| `lastLoginAt` | Date |  |
| `country` | String | enum(US/CA/IN) |
| `disabled` | Boolean | default false |
| `isDemo` | Boolean | default false |
| `deletedAt` | Date |  |

Indexes:
- `{ email:1 }` UNIQUE
- `{ role:1 }`

#### WebhookEvent  (collection `webhook_events`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `provider` | String | required |
| `eventId` | String | required |
| `type` | String |  |
| `processedAt` | Date |  |
| `outcome` | String |  |

Indexes:
- `{ provider:1, eventId:1 }` UNIQUE
- `{ createdAt:1 }` TTL 7776000s

### Suppliers (core)

Owner file: `packages/database/src/models.ts`

#### Supplier  (collection `suppliers`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `code` | String | required |
| `name` | String | required |
| `provider` | String | required |
| `country` | String | enum(US/CA/IN) |
| `servesCountries` | [String] |  |
| `priority` | Number | default 100 |
| `credentialsEnc` | String |  |
| `config` | Mixed |  |
| `fulfillmentMode` | String | enum(AUTOMATED/ASSISTED/MANUAL) |
| `sandbox` | Boolean | default false |
| `validation` | Mixed |  |
| `healthState` | String | enum(HEALTHY/DEGRADED/FAILING/DISABLED/NOT_CONFIGURED); default "NOT_CONFIGURED" |
| `consecutiveFailures` | Number | default 0 |
| `lastHealthAt` | Date |  |
| `lastSuccessfulOrderAt` | Date |  |
| `avgResponseMs` | Number |  |
| `rating` | Number | min 0; max 5; default 4 |
| `reliability` | Number | min 0; max 100; default 80 |
| `returnPolicyDays` | Number | default 14 |
| `trackingAvailable` | Boolean | default true |
| `active` | Boolean | default true |
| `apiStatus` | String | enum(ok/degraded/down/unconfigured); default "unconfigured" |
| `apiStatusMessage` | String |  |
| `lastSyncAt` | Date |  |
| `stats.ordersTotal` | Number | default 0 |
| `stats.ordersFailed` | Number | default 0 |
| `stats.ordersLate` | Number | default 0 |
| `stats.avgDeliveryDays` | Number | default 0 |
| `isDemo` | Boolean | default false |
| `userIds` | [ObjectId] | default [] |
| `network.state` | String | enum(invited/profile_submitted/documents/technical_integration/verification/probation/approved/suspended) |
| `network.supplierType` | String |  |
| `network.productionReady` | Boolean |  |
| `network.productionReadyUntil` | Date |  |
| `network.reverificationDueAt` | Date |  |
| `network.demotedAt` | Date |  |
| `network.demotionReason` | String |  |

Indexes:
- `{ code:1 }` UNIQUE
- `{ userIds:1 }`

#### SupplierOffer  (collection `supplier_offers`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `productId` | ObjectId->Product | required |
| `supplierId` | ObjectId->Supplier | required |
| `supplierProductId` | ObjectId->SupplierProduct |  |
| `externalId` | String |  |
| `destination` | String | required; enum(US/CA/IN) |
| `warehouseCountry` | String | required |
| `currency` | String | required |
| `productCost` | Number | min 0; default 0 |
| `shippingCost` | Number | min 0; default 0 |
| `fulfillmentFee` | Number | min 0; default 0 |
| `minDays` | Number | default 7 |
| `maxDays` | Number | default 14 |
| `stock` | Number | min 0; default 0 |
| `available` | Boolean | default true |
| `lastPriceChangePct` | Number | default 0 |
| `priceHistory` | [subdoc: at, productCost, shippingCost] |  |
| `syncedAt` | Date |  |
| `source` | String | enum(api/manual); default "api" |
| `confirmedAt` | Date |  |

Indexes:
- `{ productId:1, supplierId:1, destination:1 }` UNIQUE
- `{ supplierId:1, syncedAt:1 }`

#### SupplierProduct  (collection `supplier_products`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `supplierId` | ObjectId->Supplier | required |
| `externalId` | String | required |
| `productId` | ObjectId->Product |  |
| `title` | String |  |
| `description` | String |  |
| `images` | [String] |  |
| `videos` | [String] |  |
| `category` | String |  |
| `attributes` | Map |  |
| `attributes.$*` | String |  |
| `safetyInfo.standards` | [String] |  |
| `safetyInfo.ageRange` | String |  |
| `variants` | [subdoc: sku, label, options, options.$*] |  |
| `cost` | Number | min 0; default 0 |
| `currency` | String |  |
| `lastSyncAt` | Date |  |
| `importStatus` | String | enum(new/imported/rejected/review); default "new" |

Indexes:
- `{ productId:1 }`
- `{ supplierId:1, externalId:1 }` UNIQUE

### Ads, growth and analytics

Owner file: `packages/database/src/models.ts`

#### AdAccount  (collection `ad_accounts`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `platform` | String | required; enum(meta/tiktok/google) |
| `accountId` | String | required |
| `name` | String |  |
| `status` | String | enum(connected/error/disconnected); default "disconnected" |
| `statusMessage` | String |  |
| `credentialsEncrypted` | String |  |
| `dailyLimit` | Number | min 0; default 0 |
| `monthlyLimit` | Number | min 0; default 0 |
| `currency` | String | default "USD" |

Indexes:
- `{ platform:1, accountId:1 }` UNIQUE

#### AdCreative  (collection `ad_creatives`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `campaignId` | ObjectId->Campaign |  |
| `productId` | ObjectId->Product | required |
| `concept` | String | enum(problem_hook/emotional_hook/demonstration/ugc/before_after/other) |
| `hook` | String |  |
| `primaryText` | String |  |
| `headline` | String |  |
| `description` | String |  |
| `cta` | String |  |
| `videoScript` | String |  |
| `status` | String | enum(draft/active/paused/winner/loser); default "draft" |
| `externalId` | String |  |
| `source` | String | default "template" |
| `isDemo` | Boolean | default false |

Indexes:
- `{ campaignId:1 }`
- `{ productId:1 }`

#### AdMetric  (collection `ad_metrics`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `campaignId` | ObjectId->Campaign | required |
| `creativeId` | ObjectId->AdCreative |  |
| `productId` | ObjectId->Product |  |
| `platform` | String |  |
| `country` | String | enum(US/CA/IN) |
| `date` | Date | required |
| `impressions` | Number | default 0 |
| `clicks` | Number | default 0 |
| `spend` | Number | min 0; default 0 |
| `addToCart` | Number | default 0 |
| `checkouts` | Number | default 0 |
| `purchases` | Number | default 0 |
| `revenue` | Number | min 0; default 0 |
| `isDemo` | Boolean | default false |

Indexes:
- `{ productId:1 }`
- `{ campaignId:1, creativeId:1, date:1 }` UNIQUE
- `{ date:-1, country:1 }`

#### AnalyticsEvent  (collection `analytics`)

no automatic timestamps; version key `false`

| Field | Type | Constraints |
|---|---|---|
| `type` | String | required |
| `sessionId` | String |  |
| `userId` | ObjectId->User |  |
| `productId` | ObjectId->Product |  |
| `category` | String |  |
| `country` | String | enum(US/CA/IN) |
| `ts` | Date |  |
| `meta` | Mixed |  |

Indexes:
- `{ ts:1 }` TTL 15552000s
- `{ type:1, ts:-1 }`
- `{ productId:1, type:1, ts:-1 }`
- `{ sessionId:1, ts:-1 }`
- `{ userId:1, ts:-1 }` partial {"userId":{"$exists":true}}

#### Campaign  (collection `campaigns`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `platform` | String | required; enum(meta/tiktok/google) |
| `adAccountId` | ObjectId->AdAccount |  |
| `externalId` | String |  |
| `productId` | ObjectId->Product | required |
| `country` | String | required; enum(US/CA/IN) |
| `name` | String |  |
| `objective` | String | default "sales" |
| `status` | String | enum(draft/pending_launch/active/paused/ended/failed); default "draft" |
| `failureReason` | String |  |
| `dailyBudget` | Number | min 0; default 0 |
| `spent` | Number | min 0; default 0 |
| `adSets` | [subdoc: name, externalId, audience, dailyBudget] |  |
| `test.isTest` | Boolean | default true |
| `test.durationDays` | Number |  |
| `test.minImpressions` | Number |  |
| `test.minClicks` | Number |  |
| `test.minSpend` | Number |  |
| `test.targetCpa` | Number |  |
| `test.targetRoas` | Number |  |
| `test.verdict` | String | enum(WIN/CONTINUE/KILL/PENDING); default "PENDING" |
| `recommendation.action` | String |  |
| `recommendation.reason` | String |  |
| `recommendation.at` | Date |  |
| `launchedAt` | Date |  |
| `isDemo` | Boolean | default false |

Indexes:
- `{ productId:1 }`
- `{ status:1 }`
- `{ platform:1, externalId:1 }` UNIQUE, partial {"externalId":{"$type":"string"}}

#### MeasuredCpa  (collection `measured_cpa`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `scope` | String | required; enum(product/category/store) |
| `key` | String | required |
| `country` | String | required |
| `channel` | String | required; default "all" |
| `spend` | Number | min 0; default 0 |
| `orders` | Number | default 0 |
| `windowDays` | Number | default 28 |
| `source` | String | enum(ad_metrics/manual); default "ad_metrics" |
| `note` | String |  |
| `computedAt` | Date |  |

Indexes:
- `{ scope:1, key:1, country:1, channel:1 }` UNIQUE

#### MeasuredRefund  (collection `measured_refunds`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `productId` | ObjectId->Product | required |
| `supplierId` | ObjectId->Supplier | required |
| `country` | String | required |
| `orders` | Number | default 0 |
| `orderValue` | Number | min 0; default 0 |
| `refundedValue` | Number | min 0; default 0 |
| `windowDays` | Number | default 90 |
| `computedAt` | Date |  |

Indexes:
- `{ productId:1, supplierId:1, country:1 }` UNIQUE

### Market intelligence and AI operations

Owner file: `packages/database/src/models.ts`

#### AiDecision  (collection `ai_decisions`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `agent` | String | required |
| `kind` | String | required |
| `automationKey` | String |  |
| `resource` | String |  |
| `resourceId` | String |  |
| `summary` | String | required |
| `payload` | Mixed |  |
| `confidence` | Number |  |
| `status` | String | enum(proposed/approved/rejected/executed/auto_executed/failed/expired); default "proposed" |
| `mode` | String | enum(ASSISTED/AUTOMATIC) |
| `decidedBy` | String |  |
| `executedAt` | Date |  |
| `result` | Mixed |  |
| `error` | String |  |
| `dedupeKey` | String |  |

Indexes:
- `{ agent:1 }`
- `{ kind:1 }`
- `{ status:1 }`
- `{ dedupeKey:1, status:1 }`
- `{ createdAt:-1 }`

#### AiTask  (collection `ai_tasks`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `agent` | String | required |
| `status` | String | enum(running/succeeded/failed); default "running" |
| `input` | Mixed |  |
| `output` | Mixed |  |
| `confidence` | Number |  |
| `summary` | String |  |
| `provider` | String |  |
| `attempts` | Number | default 1 |
| `durationMs` | Number |  |
| `error` | String |  |

Indexes:
- `{ agent:1 }`
- `{ createdAt:-1 }`

#### MarketDocument  (collection `market_documents`)

no automatic timestamps; version key `false`

| Field | Type | Constraints |
|---|---|---|
| `sourceId` | ObjectId->MarketSource | required |
| `source` | String |  |
| `sourceUrl` | String |  |
| `urlHash` | String |  |
| `day` | String | required |
| `topicId` | ObjectId->MarketTopic |  |
| `normalizedProductName` | String |  |
| `title` | String |  |
| `keywords` | [String] |  |
| `category` | String |  |
| `country` | String | enum(US/CA/IN) |
| `observedAt` | Date | required |
| `publishedAt` | Date |  |
| `price` | Number | min 0; default 0 |
| `currency` | String |  |
| `shipping` | Number | min 0; default 0 |
| `availability` | String | enum(in_stock/out_of_stock/unknown); default "unknown" |
| `rank` | Number |  |
| `mentionCount` | Number | default 1 |

Indexes:
- `{ topicId:1 }`
- `{ normalizedProductName:1 }`
- `{ sourceId:1, urlHash:1, day:1 }` UNIQUE
- `{ keywords:1 }`
- `{ country:1, category:1, observedAt:-1 }`
- `{ observedAt:1 }` TTL 10368000s

#### MarketSource  (collection `market_sources`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `name` | String | required |
| `type` | String | required; enum(RSS/ATOM/SITEMAP/HTML_LISTING/HTML_PRODUCT/JSON_PUBLIC/SUPPLIER/INTERNAL_ANALYTICS) |
| `baseUrl` | String |  |
| `country` | String | enum(US/CA/IN) |
| `category` | String |  |
| `enabled` | Boolean | default true |
| `crawlIntervalMinutes` | Number | min 15; default 360 |
| `robotsRequired` | Boolean | default true |
| `parserConfig` | Mixed |  |
| `fetchProductPages` | Number | min 0; max 100; default 0 |
| `lastCrawledAt` | Date |  |
| `lastSuccessAt` | Date |  |
| `lastFailureAt` | Date |  |
| `lastError` | String |  |
| `failureCount` | Number | default 0 |
| `documentsCollected` | Number | default 0 |
| `healthStatus` | String | enum(NEW/HEALTHY/DEGRADED/FAILING/BLOCKED/DISABLED); default "NEW" |
| `robotsStatus` | String | enum(unknown/allowed/disallowed/unreachable); default "unknown" |
| `robotsCheckedAt` | Date |  |
| `robotsTxt` | String |  |
| `etag` | String |  |
| `lastModified` | String |  |
| `successRate` | Number | default 0 |
| `crawlCount` | Number | default 0 |

Indexes:
- `{ enabled:1 }`
- `{ enabled:1, lastCrawledAt:1 }`

#### MarketTopic  (collection `market_topics`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `normalizedName` | String | required |
| `displayName` | String |  |
| `keywords` | [String] |  |
| `category` | String |  |
| `country` | String | enum(US/CA/IN) |
| `firstSeen` | Date |  |
| `lastSeen` | Date |  |
| `observationCount` | Number | default 0 |
| `sourceCount` | Number | default 0 |
| `trendScore` | Number | default 0 |
| `confidence` | Number | default 0 |
| `status` | String | enum(TRENDING/RISING/STABLE/DECLINING/INSUFFICIENT_DATA); default "INSUFFICIENT_DATA" |
| `growthPct` | Number |  |
| `components` | Mixed |  |
| `windows` | Mixed |  |
| `evidence` | Mixed |  |
| `price` | Mixed |  |
| `internal` | Mixed |  |
| `matchedProductIds` | [ObjectId->Product] |  |
| `computedAt` | Date |  |

Indexes:
- `{ trendScore:1 }`
- `{ status:1 }`
- `{ keywords:1 }`
- `{ country:1, category:1, status:1, trendScore:-1 }`
- `{ normalizedName:1, country:1 }`

### After-sales

Owner file: `packages/database/src/models.aftersales.ts`

#### AftersalesChargeback  (collection `aftersales_chargebacks`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `provider` | String | required; enum(stripe/razorpay/mock) |
| `disputeId` | String | required |
| `orderId` | ObjectId->Order |  |
| `orderNumber` | String |  |
| `paymentId` | ObjectId->Payment |  |
| `intentId` | String |  |
| `chargeId` | String |  |
| `country` | String | enum(US/CA/IN) |
| `currency` | String |  |
| `amount` | Number | min 0; default 0 |
| `fee` | Number | min 0; default 0 |
| `reason` | String |  |
| `providerStatus` | String |  |
| `state` | String | enum(warning/needs_response/evidence_recorded/submitted/under_review/won/lost/accepted/closed); default "needs_response" |
| `evidenceDueBy` | Date |  |
| `openedAt` | Date |  |
| `closedAt` | Date |  |
| `unmatched` | Boolean | default false |
| `evidence` | [subdoc: at, by, category, text] |  |
| `submission.status` | String | enum(not_submitted/submitted_unverified/failed/unsupported); default "not_submitted" |
| `submission.at` | Date |  |
| `submission.by` | String |  |
| `submission.error` | String |  |
| `submission.providerStatus` | String |  |
| `accepted.by` | String |  |
| `accepted.at` | Date |  |
| `timeline` | [subdoc: state, at, actor, note] |  |
| `lastEventId` | String |  |
| `alerted` | [String] | default [] |

Indexes:
- `{ orderId:1 }`
- `{ state:1 }`
- `{ evidenceDueBy:1 }`
- `{ provider:1, disputeId:1 }` UNIQUE
- `{ state:1, evidenceDueBy:1 }`
- `{ createdAt:-1 }`

#### AftersalesClaim  (collection `aftersales_claims`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `claimNumber` | String | required |
| `supplierId` | ObjectId->Supplier | required |
| `orderId` | ObjectId->Order | required |
| `returnId` | ObjectId->Return |  |
| `kind` | String | required; enum(defect/non_delivery/wrong_item/damaged_in_transit) |
| `state` | String | enum(draft/submitted/acknowledged/accepted/partially_accepted/rejected/recovered/written_off); default "draft" |
| `currency` | String |  |
| `claimedAmount` | Number | min 0; default 0 |
| `approvedAmount` | Number | min 0; default 0 |
| `recoveredAmount` | Number | min 0; default 0 |
| `description` | String |  |
| `dueBy` | Date |  |
| `timeline` | [subdoc: state, at, actor, note] |  |
| `notes` | [subdoc: at, by, text, internal] |  |

Indexes:
- `{ claimNumber:1 }` UNIQUE
- `{ supplierId:1 }`
- `{ orderId:1 }`
- `{ returnId:1 }`
- `{ state:1 }`
- `{ supplierId:1, state:1 }`
- `{ createdAt:-1 }`

#### AftersalesConfig  (collection `aftersales_config`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `key` | String | required |
| `value` | Mixed |  |
| `updatedBy` | String |  |

Indexes:
- `{ key:1 }` UNIQUE

#### AftersalesReturn  (collection `aftersales_returns`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `returnId` | ObjectId->Return | required |
| `orderId` | ObjectId->Order | required |
| `orderNumber` | String |  |
| `userId` | ObjectId->User |  |
| `email` | String |  |
| `country` | String | enum(US/CA/IN) |
| `currency` | String |  |
| `rmaNumber` | String | required |
| `state` | String | enum(submitted/authorized/in_transit/received/inspected/refund_pending/replacement_pending/resolved/rejected/cancelled); default "submitted" |
| `reasonCode` | String | required; enum(damaged/defective/wrong_item/missing_parts/not_as_described/not_delivered/size_fit/changed_mind/better_price/other) |
| `details` | String |  |
| `resolution` | String | enum(refund/replacement/exchange); default "refund" |
| `items` | [subdoc: sku, title, productId, supplierId, quantity, acceptedQuantity, unitPrice, condition] |  |
| `evidenceRequired` | Boolean | default false |
| `evidence` | [subdoc: id, key, mime, bytes, uploadedAt, uploadedBy, byStaff] |  |
| `eligibility` | Mixed |  |
| `returnMethod` | String | enum(ship_back/staff_decides/none_needed) |
| `needsStaffReview` | Boolean |  |
| `instructions` | String |  |
| `returnAddress` | Mixed |  |
| `label.url` | String |  |
| `label.carrier` | String |  |
| `label.trackingNumber` | String |  |
| `label.source` | String | enum(provider/supplier_provided) |
| `label.providerKey` | String |  |
| `label.providerRef` | String |  |
| `label.issuedAt` | Date |  |
| `inspection.outcome` | String |  |
| `inspection.note` | String |  |
| `inspection.by` | String |  |
| `inspection.at` | Date |  |
| `refundCalc` | Mixed |  |
| `refundId` | ObjectId->Refund |  |
| `exchange.requestedSku` | String |  |
| `exchange.priceDifferenceRefund` | Number | min 0; default 0 |
| `fulfilment.status` | String | enum(pending/ordered/shipped/delivered) |
| `fulfilment.supplierOrderRef` | String |  |
| `fulfilment.carrier` | String |  |
| `fulfilment.trackingNumber` | String |  |
| `fulfilment.updatedAt` | Date |  |
| `supplierClaimId` | ObjectId->AftersalesClaim |  |
| `timeline` | [subdoc: state, at, actor, note] |  |
| `notes` | [subdoc: at, by, text, internal] |  |

Indexes:
- `{ returnId:1 }` UNIQUE
- `{ orderId:1 }`
- `{ userId:1 }`
- `{ email:1 }`
- `{ rmaNumber:1 }` UNIQUE
- `{ state:1 }`
- `{ state:1, createdAt:-1 }`
- `{ createdAt:-1 }`
- `{ items.supplierId:1, createdAt:-1 }`
- `{ items.productId:1, createdAt:-1 }`

#### AftersalesSupplierPolicy  (collection `aftersales_supplier_policies`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `supplierId` | ObjectId->Supplier | required |
| `supportsReturns` | String | enum(yes/no/unknown); default "unknown" |
| `supportsReplacement` | Boolean | default false |
| `supportsExchange` | Boolean | default false |
| `returnWindowDays` | Number |  |
| `defectOnly` | Boolean | default false |
| `claimWindowDays` | Number |  |
| `instructions` | String |  |
| `contactEmail` | String |  |
| `returnAddress` | Mixed |  |
| `labelProvider` | String |  |
| `updatedBy` | String |  |

Indexes:
- `{ supplierId:1 }` UNIQUE

### TrustGraph

Owner file: `packages/database/src/models.trust.ts`

#### TrustEvidence  (collection `trust_evidence`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `subject` | String | required; enum(product/supplier/manufacturer) |
| `subjectId` | ObjectId | required |
| `kind` | String | required; enum(specification/material/dimension/certificate/document/test_report/manufacturer/image_rights/other) |
| `key` | String | required |
| `value` | String | required |
| `provenance` | String | required; enum(verified/supplier_provided/customer_reported/ai_suggested) |
| `source` | String | required |
| `sourceUrl` | String |  |
| `observedAt` | Date |  |
| `expiresAt` | Date |  |
| `jurisdiction` | [String] |  |
| `note` | String |  |
| `recordedBy` | String |  |
| `supersededAt` | Date |  |

Indexes:
- `{ subject:1, subjectId:1, supersededAt:1 }`
- `{ subject:1, subjectId:1, kind:1, key:1 }`

#### TrustProductRiskSnapshot  (collection `trust_product_risk_snapshots`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `productId` | ObjectId->Product | required |
| `destination` | String | enum(US/CA/IN); default null |
| `computedAt` | Date | required |
| `modelVersion` | String | required |
| `status` | String | required; enum(insufficient_data/provisional/established) |
| `level` | String | required; enum(low/medium/high/unknown) |
| `score` | Number |  |
| `confidence` | Number | default 0 |
| `sampleSize` | Number | default 0 |
| `inputs` | Mixed |  |
| `result` | Mixed |  |
| `trigger` | String | enum(schedule/manual/on_demand); default "schedule" |

Indexes:
- `{ productId:1, destination:1, computedAt:-1 }`
- `{ level:1, score:-1 }`

#### TrustSupplierSnapshot  (collection `trust_supplier_snapshots`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `supplierId` | ObjectId->Supplier | required |
| `computedAt` | Date | required |
| `modelVersion` | String | required |
| `status` | String | required; enum(insufficient_data/provisional/established) |
| `score` | Number |  |
| `confidence` | Number | default 0 |
| `sampleSize` | Number | default 0 |
| `inputs` | Mixed |  |
| `result` | Mixed |  |
| `destinations` | [subdoc: destination, result] |  |
| `trigger` | String | enum(schedule/manual/on_demand); default "schedule" |

Indexes:
- `{ supplierId:1, computedAt:-1 }`
- `{ status:1, score:-1 }`

### Delivery Rescue

Owner file: `packages/database/src/models.rescue.ts`

#### RescueAction  (collection `rescue_actions`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `caseId` | ObjectId->RescueCase | required |
| `orderId` | ObjectId->Order | required |
| `kind` | String | required; enum(continue_shipment/reorder_same_product_alt_supplier/offer_equivalent_replacement/offer_partial_refund/offer_full_refund/escalate_human) |
| `optionId` | String | required |
| `idempotencyKey` | String | required |
| `state` | String | enum(pending/running/waiting/succeeded/failed/dead); default "pending" |
| `attempts` | Number | default 0 |
| `maxAttempts` | Number | default 4 |
| `nextAttemptAt` | Date |  |
| `lockedUntil` | Date |  |
| `lastError` | String |  |
| `result` | Mixed |  |
| `refundId` | ObjectId->Refund |  |
| `authorizedBy.mode` | String |  |
| `authorizedBy.actorType` | String |  |
| `authorizedBy.actorId` | String |  |
| `authorizedBy.consentId` | String |  |
| `cost.extraCost` | Number | default 0 |
| `cost.refund` | Number | min 0; default 0 |
| `costUsd` | Number | min 0; default 0 |

Indexes:
- `{ caseId:1 }`
- `{ idempotencyKey:1 }` UNIQUE
- `{ state:1 }`
- `{ state:1, nextAttemptAt:1 }`
- `{ createdAt:-1 }`

#### RescueCase  (collection `rescue_cases`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `orderId` | ObjectId->Order | required |
| `orderNumber` | String | required |
| `userId` | ObjectId->User |  |
| `email` | String | required |
| `lineKey` | String | required |
| `dedupeKey` | String | required |
| `country` | String |  |
| `currency` | String | required |
| `kind` | String | required; enum(supplier_cancellation/stock_shortage/supplier_acceptance_failure/failed_delivery/suspected_lost/carrier_exception/invalid_tracking/shipment_delay/unusual_delivery_pattern) |
| `severity` | String | required; enum(low/medium/high/critical) |
| `state` | String | enum(detected/planned/awaiting_customer/awaiting_staff/executing/monitoring/escalated/resolved/closed); default "detected" |
| `title` | String |  |
| `lineValue` | Number | min 0; default 0 |
| `shipmentId` | ObjectId->Shipment |  |
| `daysOverdue` | Number | default 0 |
| `alsoDetected` | [String] |  |
| `evidence` | [subdoc: code, detail, provenance, at] |  |
| `options` | [Mixed] | default [] |
| `recommendedId` | String |  |
| `recommendationReason` | String |  |
| `aiExplanation.text` | String |  |
| `aiExplanation.provenance` | String | default "ai_suggested" |
| `aiExplanation.at` | Date |  |
| `round` | Number | default 1 |
| `selectedOptionId` | String |  |
| `approval.by` | String |  |
| `approval.role` | String |  |
| `approval.at` | Date |  |
| `approval.note` | String |  |
| `approval.acknowledgedDuplicateRisk` | Boolean |  |
| `detectedAt` | Date | required |
| `plannedAt` | Date |  |
| `resolvedAt` | Date |  |
| `resolution.optionKind` | String | enum(continue_shipment/reorder_same_product_alt_supplier/offer_equivalent_replacement/offer_partial_refund/offer_full_refund/escalate_human/delivered/closed_by_staff/order_cancelled) |
| `resolution.auto` | Boolean |  |
| `resolution.by` | String |  |
| `resolution.note` | String |  |
| `actualCost.extraCost` | Number | default 0 |
| `actualCost.refund` | Number | min 0; default 0 |
| `notified` | [String] | default [] |
| `nextReviewAt` | Date |  |
| `lastSeenAt` | Date |  |
| `escalationReason` | String |  |

Indexes:
- `{ orderId:1 }`
- `{ orderNumber:1 }`
- `{ kind:1 }`
- `{ state:1 }`
- `{ nextReviewAt:1 }`
- `{ dedupeKey:1 }` UNIQUE, partial {"state":{"$in":["detected","planned","awaiting_customer","awaiting_staff","executing","monitoring","escalated"]}}
- `{ state:1, nextReviewAt:1 }`
- `{ createdAt:-1 }`
- `{ email:1, orderNumber:1 }`

#### RescueConsent  (collection `rescue_consents`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `caseId` | ObjectId->RescueCase | required |
| `orderId` | ObjectId->Order | required |
| `round` | Number | required |
| `optionId` | String | required |
| `optionKind` | String | required; enum(continue_shipment/reorder_same_product_alt_supplier/offer_equivalent_replacement/offer_partial_refund/offer_full_refund/escalate_human) |
| `termsHash` | String | required |
| `terms` | Mixed |  |
| `status` | String | enum(pending/accepted/declined/expired/revoked); default "pending" |
| `expiresAt` | Date | required |
| `decidedAt` | Date |  |
| `decidedVia` | String | enum(token/account) |
| `decidedBy` | String |  |
| `ipHash` | String |  |

Indexes:
- `{ status:1 }`
- `{ caseId:1, round:1, optionId:1 }` UNIQUE
- `{ status:1, expiresAt:1 }`

#### RescueTimeline  (collection `rescue_timeline`)

no automatic timestamps; version key `false`

| Field | Type | Constraints |
|---|---|---|
| `caseId` | ObjectId->RescueCase | required |
| `orderId` | ObjectId->Order |  |
| `at` | Date | required |
| `event` | String | required |
| `actorType` | String | required; enum(system/customer/staff) |
| `actorId` | String | required |
| `summary` | String |  |
| `data` | Mixed |  |

Indexes:
- `{ caseId:1 }`
- `{ orderId:1 }`
- `{ caseId:1, at:1 }`

### Customer 360

Owner file: `packages/database/src/models.customer360.ts`

#### C360Consent  (collection `customer360_consents`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `userId` | ObjectId->User | required |
| `kind` | String | required; enum(marketing_email/personalization/analytics/data_processing) |
| `granted` | Boolean | required |
| `policyVersion` | String | required |
| `source` | String | required; enum(account_settings/checkout/signup/staff_withdrawal/privacy_request/system) |
| `ipHash` | String |  |
| `actorId` | String |  |
| `reason` | String |  |
| `at` | Date |  |

Indexes:
- `{ userId:1, kind:1, at:-1 }`

#### C360DeletionRequest  (collection `customer360_deletion_requests`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `userId` | ObjectId->User | required |
| `status` | String | enum(requested/ready/on_hold/completed/cancelled/rejected); default "requested" |
| `reason` | String |  |
| `requestedAt` | Date |  |
| `coolingOffUntil` | Date | required |
| `processedAt` | Date |  |
| `processedBy` | String |  |
| `staffNote` | String |  |
| `result` | Mixed |  |

Indexes:
- `{ userId:1, status:1 }`
- `{ status:1, coolingOffUntil:1 }`

#### C360LifeNode  (collection `customer360_lifegraph_nodes`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `userId` | ObjectId->User | required |
| `kind` | String | required |
| `value` | String | required |
| `parentId` | ObjectId |  |
| `purpose` | String | required; enum(personalization/recommendations/gift_help/eco_filtering) |
| `source` | String | required; enum(declared/derived_from_purchases) |
| `consentVersion` | String |  |

Indexes:
- `{ userId:1 }`
- `{ userId:1, kind:1, value:1 }` UNIQUE

#### C360Memory  (collection `customer360_memory`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `userId` | ObjectId->User | required |
| `kind` | String | required; enum(requirement/comparison/product_question/favourite_collection/note) |
| `title` | String | required |
| `payload` | Mixed |  |
| `enabled` | Boolean | default true |
| `origin` | String | default "customer" |
| `expiresAt` | Date |  |

Indexes:
- `{ userId:1, createdAt:-1 }`
- `{ expiresAt:1 }` partial {"expiresAt":{"$type":"date"}}

#### C360Profile  (collection `customer360_profiles`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `userId` | ObjectId->User | required |
| `commPrefs` | Mixed |  |
| `replenishmentOptIn` | Boolean | default false |
| `lifegraphEnabled` | Boolean | default false |
| `memoryEnabled` | Boolean | default true |
| `memoryRetentionDays` | Number | default 365 |

Indexes:
- `{ userId:1 }` UNIQUE

#### C360StaffNote  (collection `customer360_staff_notes`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `userId` | ObjectId->User | required |
| `authorId` | String | required |
| `authorName` | String |  |
| `body` | String | required |

Indexes:
- `{ userId:1, createdAt:-1 }`

### Find (search and discovery)

Owner file: `packages/database/src/models.find.ts`

#### FindPriceAlert  (collection `find_price_alerts`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `userId` | ObjectId->User | required |
| `productId` | ObjectId->Product | required |
| `country` | String | required; enum(US/CA/IN) |
| `currency` | String | required |
| `active` | Boolean | default true |
| `baselinePrice` | Number | required; min 1 |
| `targetPrice` | Number | min 1; default null |
| `dropPercent` | Number | min 1; max 90; default 5 |
| `notifyOnDrop` | Boolean | default true |
| `notifyOnStock` | Boolean | default true |
| `notifyOnBetterOffer` | Boolean | default true |
| `lastSeenInStock` | Boolean | default null |
| `lastSeenPrice` | Number |  |
| `lastNotifiedDropPrice` | Number | default null |
| `targetNotifiedPrice` | Number | default null |
| `betterOfferNotifiedId` | String | default null |
| `betterOfferNotifiedPrice` | Number | default null |
| `lastCheckedAt` | Date |  |
| `lastNotifiedAt` | Date |  |
| `notifiedCount` | Number | default 0 |

Indexes:
- `{ userId:1, productId:1, country:1 }` UNIQUE
- `{ userId:1, active:1 }`
- `{ active:1, lastCheckedAt:1 }`
- `{ productId:1, country:1, active:1 }`

#### FindPriceSnapshot  (collection `find_price_snapshots`)

no automatic timestamps; version key `false`

| Field | Type | Constraints |
|---|---|---|
| `productId` | ObjectId->Product | required |
| `country` | String | required; enum(US/CA/IN) |
| `price` | Number | required; min 1 |
| `currency` | String | required |
| `inStock` | Boolean | required |
| `observedAt` | Date | required |
| `source` | String | enum(scheduled/on_demand); default "scheduled" |

Indexes:
- `{ productId:1, country:1, observedAt:-1 }`
- `{ observedAt:1 }` TTL 63072000s

#### FindSavedSearch  (collection `find_saved_searches`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `userId` | ObjectId->User | required |
| `name` | String | required |
| `query` | String | required |
| `country` | String | required; enum(US/CA/IN) |
| `budgetMax` | Number |  |
| `deliverBy` | String |  |
| `alert.newMatches` | Boolean | default false |
| `alert.lastCheckedAt` | Date |  |
| `alert.lastNotifiedAt` | Date |  |
| `alert.seenIds` | [String] | default [] |

Indexes:
- `{ userId:1 }`
- `{ userId:1, createdAt:-1 }`
- `{ alert.newMatches:1, alert.lastCheckedAt:1 }`

### Finance ledger

Owner file: `packages/database/src/models.finance.ts`

#### FinanceFxRate  (collection `finance_fx_rates`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `base` | String | required; enum(USD); default "USD" |
| `rates` | Mixed | required |
| `source` | String | required; enum(frankfurter/exchangerate_api/static/manual) |
| `providerDate` | String |  |
| `fetchedAt` | Date | required |

Indexes:
- `{ fetchedAt:-1 }`

#### FinanceLedgerEntry  (collection `finance_ledger`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `idempotencyKey` | String | required |
| `kind` | String | required |
| `currency` | String | required |
| `postedAt` | Date | required |
| `memo` | String |  |
| `lines` | [subdoc: account, side, amount] |  |
| `refs.orderId` | ObjectId |  |
| `refs.paymentId` | ObjectId |  |
| `refs.refundId` | ObjectId |  |
| `refs.shipmentId` | ObjectId |  |
| `refs.supplierId` | ObjectId |  |
| `refs.supplierOrderId` | String |  |
| `refs.settlementId` | String |  |
| `refs.campaignId` | ObjectId |  |
| `refs.metricId` | ObjectId |  |
| `reverses` | String |  |
| `fx` | Embedded |  |
| `createdBy` | String |  |

Indexes:
- `{ idempotencyKey:1 }` UNIQUE
- `{ postedAt:-1, _id:-1 }`
- `{ kind:1, postedAt:-1 }`
- `{ refs.orderId:1, kind:1 }`
- `{ lines.account:1, postedAt:-1 }`
- `{ refs.supplierId:1, kind:1, postedAt:1 }`

#### FinanceState  (collection `finance_state`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `key` | String | required |
| `value` | Mixed |  |

Indexes:
- `{ key:1 }` UNIQUE

### Creators and loyalty

Owner file: `packages/database/src/models.creators.ts`

#### CollectionComment  (collection `creator_comments`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `collectionId` | ObjectId->CreatorCollection | required |
| `creatorId` | ObjectId->CreatorProfile | required |
| `userId` | ObjectId->User | required |
| `displayName` | String | required |
| `body` | String | required |
| `status` | String | enum(pending/published/rejected/removed); default "pending" |
| `reports` | [subdoc: userId, reason, at] |  |
| `reportCount` | Number | default 0 |
| `moderatedBy` | String |  |

Indexes:
- `{ collectionId:1, status:1, createdAt:-1 }`
- `{ status:1, createdAt:1 }`
- `{ userId:1, createdAt:-1 }`

#### CreatorClick  (collection `creator_clicks`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `creatorId` | ObjectId->CreatorProfile | required |
| `linkId` | ObjectId->CreatorLink |  |
| `cartToken` | String |  |
| `ipHash` | String |  |
| `deviceHash` | String |  |
| `landing` | String |  |
| `userId` | ObjectId->User |  |
| `at` | Date |  |

Indexes:
- `{ creatorId:1, at:-1 }`
- `{ creatorId:1, ipHash:1, at:-1 }`
- `{ at:1 }` TTL 15552000s

#### CreatorCollection  (collection `creator_collections`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `creatorId` | ObjectId->CreatorProfile | required |
| `slug` | String | required |
| `title` | String | required |
| `description` | String | default "" |
| `items` | [subdoc: productId, note] |  |
| `published` | Boolean | default false |
| `publishedAt` | Date |  |
| `discussionEnabled` | Boolean | default true |

Indexes:
- `{ creatorId:1, slug:1 }` UNIQUE
- `{ creatorId:1, published:1, updatedAt:-1 }`

#### CreatorFlag  (collection `creator_flags`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `creatorId` | ObjectId->CreatorProfile | required |
| `orderId` | ObjectId->Order |  |
| `kind` | String | required; enum(self_attribution/ip_cluster/buyer_cluster/velocity/refund_rate/suspicious_order/chargeback) |
| `severity` | String | enum(low/medium/high); default "medium" |
| `detail` | String |  |
| `status` | String | enum(open/cleared/confirmed); default "open" |
| `dedupeKey` | String | required |
| `resolvedBy` | String |  |
| `resolvedAt` | Date |  |
| `resolution` | String |  |

Indexes:
- `{ dedupeKey:1 }` UNIQUE
- `{ status:1, createdAt:-1 }`
- `{ creatorId:1, status:1 }`
- `{ orderId:1, status:1 }`

#### CreatorLedger  (collection `creator_ledger`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `creatorId` | ObjectId->CreatorProfile | required |
| `kind` | String | required; enum(commission/clawback/adjustment) |
| `status` | String | enum(accrued/payable/paid/reversed); default "accrued" |
| `amount` | Number | default 0 |
| `currency` | String | enum(USD/CAD/INR) |
| `orderId` | ObjectId->Order |  |
| `idempotencyKey` | String | required |
| `holdUntil` | Date |  |
| `payableAt` | Date |  |
| `paidAt` | Date |  |
| `payoutId` | ObjectId->CreatorPayout |  |
| `detail.orders90d` | Number |  |
| `detail.orderRef` | String |  |
| `detail.orderedAt` | Date |  |
| `detail.deliveredAt` | Date |  |
| `detail.netBase` | Number | min 0; default 0 |
| `detail.rate` | Number |  |
| `detail.rateSource` | String |  |
| `detail.tier` | String |  |
| `detail.capped` | [String] |  |
| `detail.reasons` | [String] |  |
| `detail.refundedAtCalc` | Number | min 0; default 0 |
| `detail.lines` | [subdoc: category, net, rate, commission] |  |
| `note` | String |  |
| `actor` | String |  |

Indexes:
- `{ idempotencyKey:1 }` UNIQUE
- `{ creatorId:1, status:1, currency:1 }`
- `{ orderId:1, kind:1 }`
- `{ status:1, holdUntil:1 }`
- `{ payoutId:1 }`

#### CreatorLink  (collection `creator_links`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `creatorId` | ObjectId->CreatorProfile | required |
| `code` | String | required |
| `label` | String | required |
| `productId` | ObjectId->Product |  |
| `collectionId` | ObjectId->CreatorCollection |  |
| `clicks` | Number | default 0 |
| `active` | Boolean | default true |

Indexes:
- `{ creatorId:1 }`
- `{ code:1 }` UNIQUE

#### CreatorPayout  (collection `creator_payouts`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `creatorId` | ObjectId->CreatorProfile | required |
| `currency` | String | required; enum(USD/CAD/INR) |
| `amount` | Number | min 0; default 0 |
| `status` | String | enum(requested/approved/paid/rejected/cancelled); default "requested" |
| `entryCount` | Number | default 0 |
| `note` | String |  |
| `requestedAt` | Date |  |
| `approvedBy` | String |  |
| `approvedAt` | Date |  |
| `paidBy` | String |  |
| `paidAt` | Date |  |
| `method` | String |  |
| `externalReference` | String |  |
| `rejectedReason` | String |  |
| `checklist.kycOk` | Boolean |  |
| `checklist.taxOk` | Boolean |  |
| `checklist.thresholdOk` | Boolean |  |
| `checklist.noOpenFlags` | Boolean |  |

Indexes:
- `{ creatorId:1, createdAt:-1 }`
- `{ status:1, createdAt:-1 }`
- `{ creatorId:1, currency:1 }` UNIQUE, partial {"status":{"$in":["requested","approved"]}}

#### CreatorProfile  (collection `creator_profiles`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `userId` | ObjectId->User | required |
| `handle` | String | required |
| `displayName` | String | required |
| `bio` | String | default "" |
| `avatarUrl` | String |  |
| `socialLinks` | [subdoc: platform, url] |  |
| `audience` | String |  |
| `status` | String | enum(pending/approved/rejected/suspended); default "pending" |
| `appliedAt` | Date |  |
| `reviewedAt` | Date |  |
| `reviewedBy` | String |  |
| `reviewNote` | String |  |
| `termsAcceptedAt` | Date |  |
| `rateOverride` | Number | min 0; max 0.5 |
| `categoryRateOverrides` | Map |  |
| `categoryRateOverrides.$*` | Number |  |
| `payoutProfile.kycStatus` | String | enum(not_started/collected/verified/rejected); default "not_started" |
| `payoutProfile.taxInfoCollected` | Boolean | default false |
| `payoutProfile.taxInfoReference` | String |  |
| `payoutProfile.kycReference` | String |  |
| `payoutProfile.method` | String | enum(bank_transfer/upi/paypal/other) |
| `payoutProfile.verifiedBy` | String |  |
| `payoutProfile.verifiedAt` | Date |  |
| `payoutsHeld` | Boolean | default false |
| `holdReason` | String |  |
| `stats.clicks` | Number | default 0 |

Indexes:
- `{ userId:1 }` UNIQUE
- `{ handle:1 }` UNIQUE
- `{ status:1 }`
- `{ status:1, createdAt:-1 }`

#### CreatorProgramConfig  (collection `creator_program_config`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `key` | String | required |
| `rules` | Mixed |  |
| `loyalty` | Mixed |  |
| `updatedBy` | String |  |

Indexes:
- `{ key:1 }` UNIQUE

#### LoyaltyAccount  (collection `loyalty_accounts`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `userId` | ObjectId->User | required |
| `balance` | Number | default 0 |
| `lifetimePoints` | Number | default 0 |
| `tier` | String |  |

Indexes:
- `{ userId:1 }` UNIQUE

#### LoyaltyLedger  (collection `loyalty_ledger`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `userId` | ObjectId->User | required |
| `kind` | String | required; enum(earn/bonus/redeem/expire/adjust/reversal/restore) |
| `points` | Number | required |
| `remaining` | Number | default 0 |
| `expiresAt` | Date |  |
| `orderId` | ObjectId->Order |  |
| `redemptionId` | ObjectId |  |
| `idempotencyKey` | String | required |
| `meta` | Mixed |  |
| `note` | String |  |
| `actor` | String |  |

Indexes:
- `{ idempotencyKey:1 }` UNIQUE
- `{ userId:1, createdAt:-1 }`
- `{ userId:1, kind:1, remaining:1, expiresAt:1 }`
- `{ kind:1, expiresAt:1 }`

#### LoyaltyRedemption  (collection `loyalty_redemptions`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `userId` | ObjectId->User | required |
| `points` | Number |  |
| `valueUsd` | Number | min 0; default 0 |
| `code` | String | required |
| `promotionId` | ObjectId->Promotion |  |
| `expiresAt` | Date |  |
| `status` | String | enum(active/used/expired); default "active" |

Indexes:
- `{ code:1 }` UNIQUE
- `{ userId:1, createdAt:-1 }`
- `{ status:1, expiresAt:1 }`

#### ReferralSignal  (collection `referral_signals`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `orderId` | ObjectId->Order | required |
| `referrerUserId` | ObjectId->User |  |
| `normalizedEmail` | String |  |
| `addressHash` | String |  |
| `phoneHash` | String |  |
| `ipHash` | String |  |
| `outcome` | String | required; enum(rewarded/rejected) |
| `reason` | String |  |

Indexes:
- `{ orderId:1 }` UNIQUE
- `{ referrerUserId:1 }`
- `{ normalizedEmail:1 }`
- `{ referrerUserId:1, outcome:1, createdAt:-1 }`

### Events and marketing outbox

Owner file: `packages/database/src/models.events.ts`

#### EventsCampaign  (collection `events_campaigns`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `name` | String | required |
| `segmentId` | ObjectId->EventsSegment | required |
| `subject` | String | required |
| `message` | String | required |
| `ctaLabel` | String |  |
| `ctaUrl` | String |  |
| `status` | String | enum(draft/scheduled/sending/sent/cancelled/failed); default "draft" |
| `scheduledAt` | Date |  |
| `startedAt` | Date |  |
| `finishedAt` | Date |  |
| `maxRecipients` | Number | default 1000 |
| `plan.eligible` | Number |  |
| `plan.excludedNoConsent` | Number |  |
| `plan.excludedUnsubscribed` | Number |  |
| `plan.excludedFrequency` | Number |  |
| `plan.excludedCap` | Number |  |
| `createdBy` | String |  |
| `approvedBy` | String |  |

Indexes:
- `{ status:1 }`
- `{ status:1, scheduledAt:1 }`

#### EventsCampaignRecipient  (collection `events_campaign_recipients`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `campaignId` | ObjectId->EventsCampaign | required |
| `email` | String | required |
| `status` | String | enum(queued/sent/failed/skipped); default "queued" |
| `skipReason` | String |  |
| `notificationId` | ObjectId->Notification |  |
| `clicks` | Number | default 0 |
| `firstClickAt` | Date |  |

Indexes:
- `{ campaignId:1, email:1 }` UNIQUE
- `{ email:1, createdAt:-1 }`

#### EventsCursor  (collection `events_cursors`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `key` | String | required |
| `lastAt` | Date |  |
| `lastId` | String |  |
| `note` | String |  |

Indexes:
- `{ key:1 }` UNIQUE

#### EventsExperiment  (collection `events_experiments`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `key` | String | required |
| `name` | String | required |
| `hypothesis` | String |  |
| `variants` | [subdoc: key, weight] |  |
| `conversionEvent` | String | required |
| `status` | String | enum(draft/running/stopped); default "draft" |
| `startedAt` | Date |  |
| `stoppedAt` | Date |  |
| `createdBy` | String |  |
| `decisionNote` | String |  |

Indexes:
- `{ key:1 }` UNIQUE
- `{ status:1 }`

#### EventsExperimentEvent  (collection `events_experiment_events`)

no automatic timestamps; version key `false`

| Field | Type | Constraints |
|---|---|---|
| `experimentKey` | String | required |
| `variant` | String | required |
| `visitorId` | String | required |
| `kind` | String | required; enum(exposure/conversion) |
| `ts` | Date |  |

Indexes:
- `{ experimentKey:1, visitorId:1, kind:1 }` UNIQUE
- `{ experimentKey:1, kind:1, variant:1 }`

#### EventsOutbox  (collection `events_outbox`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `eventId` | String | required |
| `provider` | String | required; enum(meta/tiktok/ga4/google_ads) |
| `name` | String | required |
| `status` | String | enum(pending/sending/sent/dead/skipped/suppressed); default "pending" |
| `payload` | Mixed |  |
| `attempts` | Number | default 0 |
| `nextAttemptAt` | Date |  |
| `lockedUntil` | Date |  |
| `lastError` | String |  |
| `sentAt` | Date |  |
| `skipReason` | String |  |
| `occurredAt` | Date | required |
| `source` | String |  |
| `sessionId` | String |  |

Indexes:
- `{ eventId:1, provider:1 }` UNIQUE
- `{ status:1, nextAttemptAt:1 }`
- `{ provider:1, status:1, sentAt:-1 }`
- `{ createdAt:-1 }`
- `{ updatedAt:1 }` TTL 7776000s, partial {"status":{"$in":["sent","suppressed","skipped"]}}

#### EventsSegment  (collection `events_segments`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `name` | String | required |
| `description` | String |  |
| `rules` | [Mixed] |  |
| `createdBy` | String |  |

Indexes: none declared (only `_id`).

#### EventsSession  (collection `events_sessions`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `sessionId` | String | required |
| `cartToken` | String |  |
| `userId` | ObjectId->User |  |
| `consent.analytics` | Boolean |  |
| `consent.marketing` | Boolean |  |
| `consent.at` | Date |  |
| `firstTouch.utmSource` | String |  |
| `firstTouch.utmMedium` | String |  |
| `firstTouch.utmCampaign` | String |  |
| `firstTouch.utmTerm` | String |  |
| `firstTouch.utmContent` | String |  |
| `firstTouch.clickId` | String |  |
| `firstTouch.clickIdType` | String |  |
| `firstTouch.referrerHost` | String |  |
| `firstTouch.landingPath` | String |  |
| `firstTouch.at` | Date |  |
| `lastTouch.utmSource` | String |  |
| `lastTouch.utmMedium` | String |  |
| `lastTouch.utmCampaign` | String |  |
| `lastTouch.utmTerm` | String |  |
| `lastTouch.utmContent` | String |  |
| `lastTouch.clickId` | String |  |
| `lastTouch.clickIdType` | String |  |
| `lastTouch.referrerHost` | String |  |
| `lastTouch.landingPath` | String |  |
| `lastTouch.at` | Date |  |
| `clickIds.fbclid` | String |  |
| `clickIds.gclid` | String |  |
| `clickIds.ttclid` | String |  |
| `clickIds.gbraid` | String |  |
| `clickIds.wbraid` | String |  |
| `browserIds.fbp` | String |  |
| `browserIds.fbc` | String |  |
| `browserIds.ttp` | String |  |
| `browserIds.gaClientId` | String |  |
| `client.ip` | String |  |
| `client.userAgent` | String |  |
| `lastSeenAt` | Date |  |

Indexes:
- `{ sessionId:1 }` UNIQUE
- `{ cartToken:1 }`
- `{ lastSeenAt:1 }` TTL 7776000s

#### EventsUnsubscribe  (collection `events_unsubscribes`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `email` | String | required |
| `source` | String |  |
| `campaignId` | ObjectId->EventsCampaign |  |

Indexes:
- `{ email:1 }` UNIQUE

### Supplier network and portal

Owner file: `packages/database/src/models.suppliernet.ts`

#### SuppliernetCatalogItem  (collection `suppliernet_catalog_items`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `supplierId` | ObjectId->Supplier | required |
| `externalId` | String | required |
| `supplierProductId` | ObjectId->SupplierProduct |  |
| `title` | String |  |
| `normalizedTitle` | String |  |
| `brand` | String |  |
| `gtin` | String |  |
| `mpn` | String |  |
| `category` | String |  |
| `attributes` | Mixed |  |
| `imageHashes` | [String] |  |
| `priceMinor` | Number |  |
| `currency` | String |  |
| `stock` | Number |  |
| `lastSeenAt` | Date |  |

Indexes:
- `{ supplierId:1, externalId:1 }` UNIQUE
- `{ gtin:1 }` sparse

#### SuppliernetDispute  (collection `suppliernet_disputes`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `number` | String | required |
| `supplierId` | ObjectId->Supplier | required |
| `type` | String | required; enum(late/defective/not_delivered/price_mismatch/wrong_item/other) |
| `state` | String | enum(open/awaiting_supplier/awaiting_orvia/resolved_credit/resolved_no_action/rejected/escalated/closed); default "open" |
| `orderId` | ObjectId->Order |  |
| `shipmentId` | ObjectId->Shipment |  |
| `statementId` | ObjectId->SuppliernetStatement |  |
| `amountMinor` | Number | default 0 |
| `currency` | String |  |
| `creditedMinor` | Number | default 0 |
| `summary` | String |  |
| `openedBy` | String |  |
| `evidence` | [subdoc: at, by, side, note, documentId, url] |  |
| `timeline` | [subdoc: from, to, at, by, note] |  |
| `resolution` | String |  |

Indexes:
- `{ number:1 }` UNIQUE
- `{ supplierId:1, state:1, createdAt:-1 }`

#### SuppliernetDocument  (collection `suppliernet_documents`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `supplierId` | ObjectId->Supplier | required |
| `kind` | String | required; enum(business_registration/tax_certificate/product_certificate/insurance/bank_confirmation/quality_report/other) |
| `title` | String | required |
| `storageKey` | String | required |
| `mime` | String |  |
| `bytes` | Number |  |
| `sha256` | String |  |
| `status` | String | enum(pending/verified/rejected); default "pending" |
| `expiresAt` | Date |  |
| `uploadedBy` | String |  |
| `uploadedByRole` | String |  |
| `reviewedBy` | String |  |
| `reviewedAt` | Date |  |
| `reviewNote` | String |  |

Indexes:
- `{ supplierId:1, kind:1, createdAt:-1 }`
- `{ status:1, expiresAt:1 }`

#### SuppliernetIngestionJob  (collection `suppliernet_ingestion_jobs`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `supplierId` | ObjectId->Supplier | required |
| `trigger` | String | enum(manual/schedule/upload); default "manual" |
| `status` | String | enum(running/completed/failed); default "running" |
| `startedAt` | Date |  |
| `finishedAt` | Date |  |
| `seen` | Number | default 0 |
| `created` | Number | default 0 |
| `updated` | Number | default 0 |
| `rejected` | Number | default 0 |
| `candidates` | Number | default 0 |
| `error` | String |  |
| `rowErrors` | [String] | default [] |
| `startedBy` | String |  |

Indexes:
- `{ supplierId:1, startedAt:-1 }`

#### SuppliernetMatchCandidate  (collection `suppliernet_match_candidates`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `supplierId` | ObjectId->Supplier | required |
| `supplierProductId` | ObjectId->SupplierProduct | required |
| `productId` | ObjectId->Product | required |
| `score` | Number | required |
| `confidence` | String | enum(high/medium/low) |
| `reasons` | [subdoc: kind, detail, weight] |  |
| `conflicts` | [String] |  |
| `status` | String | enum(pending/approved/rejected); default "pending" |
| `decidedBy` | String |  |
| `decidedAt` | Date |  |
| `note` | String |  |

Indexes:
- `{ supplierProductId:1, productId:1 }` UNIQUE
- `{ status:1, score:-1 }`

#### SuppliernetProfile  (collection `suppliernet_profiles`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `supplierId` | ObjectId->Supplier | required |
| `state` | String | enum(invited/profile_submitted/documents/technical_integration/verification/probation/approved/suspended); default "invited" |
| `supplierType` | String | required; enum(api/feed/manual/manufacturer/wholesaler/regional_distributor/print_on_demand/local_fulfilment) |
| `invitedEmail` | String |  |
| `profile` | Mixed |  |
| `profileSubmittedAt` | Date |  |
| `probationStartedAt` | Date |  |
| `approvedAt` | Date |  |
| `suspendedReason` | String |  |
| `history` | [subdoc: from, to, at, by, reason] |  |
| `credentials.fields` | [String] |  |
| `credentials.lastRotatedAt` | Date |  |
| `credentials.rotatedBy` | String |  |
| `credentials.rotationIntervalDays` | Number | default 180 |
| `declaredCapabilities` | [String] |  |

Indexes:
- `{ supplierId:1 }` UNIQUE
- `{ state:1 }`
- `{ state:1, updatedAt:-1 }`

#### SuppliernetReturnAuth  (collection `suppliernet_return_auths`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `number` | String | required |
| `supplierId` | ObjectId->Supplier | required |
| `orderId` | ObjectId->Order | required |
| `shipmentId` | ObjectId->Shipment |  |
| `returnRef` | String |  |
| `reason` | String | required |
| `state` | String | enum(requested/authorized/rejected/received_by_supplier/refunded_by_supplier/cancelled); default "requested" |
| `rmaNumber` | String |  |
| `supplierNote` | String |  |
| `refundMinor` | Number |  |
| `requestedBy` | String |  |
| `decidedBy` | String |  |
| `decidedAt` | Date |  |
| `timeline` | [subdoc: from, to, at, by, note] |  |

Indexes:
- `{ number:1 }` UNIQUE
- `{ supplierId:1, state:1, createdAt:-1 }`
- `{ orderId:1 }`

#### SuppliernetSla  (collection `suppliernet_slas`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `supplierId` | ObjectId->Supplier | required |
| `definition` | Mixed |  |
| `updatedBy` | String |  |

Indexes:
- `{ supplierId:1 }` UNIQUE

#### SuppliernetSlaSnapshot  (collection `suppliernet_sla_snapshots`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `supplierId` | ObjectId->Supplier | required |
| `computedAt` | Date | required |
| `windowDays` | Number |  |
| `facts` | Mixed |  |
| `metrics` | Mixed |  |
| `breaches` | [subdoc: metric, severity, value, target, sample] |  |
| `worst` | String | enum(ok/warning/critical/insufficient_data) |

Indexes:
- `{ supplierId:1, computedAt:-1 }`
- `{ computedAt:1 }` TTL 31536000s

#### SuppliernetStatement  (collection `suppliernet_statements`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `supplierId` | ObjectId->Supplier | required |
| `number` | String | required |
| `currency` | String | required |
| `periodStart` | Date |  |
| `periodEnd` | Date |  |
| `source` | String | required; enum(csv/manual/portal) |
| `status` | String | enum(submitted/matched/discrepancies/disputed/settled); default "submitted" |
| `lines` | [subdoc: supplierOrderId, orderRef, description, amountMinor, match, recordedMinor, diffMinor, shipmentId, ...] |  |
| `totals.claimedMinor` | Number | default 0 |
| `totals.recordedMinor` | Number | default 0 |
| `totals.diffMinor` | Number | default 0 |
| `totals.matchedLines` | Number |  |
| `totals.flaggedLines` | Number |  |
| `totals.missingFromStatement` | Number |  |
| `disputedMinor` | Number | default 0 |
| `settlement.reference` | String |  |
| `settlement.amountMinor` | Number |  |
| `settlement.note` | String |  |
| `settlement.settledAt` | Date |  |
| `settlement.settledBy` | String |  |
| `submittedBy` | String |  |
| `reconciledAt` | Date |  |

Indexes:
- `{ supplierId:1, number:1 }` UNIQUE
- `{ status:1, createdAt:-1 }`

#### SuppliernetStockCheck  (collection `suppliernet_stock_checks`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `supplierId` | ObjectId->Supplier | required |
| `externalId` | String | required |
| `sku` | String |  |
| `claimed` | Number | required |
| `observed` | Number |  |
| `source` | String |  |
| `checkedAt` | Date | required |
| `observedAt` | Date |  |

Indexes:
- `{ supplierId:1, checkedAt:-1 }`
- `{ checkedAt:1 }` TTL 34560000s

#### SuppliernetVerificationStep  (collection `suppliernet_verification_steps`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `supplierId` | ObjectId->Supplier | required |
| `kind` | String | required; enum(catalogue_availability/price_quote_accuracy/stock_accuracy_sample/test_order_placement/cancellation/shipment_tracking/delivery_observed/return_refund_handling) |
| `required` | Boolean | default true |
| `status` | String | enum(not_started/in_progress/passed/failed); default "not_started" |
| `passedAt` | Date |  |
| `validUntil` | Date |  |
| `evidence` | [subdoc: at, operator, method, outcome, summary, request, response, orderId, ...] | default [] |

Indexes:
- `{ supplierId:1, kind:1 }` UNIQUE

### AI agents

Owner file: `packages/database/src/models.agents.ts`

#### AgentsConfig  (collection `agents_config`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `agentId` | String | required; enum(product_discovery/product_intelligence/supplier_intelligence/customer_advocate/shopping_assistant/delivery_rescue/returns/pricing_intelligence/marketing_intelligence/finance_analysis/trust_analysis) |
| `enabled` | Boolean | default true |
| `reason` | String |  |
| `changedBy` | String |  |
| `changedAt` | Date |  |

Indexes:
- `{ agentId:1 }` UNIQUE

#### AgentsConversation  (collection `agents_conversations`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `sessionId` | String | required |
| `userId` | ObjectId->User |  |
| `guestHash` | String |  |
| `country` | String |  |
| `messages` | [subdoc: role, text, at] |  |
| `context.lastOrderNumber` | String |  |
| `context.lastProducts` | [subdoc: id, slug] |  |
| `messageCount` | Number | default 0 |
| `dayWindow.day` | String |  |
| `dayWindow.count` | Number | default 0 |
| `expiresAt` | Date | required |

Indexes:
- `{ sessionId:1 }` UNIQUE
- `{ userId:1 }`
- `{ expiresAt:1 }` TTL 0s

#### AgentsEscalation  (collection `agents_escalations`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `agentId` | String | required; enum(product_discovery/product_intelligence/supplier_intelligence/customer_advocate/shopping_assistant/delivery_rescue/returns/pricing_intelligence/marketing_intelligence/finance_analysis/trust_analysis) |
| `runId` | ObjectId |  |
| `reason` | String | required; enum(low_confidence/sensitive/limit_hit/tool_refused/budget_exhausted/customer_requested/injection_suspected/grounding_failed/replacement_request/output_invalid/complex_case) |
| `status` | String | enum(open/resolved); default "open" |
| `summary` | String | required |
| `userId` | ObjectId->User |  |
| `orderNumber` | String |  |
| `context` | Mixed |  |
| `dedupeKey` | String |  |
| `resolvedBy` | String |  |
| `resolvedAt` | Date |  |
| `resolutionNote` | String |  |

Indexes:
- `{ status:1, createdAt:-1 }`
- `{ agentId:1, status:1 }`
- `{ dedupeKey:1 }` UNIQUE, partial {"dedupeKey":{"$type":"string"},"status":"open"}

#### AgentsOutcome  (collection `agents_outcomes`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `userId` | ObjectId->User | required |
| `orderId` | ObjectId->Order | required |
| `orderNumber` | String | required |
| `problem` | String | required |
| `runId` | ObjectId |  |
| `recommended.kind` | String |  |
| `recommended.rescueKind` | String |  |
| `recommended.refundMinor` | Number |  |
| `recommended.currency` | String |  |
| `permittedKinds` | [String] |  |
| `runCount` | Number | default 1 |
| `escalated` | Boolean | default false |
| `rating` | Number | min 1; max 5 |
| `ratingComment` | String |  |
| `ratedAt` | Date |  |

Indexes:
- `{ userId:1 }`
- `{ orderId:1, problem:1 }` UNIQUE
- `{ createdAt:-1 }`

#### AgentsPending  (collection `agents_pending_actions`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `agentId` | String | required; enum(product_discovery/product_intelligence/supplier_intelligence/customer_advocate/shopping_assistant/delivery_rescue/returns/pricing_intelligence/marketing_intelligence/finance_analysis/trust_analysis) |
| `tool` | String | required |
| `userId` | ObjectId->User | required |
| `sessionId` | String |  |
| `args` | Mixed | required |
| `argsHash` | String | required |
| `summary` | String | required |
| `tokenHash` | String | required |
| `state` | String | enum(pending/executing/executed/cancelled/expired/failed); default "pending" |
| `result` | Mixed |  |
| `error` | String |  |
| `expiresAt` | Date | required |
| `decidedAt` | Date |  |

Indexes:
- `{ userId:1 }`
- `{ state:1, expiresAt:1 }`

#### AgentsReplacementRequest  (collection `agents_replacement_requests`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `userId` | ObjectId->User | required |
| `orderId` | ObjectId->Order | required |
| `orderNumber` | String | required |
| `sku` | String | required |
| `quantity` | Number | default 1 |
| `reason` | String | required |
| `details` | String | default "" |
| `state` | String | enum(pending/approved/rejected); default "pending" |
| `escalationId` | ObjectId |  |
| `decidedBy` | String |  |
| `decidedAt` | Date |  |
| `decisionNote` | String |  |

Indexes:
- `{ userId:1 }`
- `{ orderNumber:1 }`
- `{ state:1, createdAt:-1 }`
- `{ orderId:1, sku:1, state:1 }` UNIQUE, partial {"state":"pending"}

#### AgentsRun  (collection `agents_runs`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `agentId` | String | required; enum(product_discovery/product_intelligence/supplier_intelligence/customer_advocate/shopping_assistant/delivery_rescue/returns/pricing_intelligence/marketing_intelligence/finance_analysis/trust_analysis) |
| `actorType` | String | required; enum(guest/customer/staff/system) |
| `actorRef` | String | required |
| `kind` | String | enum(run/confirmation); default "run" |
| `inputHash` | String | required |
| `inputRedacted` | String | default "" |
| `outcome` | String | required; enum(success/fallback/refused/error/killed/budget_stopped/escalated/awaiting_confirmation) |
| `source` | String | enum(deterministic/model/template_fallback/none); default "none" |
| `models` | [String] |  |
| `toolCalls` | [subdoc: tool, sideEffect, argsSummary, outcome, reason, ms, outputBytes] |  |
| `outputRedacted` | String | default "" |
| `confidence` | Number |  |
| `flags` | [String] |  |
| `notes` | [String] |  |
| `tokens` | Number | default 0 |
| `costMicros` | Number | default 0 |
| `modelCalls` | Number | default 0 |
| `cacheHits` | Number | default 0 |
| `steps` | Number | default 0 |
| `durationMs` | Number | default 0 |
| `escalationId` | ObjectId |  |
| `requestId` | String |  |
| `day` | String | required |
| `expiresAt` | Date | required |

Indexes:
- `{ agentId:1, createdAt:-1 }`
- `{ outcome:1, createdAt:-1 }`
- `{ actorRef:1, createdAt:-1 }`
- `{ expiresAt:1 }` TTL 0s

#### AgentsUsage  (collection `agents_usage`)

timestamps (createdAt/updatedAt); version key `version`

| Field | Type | Constraints |
|---|---|---|
| `agentId` | String | required; enum(product_discovery/product_intelligence/supplier_intelligence/customer_advocate/shopping_assistant/delivery_rescue/returns/pricing_intelligence/marketing_intelligence/finance_analysis/trust_analysis) |
| `day` | String | required |
| `runs` | Number | default 0 |
| `modelCalls` | Number | default 0 |
| `cacheHits` | Number | default 0 |
| `tokens` | Number | default 0 |
| `costMicros` | Number | default 0 |
| `budgetStops` | Number | default 0 |
| `expiresAt` | Date |  |

Indexes:
- `{ agentId:1, day:1 }` UNIQUE
- `{ expiresAt:1 }` TTL 0s

---

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
