/** aftersales: mongoose models (owned by the aftersales workstream). All collections are prefixed `aftersales_`. */
import { Schema } from 'mongoose';
import { CHARGEBACK_PROVIDERS, CHARGEBACK_STATES, CLAIM_KINDS, CLAIM_STATES, ITEM_CONDITIONS, RESOLUTION_TYPES, RMA_STATES, RETURN_REASON_CODES } from '@orvia/types';
import { COUNTRY, Mixed, defineModel, money, oid, schemaOpts } from './helpers';

const timelineEntry = { _id: false, state: String, at: Date, actor: String, note: String };
const noteEntry = { _id: false, at: Date, by: String, text: String, internal: { type: Boolean, default: true } };

/**
 * RMA record: extends the core `Return` document (1:1 via returnId) without editing it. The core Return keeps the
 * coarse status (requested/approved/received/refunded/rejected); this carries the rich workflow.
 */
const aftersalesReturnSchema = new Schema({
  returnId: { type: oid, ref: 'Return', required: true, unique: true },
  orderId: { type: oid, ref: 'Order', required: true, index: true },
  orderNumber: String,
  userId: { type: oid, ref: 'User', index: true },
  email: { type: String, index: true },
  country: COUNTRY,
  currency: String,
  rmaNumber: { type: String, required: true, unique: true },
  state: { type: String, enum: RMA_STATES, default: 'submitted', index: true },
  reasonCode: { type: String, enum: RETURN_REASON_CODES, required: true },
  details: String,
  resolution: { type: String, enum: RESOLUTION_TYPES, default: 'refund' },
  items: [{
    _id: false,
    sku: String, title: String, productId: { type: oid, ref: 'Product' }, supplierId: { type: oid, ref: 'Supplier' },
    quantity: Number, acceptedQuantity: Number, unitPrice: money, condition: { type: String, enum: ITEM_CONDITIONS },
  }],
  evidenceRequired: { type: Boolean, default: false },
  evidence: [{ _id: false, id: String, key: String, mime: String, bytes: Number, uploadedAt: Date, uploadedBy: String, byStaff: Boolean }],
  eligibility: Mixed,
  returnMethod: { type: String, enum: ['ship_back', 'staff_decides', 'none_needed'] },
  needsStaffReview: Boolean,
  instructions: String,
  returnAddress: Mixed,
  label: { url: String, carrier: String, trackingNumber: String, source: { type: String, enum: ['provider', 'supplier_provided'] }, providerKey: String, providerRef: String, issuedAt: Date },
  inspection: { outcome: String, note: String, by: String, at: Date },
  refundCalc: Mixed,
  refundId: { type: oid, ref: 'Refund' },
  exchange: { requestedSku: String, priceDifferenceRefund: money },
  fulfilment: { status: { type: String, enum: ['pending', 'ordered', 'shipped', 'delivered'] }, supplierOrderRef: String, carrier: String, trackingNumber: String, updatedAt: Date },
  supplierClaimId: { type: oid, ref: 'AftersalesClaim' },
  timeline: [timelineEntry],
  notes: [noteEntry],
}, schemaOpts);
aftersalesReturnSchema.index({ state: 1, createdAt: -1 });
aftersalesReturnSchema.index({ createdAt: -1 });
aftersalesReturnSchema.index({ 'items.supplierId': 1, createdAt: -1 });
aftersalesReturnSchema.index({ 'items.productId': 1, createdAt: -1 });
export const AftersalesReturn = defineModel('AftersalesReturn', aftersalesReturnSchema, 'aftersales_returns');

/** Per-supplier return handling instructions and capabilities (kept here so the core Supplier doc is untouched). */
const supplierPolicySchema = new Schema({
  supplierId: { type: oid, ref: 'Supplier', required: true, unique: true },
  supportsReturns: { type: String, enum: ['yes', 'no', 'unknown'], default: 'unknown' },
  supportsReplacement: { type: Boolean, default: false },
  supportsExchange: { type: Boolean, default: false },
  returnWindowDays: Number,
  defectOnly: { type: Boolean, default: false },
  claimWindowDays: Number,
  instructions: String,
  contactEmail: String,
  returnAddress: Mixed,
  labelProvider: String,
  updatedBy: String,
}, schemaOpts);
export const AftersalesSupplierPolicy = defineModel('AftersalesSupplierPolicy', supplierPolicySchema, 'aftersales_supplier_policies');

/** Claim against a supplier (defect, non-delivery, wrong item, damage) to recover goods cost. */
const claimSchema = new Schema({
  claimNumber: { type: String, required: true, unique: true },
  supplierId: { type: oid, ref: 'Supplier', required: true, index: true },
  orderId: { type: oid, ref: 'Order', required: true, index: true },
  returnId: { type: oid, ref: 'Return', index: true },
  kind: { type: String, enum: CLAIM_KINDS, required: true },
  state: { type: String, enum: CLAIM_STATES, default: 'draft', index: true },
  currency: String,
  claimedAmount: money,
  approvedAmount: money,
  recoveredAmount: money,
  description: String,
  dueBy: Date,
  timeline: [timelineEntry],
  notes: [noteEntry],
}, schemaOpts);
claimSchema.index({ supplierId: 1, state: 1 });
claimSchema.index({ createdAt: -1 });
export const AftersalesClaim = defineModel('AftersalesClaim', claimSchema, 'aftersales_claims');

/** Card-network disputes ingested from provider webhooks. Unique per (provider, disputeId): replays update, never duplicate. */
const chargebackSchema = new Schema({
  provider: { type: String, enum: CHARGEBACK_PROVIDERS, required: true },
  disputeId: { type: String, required: true },
  orderId: { type: oid, ref: 'Order', index: true },
  orderNumber: String,
  paymentId: { type: oid, ref: 'Payment' },
  intentId: String,
  chargeId: String,
  country: COUNTRY,
  currency: String,
  amount: money,
  fee: money,
  reason: String,
  providerStatus: String,
  state: { type: String, enum: CHARGEBACK_STATES, default: 'needs_response', index: true },
  evidenceDueBy: { type: Date, index: true },
  openedAt: Date,
  closedAt: Date,
  /** Unmatched disputes (no local payment found) are kept and flagged for manual matching. */
  unmatched: { type: Boolean, default: false },
  evidence: [{ _id: false, at: Date, by: String, category: String, text: String }],
  submission: { status: { type: String, enum: ['not_submitted', 'submitted_unverified', 'failed', 'unsupported'], default: 'not_submitted' }, at: Date, by: String, error: String, providerStatus: String },
  accepted: { by: String, at: Date },
  timeline: [timelineEntry],
  lastEventId: String,
  alerted: { type: [String], default: [] },
}, schemaOpts);
chargebackSchema.index({ provider: 1, disputeId: 1 }, { unique: true });
chargebackSchema.index({ state: 1, evidenceDueBy: 1 });
chargebackSchema.index({ createdAt: -1 });
export const AftersalesChargeback = defineModel('AftersalesChargeback', chargebackSchema, 'aftersales_chargebacks');

/** Key/value config for the aftersales module (policy overrides). */
const configSchema = new Schema({ key: { type: String, required: true, unique: true }, value: Mixed, updatedBy: String }, schemaOpts);
export const AftersalesConfig = defineModel('AftersalesConfig', configSchema, 'aftersales_config');
