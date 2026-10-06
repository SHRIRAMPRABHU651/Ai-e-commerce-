import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchReadiness, runProviderChecks } from '@orvia/core';
import type { Ctx } from '@orvia/core';
import { closeCtx, testCtx } from '../helpers/ctx';
import { Client, startApi } from '../helpers/client';
import { runSeed } from '../../scripts/lib/seed';

let ctx: Ctx; let admin: Client; let analyst: Client; let client: Client;
const stripeOk: typeof fetch = async (u) => new Response(JSON.stringify({ url: String(u) }), { status: String(u).includes('stripe') ? 200 : 401 });
beforeAll(async () => {
  ctx = await testCtx('launch', { STRIPE_SECRET_KEY: 'sk_test_fake', GEMINI_API_KEY: 'g-fake' });
  await runSeed(ctx, { withHistory: false });
  client = (await startApi(ctx)).client();
  admin = (await startApi(ctx)).client();
  analyst = (await startApi(ctx)).client();
  await admin.post('/api/v1/auth/admin/login', { email: 'owner@orvia.test', password: 'Orvia-Demo-2026!' });
}, 180_000);
afterAll(closeCtx);

describe('launch readiness gate', () => {
  it('is NO_GO out of the box, names blockers, and never reports mocks as verified', async () => {
    const r = await launchReadiness(ctx);
    expect(r.verdict).toBe('NO_GO');
    expect(r.blockers.length).toBeGreaterThan(0);
    expect(Object.keys(r.areas)).toEqual(expect.arrayContaining(['DATABASE', 'STORAGE', 'SUPPLIERS', 'PAYMENTS', 'LEGAL', 'MARKET INTEL', 'IMAGE SYSTEM']));
    expect(r.providers.find((p) => p.name === 'Stripe')!.status).toBe('UNVERIFIED');
    expect(r.blockers.some((b) => b.area === 'LEGAL')).toBe(true);
  });

  it('live checks use the injected fetch, record PASS/FAIL, and only call read-only endpoints', async () => {
    const seen: string[] = [];
    const f: typeof fetch = async (u, init) => { seen.push(`${init?.method ?? 'GET'} ${String(u)}`); return stripeOk(u, init); };
    const res = await runProviderChecks(ctx, f);
    expect(res['stripe']!.status).toBe('PASS');
    expect(res['ai']!.status).toBe('FAIL');
    expect(seen.every((s) => s.startsWith('GET '))).toBe(true);
    const r = await launchReadiness(ctx, { live: true, fetchImpl: f });
    expect(r.providers.find((p) => p.name === 'Stripe')!.status).toBe('PASS');
    expect(r.providers.find((p) => p.name === 'Gemini')!.status).toBe('FAIL');
    expect((await launchReadiness(ctx)).verifications['stripe']!.status).toBe('PASS');
  });

  it('a provider failure never throws and is reported, not hidden', async () => {
    const boom: typeof fetch = async () => { throw new Error('network down'); };
    const res = await runProviderChecks(ctx, boom);
    expect(res['stripe']).toEqual({ status: 'FAIL', detail: 'network down' });
  });

  it('legal attestation is recorded with the actor and clears the legal blocker', async () => {
    const bad = await admin.put('/api/v1/admin/settings/legal', { businessName: 'x', registeredAddress: 'short', supportEmail: 'nope', reviewConfirmed: true });
    expect(bad.status).toBe(400);
    const ok = await admin.put('/api/v1/admin/settings/legal', { businessName: 'Orvia Pets LLC', registeredAddress: '1 Main Street, Austin TX', supportEmail: 'help@orvia.test', reviewConfirmed: true, emailDomainVerified: true });
    expect(ok.status).toBe(200);
    expect(ok.body.reviewedBy).toBeTruthy();
    const r = await launchReadiness(ctx);
    expect(r.blockers.some((b) => b.id === 'legal.review')).toBe(false);
  });

  it('API: admin sees the report; the machine gate is 503 while blockers remain; anonymous users are rejected', async () => {
    const g = await admin.get('/api/v1/admin/launch-readiness');
    expect(g.status).toBe(200);
    expect(g.body.verdict).toBe('NO_GO');
    expect((await client.get('/api/v1/admin/launch-readiness')).status).toBe(401);
    void analyst;
    const gate = await client.get('/api/v1/launch-gate');
    expect(gate.status).toBe(503);
    expect(gate.body.verdict).toBe('NO_GO');
    expect(JSON.stringify(gate.body)).not.toMatch(/sk_test_fake|g-fake/);
  });
});
