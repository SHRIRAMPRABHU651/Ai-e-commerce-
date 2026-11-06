import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DomainError, advocateMetrics, advocateRequest, agentCatalogue, assistantMessage, confirmPendingAction, decideReplacement, deleteConversation, getConversation, getRun, listEscalations, listReplacementRequests, listRuns,
  resolveEscalation, runStaffAgent, setAgentEnabled, rateOutcome, usageSeries,
} from '@orvia/core';
import type { Ctx } from '@orvia/core';
import {
  adminRunSchema, advocateRequestSchema, agentIdSchema, assistantConfirmSchema, assistantMessageSchema, assistantRatingSchema, escalationResolveSchema, escalationsQuerySchema, killSwitchSchema, objectId,
  replacementDecisionSchema, replacementQuerySchema, runsQuerySchema, usageQuerySchema,
} from '@orvia/types';
import { route } from '../http';

const A = 'staff' as const;
const P = 'ai:write' as const;
const param = <T,>(req: { params: unknown }, schema: z.ZodType<T>, k = 'id'): T => {
  const r = schema.safeParse((req.params as Record<string, string>)[k] ?? '');
  if (!r.success) throw new DomainError('Invalid id', 'VALIDATION', 400);
  return r.data;
};
const idParam = (req: { params: unknown }) => param(req, objectId);
const sessionParam = (req: { params: unknown }) => param(req, z.string().regex(/^[a-f\d]{32}$/), 'sessionId');
const agentParam = (req: { params: unknown }) => param(req, agentIdSchema);

/** Governed AI agents: customer Shopping Assistant + Customer Advocate, and the admin console (catalogue, runs, budgets, escalations, kill switch, metrics). */
export function agentsRoutes(app: FastifyInstance, ctx: Ctx): void {
  /* --------------------------------- customer-facing --------------------------------- */
  route(app, ctx, {
    method: 'POST', url: '/assistant/message', summary: 'Shopping Assistant message (optional auth; account actions need a signed-in, email-verified customer)', tags: ['Assistant'], auth: 'optional',
    body: assistantMessageSchema, rateLimit: { max: 20, timeWindow: '1 minute' },
    handler: async ({ req, body }) => assistantMessage(ctx, req.user, body, body.country ?? req.country),
  });
  route(app, ctx, {
    method: 'POST', url: '/assistant/confirm', summary: 'Confirm or cancel an action the assistant prepared (one-time token from the assistant reply; owner only)', tags: ['Assistant'], auth: 'user',
    body: assistantConfirmSchema, rateLimit: { max: 20, timeWindow: '1 minute' },
    handler: async ({ req, body }) => confirmPendingAction(ctx, req.user, body),
  });
  route(app, ctx, {
    method: 'GET', url: '/assistant/conversations/:sessionId', summary: 'Read a conversation (its owner, or a guest holding the session id)', tags: ['Assistant'], auth: 'optional', rateLimit: { max: 30, timeWindow: '1 minute' },
    handler: async ({ req }) => getConversation(ctx, req.user, sessionParam(req)),
  });
  route(app, ctx, {
    method: 'DELETE', url: '/assistant/conversations/:sessionId', summary: 'Delete a conversation (customer-controlled deletion)', tags: ['Assistant'], auth: 'optional', rateLimit: { max: 20, timeWindow: '1 minute' },
    handler: async ({ req }) => deleteConversation(ctx, req.user, sessionParam(req)),
  });
  route(app, ctx, {
    method: 'DELETE', url: '/assistant/conversations', summary: 'Delete all my assistant conversations', tags: ['Assistant'], auth: 'user', rateLimit: { max: 5, timeWindow: '1 minute' },
    handler: async ({ req }) => deleteConversation(ctx, req.user, null),
  });
  route(app, ctx, {
    method: 'POST', url: '/assistant/advocate', summary: 'Customer Advocate: the fairest policy-permitted resolution for a delayed/damaged/missing/wrong item (recommends only)', tags: ['Assistant'], auth: 'user',
    body: advocateRequestSchema, rateLimit: { max: 10, timeWindow: '1 minute' },
    handler: async ({ req, body }) => advocateRequest(ctx, req.user, body, req.country),
  });
  route(app, ctx, {
    method: 'POST', url: '/assistant/outcomes/:id/rating', summary: 'Rate how a resolved case went (owner only, after resolution)', tags: ['Assistant'], auth: 'user', body: assistantRatingSchema, rateLimit: { max: 10, timeWindow: '1 minute' },
    handler: async ({ req, user, body }) => rateOutcome(ctx, user, (req.params as { id: string }).id, body),
  });

  /* ------------------------------------ admin ------------------------------------ */
  route(app, ctx, { method: 'GET', url: '/admin/agents', summary: 'Agent catalogue: purpose, tools, limits, model chain, status and today\'s usage', tags: ['Admin'], auth: A, permission: P, handler: async () => ({ items: await agentCatalogue(ctx) }) });
  route(app, ctx, { method: 'GET', url: '/admin/agents/runs', summary: 'Run log (redacted)', tags: ['Admin'], auth: A, permission: P, query: runsQuerySchema, handler: async ({ query }) => listRuns(query) });
  route(app, ctx, { method: 'GET', url: '/admin/agents/runs/:id', summary: 'Run drilldown (redacted)', tags: ['Admin'], auth: A, permission: P, handler: async ({ req }) => getRun(idParam(req)) });
  route(app, ctx, { method: 'GET', url: '/admin/agents/usage', summary: 'Token/cost usage per agent per day (estimates)', tags: ['Admin'], auth: A, permission: P, query: usageQuerySchema, handler: async ({ query }) => usageSeries(ctx, query.days) });
  route(app, ctx, { method: 'GET', url: '/admin/agents/escalations', summary: 'Human escalation queue', tags: ['Admin'], auth: A, permission: P, query: escalationsQuerySchema, handler: async ({ query }) => listEscalations(query) });
  route(app, ctx, {
    method: 'POST', url: '/admin/agents/escalations/:id/resolve', summary: 'Resolve an escalation', tags: ['Admin'], auth: A, permission: P, body: escalationResolveSchema,
    handler: async ({ req, body }) => resolveEscalation(ctx, req.actor, idParam(req), body.note),
  });
  route(app, ctx, { method: 'GET', url: '/admin/agents/metrics/advocate', summary: 'Customer Advocate outcome metrics from stored records ("insufficient data" below the sample floor)', tags: ['Admin'], auth: A, permission: P, handler: async () => advocateMetrics(ctx) });
  route(app, ctx, { method: 'GET', url: '/admin/agents/replacement-requests', summary: 'Replacement requests raised by the assistant, awaiting staff', tags: ['Admin'], auth: A, permission: P, query: replacementQuerySchema, handler: async ({ query }) => listReplacementRequests({ page: query.page, pageSize: query.pageSize, status: query.status }) });
  route(app, ctx, {
    method: 'POST', url: '/admin/agents/replacement-requests/:id/decide', summary: 'Approve or reject a replacement request (records the decision; fulfilment stays in the Returns console)', tags: ['Admin'], auth: A, permission: P, body: replacementDecisionSchema,
    handler: async ({ req, body }) => decideReplacement(ctx, req.actor, idParam(req), body.decision, body.note),
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/agents/:id/kill', summary: 'Kill switch: turn an agent off or on (audited)', tags: ['Admin'], auth: A, permission: P, body: killSwitchSchema,
    handler: async ({ req, body }) => setAgentEnabled(ctx, req.actor, agentParam(req), body.enabled, body.reason),
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/agents/:id/run', summary: 'Run a staff-facing agent (read-only tools; audited)', tags: ['Admin'], auth: A, permission: P, body: adminRunSchema, rateLimit: { max: 20, timeWindow: '1 minute' },
    handler: async ({ req, user, body }) => runStaffAgent(ctx, user, agentParam(req), body),
  });
}
