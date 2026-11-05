/** creators: mongoose models (owned by the creators workstream). Collections are prefixed `creator_` / `loyalty_`. */
import { Schema } from 'mongoose';
import { CREATOR_FLAG_KINDS, CREATOR_STATUSES, LEDGER_KINDS, LEDGER_STATUSES, PAYOUT_STATUSES } from '@orvia/types';
import { Mixed, defineModel, money, oid, schemaOpts, signedMoney } from './helpers';

const CUR = { type: String, enum: ['USD', 'CAD', 'INR'] };

/** One creator per user. Only the handle/display data is public; everything else is private to the creator and staff. */
const creatorProfileSchema = new Schema({
  userId: { type: oid, ref: 'User', required: true, unique: true },
  handle: { type: String, required: true, unique: true, lowercase: true },
  displayName: { type: String, required: true },
  bio: { type: String, default: '' },
  avatarUrl: String,
  socialLinks: [{ _id: false, platform: String, url: String }],
  audience: String,
  status: { type: String, enum: CREATOR_STATUSES, default: 'pending', index: true },
  appliedAt: Date,
  reviewedAt: Date,
  reviewedBy: String,
  reviewNote: String,
  termsAcceptedAt: Date,
  /** per-creator commission override (replaces default/category/tier rates when set) */
  rateOverride: { type: Number, min: 0, max: 0.5 },
  categoryRateOverrides: { type: Map, of: Number },
  /** payout checklist: we store ONLY that information was collected + an opaque reference, never raw IDs or bank numbers */
  payoutProfile: {
    kycStatus: { type: String, enum: ['not_started', 'collected', 'verified', 'rejected'], default: 'not_started' },
    taxInfoCollected: { type: Boolean, default: false },
    taxInfoReference: String,
    kycReference: String,
    method: { type: String, enum: ['bank_transfer', 'upi', 'paypal', 'other'] },
    verifiedBy: String,
    verifiedAt: Date,
  },
  /** manual fraud hold: ledger entries of this creator are not released while true */
  payoutsHeld: { type: Boolean, default: false },
  holdReason: String,
  stats: { clicks: { type: Number, default: 0 } },
}, schemaOpts);
creatorProfileSchema.index({ status: 1, createdAt: -1 });
export const CreatorProfile = defineModel('CreatorProfile', creatorProfileSchema, 'creator_profiles');

const creatorCollectionSchema = new Schema({
  creatorId: { type: oid, ref: 'CreatorProfile', required: true },
  slug: { type: String, required: true },
  title: { type: String, required: true },
  description: { type: String, default: '' },
  items: [{ _id: false, productId: { type: oid, ref: 'Product', required: true }, note: String }],
  published: { type: Boolean, default: false },
  publishedAt: Date,
  discussionEnabled: { type: Boolean, default: true },
}, schemaOpts);
creatorCollectionSchema.index({ creatorId: 1, slug: 1 }, { unique: true });
creatorCollectionSchema.index({ creatorId: 1, published: 1, updatedAt: -1 });
export const CreatorCollection = defineModel('CreatorCollection', creatorCollectionSchema, 'creator_collections');

/** Trackable share link for a product recommendation or a collection. */
const creatorLinkSchema = new Schema({
  creatorId: { type: oid, ref: 'CreatorProfile', required: true, index: true },
  code: { type: String, required: true, unique: true },
  label: { type: String, required: true },
  productId: { type: oid, ref: 'Product' },
  collectionId: { type: oid, ref: 'CreatorCollection' },
  clicks: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
}, schemaOpts);
export const CreatorLink = defineModel('CreatorLink', creatorLinkSchema, 'creator_links');

/** One row per recorded landing. IP/device are salted hashes only (never raw). Auto-expires after 180 days. */
const creatorClickSchema = new Schema({
  creatorId: { type: oid, ref: 'CreatorProfile', required: true },
  linkId: { type: oid, ref: 'CreatorLink' },
  cartToken: String,
  ipHash: String,
  deviceHash: String,
  landing: String,
  userId: { type: oid, ref: 'User' },
  at: { type: Date, default: Date.now },
}, schemaOpts);
creatorClickSchema.index({ creatorId: 1, at: -1 });
creatorClickSchema.index({ creatorId: 1, ipHash: 1, at: -1 });
creatorClickSchema.index({ at: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 180 });
export const CreatorClick = defineModel('CreatorClick', creatorClickSchema, 'creator_clicks');

/** Singleton program configuration (`key: 'default'`). `rules` / `loyalty` are zod-validated on write; absent = code defaults. */
const programConfigSchema = new Schema({
  key: { type: String, required: true, unique: true },
  rules: Mixed,
  loyalty: Mixed,
  updatedBy: String,
}, schemaOpts);
export const CreatorProgramConfig = defineModel('CreatorProgramConfig', programConfigSchema, 'creator_program_config');

/**
 * Commission ledger. Signed minor units in the ORDER currency. Append-only except status transitions
 * (accrued → payable → paid / reversed) and the pre-payable amount re-computation. `idempotencyKey` is unique.
 */
const ledgerSchema = new Schema({
  creatorId: { type: oid, ref: 'CreatorProfile', required: true },
  kind: { type: String, enum: LEDGER_KINDS, required: true },
  status: { type: String, enum: LEDGER_STATUSES, default: 'accrued' },
  amount: signedMoney,
  currency: CUR,
  orderId: { type: oid, ref: 'Order' },
  idempotencyKey: { type: String, required: true, unique: true },
  holdUntil: Date,
  payableAt: Date,
  paidAt: Date,
  payoutId: { type: oid, ref: 'CreatorPayout' },
  /** statement material: non-PII facts that justify the amount */
  detail: {
    orderRef: String, orderedAt: Date, deliveredAt: Date, netBase: money, rate: Number, rateSource: String, tier: String,
    capped: [String], reasons: [String], refundedAtCalc: money, lines: [{ _id: false, category: String, net: money, rate: Number, commission: money }],
  },
  note: String,
  actor: String,
}, schemaOpts);
ledgerSchema.index({ creatorId: 1, status: 1, currency: 1 });
ledgerSchema.index({ orderId: 1, kind: 1 });
ledgerSchema.index({ status: 1, holdUntil: 1 });
ledgerSchema.index({ payoutId: 1 });
export const CreatorLedger = defineModel('CreatorLedger', ledgerSchema, 'creator_ledger');

const payoutSchema = new Schema({
  creatorId: { type: oid, ref: 'CreatorProfile', required: true },
  currency: { ...CUR, required: true },
  amount: money,
  status: { type: String, enum: PAYOUT_STATUSES, default: 'requested' },
  entryCount: { type: Number, default: 0 },
  note: String,
  requestedAt: Date,
  approvedBy: String,
  approvedAt: Date,
  paidBy: String,
  paidAt: Date,
  /** payout execution is manual (bank/PSP console). We record method + the external transfer reference only. */
  method: String,
  externalReference: String,
  rejectedReason: String,
  checklist: { kycOk: Boolean, taxOk: Boolean, thresholdOk: Boolean, noOpenFlags: Boolean },
}, schemaOpts);
payoutSchema.index({ creatorId: 1, createdAt: -1 });
payoutSchema.index({ status: 1, createdAt: -1 });
export const CreatorPayout = defineModel('CreatorPayout', payoutSchema, 'creator_payouts');

/** Fraud / review queue entry. */
const flagSchema = new Schema({
  creatorId: { type: oid, ref: 'CreatorProfile', required: true },
  orderId: { type: oid, ref: 'Order' },
  kind: { type: String, enum: CREATOR_FLAG_KINDS, required: true },
  severity: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
  detail: String,
  status: { type: String, enum: ['open', 'cleared', 'confirmed'], default: 'open' },
  dedupeKey: { type: String, required: true, unique: true },
  resolvedBy: String,
  resolvedAt: Date,
  resolution: String,
}, schemaOpts);
flagSchema.index({ status: 1, createdAt: -1 });
flagSchema.index({ creatorId: 1, status: 1 });
flagSchema.index({ orderId: 1, status: 1 });
export const CreatorFlag = defineModel('CreatorFlag', flagSchema, 'creator_flags');

/** Collection discussion. Display name only; moderated before publishing. */
const commentSchema = new Schema({
  collectionId: { type: oid, ref: 'CreatorCollection', required: true },
  creatorId: { type: oid, ref: 'CreatorProfile', required: true },
  userId: { type: oid, ref: 'User', required: true },
  displayName: { type: String, required: true },
  body: { type: String, required: true },
  status: { type: String, enum: ['pending', 'published', 'rejected', 'removed'], default: 'pending' },
  reports: [{ _id: false, userId: { type: oid }, reason: String, at: Date }],
  reportCount: { type: Number, default: 0 },
  moderatedBy: String,
}, schemaOpts);
commentSchema.index({ collectionId: 1, status: 1, createdAt: -1 });
commentSchema.index({ status: 1, createdAt: 1 });
commentSchema.index({ userId: 1, createdAt: -1 });
export const CollectionComment = defineModel('CollectionComment', commentSchema, 'creator_comments');

/** Normalised, hashed signals recorded per referral-bearing order (duplicate/abuse detection for the referral programme). */
const referralSignalSchema = new Schema({
  orderId: { type: oid, ref: 'Order', required: true, unique: true },
  referrerUserId: { type: oid, ref: 'User', index: true },
  normalizedEmail: { type: String, index: true },
  addressHash: String,
  phoneHash: String,
  ipHash: String,
  outcome: { type: String, enum: ['rewarded', 'rejected'], required: true },
  reason: String,
}, schemaOpts);
referralSignalSchema.index({ referrerUserId: 1, outcome: 1, createdAt: -1 });
export const ReferralSignal = defineModel('ReferralSignal', referralSignalSchema, 'referral_signals');

/* ------------------------------ loyalty ------------------------------ */
const loyaltyAccountSchema = new Schema({
  userId: { type: oid, ref: 'User', required: true, unique: true },
  balance: { type: Number, default: 0 },
  lifetimePoints: { type: Number, default: 0 },
  tier: String,
}, schemaOpts);
export const LoyaltyAccount = defineModel('LoyaltyAccount', loyaltyAccountSchema, 'loyalty_accounts');

/** Points ledger. `remaining` on earn rows drives FIFO expiry. Unique idempotency key. */
const loyaltyLedgerSchema = new Schema({
  userId: { type: oid, ref: 'User', required: true },
  kind: { type: String, enum: ['earn', 'bonus', 'redeem', 'expire', 'adjust', 'reversal', 'restore'], required: true },
  points: { type: Number, required: true },
  remaining: { type: Number, default: 0 },
  expiresAt: Date,
  orderId: { type: oid, ref: 'Order' },
  redemptionId: { type: oid },
  idempotencyKey: { type: String, required: true, unique: true },
  note: String,
  actor: String,
}, schemaOpts);
loyaltyLedgerSchema.index({ userId: 1, createdAt: -1 });
loyaltyLedgerSchema.index({ userId: 1, kind: 1, remaining: 1, expiresAt: 1 });
loyaltyLedgerSchema.index({ kind: 1, expiresAt: 1 });
export const LoyaltyLedger = defineModel('LoyaltyLedger', loyaltyLedgerSchema, 'loyalty_ledger');

const loyaltyRedemptionSchema = new Schema({
  userId: { type: oid, ref: 'User', required: true },
  points: Number,
  valueUsd: money,
  code: { type: String, required: true, unique: true },
  promotionId: { type: oid, ref: 'Promotion' },
  expiresAt: Date,
  status: { type: String, enum: ['active', 'used', 'expired'], default: 'active' },
}, schemaOpts);
loyaltyRedemptionSchema.index({ userId: 1, createdAt: -1 });
loyaltyRedemptionSchema.index({ status: 1, expiresAt: 1 });
export const LoyaltyRedemption = defineModel('LoyaltyRedemption', loyaltyRedemptionSchema, 'loyalty_redemptions');
