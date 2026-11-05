/** trust: mongoose models (owned by the trust workstream). */
import { Schema } from 'mongoose';
import { EVIDENCE_KINDS, EVIDENCE_SUBJECTS, PROVENANCES, TRUST_STATUSES } from '@orvia/types';
import { COUNTRY, Mixed, defineModel, oid, schemaOpts } from './helpers';
import { Shipment } from './models';

/** An item of evidence about a product, supplier or manufacturer, with provenance and freshness. */
const trustEvidenceSchema = new Schema({
  subject: { type: String, enum: EVIDENCE_SUBJECTS, required: true },
  subjectId: { type: oid, required: true },
  kind: { type: String, enum: EVIDENCE_KINDS, required: true },
  key: { type: String, required: true },
  value: { type: String, required: true },
  provenance: { type: String, enum: PROVENANCES, required: true },
  source: { type: String, required: true },
  sourceUrl: String,
  observedAt: { type: Date, default: Date.now },
  /** After this instant the evidence no longer counts (certificates, test reports). */
  expiresAt: Date,
  jurisdiction: [String],
  note: String,
  recordedBy: String,
  /** Evidence is never deleted, only superseded. */
  supersededAt: Date,
}, schemaOpts);
trustEvidenceSchema.index({ subject: 1, subjectId: 1, supersededAt: 1 });
trustEvidenceSchema.index({ subject: 1, subjectId: 1, kind: 1, key: 1 });
export const TrustEvidence = defineModel('TrustEvidence', trustEvidenceSchema, 'trust_evidence');

const destinationSnapshotDef = new Schema({
  destination: { ...COUNTRY, required: true },
  result: Mixed,
}, { _id: false });

/**
 * Reproducible supplier trust snapshot. `inputs` holds the aggregated counts/sample sizes the score was computed from,
 * `result` the computed components, so any displayed score can be audited and recomputed.
 */
const trustSupplierSnapshotSchema = new Schema({
  supplierId: { type: oid, ref: 'Supplier', required: true },
  computedAt: { type: Date, required: true },
  modelVersion: { type: String, required: true },
  status: { type: String, enum: TRUST_STATUSES, required: true },
  score: Number,
  confidence: { type: Number, default: 0 },
  sampleSize: { type: Number, default: 0 },
  inputs: Mixed,
  result: Mixed,
  destinations: [destinationSnapshotDef],
  trigger: { type: String, enum: ['schedule', 'manual', 'on_demand'], default: 'schedule' },
}, schemaOpts);
trustSupplierSnapshotSchema.index({ supplierId: 1, computedAt: -1 });
trustSupplierSnapshotSchema.index({ status: 1, score: -1 });
export const TrustSupplierSnapshot = defineModel('TrustSupplierSnapshot', trustSupplierSnapshotSchema, 'trust_supplier_snapshots');

const trustProductRiskSnapshotSchema = new Schema({
  productId: { type: oid, ref: 'Product', required: true },
  /** null = all destinations. */
  destination: { type: String, enum: ['US', 'CA', 'IN', null], default: null },
  computedAt: { type: Date, required: true },
  modelVersion: { type: String, required: true },
  status: { type: String, enum: TRUST_STATUSES, required: true },
  level: { type: String, enum: ['low', 'medium', 'high', 'unknown'], required: true },
  score: Number,
  confidence: { type: Number, default: 0 },
  sampleSize: { type: Number, default: 0 },
  inputs: Mixed,
  result: Mixed,
  trigger: { type: String, enum: ['schedule', 'manual', 'on_demand'], default: 'schedule' },
}, schemaOpts);
trustProductRiskSnapshotSchema.index({ productId: 1, destination: 1, computedAt: -1 });
trustProductRiskSnapshotSchema.index({ level: 1, score: -1 });
export const TrustProductRiskSnapshot = defineModel('TrustProductRiskSnapshot', trustProductRiskSnapshotSchema, 'trust_product_risk_snapshots');

/**
 * Supplier-scoped shipment lookups power supplier trust scoring. The base Shipment schema has no supplierId index, and
 * models.ts is not ours to edit, so the index is declared here (additive; created by syncIndexes / autoIndex).
 */
Shipment.schema.index({ supplierId: 1, createdAt: -1 });
