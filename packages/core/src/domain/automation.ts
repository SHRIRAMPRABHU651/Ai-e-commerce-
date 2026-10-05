import { AiDecision } from '@orvia/database';
import { AUTOMATION_KEYS } from '@orvia/types';
import type { AutomationKey, AutomationMode } from '@orvia/types';
import { audit } from '../infra/audit';
import { aiActor, DomainError, notFound } from '../infra/context';
import type { Actor, Ctx } from '../infra/context';

export type Executor = (ctx: Ctx, payload: Record<string, unknown>, actor: Actor) => Promise<unknown>;
const executors = new Map<string, Executor>();

/** Domain modules register how each decision `kind` is executed (publish, price change, ad action…). */
export function registerExecutor(kind: string, fn: Executor): void {
  executors.set(kind, fn);
}

export interface Proposal {
  automationKey: AutomationKey;
  agent: string;
  kind: string;
  resource?: string;
  resourceId?: string;
  summary: string;
  payload: Record<string, unknown>;
  confidence?: number;
  /** Re-proposing the same thing while one is pending returns the pending decision. */
  dedupeKey?: string;
}

export interface ProposalOutcome {
  mode: AutomationMode;
  status: 'skipped' | 'proposed' | 'executed' | 'failed';
  decisionId?: string;
  result?: unknown;
  error?: string;
}

/**
 * The single place where automation modes are enforced.
 *  OFF       -> nothing happens
 *  ASSISTED  -> the change is recorded as a pending decision for a human to approve
 *  AUTOMATIC -> executed immediately and recorded as auto_executed
 */
export async function proposeOrExecute(ctx: Ctx, p: Proposal): Promise<ProposalOutcome> {
  const mode = await ctx.settings.automationMode(p.automationKey);
  if (mode === 'OFF') return { mode, status: 'skipped' };
  if (p.dedupeKey) {
    const pending = await AiDecision.findOne({ dedupeKey: p.dedupeKey, status: 'proposed' }).lean();
    if (pending) return { mode, status: 'proposed', decisionId: String(pending._id) };
  }
  const decision = await AiDecision.create({
    agent: p.agent,
    kind: p.kind,
    automationKey: p.automationKey,
    resource: p.resource,
    resourceId: p.resourceId,
    summary: p.summary,
    payload: p.payload,
    confidence: p.confidence,
    status: 'proposed',
    mode,
    dedupeKey: p.dedupeKey,
  });
  await audit(ctx, aiActor(p.agent), {
    action: `ai.decision.${mode === 'AUTOMATIC' ? 'auto' : 'proposed'}`,
    resource: p.resource,
    resourceId: p.resourceId,
    aiSummary: p.summary,
    newValue: p.payload,
    reason: p.summary,
  });
  if (mode === 'ASSISTED') return { mode, status: 'proposed', decisionId: String(decision._id) };
  const out = await runDecision(ctx, String(decision._id), aiActor(p.agent), 'auto_executed');
  return { mode, status: out.ok ? 'executed' : 'failed', decisionId: String(decision._id), result: out.result, error: out.error };
}

async function runDecision(ctx: Ctx, id: string, actor: Actor, okStatus: 'executed' | 'auto_executed') {
  const d = await AiDecision.findById(id);
  if (!d) throw notFound('Decision');
  const exec = executors.get(d.kind);
  if (!exec) {
    d.status = 'failed';
    d.error = `No executor for decision kind "${d.kind}"`;
    await d.save();
    return { ok: false as const, error: d.error, result: undefined };
  }
  try {
    const result = await exec(ctx, (d.payload ?? {}) as Record<string, unknown>, actor);
    d.status = okStatus;
    d.executedAt = new Date();
    d.result = result as never;
    d.decidedBy = actor.id;
    await d.save();
    await audit(ctx, actor, { action: `ai.decision.${d.kind}.executed`, resource: d.resource ?? undefined, resourceId: d.resourceId ?? undefined, aiSummary: d.summary, newValue: result });
    return { ok: true as const, result, error: undefined };
  } catch (e) {
    d.status = 'failed';
    d.error = (e as Error).message;
    await d.save();
    ctx.log.error({ channel: 'error', decision: id, kind: d.kind, err: d.error }, 'decision execution failed');
    return { ok: false as const, error: d.error, result: undefined };
  }
}

/** Human approval of an ASSISTED proposal. */
export async function approveDecision(ctx: Ctx, id: string, actor: Actor) {
  const d = await AiDecision.findById(id);
  if (!d) throw notFound('Decision');
  if (d.status !== 'proposed') throw new DomainError(`Decision is already ${d.status}`, 'CONFLICT', 409);
  // atomically claim so a double-click cannot execute twice
  const claimed = await AiDecision.findOneAndUpdate({ _id: id, status: 'proposed' }, { $set: { status: 'approved', decidedBy: actor.id } });
  if (!claimed) throw new DomainError('Decision was already handled', 'CONFLICT', 409);
  return runDecision(ctx, id, actor, 'executed');
}

export async function rejectDecision(ctx: Ctx, id: string, actor: Actor, reason: string) {
  const r = await AiDecision.findOneAndUpdate({ _id: id, status: 'proposed' }, { $set: { status: 'rejected', decidedBy: actor.id, error: reason } }, { new: true });
  if (!r) throw new DomainError('Decision is not pending', 'CONFLICT', 409);
  await audit(ctx, actor, { action: 'ai.decision.rejected', resource: 'ai_decision', resourceId: id, reason });
  return r;
}

export const isAutomationKey = (k: string): k is AutomationKey => (AUTOMATION_KEYS as readonly string[]).includes(k);

/** A human admin action that reuses a decision executor directly (not gated by automation mode; still audited). */
export async function executeNow(ctx: Ctx, kind: string, payload: Record<string, unknown>, actor: Actor): Promise<unknown> {
  const exec = executors.get(kind);
  if (!exec) throw new DomainError(`Unknown action ${kind}`, 'BAD_ACTION', 422);
  const result = await exec(ctx, payload, actor);
  await audit(ctx, actor, { action: `manual.${kind}`, newValue: payload, reason: 'manual admin action' });
  return result;
}
