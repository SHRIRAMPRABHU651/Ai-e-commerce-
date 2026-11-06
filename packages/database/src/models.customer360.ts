/** customer360: mongoose models (owned by the customer360 workstream). All collections are prefixed `customer360_`. */
import mongoose, { Schema } from 'mongoose';
import { CONSENT_KINDS, CONSENT_SOURCES, DELETION_STATUSES, LIFEGRAPH_PURPOSES, LIFEGRAPH_SOURCES, MEMORY_KINDS } from '@orvia/types';
import { Mixed, defineModel, oid, schemaOpts } from './helpers';

/** Append-only consent log. The current state is the latest record per (userId, kind). */
const consentSchema = new Schema({
  userId: { type: oid, ref: 'User', required: true },
  kind: { type: String, enum: CONSENT_KINDS, required: true },
  granted: { type: Boolean, required: true },
  policyVersion: { type: String, required: true },
  source: { type: String, enum: CONSENT_SOURCES, required: true },
  /** HMAC of the request IP (never the raw address). Optional. */
  ipHash: String,
  /** Staff actor id when a staff member withdrew consent on the customer's behalf. */
  actorId: String,
  reason: String,
  at: { type: Date, default: Date.now },
}, schemaOpts);
consentSchema.index({ userId: 1, kind: 1, at: -1 });
export const C360Consent = defineModel('C360Consent', consentSchema, 'customer360_consents');

/** One row per customer: switches, retention and communication preferences. */
const profileSchema = new Schema({
  userId: { type: oid, ref: 'User', required: true, unique: true },
  /** topic -> channel -> boolean (opt-in; absent = off for non-transactional topics). */
  commPrefs: { type: Mixed, default: {} },
  replenishmentOptIn: { type: Boolean, default: false },
  lifegraphEnabled: { type: Boolean, default: false },
  memoryEnabled: { type: Boolean, default: true },
  /** 0 = keep until deleted. */
  memoryRetentionDays: { type: Number, default: 365, validate: (v: number) => [0, 30, 90, 180, 365].includes(v) },
}, schemaOpts);
export const C360Profile = defineModel('C360Profile', profileSchema, 'customer360_profiles');

const lifeNodeSchema = new Schema({
  userId: { type: oid, ref: 'User', required: true, index: true },
  kind: { type: String, required: true },
  value: { type: String, required: true },
  parentId: { type: oid },
  purpose: { type: String, enum: LIFEGRAPH_PURPOSES, required: true },
  source: { type: String, enum: LIFEGRAPH_SOURCES, required: true },
  consentVersion: String,
}, schemaOpts);
lifeNodeSchema.index({ userId: 1, kind: 1, value: 1 }, { unique: true });
export const C360LifeNode = defineModel('C360LifeNode', lifeNodeSchema, 'customer360_lifegraph_nodes');

const memorySchema = new Schema({
  userId: { type: oid, ref: 'User', required: true },
  kind: { type: String, enum: MEMORY_KINDS, required: true },
  title: { type: String, required: true },
  payload: { type: Mixed, default: {} },
  enabled: { type: Boolean, default: true },
  /** Who wrote it: the customer in the UI, or another workstream acting on an explicit customer action. */
  origin: { type: String, default: 'customer' },
  expiresAt: Date,
}, schemaOpts);
memorySchema.index({ userId: 1, createdAt: -1 });
memorySchema.index({ expiresAt: 1 }, { partialFilterExpression: { expiresAt: { $type: 'date' } } });
export const C360Memory = defineModel('C360Memory', memorySchema, 'customer360_memory');

const staffNoteSchema = new Schema({
  userId: { type: oid, ref: 'User', required: true },
  authorId: { type: String, required: true },
  authorName: String,
  body: { type: String, required: true },
}, schemaOpts);
staffNoteSchema.index({ userId: 1, createdAt: -1 });
export const C360StaffNote = defineModel('C360StaffNote', staffNoteSchema, 'customer360_staff_notes');

const deletionSchema = new Schema({
  userId: { type: oid, ref: 'User', required: true },
  status: { type: String, enum: DELETION_STATUSES, default: 'requested' },
  reason: String,
  requestedAt: { type: Date, default: Date.now },
  coolingOffUntil: { type: Date, required: true },
  processedAt: Date,
  processedBy: String,
  staffNote: String,
  /** Minimal, PII-free summary of what was removed / retained. */
  result: Mixed,
}, schemaOpts);
deletionSchema.index({ userId: 1, status: 1 });
deletionSchema.index({ status: 1, coolingOffUntil: 1 });
export const C360DeletionRequest = defineModel('C360DeletionRequest', deletionSchema, 'customer360_deletion_requests');

/** Read-only handle to another workstream's collection by name; null when no connection or collection is available. */
export function rawCollection(name: string) {
  try {
    return mongoose.connection.readyState === 1 && mongoose.connection.db ? mongoose.connection.db.collection(name) : null;
  } catch {
    return null;
  }
}
