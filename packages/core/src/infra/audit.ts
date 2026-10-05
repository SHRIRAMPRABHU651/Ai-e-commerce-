import { AuditLog } from '@orvia/database';
import type { Actor, Ctx } from './context';

export interface AuditEntry {
  action: string;
  resource?: string;
  resourceId?: string;
  previousValue?: unknown;
  newValue?: unknown;
  reason?: string;
  aiSummary?: string;
  provider?: string;
}

/** Append-only audit trail. Never throws into the caller: audit failure is logged loudly instead. */
export async function audit(ctx: Pick<Ctx, 'log'>, actor: Actor, e: AuditEntry): Promise<void> {
  try {
    await AuditLog.create({
      timestamp: new Date(),
      actor: actor.id,
      actorType: actor.type,
      action: e.action,
      resource: e.resource,
      resourceId: e.resourceId,
      previousValue: e.previousValue,
      newValue: e.newValue,
      reason: e.reason,
      aiSummary: e.aiSummary,
      provider: e.provider,
      requestId: actor.requestId,
    });
  } catch (err) {
    ctx.log.error({ channel: 'error', err: (err as Error).message, action: e.action }, 'AUDIT WRITE FAILED');
  }
}
