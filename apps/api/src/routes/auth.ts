import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { forgotSchema, loginSchema, registerSchema, resetSchema, verifyEmailSchema } from '@orvia/types';
import { DomainError, listSessions, login, logout, registerCustomer, requestPasswordReset, resetPassword, revokeAllSessions, revokeSession, verifyEmail } from '@orvia/core';
import type { Ctx } from '@orvia/core';
import { route } from '../http';
import { SESSION_COOKIE } from '../plugins';

const strict = { max: 10, timeWindow: '1 minute' };

export function authRoutes(app: FastifyInstance, ctx: Ctx): void {
  const setSession = (reply: import('fastify').FastifyReply, token: string, expires: Date) =>
    reply.setCookie(SESSION_COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure: ctx.cfg.COOKIE_SECURE, expires });

  route(app, ctx, {
    method: 'POST', url: '/auth/register', summary: 'Create a customer account', tags: ['Auth'], body: registerSchema, rateLimit: strict,
    handler: async ({ req, body, reply }) => {
      const user = await registerCustomer(ctx, body, req.actor);
      const r = await login(ctx, { email: body.email, password: body.password, ip: req.ip, userAgent: req.headers['user-agent'] });
      setSession(reply, r.token, r.expiresAt);
      return reply.status(201).send({ user });
    },
  });

  route(app, ctx, {
    method: 'POST', url: '/auth/login', summary: 'Customer sign in', tags: ['Auth'], body: loginSchema, rateLimit: strict,
    handler: async ({ req, body, reply }) => {
      const r = await login(ctx, { ...body, ip: req.ip, userAgent: req.headers['user-agent'] });
      setSession(reply, r.token, r.expiresAt);
      return { user: r.user };
    },
  });

  route(app, ctx, {
    method: 'POST', url: '/auth/admin/login', summary: 'Staff sign in', tags: ['Auth'], body: loginSchema, rateLimit: strict,
    handler: async ({ req, body, reply }) => {
      const r = await login(ctx, { ...body, ip: req.ip, userAgent: req.headers['user-agent'], staffOnly: true });
      setSession(reply, r.token, r.expiresAt);
      return { user: r.user };
    },
  });

  route(app, ctx, {
    method: 'POST', url: '/auth/logout', summary: 'Sign out (revokes the server-side session)', tags: ['Auth'],
    handler: async ({ req, reply }) => {
      const t = req.cookies[SESSION_COOKIE];
      if (t) await logout(ctx, t);
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return { ok: true };
    },
  });

  route(app, ctx, { method: 'GET', url: '/auth/me', summary: 'Current user', tags: ['Auth'], auth: 'optional', handler: async ({ req }) => ({ user: req.user ?? null }) });

  route(app, ctx, {
    method: 'POST', url: '/auth/forgot-password', summary: 'Request a password reset email', tags: ['Auth'], body: forgotSchema, rateLimit: { max: 5, timeWindow: '1 minute' },
    handler: async ({ body }) => {
      await requestPasswordReset(ctx, body.email);
      return { ok: true, message: 'If an account exists for that email, a reset link is on its way.' };
    },
  });

  route(app, ctx, {
    method: 'POST', url: '/auth/reset-password', summary: 'Reset password with token', tags: ['Auth'], body: resetSchema, rateLimit: strict,
    handler: async ({ body }) => {
      await resetPassword(ctx, body.token, body.password);
      return { ok: true };
    },
  });

  route(app, ctx, {
    method: 'POST', url: '/auth/verify-email', summary: 'Verify email address', tags: ['Auth'], body: verifyEmailSchema, rateLimit: strict,
    handler: async ({ body }) => {
      if (!(await verifyEmail(body.token))) throw new DomainError('This verification link is invalid or has expired', 'BAD_TOKEN', 400);
      return { ok: true };
    },
  });

  route(app, ctx, { method: 'GET', url: '/auth/sessions', summary: 'List my active sessions', tags: ['Auth'], auth: 'user', handler: async ({ user }) => ({ sessions: await listSessions(user.id) }) });
  route(app, ctx, {
    method: 'DELETE', url: '/auth/sessions/:id', summary: 'Revoke one session', tags: ['Auth'], auth: 'user',
    handler: async ({ req, user }) => {
      await revokeSession(user.id, (req.params as { id: string }).id);
      return { ok: true };
    },
  });
  route(app, ctx, { method: 'POST', url: '/auth/sessions/revoke-all', summary: 'Sign out everywhere', tags: ['Auth'], auth: 'user', body: z.object({}).optional(), handler: async ({ user }) => (await revokeAllSessions(user.id), { ok: true }) });
}
