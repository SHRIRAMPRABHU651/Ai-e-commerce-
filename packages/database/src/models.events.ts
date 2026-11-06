/** events: mongoose models (owned by the events workstream). All collections are prefixed `events_`. */
import { Schema } from 'mongoose';
import { MARKETING_PROVIDER_KEYS, OUTBOX_STATUSES } from '@orvia/types';
import { Mixed, defineModel, oid, schemaOpts } from './helpers';

/**
 * Durable outbox: one row per (eventId, provider). The canonical payload only ever contains hashed identifiers.
 * Unique (eventId, provider) is the idempotency guard for generators that re-scan overlapping windows.
 */
const outboxSchema = new Schema({
  eventId: { type: String, required: true },
  provider: { type: String, enum: MARKETING_PROVIDER_KEYS, required: true },
  name: { type: String, required: true },
  status: { type: String, enum: OUTBOX_STATUSES, default: 'pending' },
  payload: Mixed,
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: Date.now },
  lockedUntil: Date,
  lastError: String,
  sentAt: Date,
  skipReason: String,
  occurredAt: { type: Date, required: true },
  /** Where the event came from, e.g. `order:<id>` or `browser`. */
  source: String,
  /** Browser session id (random, non-identifying) so a later consent withdrawal can still stop delivery. */
  sessionId: String,
}, schemaOpts);
outboxSchema.index({ eventId: 1, provider: 1 }, { unique: true });
outboxSchema.index({ status: 1, nextAttemptAt: 1 });
outboxSchema.index({ provider: 1, status: 1, sentAt: -1 });
outboxSchema.index({ createdAt: -1 });
// bounded retention: sent / suppressed / skipped rows expire after 90 days (dead letters are kept until resolved)
outboxSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90, partialFilterExpression: { status: { $in: ['sent', 'suppressed', 'skipped'] } } });
export const EventsOutbox = defineModel('EventsOutbox', outboxSchema, 'events_outbox');

/** High-water marks for the server-side generators (orders, refunds, returns, signups, referrals). */
const cursorSchema = new Schema({
  key: { type: String, required: true, unique: true },
  lastAt: Date,
  lastId: String,
  note: String,
}, schemaOpts);
export const EventsCursor = defineModel('EventsCursor', cursorSchema, 'events_cursors');

/** First-party attribution + consent per browser session (the id the storefront already uses for /events). */
const sessionSchema = new Schema({
  sessionId: { type: String, required: true, unique: true },
  cartToken: { type: String, index: true },
  userId: { type: oid, ref: 'User' },
  consent: { analytics: Boolean, marketing: Boolean, at: Date },
  firstTouch: { utmSource: String, utmMedium: String, utmCampaign: String, utmTerm: String, utmContent: String, clickId: String, clickIdType: String, referrerHost: String, landingPath: String, at: Date },
  lastTouch: { utmSource: String, utmMedium: String, utmCampaign: String, utmTerm: String, utmContent: String, clickId: String, clickIdType: String, referrerHost: String, landingPath: String, at: Date },
  clickIds: { fbclid: String, gclid: String, ttclid: String, gbraid: String, wbraid: String },
  browserIds: { fbp: String, fbc: String, ttp: String, gaClientId: String },
  /** Only stored for sessions with marketing consent (needed by Meta CAPI for `website` events). */
  client: { ip: String, userAgent: String },
  lastSeenAt: { type: Date, default: Date.now },
}, schemaOpts);
sessionSchema.index({ lastSeenAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });
export const EventsSession = defineModel('EventsSession', sessionSchema, 'events_sessions');

/* ------------------------------- segments & email campaigns ------------------------------- */
const segmentSchema = new Schema({
  name: { type: String, required: true },
  description: String,
  rules: [Mixed],
  createdBy: String,
}, schemaOpts);
export const EventsSegment = defineModel('EventsSegment', segmentSchema, 'events_segments');

const campaignSchema = new Schema({
  name: { type: String, required: true },
  segmentId: { type: oid, ref: 'EventsSegment', required: true },
  subject: { type: String, required: true },
  message: { type: String, required: true },
  ctaLabel: String,
  ctaUrl: String,
  status: { type: String, enum: ['draft', 'scheduled', 'sending', 'sent', 'cancelled', 'failed'], default: 'draft', index: true },
  scheduledAt: Date,
  startedAt: Date,
  finishedAt: Date,
  maxRecipients: { type: Number, default: 1000 },
  /** Snapshot taken when sending starts; honest about what was excluded and why. */
  plan: { eligible: Number, excludedNoConsent: Number, excludedUnsubscribed: Number, excludedFrequency: Number, excludedCap: Number },
  createdBy: String,
  approvedBy: String,
}, schemaOpts);
campaignSchema.index({ status: 1, scheduledAt: 1 });
export const EventsCampaign = defineModel('EventsCampaign', campaignSchema, 'events_campaigns');

const recipientSchema = new Schema({
  campaignId: { type: oid, ref: 'EventsCampaign', required: true },
  email: { type: String, required: true, lowercase: true },
  status: { type: String, enum: ['queued', 'sent', 'failed', 'skipped'], default: 'queued' },
  skipReason: String,
  notificationId: { type: oid, ref: 'Notification' },
  clicks: { type: Number, default: 0 },
  firstClickAt: Date,
}, schemaOpts);
recipientSchema.index({ campaignId: 1, email: 1 }, { unique: true });
recipientSchema.index({ email: 1, createdAt: -1 });
export const EventsCampaignRecipient = defineModel('EventsCampaignRecipient', recipientSchema, 'events_campaign_recipients');

const unsubSchema = new Schema({
  email: { type: String, required: true, unique: true, lowercase: true },
  source: String,
  campaignId: { type: oid, ref: 'EventsCampaign' },
}, schemaOpts);
export const EventsUnsubscribe = defineModel('EventsUnsubscribe', unsubSchema, 'events_unsubscribes');

/* ------------------------------- experiments ------------------------------- */
const experimentSchema = new Schema({
  key: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  hypothesis: String,
  variants: [{ _id: false, key: String, weight: Number }],
  conversionEvent: { type: String, required: true },
  status: { type: String, enum: ['draft', 'running', 'stopped'], default: 'draft', index: true },
  startedAt: Date,
  stoppedAt: Date,
  createdBy: String,
  /** A human note. The system NEVER promotes a variant on its own. */
  decisionNote: String,
}, schemaOpts);
export const EventsExperiment = defineModel('EventsExperiment', experimentSchema, 'events_experiments');

const experimentEventSchema = new Schema({
  experimentKey: { type: String, required: true },
  variant: { type: String, required: true },
  visitorId: { type: String, required: true },
  kind: { type: String, enum: ['exposure', 'conversion'], required: true },
  ts: { type: Date, default: Date.now },
}, { timestamps: false, versionKey: false });
experimentEventSchema.index({ experimentKey: 1, visitorId: 1, kind: 1 }, { unique: true });
experimentEventSchema.index({ experimentKey: 1, kind: 1, variant: 1 });
export const EventsExperimentEvent = defineModel('EventsExperimentEvent', experimentEventSchema, 'events_experiment_events');
