import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { metrics } from '@orvia/config';
import { authenticate, DomainError } from '@orvia/core';
import type { Ctx } from '@orvia/core';
import { isCountryCode } from '@orvia/types';
import { ZodError } from 'zod';

export const SESSION_COOKIE = 'orvia_session';
export const CART_COOKIE = 'orvia_cart';
export const COUNTRY_COOKIE = 'orvia_country';

const hasForbiddenKey = (v: unknown, depth = 0): boolean => {
  if (depth > 8 || v === null || typeof v !== 'object') return false;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (k.startsWith('$') || k.includes('.')) return true;
    if (hasForbiddenKey(val, depth + 1)) return true;
  }
  return false;
};

export async function registerPlugins(app: FastifyInstance, ctx: Ctx, opts: { redis?: Redis | null } = {}): Promise<void> {
  const cfg = ctx.cfg;
  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-site' },
    hsts: cfg.COOKIE_SECURE ? { maxAge: 63072000, includeSubDomains: true, preload: true } : false,
  });
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || cfg.corsOrigins.includes(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-requested-with', 'x-request-id'],
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: '1 minute',
    redis: opts.redis ?? undefined,
    skipOnError: true, // Redis down => fall back to allowing, never take the API down
    nameSpace: 'orvia-rl:',
    allowList: (req) => req.url.startsWith('/health') || req.url.startsWith('/live') || req.url.startsWith('/ready'),
    errorResponseBuilder: (_req, ctxRl) => new DomainError(`Too many requests. Retry in ${Math.ceil(ctxRl.ttl / 1000)}s`, 'RATE_LIMITED', 429),
  });
  await app.register(swagger, {
    openapi: {
      info: { title: 'Orvia API', version: '1.0.0', description: 'Orvia commerce platform API (v1). Cookie-authenticated.' },
      components: { securitySchemes: { cookieAuth: { type: 'apiKey', in: 'cookie', name: SESSION_COOKIE } } },
    },
  });
  if (!cfg.isProduction) await app.register(swaggerUi, { routePrefix: '/docs' });
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  // zod validates; bypass ajv (single source of truth + no coercion surprises)
  app.setValidatorCompiler(() => (data) => ({ value: data }));
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));

  // raw body for webhook signature verification
  app.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 1_000_000 }, (req, body, done) => {
    req.rawBody = body as string;
    if (!body) return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(new DomainError('Malformed JSON', 'BAD_JSON', 400), undefined);
    }
  });

  app.decorateRequest('country', 'US');

  app.addHook('onRequest', async (req, reply) => {
    const rid = (req.headers['x-request-id'] as string | undefined)?.slice(0, 64) || randomUUID();
    reply.header('x-request-id', rid);
    (req as unknown as { _start: number })._start = performance.now();
    const geo = (req.headers['cloudfront-viewer-country'] ?? req.headers['x-vercel-ip-country'] ?? req.headers['cf-ipcountry']) as string | undefined;
    req.ipCountry = geo && /^[A-Z]{2}$/.test(geo) ? geo : undefined;
    const q = (req.query as Record<string, string> | undefined)?.country;
    const fromCookie = req.cookies[COUNTRY_COOKIE];
    const pick = [q, fromCookie, req.ipCountry].find((c) => c && isCountryCode(c));
    req.country = (pick as 'US' | 'CA' | 'IN' | undefined) ?? 'US';
    req.actor = { id: 'anonymous', type: 'anonymous', requestId: rid };
    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      const user = await authenticate(ctx, token).catch(() => null);
      if (user) {
        req.user = user;
        req.actor = { id: user.id, type: 'user', role: user.role, requestId: rid };
      }
    }
  });

  // Mongo operator injection: reject `$`/dotted keys anywhere in body, query or params.
  app.addHook('preValidation', async (req) => {
    if (hasForbiddenKey(req.body) || hasForbiddenKey(req.query) || hasForbiddenKey(req.params)) {
      ctx.log.warn({ channel: 'security', url: req.url, ip: req.ip }, 'blocked request with operator-like keys');
      throw new DomainError('Invalid request', 'BAD_REQUEST', 400);
    }
  });

  // CSRF: cookie-authenticated mutations must carry the custom header (cannot be sent cross-site without a CORS preflight, which we deny)
  app.addHook('preHandler', async (req) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    if (req.url.startsWith('/api/v1/webhooks/')) return; // signature-authenticated
    const usesCookies = !!(req.cookies[SESSION_COOKIE] || req.cookies[CART_COOKIE]);
    if (!usesCookies) return;
    const origin = req.headers.origin as string | undefined;
    if (origin && !cfg.corsOrigins.includes(origin)) throw new DomainError('Cross-origin request blocked', 'CSRF', 403);
    if (req.headers['x-requested-with'] !== 'orvia') throw new DomainError('Missing CSRF header', 'CSRF', 403);
  });

  app.addHook('onResponse', async (req, reply) => {
    const start = (req as unknown as { _start?: number })._start ?? performance.now();
    const secs = (performance.now() - start) / 1000;
    const routeUrl = (req.routeOptions?.url ?? 'unknown').replace(/:[a-zA-Z]+/g, ':p');
    const status = reply.statusCode;
    metrics.observe('orvia_http_request_duration_seconds', secs, { method: req.method, route: routeUrl });
    metrics.inc('orvia_http_requests_total', { method: req.method, route: routeUrl, status: `${Math.floor(status / 100)}xx` });
    if (status >= 500) metrics.inc('orvia_http_errors_total', { route: routeUrl });
    ctx.log.info({ channel: 'app', requestId: req.actor.requestId, method: req.method, url: req.url.split('?')[0], status, ms: Math.round(secs * 1000) }, 'request');
  });

  app.setErrorHandler((err, req, reply) => {
    const requestId = req.actor?.requestId;
    if (err instanceof DomainError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details, requestId } });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: { code: 'VALIDATION', message: 'Invalid input', details: err.issues, requestId } });
    }
    const e = err as { statusCode?: number; code?: string; name?: string; message: string; retryable?: boolean };
    if (e.name === 'WebhookSignatureError') {
      ctx.log.warn({ channel: 'security', url: req.url, ip: req.ip }, 'invalid webhook signature');
      return reply.status(400).send({ error: { code: 'BAD_SIGNATURE', message: 'Invalid signature', requestId } });
    }
    if (e.statusCode && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: { code: e.code ?? 'BAD_REQUEST', message: e.message, requestId } });
    }
    if ((e.name === 'ProviderError' || e.name === 'CircuitOpenError') ) {
      ctx.log.error({ channel: 'error', requestId, err: e.message }, 'upstream provider error');
      return reply.status(502).send({ error: { code: 'UPSTREAM_ERROR', message: 'A required upstream service is unavailable. Please retry shortly.', requestId } });
    }
    ctx.log.error({ channel: 'error', requestId, err: e.message, stack: cfg.isProduction ? undefined : (err as Error).stack }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Something went wrong', requestId } });
  });

  app.setNotFoundHandler((req, reply) => reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found', requestId: req.actor?.requestId } }));
}
