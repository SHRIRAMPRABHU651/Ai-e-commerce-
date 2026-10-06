import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExceptionModel, Product } from '@orvia/database';
import { canPublish } from '@orvia/core';
import type { Ctx } from '@orvia/core';
import { closeCtx, testCtx } from '../helpers/ctx';
import { Client, startApi } from '../helpers/client';
import { fakeSupplier, restMapping } from '../helpers/fakeSupplier';
import { runSeed } from '../../scripts/lib/seed';

const S = fakeSupplier('keyO', 'https://cdn.o.example', 47851, { cost: 2, min: 4, max: 8 });
let ctx: Ctx; let admin: Client; let supId = ''; let productId = '';
beforeAll(async () => {
  await S.start();
  S.state.title = '100% Organic Cotton Dog Blanket — non-toxic, eco-certified';
  S.state.description = 'Certified organic cotton blanket. Chemical-free dyes, plant-based stuffing and biodegradable packaging keep pets cosy.';
  ctx = await testCtx('organic');
  await runSeed(ctx, { withHistory: false });
  admin = (await startApi(ctx)).client();
  expect((await admin.post('/api/v1/auth/admin/login', { email: 'owner@orvia.test', password: 'Orvia-Demo-2026!' })).status).toBe(200);
  supId = (await admin.post('/api/v1/admin/suppliers', { code: 'organic-supply', name: 'Organic supply', provider: 'rest', servesCountries: ['US', 'IN'], credentials: { apiKey: 'keyO' }, config: restMapping('http://localhost:47851', 'US') })).body.id;
}, 180_000);
afterAll(async () => { await S.stop(); await closeCtx(); });

describe('organic / eco claims are never invented', () => {
  it('strips unverified claims from the supplier title and the generated copy, keeps provenance and tells the admin', async () => {
    const r = await admin.post('/api/v1/admin/products/import', { supplierId: supId, externalId: 'P100' });
    expect(r.status).toBe(201);
    productId = r.body.productId;
    const p = await Product.findById(productId).lean();
    const text = JSON.stringify([p!.title, p!.description, p!.bullets, p!.features, p!.benefits, p!.seo, p!.faqs, p!.social]);
    expect(text).not.toMatch(/organic|non-toxic|chemical-free|eco-certified|biodegradable|plant-based/i);
    expect(p!.organic!.sourceTitle).toMatch(/Organic Cotton/);
    expect(p!.organic!.removedClaims!.length).toBeGreaterThan(0);
    expect(await ExceptionModel.countDocuments({ productId, kind: 'ORGANIC_CLAIM' })).toBe(1);
    expect(r.body.notes.join(' ')).toMatch(/Unverified claim/);
  });

  it('blocks an admin edit that re-introduces the claim on a live product, and blocks publishing it', async () => {
    await Product.updateOne({ _id: productId }, { $set: { state: 'PUBLISHED' } });
    const edit = await admin.patch(`/api/v1/admin/products/${productId}`, { description: 'Made from certified organic cotton.' });
    expect(edit.status).toBe(422);
    expect(edit.body.error.message).toMatch(/Unverified claim/);
    await Product.updateOne({ _id: productId }, { $set: { state: 'DRAFT', description: 'Made from certified organic cotton for pets.' } });
    const gate = await canPublish(ctx, productId);
    expect(gate.ok).toBe(false);
    expect(gate.problems.join(' ')).toMatch(/Unverified claim/);
  });

  it('incomplete or unverified evidence does not unlock the claim; complete evidence does — per market', async () => {
    const add = (body: Record<string, unknown>) => admin.post(`/api/v1/admin/products/${productId}/claim-evidence`, { claim: 'organic', type: 'certification', ...body });
    expect((await add({ verified: true, body: 'USDA' })).status).toBe(422); // verified but no certificate id/url
    expect((await add({ body: 'USDA', certId: 'NOP-1', jurisdiction: ['US'], verified: false })).status).toBe(201); // stored, but not verified
    expect((await canPublish(ctx, productId)).problems.join(' ')).toMatch(/Unverified claim/);
    expect((await add({ body: 'USDA', certId: 'NOP-1', jurisdiction: ['US'], verified: true })).status).toBe(201);
    // sold in US and India, certificate only covers the US ⇒ still blocked
    const p = await Product.findById(productId).lean();
    expect(p!.markets.map((m) => m.country).sort()).toEqual(expect.arrayContaining(['US']));
    if (p!.markets.some((m) => m.country === 'IN' && m.enabled)) expect((await canPublish(ctx, productId)).problems.join(' ')).toMatch(/Unverified claim/);
    expect((await add({ body: 'India Organic (NPOP)', certId: 'NPOP-77', jurisdiction: ['IN'], verified: true })).status).toBe(201);
    const gate = await canPublish(ctx, productId);
    expect(gate.problems.join(' ')).not.toMatch(/Unverified claim/);
  });

  it('only staff can verify evidence (RBAC) and every change is audited', async () => {
    const anon = (await startApi(ctx)).client();
    expect((await anon.post(`/api/v1/admin/products/${productId}/claim-evidence`, { claim: 'eco', type: 'certification', body: 'X', certId: '1', verified: true })).status).toBe(401);
    const support = (await startApi(ctx)).client();
    await support.post('/api/v1/auth/admin/login', { email: 'support@orvia.test', password: 'Orvia-Demo-2026!' });
    expect((await support.post(`/api/v1/admin/products/${productId}/claim-evidence`, { claim: 'eco', type: 'certification', body: 'X', certId: '1', verified: true })).status).toBe(403);
    const audit = await admin.get('/api/v1/admin/audit?action=product.claim_evidence');
    expect(audit.body.items.length).toBeGreaterThanOrEqual(3);
  });
});
