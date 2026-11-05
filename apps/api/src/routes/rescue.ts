import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { caseDetail, decideConsent, getRescuePolicy, listCases, recoveryView, rescueKpis, runRescueScan, staffDecide, updateRescuePolicy } from '@orvia/core';
import type { Ctx } from '@orvia/core';
import { rescueConsentBody, rescueDecisionBody, rescueListQuery, rescueObjectId, rescuePolicyPatchSchema, rescueRecoveryQuery } from '@orvia/types';
import { route } from '../http';

const idParams = (req: { params: unknown }) => z.object({ id: rescueObjectId }).parse(req.params).id;
const orderParam = (req: { params: unknown }) => z.object({ orderNumber: z.string().min(3).max(40) }).parse(req.params).orderNumber;

/** Delivery Rescue routes: staff (rescue:read / rescue:write) and customer consent (owner or signed token holder). */
export function rescueRoutes(app: FastifyInstance, ctx: Ctx): void {
  const A = 'staff' as const;

  // ------------------------------------------------------------------ staff
  route(app, ctx, {
    method: 'GET', url: '/admin/rescue/cases', summary: 'Delivery Rescue cases', tags: ['Rescue'], auth: A, permission: 'rescue:read', query: rescueListQuery,
    handler: async ({ query }) => listCases(query),
  });
  route(app, ctx, {
    method: 'GET', url: '/admin/rescue/cases/:id', summary: 'Case detail: timeline, options, actions, consents', tags: ['Rescue'], auth: A, permission: 'rescue:read',
    handler: async ({ req }) => caseDetail(idParams(req)),
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/rescue/cases/:id/decision', summary: 'Approve / override / escalate / close / re-plan a case', tags: ['Rescue'], auth: A, permission: 'rescue:write', body: rescueDecisionBody,
    rateLimit: { max: 60, timeWindow: '1 minute' },
    handler: async ({ req, body }) => {
      await staffDecide(ctx, idParams(req), req.actor, body);
      return caseDetail(idParams(req));
    },
  });
  route(app, ctx, {
    method: 'GET', url: '/admin/rescue/kpis', summary: 'Rescue KPIs computed from real cases', tags: ['Rescue'], auth: A, permission: 'rescue:read', query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }),
    handler: async ({ query }) => rescueKpis(ctx, query.days),
  });
  route(app, ctx, {
    method: 'GET', url: '/admin/rescue/policy', summary: 'Authorization and detection policy', tags: ['Rescue'], auth: A, permission: 'rescue:read',
    handler: async () => getRescuePolicy(),
  });
  route(app, ctx, {
    method: 'PUT', url: '/admin/rescue/policy', summary: 'Edit the policy (audited)', tags: ['Rescue'], auth: A, permission: 'rescue:write', body: rescuePolicyPatchSchema,
    handler: async ({ req, body }) => updateRescuePolicy(ctx, req.actor, body),
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/rescue/scan', summary: 'Run one bounded detection pass now', tags: ['Rescue'], auth: A, permission: 'rescue:write', rateLimit: { max: 6, timeWindow: '1 minute' },
    handler: async () => runRescueScan(ctx),
  });

  // --------------------------------------------------------------- customer
  route(app, ctx, {
    method: 'GET', url: '/orders/:orderNumber/recovery', summary: 'Recovery options for an order (owner or consent-link holder)', tags: ['Orders'], auth: 'optional', query: rescueRecoveryQuery,
    rateLimit: { max: 30, timeWindow: '1 minute' },
    handler: async ({ req, query }) => recoveryView(ctx, orderParam(req), { userId: req.user?.id, email: req.user?.email ?? query.email, token: query.token }),
  });
  route(app, ctx, {
    method: 'POST', url: '/orders/:orderNumber/recovery/decision', summary: 'Accept or decline one recovery option (single use)', tags: ['Orders'], auth: 'optional', body: rescueConsentBody,
    rateLimit: { max: 20, timeWindow: '1 minute' },
    handler: async ({ req, body }) => decideConsent(ctx, orderParam(req), body.optionId, body.decision, { userId: req.user?.id, email: req.user?.email ?? body.email, token: body.token }, req.ip),
  });
}
