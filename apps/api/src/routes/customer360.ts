import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { can } from '@orvia/auth';
import {
  DomainError, accountRecommendations, activeDeletion, addLifeNode, addStaffNote, aftercareHub, cancelDeletion, customer360Profile, deleteLifeGraph, deleteLifeNode, deleteMemory, deriveLifeGraph,
  exportCustomerData, getCommPrefs, lifeGraphView, listDeletionRequests, listMemory, listOwnedProducts, patchMemory, privacyOverview, processDeletion, productCompanion, recordConsent, requestDeletion,
  saveMemoryItem, searchCustomers, setCommPrefs, setLifeGraphEnabled, setMemorySettings, staffWithdrawConsent,
} from '@orvia/core';
import type { Ctx } from '@orvia/core';
import {
  CONSENT_KINDS, c360SearchSchema, c360ViewSchema, commPrefsSchema, consentChangeSchema, deletionProcessSchema, deletionRequestSchema, lifeGraphNodeSchema, lifeGraphSettingsSchema,
  memoryItemSchema, memoryPatchSchema, memorySettingsSchema, objectId, paginationSchema, staffConsentWithdrawSchema, staffNoteSchema,
} from '@orvia/types';
import { route } from '../http';

const idParam = (req: { params: unknown }, k = 'id') => {
  const v = (req.params as Record<string, string>)[k] ?? '';
  const r = objectId.safeParse(v);
  if (!r.success) throw new DomainError('Not found', 'NOT_FOUND', 404);
  return r.data;
};

/**
 * customer360 routes.
 * Customer routes (`auth: 'user'`) only ever read/write rows keyed by the session's own user id; ids in URLs are always
 * combined with that user id in the query (no IDOR). Staff routes need `customer360:read` / `customer360:write`.
 */
export function customer360Routes(app: FastifyInstance, ctx: Ctx): void {
  /* ------------------------------ privacy center ------------------------------ */
  route(app, ctx, {
    method: 'GET', url: '/account/privacy', summary: 'My consents, history, switches and deletion status', tags: ['Privacy'], auth: 'user',
    handler: ({ user }) => privacyOverview(user.id),
  });
  route(app, ctx, {
    method: 'PUT', url: '/account/privacy/consents/:kind', summary: 'Grant or withdraw a consent', tags: ['Privacy'], auth: 'user', body: consentChangeSchema,
    handler: ({ req, user, body }) => {
      const kind = z.enum(CONSENT_KINDS).safeParse((req.params as { kind: string }).kind);
      if (!kind.success) throw new DomainError('Unknown consent type', 'NOT_FOUND', 404);
      return recordConsent(ctx, { userId: user.id, email: user.email, kind: kind.data, granted: body.granted, source: body.source, ip: req.ip, actor: req.actor });
    },
  });
  route(app, ctx, {
    method: 'GET', url: '/account/privacy/export', summary: 'Download all data held about me (JSON)', tags: ['Privacy'], auth: 'user',
    rateLimit: { max: 5, timeWindow: '1 hour' },
    handler: async ({ req, user, reply }) => {
      const data = await exportCustomerData(ctx, user, req.actor);
      void reply.header('content-disposition', 'attachment; filename="orvia-my-data.json"').header('cache-control', 'no-store');
      return data;
    },
  });
  route(app, ctx, {
    method: 'GET', url: '/account/privacy/deletion', summary: 'My open deletion request', tags: ['Privacy'], auth: 'user',
    handler: async ({ user }) => ({ request: await activeDeletion(user.id) }),
  });
  route(app, ctx, {
    method: 'POST', url: '/account/privacy/deletion', summary: 'Request account deletion (starts the cooling-off period)', tags: ['Privacy'], auth: 'user', body: deletionRequestSchema,
    rateLimit: { max: 5, timeWindow: '1 hour' },
    handler: async ({ req, user, body, reply }) => reply.status(201).send({ request: await requestDeletion(ctx, user, body.reason, req.actor) }),
  });
  route(app, ctx, {
    method: 'DELETE', url: '/account/privacy/deletion', summary: 'Cancel my deletion request', tags: ['Privacy'], auth: 'user',
    handler: ({ req, user }) => cancelDeletion(ctx, user.id, req.actor),
  });

  /* ------------------------------ communication preferences ------------------------------ */
  route(app, ctx, {
    method: 'GET', url: '/account/preferences', summary: 'My communication preferences', tags: ['Privacy'], auth: 'user',
    handler: async ({ user }) => ({ ...(await getCommPrefs(user.id)), consents: (await privacyOverview(user.id)).consents }),
  });
  route(app, ctx, {
    method: 'PUT', url: '/account/preferences', summary: 'Update communication preferences', tags: ['Privacy'], auth: 'user', body: commPrefsSchema,
    handler: ({ req, user, body }) => setCommPrefs(ctx, user.id, body.topics, body.replenishmentOptIn, req.actor),
  });

  /* ------------------------------ LifeGraph ------------------------------ */
  route(app, ctx, { method: 'GET', url: '/account/lifegraph', summary: 'My LifeGraph', tags: ['LifeGraph'], auth: 'user', handler: ({ user }) => lifeGraphView(user.id) });
  route(app, ctx, {
    method: 'PUT', url: '/account/lifegraph/settings', summary: 'Turn LifeGraph on or off', tags: ['LifeGraph'], auth: 'user', body: lifeGraphSettingsSchema,
    handler: ({ req, user, body }) => setLifeGraphEnabled(ctx, user.id, body.enabled, req.actor),
  });
  route(app, ctx, {
    method: 'POST', url: '/account/lifegraph/nodes', summary: 'Add something you want us to know', tags: ['LifeGraph'], auth: 'user', body: lifeGraphNodeSchema,
    handler: async ({ req, user, body, reply }) => reply.status(201).send(await addLifeNode(ctx, user.id, body, req.actor)),
  });
  route(app, ctx, {
    method: 'DELETE', url: '/account/lifegraph/nodes/:id', summary: 'Delete one LifeGraph item', tags: ['LifeGraph'], auth: 'user',
    handler: ({ req, user }) => deleteLifeNode(ctx, user.id, idParam(req), req.actor),
  });
  route(app, ctx, {
    method: 'POST', url: '/account/lifegraph/derive', summary: 'Suggest interests from my purchases (visible and deletable)', tags: ['LifeGraph'], auth: 'user',
    handler: ({ req, user }) => deriveLifeGraph(ctx, user, req.actor),
  });
  route(app, ctx, {
    method: 'DELETE', url: '/account/lifegraph', summary: 'Erase my whole LifeGraph', tags: ['LifeGraph'], auth: 'user',
    handler: ({ req, user }) => deleteLifeGraph(ctx, user.id, req.actor),
  });
  route(app, ctx, {
    method: 'GET', url: '/account/lifegraph/export', summary: 'Download my LifeGraph (JSON)', tags: ['LifeGraph'], auth: 'user',
    handler: async ({ user, reply }) => {
      const v = await lifeGraphView(user.id);
      void reply.header('content-disposition', 'attachment; filename="orvia-lifegraph.json"').header('cache-control', 'no-store');
      return { schema: 'orvia.lifegraph.v1', enabled: v.enabled, nodes: v.nodes, graph: v.graph };
    },
  });
  route(app, ctx, {
    method: 'GET', url: '/account/recommendations', summary: 'Suggestions, boosted by LifeGraph only when you opted in', tags: ['LifeGraph'], auth: 'user',
    query: z.object({ limit: z.coerce.number().int().min(1).max(24).default(12) }),
    handler: ({ req, user, query }) => accountRecommendations(ctx, user, req.country, query.limit),
  });

  /* ------------------------------ Commerce Memory ------------------------------ */
  route(app, ctx, {
    method: 'GET', url: '/account/memory', summary: 'My Commerce Memory', tags: ['Memory'], auth: 'user', query: paginationSchema,
    handler: ({ user, query }) => listMemory(user.id, query.page, query.pageSize),
  });
  route(app, ctx, {
    method: 'POST', url: '/account/memory', summary: 'Save a note, requirement or comparison', tags: ['Memory'], auth: 'user', body: memoryItemSchema,
    handler: async ({ user, body, reply }) => {
      const r = await saveMemoryItem(ctx, user.id, body);
      if (!r.saved) throw new DomainError(r.reason === 'memory_off' ? 'Commerce Memory is switched off' : r.reason === 'limit' ? 'Memory limit reached' : 'That item is too large', r.reason === 'memory_off' ? 'MEMORY_OFF' : 'LIMIT', 409);
      return reply.status(201).send({ id: r.id });
    },
  });
  route(app, ctx, {
    method: 'PATCH', url: '/account/memory/:id', summary: 'Edit or switch off one memory item', tags: ['Memory'], auth: 'user', body: memoryPatchSchema,
    handler: ({ req, user, body }) => patchMemory(ctx, user.id, idParam(req), body, req.actor),
  });
  route(app, ctx, {
    method: 'DELETE', url: '/account/memory/:id', summary: 'Delete one memory item', tags: ['Memory'], auth: 'user',
    handler: ({ req, user }) => deleteMemory(ctx, user.id, idParam(req), req.actor),
  });
  route(app, ctx, {
    method: 'DELETE', url: '/account/memory', summary: 'Delete all my memory', tags: ['Memory'], auth: 'user',
    handler: ({ req, user }) => deleteMemory(ctx, user.id, null, req.actor),
  });
  route(app, ctx, {
    method: 'PUT', url: '/account/memory/settings', summary: 'Memory on/off and retention', tags: ['Memory'], auth: 'user', body: memorySettingsSchema,
    handler: ({ req, user, body }) => setMemorySettings(ctx, user.id, body, req.actor),
  });
  route(app, ctx, {
    method: 'GET', url: '/account/memory/export', summary: 'Download my memory (JSON)', tags: ['Memory'], auth: 'user',
    handler: async ({ user, reply }) => {
      const m = await listMemory(user.id, 1, 200);
      void reply.header('content-disposition', 'attachment; filename="orvia-memory.json"').header('cache-control', 'no-store');
      return { schema: 'orvia.memory.v1', settings: m.settings, items: m.items };
    },
  });

  /* ------------------------------ companion + aftercare ------------------------------ */
  route(app, ctx, { method: 'GET', url: '/account/products', summary: 'Products I received', tags: ['Companion'], auth: 'user', handler: ({ user }) => listOwnedProducts(ctx, user) });
  route(app, ctx, {
    method: 'GET', url: '/account/products/:orderItemId', summary: 'Product companion (verified product data only)', tags: ['Companion'], auth: 'user',
    handler: ({ req, user }) => productCompanion(ctx, user, (req.params as { orderItemId: string }).orderItemId),
  });
  route(app, ctx, { method: 'GET', url: '/account/aftercare', summary: 'Open returns, refunds, tickets and delivery issues', tags: ['Companion'], auth: 'user', handler: ({ user }) => aftercareHub(ctx, user) });

  /* ------------------------------ staff: Customer 360 ------------------------------ */
  route(app, ctx, {
    method: 'GET', url: '/admin/customer-360', summary: 'Search customers (masked)', tags: ['Customer 360'], auth: 'staff', permission: 'customer360:read', query: c360SearchSchema,
    handler: ({ req, query }) => searchCustomers(ctx, req.actor, query.q, query.page),
  });
  route(app, ctx, {
    method: 'GET', url: '/admin/customer-360/deletion-requests', summary: 'Deletion requests', tags: ['Customer 360'], auth: 'staff', permission: 'customer360:read',
    query: z.object({ status: z.enum(['requested', 'ready', 'on_hold', 'completed', 'cancelled', 'rejected']).optional(), page: z.coerce.number().int().min(1).max(100).default(1) }),
    handler: ({ query }) => listDeletionRequests(query.status, query.page),
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/customer-360/deletion-requests/:id/process', summary: 'Execute, reject, hold or release a deletion request', tags: ['Customer 360'], auth: 'staff', permission: 'customer360:write', body: deletionProcessSchema,
    handler: ({ req, body }) => processDeletion(ctx, idParam(req), body.action, body.note, req.actor),
  });
  route(app, ctx, {
    method: 'GET', url: '/admin/customer-360/:userId', summary: 'Customer profile (PII-minimized, audited)', tags: ['Customer 360'], auth: 'staff', permission: 'customer360:read', query: c360ViewSchema,
    handler: ({ req, user, query }) => {
      if (query.reveal) {
        if (!can(user.role, 'customer360:write')) throw new DomainError('Revealing contact details needs customer360:write', 'FORBIDDEN', 403);
        if (!query.reason) throw new DomainError('A reason is required to reveal contact details', 'VALIDATION', 400);
      }
      return customer360Profile(ctx, req.actor, idParam(req, 'userId'), { revealEmail: !!query.reveal, reason: query.reason });
    },
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/customer-360/:userId/notes', summary: 'Add a staff note', tags: ['Customer 360'], auth: 'staff', permission: 'customer360:write', body: staffNoteSchema,
    handler: async ({ req, user, body, reply }) => reply.status(201).send(await addStaffNote(ctx, req.actor, { id: user.id, name: user.name }, idParam(req, 'userId'), body.body)),
  });
  route(app, ctx, {
    method: 'POST', url: '/admin/customer-360/:userId/consents/withdraw', summary: 'Withdraw a consent on the customer\'s behalf (audited)', tags: ['Customer 360'], auth: 'staff', permission: 'customer360:write', body: staffConsentWithdrawSchema,
    handler: ({ req, body }) => staffWithdrawConsent(ctx, req.actor, idParam(req, 'userId'), body.kind, body.reason),
  });
}
