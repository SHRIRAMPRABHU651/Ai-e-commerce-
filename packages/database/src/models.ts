import { Schema } from 'mongoose';
import {
  ORDER_STATUSES,
  PRODUCT_STATES,
  ROLES,
  EXCEPTION_KINDS,
  INVENTORY_STATUSES,
} from '@orvia/types';
import { COUNTRY, Mixed, defineModel, money, oid, schemaOpts, signedMoney } from './helpers';

const addressDef = {
  fullName: String,
  line1: String,
  line2: String,
  city: String,
  region: String,
  postalCode: String,
  country: COUNTRY,
  phone: String,
};

/* ----------------------------- identity ----------------------------- */
const userSchema = new Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
  name: { type: String, required: true },
  role: { type: String, enum: ROLES, default: 'CUSTOMER', index: true },
  emailVerified: { type: Boolean, default: false },
  verifyTokenHash: { type: String, select: false },
  verifyTokenExpires: { type: Date, select: false },
  resetTokenHash: { type: String, select: false },
  resetTokenExpires: { type: Date, select: false },
  failedLogins: { type: Number, default: 0 },
  lockUntil: Date,
  lastLoginAt: Date,
  country: COUNTRY,
  disabled: { type: Boolean, default: false },
  isDemo: { type: Boolean, default: false },
  deletedAt: Date,
}, schemaOpts);
export const User = defineModel('User', userSchema, 'users');

const roleSchema = new Schema({
  name: { type: String, enum: ROLES, unique: true },
  description: String,
  permissions: [String],
}, schemaOpts);
export const RoleModel = defineModel('Role', roleSchema, 'roles');

const sessionSchema = new Schema({
  userId: { type: oid, ref: 'User', index: true, required: true },
  userAgent: String,
  ip: String,
  expiresAt: { type: Date, required: true },
  revokedAt: Date,
}, schemaOpts);
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });
export const Session = defineModel('Session', sessionSchema, 'sessions');

const customerSchema = new Schema({
  userId: { type: oid, ref: 'User', unique: true, sparse: true },
  email: { type: String, required: true, unique: true, lowercase: true },
  name: String,
  country: COUNTRY,
  ordersCount: { type: Number, default: 0 },
  lifetimeValue: money,
  lastOrderAt: Date,
  marketingConsent: { type: Boolean, default: false },
  riskFlags: [String],
  isDemo: { type: Boolean, default: false },
}, schemaOpts);
export const Customer = defineModel('Customer', customerSchema, 'customers');

const addressSchema = new Schema({
  userId: { type: oid, ref: 'User', index: true, required: true },
  ...addressDef,
  isDefault: { type: Boolean, default: false },
}, schemaOpts);
export const AddressModel = defineModel('Address', addressSchema, 'addresses');

/* ------------------------------ catalog ------------------------------ */
const categorySchema = new Schema({
  slug: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  parentSlug: { type: String, index: true },
  path: [String],
  dynamic: { type: Boolean, default: false },
  position: { type: Number, default: 0 },
  image: String,
}, schemaOpts);
export const Category = defineModel('Category', categorySchema, 'categories');

const marketSchema = new Schema(
  {
    country: { ...COUNTRY, required: true },
    enabled: { type: Boolean, default: true },
    currency: String,
    price: money,
    compareAtPrice: money,
    pricingStrategy: { type: String, default: 'target_margin' },
    /** Cached contribution estimates for admin dashboards (recomputed by the pricing agent). */
    expectedProfit: signedMoney,
    expectedMargin: { type: Number, default: 0 },
    bestSupplierId: { type: oid, ref: 'Supplier' },
    landedCost: money,
    shipsFrom: String,
    minDays: Number,
    maxDays: Number,
    stock: { type: Number, default: 0 },
    /** Photos from the supplier that serves this country (set when the market is refreshed); falls back to product.images. */
    images: [String],
  },
  { _id: false },
);

const productSchema = new Schema({
  slug: { type: String, required: true, unique: true },
  sku: { type: String, required: true, unique: true },
  title: { type: String, required: true },
  brand: { type: String, default: 'Orvia' },
  description: String,
  bullets: [String],
  features: [String],
  benefits: [String],
  faqs: [{ _id: false, q: String, a: String }],
  seo: { title: String, metaDescription: String, keywords: [String] },
  social: { instagram: String, tiktokScript: String, facebookAd: String },
  /** Customer-facing image projection, rebuilt from ProductAsset by syncProductImages(). */
  images: [{ _id: false, url: String, alt: String, card: String, thumb: String, zoom: String, assetId: String, source: String, license: String }],
  imageStatus: { type: String, enum: ['MISSING', 'PENDING', 'READY', 'FAILED'], default: 'MISSING', index: true },
  videos: [{ _id: false, url: String, licensed: Boolean }],
  category: { type: String, index: true }, // sub-category slug
  topCategory: { type: String, index: true }, // pet|kids|fashion|gadgets
  tags: [String],
  attributes: { type: Map, of: String },
  state: { type: String, enum: PRODUCT_STATES, default: 'DRAFT', index: true },
  stateHistory: [{ _id: false, state: String, at: Date, by: String, reason: String }],
  markets: [marketSchema],
  stats: {
    ratingAvg: { type: Number, default: 0 },
    ratingCount: { type: Number, default: 0 },
    soldCount: { type: Number, default: 0 },
    views: { type: Number, default: 0 },
    trendScore: { type: Number, default: 0 },
    conversionRate: { type: Number, default: 0 },
    refundRate: { type: Number, default: 0 },
  },
  opportunity: { finalScore: Number, action: String, computedAt: Date },
  compliance: {
    status: { type: String, enum: ['pending', 'passed', 'failed', 'review'], default: 'pending' },
    flags: [String],
    checkedAt: Date,
    safetyInfo: { standards: [String], ageRange: String, certificateUrl: String },
  },
  /** Market intelligence used for scoring/pricing: competitor prices per country, demand/trend signals. */
  intel: Mixed,
  sourceSupplierProductId: { type: oid, ref: 'SupplierProduct' },
  pricingConfig: {
    strategy: { type: String, default: 'target_margin' },
    targetMarginPct: { type: Number, default: 0.4 },
  },
  inventorySyncedAt: Date,
  isDemo: { type: Boolean, default: false },
  deletedAt: Date,
}, schemaOpts);
productSchema.index({ title: 'text', 'seo.keywords': 'text', tags: 'text' }, { weights: { title: 10, tags: 4, 'seo.keywords': 3 } });
productSchema.index({ state: 1, topCategory: 1, 'stats.trendScore': -1 });
productSchema.index({ state: 1, category: 1, createdAt: -1 });
productSchema.index({ state: 1, 'stats.soldCount': -1 });
productSchema.index({ 'markets.country': 1, state: 1 });
export const Product = defineModel('Product', productSchema, 'products');

const variantSchema = new Schema({
  productId: { type: oid, ref: 'Product', required: true, index: true },
  sku: { type: String, required: true, unique: true },
  options: { type: Map, of: String },
  label: String,
  image: String,
  priceDelta: { type: Number, default: 0 },
  supplierSku: String,
  active: { type: Boolean, default: true },
}, schemaOpts);
export const ProductVariant = defineModel('ProductVariant', variantSchema, 'product_variants');

/* ----------------------------- suppliers ----------------------------- */
const supplierSchema = new Schema({
  code: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  provider: { type: String, required: true }, // adapter key: mock | cj | ...
  country: COUNTRY,
  servesCountries: [String],
  /** Lower number = preferred when several suppliers can serve the same country at similar value. */
  priority: { type: Number, default: 100 },
  /** AES-GCM encrypted JSON of credentials ({apiKey, apiSecret}); never returned by the API. */
  credentialsEnc: { type: String, select: false },
  /** Non-secret adapter mapping (used by the configurable "rest" provider). */
  config: Mixed,
  /** AUTOMATED = we place/track orders via API; ASSISTED = API order after human approval; MANUAL = a human places each order. Unset ⇒ derived (mock: AUTOMATED, others: ASSISTED). */
  fulfillmentMode: { type: String, enum: ['AUTOMATED', 'ASSISTED', 'MANUAL'] },
  sandbox: { type: Boolean, default: false },
  /** Operator-run validation results per check: { connection: { status: 'pass'|'fail', at, message } … } */
  validation: Mixed,
  healthState: { type: String, enum: ['HEALTHY', 'DEGRADED', 'FAILING', 'DISABLED', 'NOT_CONFIGURED'], default: 'NOT_CONFIGURED' },
  consecutiveFailures: { type: Number, default: 0 },
  lastHealthAt: Date,
  lastSuccessfulOrderAt: Date,
  avgResponseMs: Number,
  rating: { type: Number, default: 4, min: 0, max: 5 },
  reliability: { type: Number, default: 80, min: 0, max: 100 },
  returnPolicyDays: { type: Number, default: 14 },
  trackingAvailable: { type: Boolean, default: true },
  active: { type: Boolean, default: true },
  apiStatus: { type: String, enum: ['ok', 'degraded', 'down', 'unconfigured'], default: 'unconfigured' },
  apiStatusMessage: String,
  lastSyncAt: Date,
  stats: {
    ordersTotal: { type: Number, default: 0 },
    ordersFailed: { type: Number, default: 0 },
    ordersLate: { type: Number, default: 0 },
    avgDeliveryDays: { type: Number, default: 0 },
  },
  isDemo: { type: Boolean, default: false },
}, schemaOpts);
export const Supplier = defineModel('Supplier', supplierSchema, 'suppliers');

const warehouseSchema = new Schema({
  supplierId: { type: oid, ref: 'Supplier', required: true, index: true },
  code: { type: String, required: true },
  name: String,
  country: { type: String, required: true },
}, schemaOpts);
warehouseSchema.index({ supplierId: 1, code: 1 }, { unique: true });
export const Warehouse = defineModel('Warehouse', warehouseSchema, 'warehouses');

const supplierProductSchema = new Schema({
  supplierId: { type: oid, ref: 'Supplier', required: true },
  externalId: { type: String, required: true },
  productId: { type: oid, ref: 'Product', index: true },
  title: String,
  description: String,
  images: [String],
  videos: [String],
  category: String,
  attributes: { type: Map, of: String },
  safetyInfo: { standards: [String], ageRange: String },
  variants: [{ _id: false, sku: String, label: String, options: { type: Map, of: String } }],
  cost: money,
  currency: String,
  lastSyncAt: Date,
  importStatus: { type: String, enum: ['new', 'imported', 'rejected', 'review'], default: 'new' },
}, schemaOpts);
supplierProductSchema.index({ supplierId: 1, externalId: 1 }, { unique: true });
export const SupplierProduct = defineModel('SupplierProduct', supplierProductSchema, 'supplier_products');

const offerSchema = new Schema({
  productId: { type: oid, ref: 'Product', required: true },
  supplierId: { type: oid, ref: 'Supplier', required: true },
  supplierProductId: { type: oid, ref: 'SupplierProduct' },
  externalId: String,
  destination: { ...COUNTRY, required: true },
  warehouseCountry: { type: String, required: true },
  currency: { type: String, required: true },
  productCost: money,
  shippingCost: money,
  fulfillmentFee: money,
  minDays: { type: Number, default: 7 },
  maxDays: { type: Number, default: 14 },
  stock: { type: Number, default: 0, min: 0 },
  available: { type: Boolean, default: true },
  lastPriceChangePct: { type: Number, default: 0 },
  priceHistory: [{ _id: false, at: Date, productCost: Number, shippingCost: Number }],
  syncedAt: Date,
  /** 'manual' offers are typed in by an operator; they expire (confirmedAt + TTL) instead of being refreshed by an API. */
  source: { type: String, enum: ['api', 'manual'], default: 'api' },
  confirmedAt: Date,
}, schemaOpts);
offerSchema.index({ productId: 1, supplierId: 1, destination: 1 }, { unique: true });
offerSchema.index({ supplierId: 1, syncedAt: 1 });
export const SupplierOffer = defineModel('SupplierOffer', offerSchema, 'supplier_offers');

const inventorySchema = new Schema({
  productId: { type: oid, ref: 'Product', required: true },
  country: { ...COUNTRY, required: true },
  available: { type: Number, default: 0 },
  threshold: { type: Number, default: 10 },
  status: { type: String, enum: INVENTORY_STATUSES, default: 'IN_STOCK', index: true },
  bestSupplierId: { type: oid, ref: 'Supplier' },
  syncedAt: Date,
}, schemaOpts);
inventorySchema.index({ productId: 1, country: 1 }, { unique: true });
export const Inventory = defineModel('Inventory', inventorySchema, 'inventory');

/* ------------------------------- orders ------------------------------- */
const orderItemDef = {
  productId: { type: oid, ref: 'Product', required: true, immutable: true },
  sku: { type: String, required: true, immutable: true },
  title: { type: String, required: true, immutable: true },
  image: { type: String, immutable: true },
  quantity: { type: Number, required: true, min: 1, immutable: true },
  unitPrice: { ...money, immutable: true },
  lineKey: { type: String, required: true, immutable: true },
};

const orderSchema = new Schema({
  orderNumber: { type: String, required: true, unique: true, immutable: true },
  idempotencyKey: { type: String, required: true, unique: true, immutable: true },
  userId: { type: oid, ref: 'User', index: true },
  email: { type: String, required: true, index: true, immutable: true },
  country: { ...COUNTRY, required: true, immutable: true },
  currency: { type: String, required: true, immutable: true },
  // financial records are immutable after creation
  items: { type: [new Schema(orderItemDef, { _id: false })], immutable: true },
  address: { type: new Schema(addressDef, { _id: false }), immutable: true },
  shippingMethod: { type: String, immutable: true },
  amounts: {
    type: new Schema(
      {
        subtotal: money,
        discount: money,
        shipping: money,
        tax: money,
        total: money,
        taxInclusive: Boolean,
      },
      { _id: false },
    ),
    immutable: true,
  },
  couponCode: String,
  status: { type: String, enum: ORDER_STATUSES, default: 'PENDING_PAYMENT', index: true },
  timeline: [{ _id: false, status: String, at: Date, note: String, actor: String }],
  payment: {
    provider: String,
    intentId: String,
    status: { type: String, enum: ['pending', 'succeeded', 'failed', 'refunded', 'partially_refunded'], default: 'pending' },
    paidAt: Date,
    fee: money,
  },
  fraud: { score: Number, level: { type: String, enum: ['low', 'medium', 'high'] }, signals: [String], ip: String },
  fulfillment: {
    state: { type: String, enum: ['none', 'queued', 'processing', 'placed', 'partial', 'failed'], default: 'none' },
    attempts: { type: Number, default: 0 },
    lastError: String,
  },
  // Cost ledger filled in when supplier orders are placed.
  costs: {
    supplierCost: money,
    shippingCost: money,
    duties: money,
    paymentFee: money,
    refunded: money,
  },
  profit: { contribution: signedMoney, margin: { type: Number, default: 0 } },
  attribution: { campaignId: { type: oid, ref: 'Campaign' }, utmSource: String },
  exceptionOpen: { type: Boolean, default: false, index: true },
  cancelledAt: Date,
  deliveredAt: Date,
  isDemo: { type: Boolean, default: false },
}, schemaOpts);
orderSchema.index({ country: 1, createdAt: -1 });
orderSchema.index({ status: 1, createdAt: -1 });
orderSchema.index({ 'payment.intentId': 1 });
orderSchema.index({ createdAt: -1 });
export const Order = defineModel('Order', orderSchema, 'orders');

const orderItemSchema = new Schema({
  orderId: { type: oid, ref: 'Order', required: true, index: true },
  productId: { type: oid, ref: 'Product', index: true },
  sku: String,
  title: String,
  quantity: Number,
  unitPrice: money,
  country: COUNTRY,
  createdAt: { type: Date, index: true },
}, schemaOpts);
orderItemSchema.index({ productId: 1, createdAt: -1 });
export const OrderItem = defineModel('OrderItem', orderItemSchema, 'order_items');

const paymentSchema = new Schema({
  orderId: { type: oid, ref: 'Order', required: true, index: true },
  provider: { type: String, required: true },
  intentId: { type: String, required: true },
  clientSecret: { type: String, select: false },
  amount: money,
  currency: String,
  status: { type: String, enum: ['pending', 'succeeded', 'failed', 'refunded', 'partially_refunded'], default: 'pending' },
  failureReason: String,
  refundedAmount: money,
}, schemaOpts);
paymentSchema.index({ provider: 1, intentId: 1 }, { unique: true });
export const Payment = defineModel('Payment', paymentSchema, 'payments');

const webhookEventSchema = new Schema({
  provider: { type: String, required: true },
  eventId: { type: String, required: true },
  type: String,
  processedAt: Date,
  outcome: String,
}, schemaOpts);
webhookEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });
webhookEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });
export const WebhookEvent = defineModel('WebhookEvent', webhookEventSchema, 'webhook_events');

/** Supplier orders / shipments. Unique (orderId, lineKey) makes duplicate supplier orders impossible. */
const shipmentSchema = new Schema({
  orderId: { type: oid, ref: 'Order', required: true },
  lineKey: { type: String, required: true },
  productId: { type: oid, ref: 'Product' },
  sku: String,
  quantity: Number,
  supplierId: { type: oid, ref: 'Supplier', required: true },
  idempotencyKey: { type: String, required: true, unique: true },
  supplierOrderId: String,
  status: {
    type: String,
    enum: ['PENDING_CREATE', 'CREATED', 'SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED', 'CANCELLED', 'RETURNED'],
    default: 'PENDING_CREATE',
    index: true,
  },
  carrier: String,
  trackingNumber: String,
  trackingUrl: String,
  estimatedDelivery: Date,
  events: [{ _id: false, status: String, description: String, location: String, at: Date }],
  cost: { productCost: money, shippingCost: money, duties: money, currency: String },
  attempts: { type: Number, default: 0 },
  lastError: String,
  lastTrackedAt: Date,
  notified: { type: [String], default: [] },
}, schemaOpts);
// One ACTIVE supplier order per order line. FAILED/CANCELLED rows are history, so failover and change-supplier can place a replacement.
shipmentSchema.index({ orderId: 1, lineKey: 1 }, { unique: true, partialFilterExpression: { status: { $in: ['PENDING_CREATE', 'CREATED', 'SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'RETURNED'] } } });
shipmentSchema.index({ status: 1, lastTrackedAt: 1 });
export const Shipment = defineModel('Shipment', shipmentSchema, 'shipments');

/* ----------------------------- customer-ish ----------------------------- */
const reviewSchema = new Schema({
  productId: { type: oid, ref: 'Product', required: true },
  userId: { type: oid, ref: 'User', required: true },
  authorName: String,
  orderId: { type: oid, ref: 'Order' },
  rating: { type: Number, min: 1, max: 5, required: true },
  title: String,
  body: String,
  images: [String],
  verifiedPurchase: { type: Boolean, default: false },
  helpfulVotes: { type: Number, default: 0 },
  votedBy: { type: [oid], select: false },
  status: { type: String, enum: ['published', 'pending', 'rejected'], default: 'published' },
  sentiment: { type: String, enum: ['positive', 'neutral', 'negative'] },
  isDemo: { type: Boolean, default: false },
}, schemaOpts);
reviewSchema.index({ productId: 1, status: 1, createdAt: -1 });
reviewSchema.index({ productId: 1, userId: 1 }, { unique: true });
export const Review = defineModel('Review', reviewSchema, 'reviews');

const wishlistSchema = new Schema({
  userId: { type: oid, ref: 'User', required: true, unique: true },
  productIds: [{ type: oid, ref: 'Product' }],
}, schemaOpts);
export const Wishlist = defineModel('Wishlist', wishlistSchema, 'wishlists');

const cartSchema = new Schema({
  token: { type: String, required: true, unique: true },
  userId: { type: oid, ref: 'User', index: true },
  email: String,
  country: COUNTRY,
  items: [
    {
      _id: false,
      productId: { type: oid, ref: 'Product', required: true },
      sku: { type: String, required: true },
      quantity: { type: Number, required: true, min: 1, max: 10 },
    },
  ],
  couponCode: String,
  marketingConsent: { type: Boolean, default: false },
  convertedOrderId: { type: oid, ref: 'Order' },
  abandonment: {
    stage: { type: Number, default: 0 },
    lastSentAt: Date,
    stopped: { type: Boolean, default: false },
  },
  lastActivityAt: { type: Date, default: Date.now, index: true },
}, schemaOpts);
export const Cart = defineModel('Cart', cartSchema, 'carts');

const returnSchema = new Schema({
  orderId: { type: oid, ref: 'Order', required: true, index: true },
  userId: { type: oid, ref: 'User' },
  email: String,
  reason: String,
  details: String,
  itemSkus: [String],
  status: { type: String, enum: ['requested', 'approved', 'rejected', 'received', 'refunded'], default: 'requested', index: true },
  refundId: { type: oid, ref: 'Refund' },
  resolutionNote: String,
}, schemaOpts);
export const ReturnRequest = defineModel('Return', returnSchema, 'returns');

const refundSchema = new Schema({
  orderId: { type: oid, ref: 'Order', required: true, index: true },
  paymentId: { type: oid, ref: 'Payment' },
  amount: money,
  currency: String,
  reason: String,
  status: { type: String, enum: ['pending_approval', 'processing', 'succeeded', 'failed', 'rejected'], default: 'processing' },
  providerRefundId: String,
  idempotencyKey: { type: String, required: true, unique: true },
  requestedBy: String,
  failureReason: String,
}, schemaOpts);
export const Refund = defineModel('Refund', refundSchema, 'refunds');

const ticketSchema = new Schema({
  userId: { type: oid, ref: 'User' },
  email: String,
  orderId: { type: oid, ref: 'Order' },
  subject: String,
  messages: [{ _id: false, from: { type: String, enum: ['customer', 'ai', 'agent'] }, text: String, at: Date, meta: Mixed }],
  status: { type: String, enum: ['open', 'pending', 'escalated', 'resolved'], default: 'open', index: true },
  priority: { type: String, enum: ['low', 'normal', 'high'], default: 'normal' },
}, schemaOpts);
export const SupportTicket = defineModel('SupportTicket', ticketSchema, 'support_tickets');

/* ------------------------------ marketing ------------------------------ */
const promotionSchema = new Schema({
  name: { type: String, required: true },
  type: {
    type: String,
    enum: ['percentage', 'fixed', 'free_shipping', 'bxgy', 'first_order', 'cart', 'flash_sale', 'seasonal'],
    required: true,
  },
  code: { type: String, uppercase: true, trim: true },
  countries: [String], // empty = all
  /** percentage: fraction (0.1); fixed: map of country->minor units */
  percent: { type: Number, default: 0, min: 0, max: 0.9 },
  fixedAmount: { type: Map, of: Number },
  minSubtotal: { type: Map, of: Number },
  bxgy: { buy: Number, get: Number, productIds: [oid] },
  productIds: [oid],
  startsAt: Date,
  endsAt: Date,
  usageLimit: { type: Number, default: 0 },
  usedCount: { type: Number, default: 0 },
  perUserLimit: { type: Number, default: 1 },
  active: { type: Boolean, default: true },
  automated: { type: Boolean, default: false },
  /** Shown in storefront banners (code is only revealed when public). */
  public: { type: Boolean, default: false },
  recommendedBy: String,
}, schemaOpts);
promotionSchema.index({ code: 1 }, { unique: true, partialFilterExpression: { code: { $type: 'string' } } });
promotionSchema.index({ active: 1, startsAt: 1, endsAt: 1 });
export const Promotion = defineModel('Promotion', promotionSchema, 'promotions');

const couponSchema = new Schema({
  code: { type: String, required: true, unique: true, uppercase: true, trim: true },
  promotionId: { type: oid, ref: 'Promotion', required: true },
  redemptions: [{ _id: false, orderId: oid, email: String, at: Date }],
}, schemaOpts);
export const Coupon = defineModel('Coupon', couponSchema, 'coupons');

const adAccountSchema = new Schema({
  platform: { type: String, enum: ['meta', 'tiktok', 'google'], required: true },
  accountId: { type: String, required: true },
  name: String,
  status: { type: String, enum: ['connected', 'error', 'disconnected'], default: 'disconnected' },
  statusMessage: String,
  /** Credentials, if stored in DB at all, are AES-GCM encrypted; env vars are preferred. */
  credentialsEncrypted: { type: String, select: false },
  dailyLimit: money,
  monthlyLimit: money,
  currency: { type: String, default: 'USD' },
}, schemaOpts);
adAccountSchema.index({ platform: 1, accountId: 1 }, { unique: true });
export const AdAccount = defineModel('AdAccount', adAccountSchema, 'ad_accounts');

const campaignSchema = new Schema({
  platform: { type: String, enum: ['meta', 'tiktok', 'google'], required: true },
  adAccountId: { type: oid, ref: 'AdAccount' },
  externalId: String,
  productId: { type: oid, ref: 'Product', required: true, index: true },
  country: { ...COUNTRY, required: true },
  name: String,
  objective: { type: String, default: 'sales' },
  status: { type: String, enum: ['draft', 'pending_launch', 'active', 'paused', 'ended', 'failed'], default: 'draft', index: true },
  failureReason: String,
  dailyBudget: money,
  spent: money,
  adSets: [{ _id: false, name: String, externalId: String, audience: Mixed, dailyBudget: Number }],
  test: {
    isTest: { type: Boolean, default: true },
    durationDays: Number,
    minImpressions: Number,
    minClicks: Number,
    minSpend: Number,
    targetCpa: Number,
    targetRoas: Number,
    verdict: { type: String, enum: ['WIN', 'CONTINUE', 'KILL', 'PENDING'], default: 'PENDING' },
  },
  recommendation: { action: String, reason: String, at: Date },
  launchedAt: Date,
  isDemo: { type: Boolean, default: false },
}, schemaOpts);
campaignSchema.index({ platform: 1, externalId: 1 }, { unique: true, partialFilterExpression: { externalId: { $type: 'string' } } });
export const Campaign = defineModel('Campaign', campaignSchema, 'campaigns');

const creativeSchema = new Schema({
  campaignId: { type: oid, ref: 'Campaign', index: true },
  productId: { type: oid, ref: 'Product', required: true, index: true },
  concept: { type: String, enum: ['problem_hook', 'emotional_hook', 'demonstration', 'ugc', 'before_after', 'other'] },
  hook: String,
  primaryText: String,
  headline: String,
  description: String,
  cta: String,
  videoScript: String,
  status: { type: String, enum: ['draft', 'active', 'paused', 'winner', 'loser'], default: 'draft' },
  externalId: String,
  source: { type: String, default: 'template' },
  isDemo: { type: Boolean, default: false },
}, schemaOpts);
export const AdCreative = defineModel('AdCreative', creativeSchema, 'ad_creatives');

const adMetricSchema = new Schema({
  campaignId: { type: oid, ref: 'Campaign', required: true },
  creativeId: { type: oid, ref: 'AdCreative' },
  productId: { type: oid, ref: 'Product', index: true },
  platform: String,
  country: COUNTRY,
  date: { type: Date, required: true },
  impressions: { type: Number, default: 0 },
  clicks: { type: Number, default: 0 },
  spend: money,
  addToCart: { type: Number, default: 0 },
  checkouts: { type: Number, default: 0 },
  purchases: { type: Number, default: 0 },
  revenue: money,
  isDemo: { type: Boolean, default: false },
}, schemaOpts);
adMetricSchema.index({ campaignId: 1, creativeId: 1, date: 1 }, { unique: true });
adMetricSchema.index({ date: -1, country: 1 });
export const AdMetric = defineModel('AdMetric', adMetricSchema, 'ad_metrics');

/** Storefront behavioural events (page/product views, add-to-cart, checkout). TTL 180d. */
const analyticsSchema = new Schema(
  {
    type: { type: String, required: true },
    sessionId: String,
    userId: { type: oid, ref: 'User' },
    productId: { type: oid, ref: 'Product' },
    category: String,
    country: COUNTRY,
    ts: { type: Date, default: Date.now },
    meta: Mixed,
  },
  { timestamps: false, versionKey: false },
);
analyticsSchema.index({ ts: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 180 });
analyticsSchema.index({ type: 1, ts: -1 });
analyticsSchema.index({ productId: 1, type: 1, ts: -1 });
analyticsSchema.index({ sessionId: 1, ts: -1 });
export const AnalyticsEvent = defineModel('AnalyticsEvent', analyticsSchema, 'analytics');

const reportSchema = new Schema({
  kind: { type: String, default: 'daily_brief' },
  date: { type: String, required: true },
  data: Mixed,
  narrative: String,
  source: String,
}, schemaOpts);
reportSchema.index({ kind: 1, date: 1 }, { unique: true });
export const Report = defineModel('Report', reportSchema, 'reports');

/* --------------------------------- AI --------------------------------- */
const productScoreSchema = new Schema({
  productId: { type: oid, ref: 'Product', required: true },
  components: Mixed,
  finalScore: Number,
  action: String,
  reasons: [String],
  source: String,
  computedAt: { type: Date, default: Date.now },
}, schemaOpts);
productScoreSchema.index({ productId: 1, computedAt: -1 });
export const ProductScore = defineModel('ProductScore', productScoreSchema, 'product_scores');

const aiTaskSchema = new Schema({
  agent: { type: String, required: true, index: true },
  status: { type: String, enum: ['running', 'succeeded', 'failed'], default: 'running' },
  input: Mixed,
  output: Mixed,
  confidence: Number,
  summary: String,
  provider: String,
  attempts: { type: Number, default: 1 },
  durationMs: Number,
  error: String,
}, schemaOpts);
aiTaskSchema.index({ createdAt: -1 });
export const AiTask = defineModel('AiTask', aiTaskSchema, 'ai_tasks');

const aiDecisionSchema = new Schema({
  agent: { type: String, required: true, index: true },
  kind: { type: String, required: true, index: true },
  automationKey: String,
  resource: String,
  resourceId: String,
  summary: { type: String, required: true },
  payload: Mixed,
  confidence: Number,
  status: {
    type: String,
    enum: ['proposed', 'approved', 'rejected', 'executed', 'auto_executed', 'failed', 'expired'],
    default: 'proposed',
    index: true,
  },
  mode: { type: String, enum: ['ASSISTED', 'AUTOMATIC'] },
  decidedBy: String,
  executedAt: Date,
  result: Mixed,
  error: String,
  dedupeKey: String,
}, schemaOpts);
aiDecisionSchema.index({ dedupeKey: 1, status: 1 });
aiDecisionSchema.index({ createdAt: -1 });
export const AiDecision = defineModel('AiDecision', aiDecisionSchema, 'ai_decisions');

const exceptionSchema = new Schema({
  kind: { type: String, enum: EXCEPTION_KINDS, required: true, index: true },
  priority: { type: String, enum: ['low', 'medium', 'high', 'critical'], default: 'medium' },
  status: { type: String, enum: ['open', 'in_progress', 'resolved', 'dismissed'], default: 'open', index: true },
  issue: { type: String, required: true },
  orderId: { type: oid, ref: 'Order' },
  productId: { type: oid, ref: 'Product' },
  customerEmail: String,
  aiRecommendation: String,
  suggestedAction: String,
  actionCode: String, // machine-readable e.g. retry_supplier_order
  details: Mixed,
  dedupeKey: { type: String },
  resolvedBy: String,
  resolvedAt: Date,
  resolution: String,
}, schemaOpts);
exceptionSchema.index({ dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' }, status: { $in: ['open', 'in_progress'] } } });
exceptionSchema.index({ status: 1, priority: 1, createdAt: -1 });
export const ExceptionModel = defineModel('Exception', exceptionSchema, 'exceptions');

/* -------------------------------- system -------------------------------- */
const notificationSchema = new Schema({
  userId: { type: oid, ref: 'User' },
  orderId: { type: oid, ref: 'Order' },
  to: String,
  channel: { type: String, enum: ['email', 'sms', 'push', 'whatsapp'], required: true },
  template: String,
  subject: String,
  body: String,
  status: { type: String, enum: ['queued', 'sent', 'failed', 'logged_dev', 'skipped'], default: 'queued', index: true },
  provider: String,
  providerMessageId: String,
  error: String,
  dedupeKey: String,
}, schemaOpts);
notificationSchema.index({ dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } });
notificationSchema.index({ createdAt: -1 });
export const Notification = defineModel('Notification', notificationSchema, 'notifications');

const auditSchema = new Schema(
  {
    timestamp: { type: Date, default: Date.now, index: true },
    actor: { type: String, required: true },
    actorType: { type: String, enum: ['user', 'ai', 'system', 'webhook', 'anonymous'], required: true },
    action: { type: String, required: true, index: true },
    resource: { type: String, index: true },
    resourceId: { type: String, index: true },
    previousValue: Mixed,
    newValue: Mixed,
    reason: String,
    aiSummary: String,
    provider: String,
    requestId: String,
  },
  { timestamps: false, versionKey: false },
);
export const AuditLog = defineModel('AuditLog', auditSchema, 'audit_logs');

const settingSchema = new Schema({
  key: { type: String, required: true, unique: true },
  value: Mixed,
  updatedBy: String,
}, schemaOpts);
export const SystemSetting = defineModel('SystemSetting', settingSchema, 'system_settings');

const countryConfigSchema = new Schema({
  code: { ...COUNTRY, required: true, unique: true },
  config: Mixed,
}, schemaOpts);
export const CountryConfigModel = defineModel('CountryConfig', countryConfigSchema, 'country_configs');

/** Durable job queue (Mongo-backed). See packages/core/src/queue. */
const jobSchema = new Schema({
  queue: { type: String, required: true },
  name: { type: String, required: true },
  payload: Mixed,
  dedupeKey: String,
  status: { type: String, enum: ['queued', 'active', 'completed', 'failed', 'dead'], default: 'queued' },
  runAt: { type: Date, default: Date.now },
  attempts: { type: Number, default: 0 },
  maxAttempts: { type: Number, default: 5 },
  lockedBy: String,
  lockedUntil: Date,
  lastError: String,
  result: Mixed,
  completedAt: Date,
}, schemaOpts);
jobSchema.index({ status: 1, runAt: 1, queue: 1 });
jobSchema.index({ dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' }, status: { $in: ['queued', 'active'] } } });
jobSchema.index({ completedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 14, partialFilterExpression: { status: 'completed' } });
export const Job = defineModel('Job', jobSchema, 'jobs');

/** Dev/test-only persistence for mock providers so API + worker processes share state. */
const mockStoreSchema = new Schema({
  kind: { type: String, required: true },
  key: { type: String, required: true },
  data: Mixed,
}, schemaOpts);
mockStoreSchema.index({ kind: 1, key: 1 }, { unique: true });
export const MockStore = defineModel('MockStore', mockStoreSchema, 'mock_store');

/** One uploaded/ingested image: the Orvia-hosted original + processed variants. Supplier URL is kept only as provenance. */
const productAssetSchema = new Schema({
  productId: { type: oid, ref: 'Product', required: true, index: true },
  kind: { type: String, enum: ['image'], default: 'image' },
  source: { type: String, enum: ['supplier', 'admin'], required: true },
  sourceUrl: String,
  supplierId: { type: oid, ref: 'Supplier' },
  status: { type: String, enum: ['ready', 'failed'], required: true },
  error: String,
  sha256: String,
  dhash: String,
  width: Number,
  height: Number,
  bytes: Number,
  format: String,
  hasAlpha: Boolean,
  variants: { thumb: String, card: String, page: String, zoom: String, og: String },
  keys: [String],
  alt: String,
  position: { type: Number, default: 0 },
  isPrimary: { type: Boolean, default: false },
  variantSku: String,
  countries: [String],
  license: { type: String, enum: ['unknown', 'supplier_provided', 'owned'], default: 'unknown' },
  createdBy: String,
}, schemaOpts);
productAssetSchema.index({ productId: 1, sha256: 1 });
productAssetSchema.index({ productId: 1, sourceUrl: 1 });
export const ProductAsset = defineModel('ProductAsset', productAssetSchema, 'product_assets');
