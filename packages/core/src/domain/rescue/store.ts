/** Delivery Rescue persistence helpers: policy storage, immutable timeline, daily usage. */
import { RescueAction, RescueTimeline, SystemSetting } from '@orvia/database';
import type { RescueActorType, RescuePolicy } from '@orvia/types';
import { rescuePolicyPatchSchema, rescuePolicySchema } from '@orvia/types';
import { audit } from '../../infra/audit';
import { DomainError } from '../../infra/context';
import type { Actor, Ctx } from '../../infra/context';
import { resolvePolicy } from './policy';

const POLICY_KEY = 'rescue_policy';

export interface RescueActor {
  type: RescueActorType;
  id: string;
}
export const SYSTEM_RESCUE: RescueActor = { type: 'system', id: 'rescue-engine' };
export const actorOf = (a: Actor): RescueActor => (a.type === 'user' ? { type: 'staff', id: a.id } : { type: 'system', id: a.id });

export async function getRescuePolicy(): Promise<RescuePolicy> {
  const doc = await SystemSetting.findOne({ key: POLICY_KEY }).lean();
  return resolvePolicy(doc?.value);
}

/** Admin edit. Caller must already hold `rescue:write`; the change is validated, merged over the stored policy and audited. */
export async function updateRescuePolicy(ctx: Ctx, actor: Actor, patch: unknown): Promise<RescuePolicy> {
  const parsed = rescuePolicyPatchSchema.safeParse(patch);
  if (!parsed.success) throw new DomainError('Invalid policy', 'VALIDATION', 400, parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  const { reason, ...rest } = parsed.data;
  const before = await getRescuePolicy();
  const merged = { ...before, ...rest, detection: { ...before.detection, ...(rest.detection ?? {}) } };
  const checked = rescuePolicySchema.safeParse(merged);
  if (!checked.success) throw new DomainError('Policy values are out of range', 'VALIDATION', 400, checked.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  const next = checked.data;
  await SystemSetting.updateOne({ key: POLICY_KEY }, { $set: { value: next, updatedBy: actor.id } }, { upsert: true });
  await audit(ctx, actor, { action: 'rescue.policy.updated', resource: 'rescue_policy', previousValue: before, newValue: next, reason });
  return next;
}

export async function logEvent(caseId: unknown, orderId: unknown, a: RescueActor, event: string, summary: string, data?: unknown, at = new Date()): Promise<void> {
  await RescueTimeline.create({ caseId, orderId, at, event, actorType: a.type, actorId: a.id, summary, data });
}

/** Money and count already auto-spent today (UTC) by succeeded/running auto-authorized actions. */
export async function autoUsageToday(now: Date): Promise<{ autoCostUsd: number; autoActions: number }> {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const rows = await RescueAction.find({ createdAt: { $gte: start }, 'authorizedBy.mode': 'auto', state: { $in: ['pending', 'running', 'waiting', 'succeeded'] } }).select('costUsd').lean();
  return { autoCostUsd: rows.reduce((a, r) => a + (r.costUsd ?? 0), 0), autoActions: rows.length };
}
