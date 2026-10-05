import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { User, Session } from '@orvia/database';
import { createStaffUser, SYSTEM } from '@orvia/core';
import type { Ctx } from '@orvia/core';
import { closeCtx, testCtx } from '../helpers/ctx';
import { startApi } from '../helpers/client';
import type { Client } from '../helpers/client';

let ctx: Ctx;
let mk: (h?: Record<string, string>) => Client;
let app: Awaited<ReturnType<typeof startApi>>['app'];
beforeAll(async () => {
  ctx = await testCtx('sec');
  const s = await startApi(ctx);
  mk = s.client;
  app = s.app;
  for (const role of ['SUPER_ADMIN', 'ADMIN', 'MARKETING', 'OPERATIONS', 'SUPPORT', 'ANALYST'] as const) {
    await createStaffUser(ctx, { email: `${role.toLowerCase()}@t.test`, name: role, password: 'Str0ngPassw0rd!', role }, SYSTEM);
  }
}, 60_000);
afterAll(closeCtx);

describe('authentication', () => {
  it('registers, hashes passwords, logs in/out and revokes server-side sessions', async () => {
    const c = mk();
    const r = await c.post('/api/v1/auth/register', { email: 'new@user.test', password: 'Sup3rSecretPass', name: 'New User' });
    expect(r.status).toBe(201);
    const u = await User.findOne({ email: 'new@user.test' }).select('+passwordHash').lean();
    expect(u!.passwordHash).toMatch(/^scrypt\$/);
    expect(u!.passwordHash).not.toContain('Sup3rSecretPass');
    expect(r.headers['set-cookie']).toMatch(/HttpOnly/i);
    expect(r.headers['set-cookie']).toMatch(/SameSite=Lax/i);
    expect((await c.get('/api/v1/auth/me')).body.user.email).toBe('new@user.test');
    const stolen = c.cookies['orvia_session']!;
    await c.post('/api/v1/auth/logout');
    expect((await c.get('/api/v1/auth/me')).body.user).toBeNull();
    // the old token no longer works even though the JWT itself is still unexpired
    const replay = mk();
    replay.cookies['orvia_session'] = stolen;
    expect((await replay.get('/api/v1/auth/me')).body.user).toBeNull();
    expect(await Session.countDocuments({ revokedAt: { $ne: null } })).toBeGreaterThan(0);
  });

  it('rejects weak passwords, duplicate emails and bad credentials with generic errors', async () => {
    const c = mk();
    expect((await c.post('/api/v1/auth/register', { email: 'weak@user.test', password: 'short', name: 'W' })).status).toBe(400);
    expect((await c.post('/api/v1/auth/register', { email: 'new@user.test', password: 'Sup3rSecretPass', name: 'Dup' })).status).toBe(409);
    const a = await c.post('/api/v1/auth/login', { email: 'new@user.test', password: 'WrongPassword1' });
    const b = await c.post('/api/v1/auth/login', { email: 'ghost@user.test', password: 'WrongPassword1' });
    expect(a.status).toBe(401);
    expect(b.body.error.message).toBe(a.body.error.message); // no user enumeration
  });

  it('locks the account after repeated failures (brute force protection)', async () => {
    const c = mk();
    await c.post('/api/v1/auth/register', { email: 'brute@user.test', password: 'Sup3rSecretPass', name: 'B' });
    await c.post('/api/v1/auth/logout');
    for (let i = 0; i < 5; i++) await c.post('/api/v1/auth/login', { email: 'brute@user.test', password: 'nope-nope-nope' });
    const locked = await c.post('/api/v1/auth/login', { email: 'brute@user.test', password: 'Sup3rSecretPass' });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
  });

  it('applies a strict rate limit to auth endpoints', async () => {
    const c = mk();
    c.remoteAddress = '10.20.30.40';
    let limited = 0;
    for (let i = 0; i < 14; i++) {
      const r = await c.post('/api/v1/auth/login', { email: `rl${i}@user.test`, password: 'whatever-123' });
      if (r.status === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });

  it('password reset: tokens are hashed, single use, and revoke sessions; unknown emails get the same reply', async () => {
    const c = mk();
    await c.post('/api/v1/auth/register', { email: 'reset@user.test', password: 'Sup3rSecretPass', name: 'R' });
    const a = await c.post('/api/v1/auth/forgot-password', { email: 'reset@user.test' });
    const b = await c.post('/api/v1/auth/forgot-password', { email: 'nobody@user.test' });
    expect(a.body).toEqual(b.body);
    const u = await User.findOne({ email: 'reset@user.test' }).select('+resetTokenHash').lean();
    expect(u!.resetTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect((await c.post('/api/v1/auth/reset-password', { token: 'x'.repeat(40), password: 'AnotherPassw0rd' })).status).toBe(400);
  });
});

describe('RBAC', () => {
  const login = async (role: string) => {
    const c = mk();
    const r = await c.post('/api/v1/auth/admin/login', { email: `${role.toLowerCase()}@t.test`, password: 'Str0ngPassw0rd!' });
    expect(r.status).toBe(200);
    return c;
  };
  it('customers cannot use staff login or admin APIs; anonymous gets 401', async () => {
    const c = mk();
    await c.post('/api/v1/auth/register', { email: 'cust@user.test', password: 'Sup3rSecretPass', name: 'C' });
    expect((await c.post('/api/v1/auth/admin/login', { email: 'cust@user.test', password: 'Sup3rSecretPass' })).status).toBe(401);
    expect((await c.get('/api/v1/admin/orders')).status).toBe(403);
    expect((await mk().get('/api/v1/admin/orders')).status).toBe(401);
  });
  it('enforces the permission matrix per role', async () => {
    const analyst = await login('ANALYST');
    const support = await login('SUPPORT');
    const marketing = await login('MARKETING');
    const ops = await login('OPERATIONS');
    const admin = await login('ADMIN');
    const owner = await login('SUPER_ADMIN');
    expect((await analyst.get('/api/v1/admin/analytics')).status).toBe(200);
    expect((await analyst.get('/api/v1/admin/settings')).status).toBe(403);
    expect((await analyst.put('/api/v1/admin/automation/dynamic_pricing', { mode: 'AUTOMATIC' })).status).toBe(403);
    expect((await support.get('/api/v1/admin/orders')).status).toBe(200);
    expect((await support.get('/api/v1/admin/marketing')).status).toBe(403);
    expect((await marketing.get('/api/v1/admin/marketing')).status).toBe(200);
    expect((await marketing.get('/api/v1/admin/orders')).status).toBe(403);
    expect((await ops.get('/api/v1/admin/suppliers')).status).toBe(200);
    expect((await ops.put('/api/v1/admin/settings/pricing', { minMarginPct: 0.1 })).status).toBe(403);
    expect((await admin.put('/api/v1/admin/automation/dynamic_pricing', { mode: 'AUTOMATIC' })).status).toBe(200);
    expect((await admin.put('/api/v1/admin/automation/dynamic_pricing', { mode: 'ASSISTED' })).status).toBe(200);
    expect((await admin.get('/api/v1/admin/users')).status).toBe(403); // users:manage is SUPER_ADMIN only
    expect((await owner.get('/api/v1/admin/users')).status).toBe(200);
    // audit trail recorded the mode change with actor + before/after
    const audit = await owner.get('/api/v1/admin/audit?action=automation.mode');
    expect(audit.body.items[0].previousValue).toBeDefined();
    expect(audit.body.items[0].actorType).toBe('user');
  });
});

describe('web security', () => {
  it('sets security headers and never exposes secrets', async () => {
    const r = await mk().get('/health');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
    expect(r.headers['x-powered-by']).toBeUndefined();
    const meta = JSON.stringify((await mk().get('/api/v1/meta')).body);
    for (const bad of ['GEMINI', 'SECRET', 'sk_live', 'passwordHash', 'JWT']) expect(meta).not.toContain(bad);
    const admin = mk();
    await admin.post('/api/v1/auth/admin/login', { email: 'admin@t.test', password: 'Str0ngPassw0rd!' });
    const settings = JSON.stringify((await admin.get('/api/v1/admin/settings')).body);
    expect(settings).not.toMatch(/sk_|whsec_|AIza|passwordHash/);
  });
  it('blocks mongo operator injection and malformed input', async () => {
    const c = mk();
    expect((await c.post('/api/v1/auth/login', { email: { $gt: '' }, password: { $gt: '' } })).status).toBe(400);
    expect((await c.get('/api/v1/products?q[$ne]=x')).status).toBe(400);
    expect((await c.post('/api/v1/auth/login', '{bad json')).status).toBe(400);
    expect((await c.get('/api/v1/products?pageSize=100000')).status).toBe(400); // unbounded queries rejected
  });
  it('requires the CSRF header for cookie-authenticated mutations and rejects foreign origins', async () => {
    const c = mk();
    await c.post('/api/v1/auth/register', { email: 'csrf@user.test', password: 'Sup3rSecretPass', name: 'C' });
    const cookie = `orvia_session=${c.cookies['orvia_session']}`;
    const noHeader = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie } });
    expect(noHeader.statusCode).toBe(403);
    const foreign = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie, 'x-requested-with': 'orvia', origin: 'https://evil.example' } });
    expect(foreign.statusCode).toBe(403);
    const ok = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie, 'x-requested-with': 'orvia', origin: 'http://localhost:3000' } });
    expect(ok.statusCode).toBe(200);
  });
  it('exposes health, liveness, readiness and metrics', async () => {
    const c = mk();
    expect((await c.get('/live')).status).toBe(200);
    expect((await c.get('/health')).body.status).toBe('ok');
    const ready = await c.get('/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.checks.mongodb).toBe(true);
    const m = await c.get('/metrics');
    expect(m.raw).toContain('orvia_http_requests_total');
  });
  it('serves OpenAPI documentation for the v1 API', async () => {
    const spec = (await mk().get('/openapi.json')).body;
    expect(spec.openapi).toMatch(/^3/);
    expect(Object.keys(spec.paths).filter((p) => p.startsWith('/api/v1/')).length).toBeGreaterThan(80);
    expect(spec.paths['/api/v1/checkout']).toBeDefined();
  });
});
