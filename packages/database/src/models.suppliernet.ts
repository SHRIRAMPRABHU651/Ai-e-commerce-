/** suppliernet: mongoose models (owned by the suppliernet workstream). All collections are prefixed `suppliernet_`. */
import { Schema } from 'mongoose';
import {
  DISPUTE_STATES, DISPUTE_TYPES, MATCH_STATUSES, RETURN_AUTH_STATES, STATEMENT_STATUSES, SUPPLIER_DOCUMENT_KINDS, SUPPLIER_DOCUMENT_STATUSES,
  SUPPLIER_ONBOARDING_STATES, SUPPLIER_TYPES, VERIFICATION_STEP_KINDS, VERIFICATION_STEP_STATUSES,
} from '@orvia/types';
import { Mixed, defineModel, oid, schemaOpts, signedMoney } from './helpers';

/** One profile per supplier: legal/commercial facts, onboarding state machine history, credential-rotation metadata (never secrets). */
const profileSchema = new Schema({
  supplierId: { type: oid, ref: 'Supplier', required: true, unique: true },
  state: { type: String, enum: SUPPLIER_ONBOARDING_STATES, default: 'invited', index: true },
  supplierType: { type: String, enum: SUPPLIER_TYPES, required: true },
  invitedEmail: String,
  profile: Mixed, // validated by supplierProfileSchema before it is stored
  profileSubmittedAt: Date,
  probationStartedAt: Date,
  approvedAt: Date,
  suspendedReason: String,
  history: [{ _id: false, from: String, to: String, at: Date, by: String, reason: String }],
  credentials: { fields: [String], lastRotatedAt: Date, rotatedBy: String, rotationIntervalDays: { type: Number, default: 180 } },
  /** Declared (claimed) capability flags; proven ones come from verification steps. */
  declaredCapabilities: [String],
}, schemaOpts);
profileSchema.index({ state: 1, updatedAt: -1 });
export const SuppliernetProfile = defineModel('SuppliernetProfile', profileSchema, 'suppliernet_profiles');

const documentSchema = new Schema({
  supplierId: { type: oid, ref: 'Supplier', required: true },
  kind: { type: String, enum: SUPPLIER_DOCUMENT_KINDS, required: true },
  title: { type: String, required: true, maxlength: 160 },
  /** Object-storage key. Never exposed publicly: files are served only through permission-checked routes. */
  storageKey: { type: String, required: true, select: false },
  mime: String,
  bytes: Number,
  sha256: String,
  status: { type: String, enum: SUPPLIER_DOCUMENT_STATUSES, default: 'pending' },
  expiresAt: Date,
  uploadedBy: String,
  uploadedByRole: String,
  reviewedBy: String,
  reviewedAt: Date,
  reviewNote: String,
}, schemaOpts);
documentSchema.index({ supplierId: 1, kind: 1, createdAt: -1 });
documentSchema.index({ status: 1, expiresAt: 1 });
export const SuppliernetDocument = defineModel('SuppliernetDocument', documentSchema, 'suppliernet_documents');

const evidenceSchema = new Schema({
  at: { type: Date, required: true },
  operator: { type: String, required: true },
  method: { type: String, enum: ['automated', 'manual'], required: true },
  outcome: { type: String, enum: ['pass', 'fail', 'info'], required: true },
  summary: { type: String, required: true },
  /** Redacted request/response summaries only (no secrets, no customer PII). */
  request: Mixed,
  response: Mixed,
  orderId: String,
  shipmentId: String,
  supplierOrderId: String,
  documentId: String,
  externalReference: String,
  metrics: Mixed,
}, { _id: true });

const verificationStepSchema = new Schema({
  supplierId: { type: oid, ref: 'Supplier', required: true },
  kind: { type: String, enum: VERIFICATION_STEP_KINDS, required: true },
  required: { type: Boolean, default: true },
  status: { type: String, enum: VERIFICATION_STEP_STATUSES, default: 'not_started' },
  passedAt: Date,
  /** passedAt + validity window; after this the step no longer counts. */
  validUntil: Date,
  evidence: { type: [evidenceSchema], default: [] },
}, schemaOpts);
verificationStepSchema.index({ supplierId: 1, kind: 1 }, { unique: true });
export const SuppliernetVerificationStep = defineModel('SuppliernetVerificationStep', verificationStepSchema, 'suppliernet_verification_steps');

/** Claimed vs observed stock samples. Feeds the stock-accuracy SLA metric. */
const stockCheckSchema = new Schema({
  supplierId: { type: oid, ref: 'Supplier', required: true },
  externalId: { type: String, required: true },
  sku: String,
  claimed: { type: Number, required: true },
  observed: Number,
  source: String,
  checkedAt: { type: Date, required: true },
  observedAt: Date,
}, schemaOpts);
stockCheckSchema.index({ supplierId: 1, checkedAt: -1 });
stockCheckSchema.index({ checkedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 400 });
export const SuppliernetStockCheck = defineModel('SuppliernetStockCheck', stockCheckSchema, 'suppliernet_stock_checks');

/** Catalogue items as last ingested, with identifiers the base SupplierProduct model does not carry. */
const catalogItemSchema = new Schema({
  supplierId: { type: oid, ref: 'Supplier', required: true },
  externalId: { type: String, required: true },
  supplierProductId: { type: oid, ref: 'SupplierProduct' },
  title: String,
  normalizedTitle: String,
  brand: String,
  gtin: String,
  mpn: String,
  category: String,
  attributes: Mixed,
  imageHashes: [String],
  priceMinor: Number,
  currency: String,
  stock: Number,
  lastSeenAt: Date,
}, schemaOpts);
catalogItemSchema.index({ supplierId: 1, externalId: 1 }, { unique: true });
catalogItemSchema.index({ gtin: 1 }, { sparse: true });
export const SuppliernetCatalogItem = defineModel('SuppliernetCatalogItem', catalogItemSchema, 'suppliernet_catalog_items');

const ingestionSchema = new Schema({
  supplierId: { type: oid, ref: 'Supplier', required: true },
  trigger: { type: String, enum: ['manual', 'schedule', 'upload'], default: 'manual' },
  status: { type: String, enum: ['running', 'completed', 'failed'], default: 'running' },
  startedAt: Date,
  finishedAt: Date,
  seen: { type: Number, default: 0 },
  created: { type: Number, default: 0 },
  updated: { type: Number, default: 0 },
  rejected: { type: Number, default: 0 },
  candidates: { type: Number, default: 0 },
  error: String,
  rowErrors: { type: [String], default: [] },
  startedBy: String,
}, schemaOpts);
ingestionSchema.index({ supplierId: 1, startedAt: -1 });
export const SuppliernetIngestionJob = defineModel('SuppliernetIngestionJob', ingestionSchema, 'suppliernet_ingestion_jobs');

/** Proposed link between a supplier catalogue item and an ORVIA product. A human approves; nothing merges automatically. */
const matchSchema = new Schema({
  supplierId: { type: oid, ref: 'Supplier', required: true },
  supplierProductId: { type: oid, ref: 'SupplierProduct', required: true },
  productId: { type: oid, ref: 'Product', required: true },
  score: { type: Number, required: true },
  confidence: { type: String, enum: ['high', 'medium', 'low'] },
  reasons: [{ _id: false, kind: String, detail: String, weight: Number }],
  conflicts: [String],
  status: { type: String, enum: MATCH_STATUSES, default: 'pending' },
  decidedBy: String,
  decidedAt: Date,
  note: String,
}, schemaOpts);
matchSchema.index({ supplierProductId: 1, productId: 1 }, { unique: true });
matchSchema.index({ status: 1, score: -1 });
export const SuppliernetMatchCandidate = defineModel('SuppliernetMatchCandidate', matchSchema, 'suppliernet_match_candidates');

const slaSchema = new Schema({
  supplierId: { type: oid, ref: 'Supplier', required: true, unique: true },
  definition: Mixed, // slaDefinitionSchema
  updatedBy: String,
}, schemaOpts);
export const SuppliernetSla = defineModel('SuppliernetSla', slaSchema, 'suppliernet_slas');

const slaSnapshotSchema = new Schema({
  supplierId: { type: oid, ref: 'Supplier', required: true },
  computedAt: { type: Date, required: true },
  windowDays: Number,
  facts: Mixed, // raw counts
  metrics: Mixed, // rates with sample sizes; null when insufficient
  breaches: [{ _id: false, metric: String, severity: String, value: Number, target: Number, sample: Number }],
  worst: { type: String, enum: ['ok', 'warning', 'critical', 'insufficient_data'] },
}, schemaOpts);
slaSnapshotSchema.index({ supplierId: 1, computedAt: -1 });
slaSnapshotSchema.index({ computedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 365 });
export const SuppliernetSlaSnapshot = defineModel('SuppliernetSlaSnapshot', slaSnapshotSchema, 'suppliernet_sla_snapshots');

const disputeSchema = new Schema({
  number: { type: String, required: true, unique: true },
  supplierId: { type: oid, ref: 'Supplier', required: true },
  type: { type: String, enum: DISPUTE_TYPES, required: true },
  state: { type: String, enum: DISPUTE_STATES, default: 'open' },
  orderId: { type: oid, ref: 'Order' },
  shipmentId: { type: oid, ref: 'Shipment' },
  statementId: { type: oid, ref: 'SuppliernetStatement' },
  amountMinor: { type: Number, default: 0 },
  currency: String,
  creditedMinor: { type: Number, default: 0 },
  summary: String,
  openedBy: String,
  evidence: [{ at: Date, by: String, side: { type: String, enum: ['orvia', 'supplier'] }, note: String, documentId: String, url: String }],
  timeline: [{ _id: false, from: String, to: String, at: Date, by: String, note: String }],
  resolution: String,
}, schemaOpts);
disputeSchema.index({ supplierId: 1, state: 1, createdAt: -1 });
export const SuppliernetDispute = defineModel('SuppliernetDispute', disputeSchema, 'suppliernet_disputes');

const returnAuthSchema = new Schema({
  number: { type: String, required: true, unique: true },
  supplierId: { type: oid, ref: 'Supplier', required: true },
  orderId: { type: oid, ref: 'Order', required: true },
  shipmentId: { type: oid, ref: 'Shipment' },
  /** Optional link to the aftersales workstream's return record (opaque id; we never read their model). */
  returnRef: String,
  reason: { type: String, required: true },
  state: { type: String, enum: RETURN_AUTH_STATES, default: 'requested' },
  rmaNumber: String,
  supplierNote: String,
  refundMinor: Number,
  requestedBy: String,
  decidedBy: String,
  decidedAt: Date,
  timeline: [{ _id: false, from: String, to: String, at: Date, by: String, note: String }],
}, schemaOpts);
returnAuthSchema.index({ supplierId: 1, state: 1, createdAt: -1 });
returnAuthSchema.index({ orderId: 1 });
export const SuppliernetReturnAuth = defineModel('SuppliernetReturnAuth', returnAuthSchema, 'suppliernet_return_auths');

const statementSchema = new Schema({
  supplierId: { type: oid, ref: 'Supplier', required: true },
  number: { type: String, required: true },
  currency: { type: String, required: true },
  periodStart: Date,
  periodEnd: Date,
  source: { type: String, enum: ['csv', 'manual', 'portal'], required: true },
  status: { type: String, enum: STATEMENT_STATUSES, default: 'submitted' },
  lines: [{
    _id: true, supplierOrderId: String, orderRef: String, description: String, amountMinor: Number,
    /** Filled by reconciliation. */
    match: { type: String, enum: ['matched', 'amount_difference', 'unknown_order', 'duplicate', 'currency_mismatch', 'unmatched'] },
    recordedMinor: Number, diffMinor: Number, shipmentId: String, orderId: String,
  }],
  totals: { claimedMinor: signedMoney, recordedMinor: signedMoney, diffMinor: signedMoney, matchedLines: Number, flaggedLines: Number, missingFromStatement: Number },
  disputedMinor: { type: Number, default: 0 },
  settlement: { reference: String, amountMinor: Number, note: String, settledAt: Date, settledBy: String },
  submittedBy: String,
  reconciledAt: Date,
}, schemaOpts);
statementSchema.index({ supplierId: 1, number: 1 }, { unique: true });
statementSchema.index({ status: 1, createdAt: -1 });
export const SuppliernetStatement = defineModel('SuppliernetStatement', statementSchema, 'suppliernet_statements');
