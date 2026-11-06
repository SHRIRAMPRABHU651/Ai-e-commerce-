import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { toJSONSchema } from 'zod';
import type { ZodType } from 'zod';
import { can } from '@orvia/auth';
import type { Permission } from '@orvia/auth';
import { DomainError } from '@orvia/core';
import type { Actor, AuthUser, Ctx } from '@orvia/core';
import type { CountryCode } from '@orvia/types';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
    rawBody?: string;
    country: CountryCode;
    ipCountry?: string;
    actor: Actor;
  }
}

export interface RouteDef<B, Q> {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  summary: string;
  tags: string[];
  /** none = public; user = any signed-in account; staff = needs `permission` */
  auth?: 'none' | 'user' | 'optional' | 'staff';
  permission?: Permission;
  body?: ZodType<B, unknown>;
  query?: ZodType<Q, unknown>;
  rateLimit?: { max: number; timeWindow: string };
  handler: (a: { req: FastifyRequest; reply: FastifyReply; body: B; query: Q; user: AuthUser; ctx: Ctx }) => Promise<unknown> | unknown;
}

const jsonSchema = (z: ZodType<unknown, unknown>) => {
  const s = toJSONSchema(z, { target: 'openapi-3.0', io: 'input', unrepresentable: 'any', reused: 'inline' }) as Record<string, unknown>;
  delete s['$schema'];
  return s;
};

/** Declarative metadata of a registered route (no handler). Read by `scripts/gen-api-reference.ts`; has no runtime effect. */
export interface RouteMeta {
  method: RouteDef<unknown, unknown>['method'];
  url: string;
  summary: string;
  tags: string[];
  auth: 'none' | 'user' | 'optional' | 'staff';
  permission?: Permission;
  rateLimit?: { max: number; timeWindow: string };
  bodySchema?: Record<string, unknown>;
  querySchema?: Record<string, unknown>;
}
const routeRegistry: RouteMeta[] = [];
/** Snapshot of every route registered through `route()` in this process (used by docs generators only). */
export const registeredRoutes = (): readonly RouteMeta[] => routeRegistry;

/**
 * Registers a route with zod validation (400 on bad input), auth/RBAC enforcement and OpenAPI docs.
 * Fastify's own ajv validation is bypassed (see server.ts) so zod is the single source of truth.
 */
export function route<B = undefined, Q = undefined>(app: FastifyInstance, ctx: Ctx, d: RouteDef<B, Q>): void {
  const auth = d.auth ?? 'none';
  routeRegistry.push({
    method: d.method,
    url: `/api/v1${d.url}`,
    summary: d.summary,
    tags: d.tags,
    auth,
    permission: d.permission,
    rateLimit: d.rateLimit,
    bodySchema: d.body ? jsonSchema(d.body) : undefined,
    querySchema: d.query ? jsonSchema(d.query) : undefined,
  });
  app.route({
    method: d.method,
    url: `/api/v1${d.url}`,
    schema: {
      summary: d.summary,
      tags: d.tags,
      ...(d.body ? { body: jsonSchema(d.body) } : {}),
      ...(d.query ? { querystring: jsonSchema(d.query) } : {}),
      ...(auth === 'staff' || auth === 'user' ? { security: [{ cookieAuth: [] }] } : {}),
    },
    config: d.rateLimit ? { rateLimit: d.rateLimit } : {},
    handler: async (req, reply) => {
      if (auth === 'user' || auth === 'staff') {
        if (!req.user) throw new DomainError('Authentication required', 'UNAUTHENTICATED', 401);
        if (auth === 'staff') {
          if (req.user.role === 'CUSTOMER' || req.user.role === 'SUPPLIER') throw new DomainError('Forbidden', 'FORBIDDEN', 403);
          if (d.permission && !can(req.user.role, d.permission)) {
            ctx.log.warn({ channel: 'security', user: req.user.id, permission: d.permission, url: req.url.split('?')[0] }, 'permission denied');
            throw new DomainError('You do not have permission to do this', 'FORBIDDEN', 403);
          }
        }
      }
      let body = undefined as B;
      let query = undefined as Q;
      if (d.body) {
        const r = d.body.safeParse(req.body ?? {});
        if (!r.success) throw new DomainError('Invalid request body', 'VALIDATION', 400, r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
        body = r.data;
      }
      if (d.query) {
        const r = d.query.safeParse(req.query ?? {});
        if (!r.success) throw new DomainError('Invalid query', 'VALIDATION', 400, r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
        query = r.data;
      }
      return d.handler({ req, reply, body, query, user: req.user as AuthUser, ctx });
    },
  });
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
