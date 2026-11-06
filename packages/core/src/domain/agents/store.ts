/** Mongo adapters for the runner ports: kill switch, usage counters, audit log, escalations, pending confirmations. */
import { Types } from 'mongoose';
import { AgentsConfig, AgentsEscalation, AgentsPending, AgentsRun, AgentsUsage } from '@orvia/database';
import type { Ctx } from '../../infra/context';
import type { PendingConfirmation, PendingPort } from './framework';
import { signConfirmation, tokenHash } from './policy';
import type { EscalationInput, RunRecord, RunStorePort } from './runner';

export const RUN_RETENTION_DAYS = 365;
export const USAGE_RETENTION_DAYS = 400;
export const PENDING_TTL_MS = 15 * 60_000;
const DAY = 86_400_000;

const enabledCache = new Map<string, { at: number; enabled: boolean }>();
export const invalidateEnabledCache = (): void => enabledCache.clear();

export function mongoStore(ctx: Ctx): RunStorePort {
  return {
    async isEnabled(agentId) {
      const hit = enabledCache.get(agentId);
      if (hit && Date.now() - hit.at < 5_000) return hit.enabled;
      const row = await AgentsConfig.findOne({ agentId }).select('enabled').lean();
      const enabled = row ? row.enabled !== false : true;
      enabledCache.set(agentId, { at: Date.now(), enabled });
      return enabled;
    },
    async usageToday(agentId, day) {
      const u = await AgentsUsage.findOne({ agentId, day }).select('tokens costMicros').lean();
      return { tokens: u?.tokens ?? 0, costMicros: u?.costMicros ?? 0 };
    },
    async addUsage(agentId, day, d) {
      await AgentsUsage.updateOne(
        { agentId, day },
        { $inc: { runs: d.runs, tokens: d.tokens, costMicros: d.costMicros, modelCalls: d.modelCalls, cacheHits: d.cacheHits, budgetStops: d.budgetStops }, $setOnInsert: { expiresAt: new Date(ctx.now().getTime() + USAGE_RETENTION_DAYS * DAY) } },
        { upsert: true },
      );
    },
    async saveRun(r: RunRecord) {
      const doc = await AgentsRun.create({ ...r, escalationId: r.escalationId && Types.ObjectId.isValid(r.escalationId) ? r.escalationId : undefined, expiresAt: new Date(ctx.now().getTime() + RUN_RETENTION_DAYS * DAY) });
      return String(doc._id);
    },
    async escalate(e: EscalationInput) {
      try {
        const doc = await AgentsEscalation.create({
          agentId: e.agentId, reason: e.reason, summary: e.summary.slice(0, 400), userId: e.userId && Types.ObjectId.isValid(e.userId) ? e.userId : undefined, orderNumber: e.orderNumber, context: e.context, dedupeKey: e.dedupeKey,
        });
        return String(doc._id);
      } catch (err) {
        if ((err as { code?: number }).code === 11000) return null; // an open escalation with this dedupe key already exists
        throw err;
      }
    },
  };
}

export function mongoPending(ctx: Ctx): PendingPort {
  return {
    async create(p): Promise<PendingConfirmation> {
      const userId = p.auth.userId as string;
      const expiresAt = new Date(ctx.now().getTime() + PENDING_TTL_MS);
      const id = new Types.ObjectId();
      const token = signConfirmation(ctx.cfg.JWT_SECRET, { pendingId: String(id), userId, tool: p.tool, argsHash: p.argsHash, expiresAt });
      await AgentsPending.create({ _id: id, agentId: p.agentId, tool: p.tool, userId, args: p.args, argsHash: p.argsHash, summary: p.summary.slice(0, 400), tokenHash: tokenHash(token), expiresAt });
      return { actionId: String(id), token, tool: p.tool, summary: p.summary, expiresAt };
    },
  };
}
