/** rescue: mongoose models (owned by the rescue workstream). */
import { Schema } from 'mongoose';
import { RESCUE_ACTIVE_STATES, RESCUE_ACTOR_TYPES, RESCUE_FAILURE_KINDS, RESCUE_OPTION_KINDS, RESCUE_SEVERITIES, RESCUE_STATES } from '@orvia/types';
import { Mixed, defineModel, money, oid, schemaOpts, signedMoney } from './helpers';

/** One recovery case per order line (a unique partial index keeps exactly one ACTIVE case per line). */
const rescueCaseSchema = new Schema({
  orderId: { type: oid, ref: 'Order', required: true, index: true },
  orderNumber: { type: String, required: true, index: true },
  userId: { type: oid, ref: 'User' },
  email: { type: String, required: true },
  lineKey: { type: String, required: true },
  dedupeKey: { type: String, required: true },
  country: String,
  currency: { type: String, required: true },
  kind: { type: String, enum: RESCUE_FAILURE_KINDS, required: true, index: true },
  severity: { type: String, enum: RESCUE_SEVERITIES, required: true },
  state: { type: String, enum: RESCUE_STATES, default: 'detected', index: true },
  title: String,
  lineValue: money,
  shipmentId: { type: oid, ref: 'Shipment' },
  daysOverdue: { type: Number, default: 0 },
  alsoDetected: [String],
  evidence: [{ _id: false, code: String, detail: String, provenance: String, at: String }],
  /** Frozen option snapshot (with computed impact + authorization) for the current round. */
  options: { type: [Mixed], default: [] },
  recommendedId: String,
  recommendationReason: String,
  /** Optional AI-written explanation. Display only; never read by any decision code. Provenance is always ai_suggested. */
  aiExplanation: { text: String, provenance: { type: String, default: 'ai_suggested' }, at: Date },
  /** Bumped on every re-plan; invalidates old consent links. */
  round: { type: Number, default: 1 },
  /** Option the case is committed to (after consent / approval / auto). */
  selectedOptionId: String,
  approval: { by: String, role: String, at: Date, note: String, acknowledgedDuplicateRisk: Boolean },
  detectedAt: { type: Date, required: true },
  plannedAt: Date,
  resolvedAt: Date,
  resolution: { optionKind: { type: String, enum: [...RESCUE_OPTION_KINDS, 'delivered', 'closed_by_staff', 'order_cancelled'] }, auto: Boolean, by: String, note: String },
  /** Real money actually spent (set by executed actions, never estimated). */
  actualCost: { extraCost: signedMoney, refund: money },
  /** Customer-facing stages already notified (dedupe). */
  notified: { type: [String], default: [] },
  nextReviewAt: { type: Date, index: true },
  lastSeenAt: Date,
  escalationReason: String,
}, schemaOpts);
rescueCaseSchema.index({ dedupeKey: 1 }, { unique: true, partialFilterExpression: { state: { $in: [...RESCUE_ACTIVE_STATES] } } });
rescueCaseSchema.index({ state: 1, nextReviewAt: 1 });
rescueCaseSchema.index({ createdAt: -1 });
rescueCaseSchema.index({ email: 1, orderNumber: 1 });
export const RescueCase = defineModel('RescueCase', rescueCaseSchema, 'rescue_cases');

/** Append-only audit timeline: decisions, inputs, outputs, actor. Updates and deletes are rejected at the ODM layer. */
const rescueTimelineSchema = new Schema({
  caseId: { type: oid, ref: 'RescueCase', required: true, index: true },
  orderId: { type: oid, ref: 'Order', index: true },
  at: { type: Date, required: true },
  event: { type: String, required: true },
  actorType: { type: String, enum: RESCUE_ACTOR_TYPES, required: true },
  actorId: { type: String, required: true },
  summary: String,
  data: Mixed,
}, { timestamps: false, versionKey: false });
rescueTimelineSchema.index({ caseId: 1, at: 1 });
const immutable = (): never => {
  throw new Error('rescue_timeline is append-only');
};
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndReplace', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete'] as const) rescueTimelineSchema.pre(op, immutable);
rescueTimelineSchema.pre('save', function () {
  if (!this.isNew) immutable();
});
export const RescueTimeline = defineModel('RescueTimeline', rescueTimelineSchema, 'rescue_timeline');

/** One executable action; the unique idempotencyKey makes a second execution of the same thing impossible. */
const rescueActionSchema = new Schema({
  caseId: { type: oid, ref: 'RescueCase', required: true, index: true },
  orderId: { type: oid, ref: 'Order', required: true },
  kind: { type: String, enum: RESCUE_OPTION_KINDS, required: true },
  optionId: { type: String, required: true },
  idempotencyKey: { type: String, required: true, unique: true },
  state: { type: String, enum: ['pending', 'running', 'waiting', 'succeeded', 'failed', 'dead'], default: 'pending', index: true },
  attempts: { type: Number, default: 0 },
  maxAttempts: { type: Number, default: 4 },
  nextAttemptAt: { type: Date, default: () => new Date(0) },
  lockedUntil: Date,
  lastError: String,
  result: Mixed,
  refundId: { type: oid, ref: 'Refund' },
  /** Who authorized it, frozen at creation. */
  authorizedBy: { mode: String, actorType: String, actorId: String, consentId: String },
  cost: { extraCost: signedMoney, refund: money },
  /** Planned exposure in USD minor units (for the daily budget). */
  costUsd: money,
}, schemaOpts);
rescueActionSchema.index({ state: 1, nextAttemptAt: 1 });
rescueActionSchema.index({ createdAt: -1 });
export const RescueAction = defineModel('RescueAction', rescueActionSchema, 'rescue_actions');

/** One customer decision on one option in one round. Decided exactly once (atomic pending -> accepted|declined). */
const rescueConsentSchema = new Schema({
  caseId: { type: oid, ref: 'RescueCase', required: true },
  orderId: { type: oid, ref: 'Order', required: true },
  round: { type: Number, required: true },
  optionId: { type: String, required: true },
  optionKind: { type: String, enum: RESCUE_OPTION_KINDS, required: true },
  termsHash: { type: String, required: true },
  terms: Mixed,
  status: { type: String, enum: ['pending', 'accepted', 'declined', 'expired', 'revoked'], default: 'pending', index: true },
  expiresAt: { type: Date, required: true },
  decidedAt: Date,
  decidedVia: { type: String, enum: ['token', 'account'] },
  decidedBy: String,
  ipHash: String,
}, schemaOpts);
rescueConsentSchema.index({ caseId: 1, round: 1, optionId: 1 }, { unique: true });
rescueConsentSchema.index({ status: 1, expiresAt: 1 });
export const RescueConsent = defineModel('RescueConsent', rescueConsentSchema, 'rescue_consents');
