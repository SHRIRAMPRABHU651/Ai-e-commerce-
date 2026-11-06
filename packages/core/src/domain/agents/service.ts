/**
 * Agents service (IO): wires specs + tools + Mongo ports + model chain, and implements the customer assistant conversation,
 * the confirmation endpoint, staff runs, the admin catalogue/usage/escalation/kill-switch operations and Customer Advocate metrics.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { GeminiProvider } from '@orvia/ai';
import { can } from '@orvia/auth';
import type { Permission } from '@orvia/auth';
import {
  AgentsConfig, AgentsConversation, AgentsEscalation, AgentsOutcome, AgentsPending, AgentsReplacementRequest, AgentsRun, AgentsUsage, AftersalesReturn, Order, Refund, RescueCase,
} from '@orvia/database';
import { ADVOCATE_MIN_SAMPLE } from '@orvia/types';
import type { AgentId, AssistantMessageInput, AssistantReply } from '@orvia/types';
import { audit } from '../../infra/audit';
import { DomainError, forbidden, notFound } from '../../infra/context';
import type { Actor, Ctx } from '../../infra/context';
import type { AuthUser } from '../identity';
import { computeAdvocateMetrics } from './advocate';
import type { AdvocateRecord, FinalOutcome } from './advocate';
import { detectIntent, extractOrderNumber, extractReason, memoryFromResults } from './assistant';
import type { AssistantMemory } from './assistant';
import { executeTool } from './executor';
import type { AnyGovSpec, AnyTool, AuthContext } from './framework';
import { newRunState } from './framework';
import { redact } from './injection';
import { TtlCache, argsHash, dayKey, sha256, tokenHash, verifyConfirmation } from './policy';
import { runGovernedAgent } from './runner';
import type { GovRunResult, ModelPort, RunnerDeps } from './runner';
import { AGENT_SPECS, customerAdvocateSpec, shoppingAssistantSpec, specById } from './specs';
import type { AdvocateOut, AssistantOut } from './specs';
import { PENDING_TTL_MS, invalidateEnabledCache, mongoPending, mongoStore } from './store';
import { CUSTOMER_TOOLS } from './tools.customer';
import type { AgentIO } from './tools.customer';
import { STAFF_TOOLS } from './tools.staff';

const DAY = 86_400_000;
export const CONVERSATION_RETENTION_DAYS = { customer: 30, guest: 1 } as const;
export const MAX_STORED_MESSAGES = 40;
export const MAX_MESSAGES_PER_CONVERSATION_PER_DAY = 120;
export const MAX_RUNS_PER_ACTOR_PER_HOUR = 60;

const cache = new TtlCache<unknown>(5 * 60_000, 500);

export const allTools = (): Map<string, AnyTool<AgentIO>> => new Map([...CUSTOMER_TOOLS, ...STAFF_TOOLS].map((t) => [t.name, t]));

/** Models in the spec's chain, each a GeminiProvider on the configured key. Empty without a key (deterministic templates only). */
export function modelsFor(ctx: Ctx, spec: AnyGovSpec): ModelPort[] {
  const key = ctx.cfg.GEMINI_API_KEY;
  if (!key) return [];
  return spec.modelChain.map((id) => {
    const p = new GeminiProvider(key, { model: id, timeoutMs: ctx.cfg.GEMINI_TIMEOUT_MS });
    return { id, generate: <T,>(prompt: string, schema: z.ZodType<T>, system: string) => p.generateStructuredOutput(prompt, schema as never, { system, temperature: 0.2 }) as Promise<T> };
  });
}

export function buildAgentDeps(ctx: Ctx): RunnerDeps<AgentIO> {
  return { store: mongoStore(ctx), tools: allTools(), io: { ctx }, pending: mongoPending(ctx), models: (spec) => modelsFor(ctx, spec), now: () => ctx.now(), cache, log: ctx.log };
}

/* ------------------------------------------ auth ------------------------------------------ */
export function staffAuth(user: AuthUser, country = 'US'): AuthContext {
  return { kind: 'staff', userId: user.id, email: user.email, emailVerified: user.emailVerified, role: user.role, can: (p) => can(user.role, p as Permission), country, actorRef: user.id };
}

/**
 * Customer vs guest is decided here from the authenticated session, never from the request body or the model:
 * only a signed-in CUSTOMER account with a verified email gets account tools. A guest's typed email is only used for the
 * order-number + email lookup contract.
 */
export function assistantAuth(user: AuthUser | undefined, country: string, sessionKey: string, typedEmail?: string): AuthContext {
  if (user && user.role === 'CUSTOMER' && user.emailVerified) return { kind: 'customer', userId: user.id, email: user.email, emailVerified: true, role: user.role, country, actorRef: user.id };
  return { kind: 'guest', email: typedEmail?.toLowerCase(), emailVerified: false, country, actorRef: `guest:${sha256(`g|${sessionKey}`).slice(0, 24)}` };
}

/* --------------------------------------- conversations --------------------------------------- */
type ConvDoc = InstanceType<typeof AgentsConversation>;
const retentionMs = (auth: AuthContext) => (auth.kind === 'customer' ? CONVERSATION_RETENTION_DAYS.customer : CONVERSATION_RETENTION_DAYS.guest) * DAY;

async function loadConversation(ctx: Ctx, auth: AuthContext, sessionId: string | undefined, country: string): Promise<ConvDoc> {
  if (sessionId) {
    const c = await AgentsConversation.findOne({ sessionId });
    // a conversation belongs to the account that opened it; a guest conversation is reachable only by its unguessable id
    if (c && ((c.userId && auth.userId && String(c.userId) === auth.userId) || (!c.userId && auth.kind === 'guest'))) return c;
  }
  return AgentsConversation.create({ sessionId: randomBytes(16).toString('hex'), userId: auth.kind === 'customer' ? auth.userId : undefined, guestHash: auth.kind === 'guest' ? auth.actorRef : undefined, country, expiresAt: new Date(ctx.now().getTime() + retentionMs(auth)) });
}

async function checkRate(ctx: Ctx, auth: AuthContext, conv: ConvDoc): Promise<void> {
  const since = new Date(ctx.now().getTime() - 3_600_000);
  const n = await AgentsRun.countDocuments({ actorRef: auth.actorRef, agentId: { $in: ['shopping_assistant', 'customer_advocate'] }, createdAt: { $gte: since } });
  if (n >= MAX_RUNS_PER_ACTOR_PER_HOUR) throw new DomainError('You are sending messages very quickly. Please wait a little and try again.', 'RATE_LIMITED', 429);
  const day = dayKey(ctx.now());
  if (conv.dayWindow?.day === day && (conv.dayWindow.count ?? 0) >= MAX_MESSAGES_PER_CONVERSATION_PER_DAY) throw new DomainError('This conversation reached its daily message limit. Please start a new one tomorrow or contact support.', 'RATE_LIMITED', 429);
}

const memoryOf = (c: ConvDoc): AssistantMemory => ({ lastOrderNumber: c.context?.lastOrderNumber ?? undefined, lastProducts: (c.context?.lastProducts ?? []).map((p) => ({ id: String(p.id), slug: String(p.slug) })) });

const PROBLEM_FROM_REASON = (text: string, reason?: string): 'delayed' | 'damaged' | 'missing' | 'wrong_item' | 'other' => {
  if (reason === 'damaged' || reason === 'defective') return 'damaged';
  if (reason === 'wrong_item') return 'wrong_item';
  if (/\b(late|delayed|stuck|slow|taking (too )?long|hasn'?t arrived|not arrived)\b/i.test(text)) return 'delayed';
  if (reason === 'not_delivered' || reason === 'missing_parts' || /\b(missing|never arrived|lost)\b/i.test(text)) return 'missing';
  return 'other';
};

const reply = (p: Partial<AssistantReply> & { sessionId: string; reply: string; identity: 'guest' | 'customer' }): AssistantReply => ({ cards: [], pending: [], escalated: false, source: 'deterministic', aiUsed: false, suggestions: [], ...p });

/** One assistant turn. Customer-scoped tools bind the user from the session; the model never supplies identity. */
export async function assistantMessage(ctx: Ctx, user: AuthUser | undefined, input: AssistantMessageInput, country: string): Promise<AssistantReply> {
  const deps = buildAgentDeps(ctx);
  const probe = assistantAuth(user, country, input.sessionId ?? 'new', input.email);
  const conv = await loadConversation(ctx, probe, input.sessionId, country);
  const auth = assistantAuth(user, country, conv.sessionId, input.email);
  await checkRate(ctx, auth, conv);
  const mem = memoryOf(conv);
  const intent = detectIntent(input.message);
  const identity = auth.kind === 'customer' ? 'customer' : 'guest';
  let out: AssistantReply;

  const orderNo = extractOrderNumber(input.message) ?? input.orderNumber?.toUpperCase() ?? mem.lastOrderNumber;
  if (intent === 'problem' && auth.kind === 'customer' && orderNo) {
    const r = await runAdvocate(ctx, deps, auth, { orderNumber: orderNo, problem: PROBLEM_FROM_REASON(input.message, extractReason(input.message)), details: input.message.slice(0, 1000) });
    out = reply({ sessionId: conv.sessionId, identity, reply: r.reply, cards: r.card ? [r.card] : [], escalated: r.escalated, source: r.source, aiUsed: r.aiUsed, suggestions: ['Ask for a person'] });
    conv.context = { ...(conv.context ?? {}), lastOrderNumber: orderNo } as never;
  } else {
    const run = await runGovernedAgent<AgentIO, unknown, AssistantOut>(deps, shoppingAssistantSpec as unknown as AnyGovSpec, { ...input, country }, auth, { memory: mem as Record<string, unknown> });
    if (run.outcome === 'killed') out = reply({ sessionId: conv.sessionId, identity, reply: 'The assistant is switched off for now. Please use the support page or email us and a team member will help.', suggestions: [] });
    else if (!run.output) out = reply({ sessionId: conv.sessionId, identity, reply: 'Sorry, something went wrong on my side. Please try again, or ask for a person.', suggestions: ['Ask for a person'], escalated: run.escalated });
    else {
      const o = run.output;
      out = reply({
        sessionId: conv.sessionId, identity, reply: o.reply, cards: o.cards, suggestions: o.suggestions.slice(0, 4), escalated: run.escalated, source: run.source === 'none' ? 'deterministic' : run.source, aiUsed: run.aiUsed,
        pending: run.pending.map((p) => ({ actionId: p.actionId, token: p.token, tool: p.tool, summary: p.summary, expiresAt: p.expiresAt.toISOString() })),
        escalationNote: run.escalated ? 'A team member has been notified and can follow up.' : undefined,
      });
      const next = memoryFromResults(run.results, mem);
      conv.context = { lastOrderNumber: next.lastOrderNumber, lastProducts: next.lastProducts ?? [] } as never;
    }
  }

  const now = ctx.now();
  const day = dayKey(now);
  conv.messages.push({ role: 'user', text: redact(input.message, 1000), at: now }, { role: 'assistant', text: out.reply.slice(0, 1500), at: now });
  if (conv.messages.length > MAX_STORED_MESSAGES) conv.messages.splice(0, conv.messages.length - MAX_STORED_MESSAGES);
  conv.messageCount = (conv.messageCount ?? 0) + 1;
  conv.dayWindow = { day, count: conv.dayWindow?.day === day ? (conv.dayWindow.count ?? 0) + 1 : 1 } as never;
  conv.expiresAt = new Date(now.getTime() + retentionMs(auth));
  await conv.save();
  return out;
}

export async function getConversation(ctx: Ctx, user: AuthUser | undefined, sessionId: string) {
  const auth = assistantAuth(user, 'US', sessionId);
  const c = await AgentsConversation.findOne({ sessionId }).lean();
  if (!c || (c.userId ? String(c.userId) !== auth.userId : auth.kind !== 'guest')) throw notFound('Conversation');
  return { sessionId: c.sessionId, messages: c.messages, expiresAt: c.expiresAt };
}

/** Customer-controlled deletion. A signed-in customer may delete one or all of their conversations; a guest only the one they hold the id of. */
export async function deleteConversation(ctx: Ctx, user: AuthUser | undefined, sessionId: string | null): Promise<{ deleted: number }> {
  if (!sessionId) {
    if (!user) throw new DomainError('Sign in to delete all your conversations', 'UNAUTHENTICATED', 401);
    const r = await AgentsConversation.deleteMany({ userId: user.id });
    await audit(ctx, { id: user.id, type: 'user' }, { action: 'agents.conversations_deleted', resource: 'agents_conversation', newValue: { count: r.deletedCount } });
    return { deleted: r.deletedCount };
  }
  const c = await AgentsConversation.findOne({ sessionId }).select('userId').lean();
  if (!c || (c.userId ? !user || String(c.userId) !== user.id : false)) throw notFound('Conversation');
  const r = await AgentsConversation.deleteOne({ sessionId });
  if (user) await audit(ctx, { id: user.id, type: 'user' }, { action: 'agents.conversation_deleted', resource: 'agents_conversation', resourceId: sessionId });
  return { deleted: r.deletedCount };
}

/* ------------------------------------- confirmation ------------------------------------- */
export interface ConfirmResult { executed: boolean; cancelled: boolean; message: string; tool: string }

/**
 * The only place a guarded action can run. The pending action (arguments stored server-side when the tool was first requested)
 * is looked up for THIS signed-in user, its one-time token and expiry are verified, and the tool is executed through the same
 * executor as any other call: allowlist, audience, verified email, strict argument validation and the exact-arguments hash are
 * all re-checked. The model is not involved.
 */
export async function confirmPendingAction(ctx: Ctx, user: AuthUser | undefined, body: { actionId: string; token: string; decision: 'confirm' | 'cancel' }): Promise<ConfirmResult> {
  const auth = assistantAuth(user, 'US', 'confirm');
  if (auth.kind !== 'customer' || !auth.userId) throw new DomainError('Sign in with a verified email to confirm actions', 'UNAUTHENTICATED', 401);
  const p = await AgentsPending.findOne({ _id: body.actionId, userId: auth.userId }); // owner only: another user's id is simply "not found"
  if (!p) throw notFound('Pending action');
  if (p.state !== 'pending') throw new DomainError('This action was already handled', 'CONFLICT', 409);
  const v = verifyConfirmation(ctx.cfg.JWT_SECRET, body.token, { pendingId: String(p._id), userId: auth.userId, tool: p.tool, argsHash: p.argsHash, expiresAt: p.expiresAt }, ctx.now());
  if (!v.ok || tokenHash(body.token) !== p.tokenHash) {
    if (!v.ok && v.reason === 'expired') { p.state = 'expired'; await p.save(); throw new DomainError('This confirmation expired. Ask me again and I will prepare it afresh.', 'EXPIRED', 410); }
    throw new DomainError('This confirmation is not valid', 'FORBIDDEN', 403);
  }
  if (body.decision === 'cancel') {
    p.state = 'cancelled'; p.decidedAt = ctx.now(); await p.save();
    await audit(ctx, { id: auth.userId, type: 'user' }, { action: 'agents.action_cancelled', resource: 'agents_pending', resourceId: String(p._id), newValue: { tool: p.tool } });
    return { executed: false, cancelled: true, message: 'Cancelled. Nothing was changed.', tool: p.tool };
  }
  if (argsHash(p.tool, p.args) !== p.argsHash) throw new DomainError('This action was modified and cannot be run', 'FORBIDDEN', 403);
  const claimed = await AgentsPending.findOneAndUpdate({ _id: p._id, userId: auth.userId, state: 'pending' }, { $set: { state: 'executing', decidedAt: ctx.now() } }, { new: true });
  if (!claimed) throw new DomainError('This action is already being handled', 'CONFLICT', 409);

  const spec = specById(p.agentId) as AnyGovSpec;
  const deps = buildAgentDeps(ctx);
  const state = newRunState(spec.id, spec.tools, 2);
  const started = Date.now();
  const confirmedAuth: AuthContext = { ...auth, confirmation: { pendingId: String(p._id), tool: p.tool, argsHash: p.argsHash } };
  const r = await executeTool({ tools: deps.tools, io: deps.io, now: deps.now }, state, confirmedAuth, p.tool, p.args);
  const message = r.ok ? String((r.data as { message?: string }).message ?? 'Done.') : `This could not be completed: ${r.reason}`;
  const okResult = r.ok && ((r.data as Record<string, unknown>)['started'] !== false && (r.data as Record<string, unknown>)['created'] !== false && (r.data as Record<string, unknown>)['saved'] !== false && (r.data as Record<string, unknown>)['requested'] !== false);
  await AgentsPending.updateOne({ _id: p._id }, { $set: { state: r.ok && okResult ? 'executed' : 'failed', result: r.ok ? (r.data as never) : undefined, error: r.ok ? undefined : r.reason } });
  await deps.store.saveRun({
    agentId: spec.id, actorType: 'customer', actorRef: auth.actorRef, kind: 'confirmation', inputHash: sha256(`${p.tool}|${p.argsHash}`), inputRedacted: `confirm ${p.tool}`, outcome: r.ok ? 'success' : 'refused', source: 'none', models: [], toolCalls: state.calls,
    outputRedacted: redact(JSON.stringify(r.ok ? r.data : { error: r.reason }), 1000), flags: [...state.flags], notes: [], tokens: 0, costMicros: 0, modelCalls: 0, cacheHits: 0, steps: 1, durationMs: Date.now() - started, day: dayKey(ctx.now()),
  }).catch(() => undefined);
  await audit(ctx, { id: auth.userId, type: 'user' }, { action: 'agents.action_confirmed', resource: 'agents_pending', resourceId: String(p._id), newValue: { tool: p.tool, ok: r.ok }, reason: 'customer confirmed via assistant' });
  return { executed: okResult, cancelled: false, message, tool: p.tool };
}

/* ------------------------------------- customer advocate ------------------------------------- */
export async function runAdvocate(ctx: Ctx, deps: RunnerDeps<AgentIO>, auth: AuthContext, input: { orderNumber: string; problem: 'delayed' | 'damaged' | 'missing' | 'wrong_item' | 'other'; details: string }): Promise<{ reply: string; card: AdvocateOut['card']; escalated: boolean; source: 'deterministic' | 'model' | 'template_fallback'; aiUsed: boolean; outcomeId: string | null }> {
  const run = await runGovernedAgent<AgentIO, unknown, AdvocateOut>(deps, customerAdvocateSpec as unknown as AnyGovSpec, input, auth);
  const o = run.output;
  if (!o) return { reply: 'I cannot look at this automatically right now. Please ask for a person and they will review your order.', card: null, escalated: run.escalated, source: 'deterministic', aiUsed: false, outcomeId: null };
  let outcomeId: string | null = null;
  const found = o.orderNumber !== null;
  if (found && auth.userId) {
    const order = await Order.findOne({ orderNumber: o.orderNumber, userId: auth.userId }).select('_id').lean();
    if (order) {
      const doc = await AgentsOutcome.findOneAndUpdate(
        { orderId: order._id, problem: input.problem },
        { $set: { userId: auth.userId, orderNumber: o.orderNumber, runId: run.runId ?? undefined, recommended: { kind: o.recommendedKind ?? undefined, rescueKind: o.recommendedRescueKind ?? undefined, refundMinor: o.recommendedRefundMinor ?? undefined }, permittedKinds: o.permittedKinds, ...(run.escalated ? { escalated: true } : {}) }, $inc: { runCount: 1 } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ).lean().catch(() => null);
      outcomeId = doc ? String(doc._id) : null;
    }
  }
  const card = o.card ? { ...o.card, outcomeId } : null;
  return { reply: o.reply, card, escalated: run.escalated, source: run.source === 'none' ? 'deterministic' : run.source, aiUsed: run.aiUsed, outcomeId };
}

export async function advocateRequest(ctx: Ctx, user: AuthUser | undefined, input: { orderNumber: string; problem: 'delayed' | 'damaged' | 'missing' | 'wrong_item' | 'other'; details: string }, country: string) {
  const auth = assistantAuth(user, country, 'advocate');
  if (auth.kind !== 'customer') throw new DomainError('Sign in with a verified email to review an order problem', 'UNAUTHENTICATED', 401);
  return runAdvocate(ctx, buildAgentDeps(ctx), auth, input);
}

const ctxEpoch = new Date(0);
/** Final outcome of the case, as decided by the deterministic engines / staff (never by the agent). */
interface FinalInfo { final: FinalOutcome; resolvedAt: Date; rescueFirst?: boolean }
async function finalOutcomes(orderIds: unknown[]): Promise<Map<string, FinalInfo>> {
  const m = new Map<string, FinalInfo>();
  const rmas = await AftersalesReturn.find({ orderId: { $in: orderIds }, state: 'resolved' }).select('orderId resolution refundId updatedAt').sort({ updatedAt: 1 }).lean();
  const refunds = new Map((await Refund.find({ _id: { $in: rmas.map((r) => r.refundId).filter(Boolean) } }).select('amount').lean()).map((r) => [String(r._id), r.amount ?? 0]));
  for (const r of rmas) m.set(String(r.orderId), { final: { kind: r.resolution === 'replacement' ? 'replacement' : r.resolution === 'refund' ? 'refund' : 'other', refundMinor: r.refundId ? refunds.get(String(r.refundId)) ?? null : null }, resolvedAt: (r as unknown as { updatedAt: Date }).updatedAt });
  const cases = await RescueCase.find({ orderId: { $in: orderIds }, state: 'resolved' }).select('orderId resolution resolvedAt actualCost').lean();
  for (const c of cases) {
    if (m.has(String(c.orderId))) continue;
    const k = c.resolution?.optionKind as string | undefined;
    const kind: FinalOutcome['kind'] = k === 'offer_full_refund' || k === 'offer_partial_refund' ? 'refund' : k === 'offer_equivalent_replacement' || k === 'reorder_same_product_alt_supplier' ? 'replacement' : k === 'continue_shipment' || k === 'delivered' ? 'wait' : 'other';
    m.set(String(c.orderId), { final: { kind, refundMinor: kind === 'refund' ? c.actualCost?.refund ?? null : null }, resolvedAt: c.resolvedAt ?? ctxEpoch });
  }
  return m;
}
export async function rateOutcome(ctx: Ctx, user: AuthUser, outcomeId: string, body: { rating: number; comment?: string }) {
  if (!/^[a-f\d]{24}$/i.test(outcomeId)) throw notFound('Outcome');
  const o = await AgentsOutcome.findOne({ _id: outcomeId, userId: user.id });
  if (!o) throw notFound('Outcome');
  const fin = await finalOutcomes([o.orderId]);
  if (!fin.has(String(o.orderId))) throw new DomainError('You can rate this once your case has been resolved', 'NOT_RESOLVED', 409);
  o.rating = body.rating; o.ratingComment = body.comment ? redact(body.comment, 500) : undefined; o.ratedAt = ctx.now();
  await o.save();
  return { ok: true };
}

export async function advocateMetrics(ctx: Ctx) {
  const since = new Date(ctx.now().getTime() - 365 * DAY);
  const outcomes = await AgentsOutcome.find({ createdAt: { $gte: since } }).sort({ createdAt: -1 }).limit(5000).lean();
  const fin = await finalOutcomes(outcomes.map((o) => o.orderId));
  const userIds = [...new Set(outcomes.filter((o) => fin.has(String(o.orderId))).map((o) => String(o.userId)))];
  const later = userIds.length ? await Order.find({ userId: { $in: userIds }, 'payment.status': { $in: ['succeeded', 'partially_refunded'] }, createdAt: { $gte: since } }).select('userId createdAt').limit(50_000).lean() : [];
  const byUser = new Map<string, Date[]>();
  for (const l of later) { const a = byUser.get(String(l.userId)) ?? []; a.push((l as unknown as { createdAt: Date }).createdAt); byUser.set(String(l.userId), a); }
  const WINDOW = 90 * DAY;
  const records: AdvocateRecord[] = outcomes.map((o) => {
    const f = fin.get(String(o.orderId));
    let repeat: boolean | null | undefined;
    if (f) {
      const repeated = (byUser.get(String(o.userId)) ?? []).some((d) => d.getTime() > f.resolvedAt.getTime() && d.getTime() <= f.resolvedAt.getTime() + WINDOW);
      repeat = repeated ? true : ctx.now().getTime() >= f.resolvedAt.getTime() + WINDOW ? false : null;
    }
    return {
      recommendedKind: (o.recommended?.kind as AdvocateRecord['recommendedKind']) ?? null, recommendedRescueKind: o.recommended?.rescueKind ?? null, recommendedRefundMinor: o.recommended?.refundMinor ?? null,
      rating: o.rating ?? null, final: f?.final ?? null, firstContact: f ? (o.runCount ?? 1) <= 1 && !o.escalated : undefined, repeatPurchase: repeat,
    };
  });
  return { ...computeAdvocateMetrics(records, ADVOCATE_MIN_SAMPLE), definitions: {
    satisfaction: 'Mean customer rating (1-5) given after the case was resolved by the engines/staff.',
    firstContactResolution: 'Share of resolved cases with a single advocate run and no escalation.',
    refundAccuracy: 'Kind match: the recommended resolution class equals the final engine/staff outcome. Exact amount: for refund recommendations that ended in a refund, the amounts are identical.',
    retention: 'Share of resolved cases whose customer placed another paid order within 90 days (only cases with the 90-day window elapsed, or a repeat already seen).',
  } };
}

/* ------------------------------------------ staff ------------------------------------------ */
export async function runStaffAgent(ctx: Ctx, user: AuthUser, agentId: string, rawInput: unknown) {
  const spec = specById(agentId);
  if (!spec) throw notFound('Agent');
  if (spec.audience !== 'staff') throw new DomainError('This agent is customer-facing and cannot be run from the admin', 'BAD_AGENT', 422);
  const actor: Actor = { id: user.id, type: 'user', role: user.role };
  await audit(ctx, actor, { action: 'agents.run', resource: 'agent', resourceId: spec.id, reason: 'staff run' });
  const run = await runGovernedAgent(buildAgentDeps(ctx), spec, rawInput ?? {}, staffAuth(user));
  return {
    runId: run.runId, agentId: spec.id, outcome: run.outcome, output: run.output ?? null, source: run.source, aiUsed: run.aiUsed, notes: run.notes, escalated: run.escalated, escalationReasons: run.escalationReasons,
    usage: run.usage, toolCalls: run.toolCalls.map((c) => ({ tool: c.tool, sideEffect: c.sideEffect, outcome: c.outcome, reason: c.reason ?? null, ms: c.ms })), flags: run.flags,
  };
}

/* ------------------------------------------ admin ------------------------------------------ */
export async function agentCatalogue(ctx: Ctx) {
  const today = dayKey(ctx.now());
  const [cfgs, usage] = await Promise.all([AgentsConfig.find({}).lean(), AgentsUsage.find({ day: today }).lean()]);
  const cfg = new Map(cfgs.map((c) => [c.agentId, c]));
  const use = new Map(usage.map((u) => [u.agentId, u]));
  const tools = allTools();
  const hasKey = !!ctx.cfg.GEMINI_API_KEY;
  return AGENT_SPECS.map((s) => {
    const c = cfg.get(s.id);
    const u = use.get(s.id);
    const enabled = c ? c.enabled !== false : true;
    return {
      id: s.id, name: s.name, purpose: s.purpose, audience: s.audience, enabled, disabledReason: enabled ? null : c?.reason ?? null, disabledBy: enabled ? null : c?.changedBy ?? null, disabledAt: enabled ? null : c?.changedAt ?? null,
      status: !enabled ? 'killed' : hasKey ? 'ready' : 'needs_api_key', needsApiKey: !hasKey,
      mode: hasKey ? 'deterministic tools + model chain with template fallback' : 'deterministic tools and templates only (no model API key configured)',
      modelChain: s.modelChain, tools: s.tools.map((n) => { const t = tools.get(n); return { name: n, sideEffect: t?.sideEffect ?? 'unknown', audience: t?.audience ?? [], permission: t?.permission ?? null, requiresConfirmation: t ? t.sideEffect === 'write_guarded' || !!t.requiresConfirmation : false, description: t?.description ?? '' }; }),
      limits: { timeoutMs: s.timeoutMs, maxSteps: s.maxSteps, maxToolCalls: s.maxToolCalls, retryLimit: s.retryLimit, minConfidence: s.minConfidence, budget: s.budget },
      usageToday: { runs: u?.runs ?? 0, modelCalls: u?.modelCalls ?? 0, cacheHits: u?.cacheHits ?? 0, tokens: u?.tokens ?? 0, costMicros: u?.costMicros ?? 0, budgetStops: u?.budgetStops ?? 0, tokenPct: Math.min(1, (u?.tokens ?? 0) / s.budget.perDayTokens), costPct: Math.min(1, (u?.costMicros ?? 0) / s.budget.perDayCostMicros) },
    };
  });
}

export async function setAgentEnabled(ctx: Ctx, actor: Actor, agentId: AgentId, enabled: boolean, reason: string) {
  if (!specById(agentId)) throw notFound('Agent');
  const prev = await AgentsConfig.findOne({ agentId }).lean();
  await AgentsConfig.updateOne({ agentId }, { $set: { enabled, reason, changedBy: actor.id, changedAt: ctx.now() } }, { upsert: true });
  invalidateEnabledCache();
  await audit(ctx, actor, { action: enabled ? 'agents.enabled' : 'agents.killed', resource: 'agent', resourceId: agentId, previousValue: { enabled: prev ? prev.enabled !== false : true }, newValue: { enabled }, reason });
  return { agentId, enabled };
}

export async function listRuns(q: { page: number; pageSize: number; agentId?: string; outcome?: string; actorType?: string; from?: Date; to?: Date }) {
  const f: Record<string, unknown> = {};
  if (q.agentId) f['agentId'] = q.agentId;
  if (q.outcome) f['outcome'] = q.outcome;
  if (q.actorType) f['actorType'] = q.actorType;
  if (q.from || q.to) f['createdAt'] = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  const [items, total] = await Promise.all([
    AgentsRun.find(f).sort({ createdAt: -1 }).skip((q.page - 1) * q.pageSize).limit(q.pageSize).select('-outputRedacted -toolCalls').lean(),
    AgentsRun.countDocuments(f),
  ]);
  return { items, total, page: q.page, pageSize: q.pageSize };
}
export async function getRun(id: string) {
  const r = await AgentsRun.findById(id).lean();
  if (!r) throw notFound('Run');
  return r;
}

export async function usageSeries(ctx: Ctx, days: number) {
  const since = dayKey(new Date(ctx.now().getTime() - (days - 1) * DAY));
  const rows = await AgentsUsage.find({ day: { $gte: since } }).sort({ day: 1 }).limit(60 * 11).lean();
  return { days, items: rows.map((r) => ({ agentId: r.agentId, day: r.day, runs: r.runs, modelCalls: r.modelCalls, cacheHits: r.cacheHits, tokens: r.tokens, costMicros: r.costMicros, budgetStops: r.budgetStops })), note: 'Tokens are estimated (~4 characters per token) and cost uses a configured per-model price table. These are budgeting estimates, not a bill.' };
}

export async function listEscalations(q: { page: number; pageSize: number; status?: string; agentId?: string }) {
  const f: Record<string, unknown> = {};
  if (q.status) f['status'] = q.status;
  if (q.agentId) f['agentId'] = q.agentId;
  const [items, total, open] = await Promise.all([AgentsEscalation.find(f).sort({ createdAt: -1 }).skip((q.page - 1) * q.pageSize).limit(q.pageSize).lean(), AgentsEscalation.countDocuments(f), AgentsEscalation.countDocuments({ status: 'open' })]);
  return { items, total, open, page: q.page, pageSize: q.pageSize };
}
export async function resolveEscalation(ctx: Ctx, actor: Actor, id: string, note: string) {
  const e = await AgentsEscalation.findOneAndUpdate({ _id: id, status: 'open' }, { $set: { status: 'resolved', resolvedBy: actor.id, resolvedAt: ctx.now(), resolutionNote: note } }, { new: true });
  if (!e) throw new DomainError('Escalation not found or already resolved', 'NOT_FOUND', 404);
  await audit(ctx, actor, { action: 'agents.escalation_resolved', resource: 'agents_escalation', resourceId: id, reason: note });
  return e;
}

export async function listReplacementRequests(q: { page: number; pageSize: number; status?: string }) {
  const f = q.status ? { state: q.status } : {};
  const [items, total] = await Promise.all([AgentsReplacementRequest.find(f).sort({ createdAt: -1 }).skip((q.page - 1) * q.pageSize).limit(q.pageSize).lean(), AgentsReplacementRequest.countDocuments(f)]);
  return { items, total, page: q.page, pageSize: q.pageSize };
}
/** Records the staff decision on a replacement request. It never ships or refunds: staff carry the approved request out in the Returns console. */
export async function decideReplacement(ctx: Ctx, actor: Actor, id: string, decision: 'approved' | 'rejected', note: string) {
  if (actor.type !== 'user') throw forbidden();
  const r = await AgentsReplacementRequest.findOneAndUpdate({ _id: id, state: 'pending' }, { $set: { state: decision, decidedBy: actor.id, decidedAt: ctx.now(), decisionNote: note } }, { new: true });
  if (!r) throw new DomainError('Request not found or already decided', 'NOT_FOUND', 404);
  if (r.escalationId) await AgentsEscalation.updateOne({ _id: r.escalationId, status: 'open' }, { $set: { status: 'resolved', resolvedBy: actor.id, resolvedAt: ctx.now(), resolutionNote: `Replacement ${decision}: ${note}` } });
  await audit(ctx, actor, { action: `agents.replacement_${decision}`, resource: 'agents_replacement_request', resourceId: id, reason: note });
  return r;
}

/** Daily housekeeping (idempotent): expire stale confirmations, drop expired conversations. */
export async function agentsMaintenance(ctx: Ctx) {
  const now = ctx.now();
  const exp = await AgentsPending.updateMany({ state: 'pending', expiresAt: { $lt: now } }, { $set: { state: 'expired' } });
  const conv = await AgentsConversation.deleteMany({ expiresAt: { $lt: now } });
  const oldPending = await AgentsPending.deleteMany({ state: { $in: ['executed', 'cancelled', 'expired', 'failed'] }, updatedAt: { $lt: new Date(now.getTime() - 30 * DAY) } });
  return { expiredConfirmations: exp.modifiedCount, conversationsDeleted: conv.deletedCount, pendingPurged: oldPending.deletedCount, pendingTtlMs: PENDING_TTL_MS };
}

export type { GovRunResult };
