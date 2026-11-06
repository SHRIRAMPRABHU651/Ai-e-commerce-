/** agents: mongoose models (owned by the agents workstream). Collections are prefixed `agents_`. */
import { Schema } from 'mongoose';
import { AGENT_IDS, AGENT_RUN_OUTCOMES, ESCALATION_REASONS, ESCALATION_STATUSES, PENDING_ACTION_STATES, REPLACEMENT_STATES } from '@orvia/types';
import { Mixed, defineModel, oid, schemaOpts } from './helpers';

/** One document per agent run: the audit log. Inputs are hashed + redacted; nothing here is a secret. */
const runSchema = new Schema(
  {
    agentId: { type: String, enum: AGENT_IDS, required: true },
    actorType: { type: String, enum: ['guest', 'customer', 'staff', 'system'], required: true },
    /** user id for customer/staff, hashed session for guests. */
    actorRef: { type: String, required: true },
    kind: { type: String, enum: ['run', 'confirmation'], default: 'run' },
    inputHash: { type: String, required: true },
    inputRedacted: { type: String, default: '' },
    outcome: { type: String, enum: AGENT_RUN_OUTCOMES, required: true },
    source: { type: String, enum: ['deterministic', 'model', 'template_fallback', 'none'], default: 'none' },
    models: [String],
    toolCalls: [{ _id: false, tool: String, sideEffect: String, argsSummary: String, outcome: String, reason: String, ms: Number, outputBytes: Number }],
    outputRedacted: { type: String, default: '' },
    confidence: Number,
    flags: [String],
    notes: [String],
    tokens: { type: Number, default: 0 },
    costMicros: { type: Number, default: 0 },
    modelCalls: { type: Number, default: 0 },
    cacheHits: { type: Number, default: 0 },
    steps: { type: Number, default: 0 },
    durationMs: { type: Number, default: 0 },
    escalationId: { type: oid },
    requestId: String,
    day: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  schemaOpts,
);
runSchema.index({ agentId: 1, createdAt: -1 });
runSchema.index({ outcome: 1, createdAt: -1 });
runSchema.index({ actorRef: 1, createdAt: -1 });
runSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const AgentsRun = defineModel('AgentsRun', runSchema, 'agents_runs');

/** Human queue: low confidence, sensitive, limit hit, tool refused, budget exhausted, customer asked for a person. */
const escalationSchema = new Schema(
  {
    agentId: { type: String, enum: AGENT_IDS, required: true },
    runId: { type: oid },
    reason: { type: String, enum: ESCALATION_REASONS, required: true },
    status: { type: String, enum: ESCALATION_STATUSES, default: 'open' },
    summary: { type: String, required: true },
    /** customer-scoped escalations carry the user id so staff can follow up; never the full conversation. */
    userId: { type: oid, ref: 'User' },
    orderNumber: String,
    context: { type: Mixed },
    dedupeKey: { type: String },
    resolvedBy: String,
    resolvedAt: Date,
    resolutionNote: String,
  },
  schemaOpts,
);
escalationSchema.index({ status: 1, createdAt: -1 });
escalationSchema.index({ agentId: 1, status: 1 });
escalationSchema.index({ dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' }, status: 'open' } });
export const AgentsEscalation = defineModel('AgentsEscalation', escalationSchema, 'agents_escalations');

/** Stored daily counters per agent (hard budget stop). */
const usageSchema = new Schema(
  {
    agentId: { type: String, enum: AGENT_IDS, required: true },
    day: { type: String, required: true },
    runs: { type: Number, default: 0 },
    modelCalls: { type: Number, default: 0 },
    cacheHits: { type: Number, default: 0 },
    tokens: { type: Number, default: 0 },
    costMicros: { type: Number, default: 0 },
    budgetStops: { type: Number, default: 0 },
    expiresAt: { type: Date },
  },
  schemaOpts,
);
usageSchema.index({ agentId: 1, day: 1 }, { unique: true });
usageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const AgentsUsage = defineModel('AgentsUsage', usageSchema, 'agents_usage');

/** Per-agent stored settings: the kill switch (audited when changed). Absent row = enabled. */
const configSchema = new Schema(
  {
    agentId: { type: String, enum: AGENT_IDS, required: true, unique: true },
    enabled: { type: Boolean, default: true },
    reason: String,
    changedBy: String,
    changedAt: Date,
  },
  schemaOpts,
);
export const AgentsConfig = defineModel('AgentsConfig', configSchema, 'agents_config');

/** Assistant conversation: session scoped, bounded, expires automatically; customers can delete it. */
const conversationSchema = new Schema(
  {
    sessionId: { type: String, required: true, unique: true },
    /** Set for signed-in, email-verified customers. Guests have none. */
    userId: { type: oid, ref: 'User', index: true },
    guestHash: { type: String },
    country: String,
    messages: [{ _id: false, role: { type: String, enum: ['user', 'assistant'] }, text: String, at: Date }],
    context: { lastOrderNumber: String, lastProducts: [{ _id: false, id: String, slug: String }] },
    messageCount: { type: Number, default: 0 },
    dayWindow: { day: String, count: { type: Number, default: 0 } },
    expiresAt: { type: Date, required: true },
  },
  schemaOpts,
);
conversationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const AgentsConversation = defineModel('AgentsConversation', conversationSchema, 'agents_conversations');

/** A guarded action waiting for the customer's explicit confirmation. Arguments are stored server-side and re-validated on confirm. */
const pendingSchema = new Schema(
  {
    agentId: { type: String, enum: AGENT_IDS, required: true },
    tool: { type: String, required: true },
    userId: { type: oid, ref: 'User', required: true, index: true },
    sessionId: String,
    args: { type: Mixed, required: true },
    argsHash: { type: String, required: true },
    summary: { type: String, required: true },
    tokenHash: { type: String, required: true },
    state: { type: String, enum: PENDING_ACTION_STATES, default: 'pending' },
    result: { type: Mixed },
    error: String,
    expiresAt: { type: Date, required: true },
    decidedAt: Date,
  },
  schemaOpts,
);
pendingSchema.index({ state: 1, expiresAt: 1 });
export const AgentsPending = defineModel('AgentsPending', pendingSchema, 'agents_pending_actions');

/** Replacement requests raised by the assistant. They are only REQUESTS: staff decide, deterministic aftersales code executes. */
const replacementSchema = new Schema(
  {
    userId: { type: oid, ref: 'User', required: true, index: true },
    orderId: { type: oid, ref: 'Order', required: true },
    orderNumber: { type: String, required: true, index: true },
    sku: { type: String, required: true },
    quantity: { type: Number, default: 1 },
    reason: { type: String, required: true },
    details: { type: String, default: '' },
    state: { type: String, enum: REPLACEMENT_STATES, default: 'pending' },
    escalationId: { type: oid },
    decidedBy: String,
    decidedAt: Date,
    decisionNote: String,
  },
  schemaOpts,
);
replacementSchema.index({ state: 1, createdAt: -1 });
replacementSchema.index({ orderId: 1, sku: 1, state: 1 }, { unique: true, partialFilterExpression: { state: 'pending' } });
export const AgentsReplacementRequest = defineModel('AgentsReplacementRequest', replacementSchema, 'agents_replacement_requests');

/** Customer Advocate recommendation + what actually happened afterwards (metrics are computed from these records). */
const outcomeSchema = new Schema(
  {
    userId: { type: oid, ref: 'User', required: true, index: true },
    orderId: { type: oid, ref: 'Order', required: true },
    orderNumber: { type: String, required: true },
    problem: { type: String, required: true },
    runId: { type: oid },
    recommended: { kind: String, rescueKind: String, refundMinor: Number, currency: String },
    permittedKinds: [String],
    runCount: { type: Number, default: 1 },
    escalated: { type: Boolean, default: false },
    rating: { type: Number, min: 1, max: 5 },
    ratingComment: String,
    ratedAt: Date,
  },
  schemaOpts,
);
outcomeSchema.index({ orderId: 1, problem: 1 }, { unique: true });
outcomeSchema.index({ createdAt: -1 });
export const AgentsOutcome = defineModel('AgentsOutcome', outcomeSchema, 'agents_outcomes');
