/**
 * Finance integration tests. Mongo-backed: run in CI (they could not be executed in the sandbox that wrote them).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { FinanceFxRate, FinanceLedgerEntry, Order, Refund } from '@orvia/database';
import { SYSTEM, backfillLedger, buildOrderPaid, createStaffUser, currentFx, fxPolicy, liveFxTable, refreshFx, setFxOverride, setFxProvider, syncLedger, postJournal, ledgerBalances, totalsFromBalances, ledgerReconciliation } from '@orvia/core';
import type { Ctx, FxProvider } from '@orvia/core';
import type { FxSnapshot } from '@orvia/types';
import { closeCtx, testCtx } from '../helpers/ctx';
import { startApi } from '../helpers/client';
import type { Client } from '../helpers/client';

let ctx: Ctx;
let prodCtx: Ctx;
let mk: (h?: Record<string, string>) => Client;
const mkOrder = (n: number, over: Record<string, unknown> = {}) => Order.create({
  orderNumber: `ORV-F${n}`, idempotencyKey: `fin-${n}`, email: `buyer${n}@x.test`, country: 'US', currency: 'USD', status: 'PAID',
  amounts: { subtotal: 10_000, discount: 0, shipping: 500, tax: 0, total: 10_500 },
  payment: { provider: 'mock', status: 'succeeded', paidAt: new Date(), fee: 335 }, costs: { paymentFee: 335 }, ...over,
});

beforeAll(async () => {
  ctx = await testCtx('finance');
  mk = (await startApi(ctx)).client;
  for (const role of ['ADMIN', 'ANALYST', 'MARKETING'] as const) await createStaffUser(ctx, { email: `${role.toLowerCase()}@t.test`, name: role, password: 'Str0ngPassw0rd!', role }, SYSTEM);
}, 120_000);
afterAll(closeCtx);

const login = async (role: string) => {
  const c = mk();
  expect((await c.post('/api/v1/auth/admin/login', { email: `${role.toLowerCase()}@t.test`, password: 'Str0ngPassw0rd!' })).status).toBe(200);
  return c;
};

describe('ledger is append-only and idempotent', () => {
  it('rejects updates/deletes and ignores a repeated key', async () => {
    const d = buildOrderPaid({ orderId: new mongoose.Types.ObjectId().toString(), currency: 'USD', postedAt: new Date(), total: 1000, tax: 0, discount: 0, shipping: 0 });
    expect((await postJournal(ctx, d)).posted).toBe(true);
    expect((await postJournal(ctx, d)).posted).toBe(false);
    expect(await FinanceLedgerEntry.countDocuments({ idempotencyKey: d.idempotencyKey })).toBe(1);
    await expect(FinanceLedgerEntry.updateOne({ idempotencyKey: d.idempotencyKey }, { $set: { memo: 'x' } })).rejects.toThrow(/append-only/);
    await expect(FinanceLedgerEntry.deleteMany({})).rejects.toThrow(/append-only/);
  });
});

describe('sync, backfill and reconciliation', () => {
  it('posts paid orders and refunds once, however many times it runs', async () => {
    const o = await mkOrder(1);
    await mkOrder(2, { isDemo: true });
    await mkOrder(3, { payment: { provider: 'mock', status: 'pending' } });
    const a = await syncLedger(ctx);
    expect(a.orders).toBeGreaterThanOrEqual(2); // order_paid + payment_fee for order 1 only (demo and unpaid skipped)
    const b = await syncLedger(ctx);
    expect(b.orders).toBe(0);
    expect(await FinanceLedgerEntry.countDocuments({ 'refs.orderId': o._id })).toBe(2);
    const bf = await backfillLedger(ctx, { actor: SYSTEM });
    expect(bf.orders).toBe(0); // idempotent rebuild creates nothing new
    await Refund.create({ orderId: o._id, amount: 2_000, currency: 'USD', status: 'succeeded', idempotencyKey: 'fin-ref-1' });
    await Order.updateOne({ _id: o._id }, { $set: { 'costs.refunded': 2_000, 'payment.status': 'partially_refunded' } });
    expect((await syncLedger(ctx)).refunds).toBe(1);
    expect((await syncLedger(ctx)).refunds).toBe(0);
    const bal = await ledgerBalances();
    const t = totalsFromBalances(bal['USD'] ?? {});
    expect(t.netSales).toBeGreaterThan(0);
    const rec = await ledgerReconciliation(ctx, { sinceDays: 1 });
    expect(rec.findings.filter((f) => f.kind === 'ledger_amount_mismatch' || f.kind === 'ledger_refund_mismatch')).toEqual([]);
  });
});

describe('FX service', () => {
  const fake = (hoursAgo: number, usdInr = 85): FxProvider => ({ name: 'frankfurter', fetchRates: async (now) => ({ base: 'USD', rates: { USD: 1, CAD: 1.4, INR: usdInr }, source: 'frankfurter', fetchedAt: new Date(now.getTime() - hoursAgo * 3_600_000) } satisfies FxSnapshot) });
  it('stores rates, refuses expired rates for pricing in production, honours an audited override, and rejects wild jumps', async () => {
    prodCtx = { ...ctx, cfg: { ...ctx.cfg, APP_ENV: 'production', isProduction: true, FX_PROVIDER: 'frankfurter' } };
    setFxProvider(prodCtx, fake(200));
    await refreshFx(prodCtx);
    expect(await FinanceFxRate.countDocuments()).toBe(1);
    expect((await currentFx(prodCtx)).rates.INR).toBe(85);
    await expect(liveFxTable(prodCtx, { forPricing: true })).rejects.toMatchObject({ code: 'FX_RATES_EXPIRED' });
    expect((await liveFxTable(prodCtx)).INR).toBe(85); // reporting use never blocks
    await setFxOverride(prodCtx, 2, SYSTEM, 'supplier outage, provider unreachable');
    expect((await fxPolicy(prodCtx)).adminOverride).toBe(true);
    expect((await liveFxTable(prodCtx, { forPricing: true })).INR).toBe(85);
    setFxProvider(prodCtx, fake(0, 140));
    await expect(refreshFx(prodCtx)).rejects.toMatchObject({ code: 'FX_SUSPICIOUS_MOVE' });
    await refreshFx(prodCtx, { acceptLargeMove: true });
    expect((await currentFx(prodCtx)).rates.INR).toBe(140);
  });
});

describe('finance API', () => {
  it('enforces finance:read / finance:write and returns honest empty states', async () => {
    const analyst = await login('ANALYST');
    const marketing = await login('MARKETING');
    const admin = await login('ADMIN');
    expect((await mk().get('/api/v1/admin/finance/overview')).status).toBe(401);
    expect((await marketing.get('/api/v1/admin/finance/overview')).status).toBe(403);
    expect((await analyst.get('/api/v1/admin/finance/overview')).status).toBe(200);
    expect((await analyst.post('/api/v1/admin/finance/ledger/sync', {})).status).toBe(403);
    expect((await analyst.put('/api/v1/admin/finance/settings', { monthlyOpex: 1 })).status).toBe(403);
    expect((await analyst.get('/api/v1/admin/finance/ledger?page=1&pageSize=5')).body.items.length).toBeGreaterThan(0);
    const csv = await analyst.get('/api/v1/admin/finance/ledger/export');
    expect(csv.body.csv.split('\n')[0]).toContain('idempotency_key');
    const model = await analyst.get('/api/v1/admin/finance/model');
    expect(model.body.measuredApplied).toBe(false); // too few orders: placeholders only
    expect(model.body.results.conservative.reachable).toBe(false);
    const set = await admin.put('/api/v1/admin/finance/settings', { monthlyOpex: 5_000_000, openingCash: 10_000_000 });
    expect(set.status).toBe(200);
    expect(set.body.settings.monthlyOpex).toBe(5_000_000);
    const manual = await admin.post('/api/v1/admin/finance/ledger/entries', { type: 'chargeback', id: 'cb-1', currency: 'USD', amount: 1000, fee: 1500 });
    expect(manual.status).toBe(200);
    expect(manual.body.posted).toBe(true);
    expect((await admin.post('/api/v1/admin/finance/ledger/entries', { type: 'chargeback', id: 'cb-1', currency: 'USD', amount: 1000, fee: 1500 })).body.posted).toBe(false);
    expect((await admin.post('/api/v1/admin/finance/ledger/entries', { type: 'chargeback', id: 'bad id!', currency: 'USD', amount: 1, fee: 0 })).status).toBe(400);
    const cash = await analyst.get('/api/v1/admin/finance/cashflow');
    expect(cash.status).toBe(200);
    expect(cash.body.forecast.openingCash).toBe(10_000_000);
    expect((await analyst.get('/api/v1/admin/finance/fx')).body.provider).toBe('static');
  });
});
