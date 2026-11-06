/** find: mongoose models (ORVIA Find + Price Guard; owned by the find workstream). */
import { Schema } from 'mongoose';
import { COUNTRY, defineModel, oid, schemaOpts } from './helpers';

/**
 * Observed per-country price of a sellable product. One row per observed CHANGE (price or availability), so history is
 * compact and honest: only what we actually saw. Rows are never edited and no reference/"was" price is ever stored.
 */
const priceSnapshotSchema = new Schema({
  productId: { type: oid, ref: 'Product', required: true },
  country: { ...COUNTRY, required: true },
  price: { type: Number, required: true, min: 1, validate: Number.isInteger }, // minor units
  currency: { type: String, required: true },
  inStock: { type: Boolean, required: true },
  observedAt: { type: Date, required: true, default: () => new Date() },
  source: { type: String, enum: ['scheduled', 'on_demand'], default: 'scheduled' },
}, { timestamps: false, versionKey: false });
priceSnapshotSchema.index({ productId: 1, country: 1, observedAt: -1 });
priceSnapshotSchema.index({ observedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 730 }); // keep two years
export const FindPriceSnapshot = defineModel('FindPriceSnapshot', priceSnapshotSchema, 'find_price_snapshots');

const savedSearchSchema = new Schema({
  userId: { type: oid, ref: 'User', required: true, index: true },
  name: { type: String, required: true, maxlength: 80 },
  query: { type: String, required: true, maxlength: 300 },
  country: { ...COUNTRY, required: true },
  budgetMax: Number, // major units of the market currency, as typed by the user
  deliverBy: String, // YYYY-MM-DD
  alert: {
    newMatches: { type: Boolean, default: false },
    lastCheckedAt: Date,
    lastNotifiedAt: Date,
    /** product ids already seen/notified (bounded) so only genuinely new matches trigger a message */
    seenIds: { type: [String], default: [] },
  },
}, schemaOpts);
savedSearchSchema.index({ userId: 1, createdAt: -1 });
savedSearchSchema.index({ 'alert.newMatches': 1, 'alert.lastCheckedAt': 1 });
export const FindSavedSearch = defineModel('FindSavedSearch', savedSearchSchema, 'find_saved_searches');

const priceAlertSchema = new Schema({
  userId: { type: oid, ref: 'User', required: true },
  productId: { type: oid, ref: 'Product', required: true },
  country: { ...COUNTRY, required: true },
  currency: { type: String, required: true },
  active: { type: Boolean, default: true },
  /** price (minor units) when tracking began: drops are measured against this, never against a manufactured reference */
  baselinePrice: { type: Number, required: true, min: 1 },
  targetPrice: { type: Number, default: null, min: 1 },
  dropPercent: { type: Number, default: 5, min: 1, max: 90 },
  notifyOnDrop: { type: Boolean, default: true },
  notifyOnStock: { type: Boolean, default: true },
  notifyOnBetterOffer: { type: Boolean, default: true },
  // dedupe state (see priceGuard.decideAlertEvents)
  lastSeenInStock: { type: Boolean, default: null },
  lastSeenPrice: Number,
  lastNotifiedDropPrice: { type: Number, default: null },
  targetNotifiedPrice: { type: Number, default: null },
  betterOfferNotifiedId: { type: String, default: null },
  betterOfferNotifiedPrice: { type: Number, default: null },
  lastCheckedAt: Date,
  lastNotifiedAt: Date,
  notifiedCount: { type: Number, default: 0 },
}, schemaOpts);
priceAlertSchema.index({ userId: 1, productId: 1, country: 1 }, { unique: true });
priceAlertSchema.index({ userId: 1, active: 1 });
priceAlertSchema.index({ active: 1, lastCheckedAt: 1 });
priceAlertSchema.index({ productId: 1, country: 1, active: 1 });
export const FindPriceAlert = defineModel('FindPriceAlert', priceAlertSchema, 'find_price_alerts');
