import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LEDGER_ACCOUNTS, JOURNAL_KINDS, currencySchema } from '@orvia/types';
import {
  cashFlowReport, cohortReport, costAlertReport, fxStatus, getFinanceSettings, ledgerBalances, ledgerCsv, ledgerPage, ledgerReconciliation, objectiveModel, overview, parseRange,
  postManual, priceBooks, profitabilityReport, refreshFx, saveScenarioSets, scenarioSetsSchema, setFxOverride, financeSettingsPatchSchema, syncLedger, totalsFromBalances, updateFinanceSettings, DomainError,
} from '@orvia/core';
import type { Ctx } from '@orvia/core';
import { route } from '../http';

const rangeQ = z.object({ preset: z.enum(['today', '7d', '30d', '90d', 'custom']).default('30d'), from: z.string().max(30).optional(), to: z.string().max(30).optional() });
const ledgerQ = z.object({
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
  account: z.enum(LEDGER_ACCOUNTS).optional(), kind: z.enum(JOURNAL_KINDS).optional(), orderId: z.string().max(40).optional(), currency: currencySchema.optional(),
  from: z.string().max(30).optional(), to: z.string().max(30).optional(),
});
const day = (s?: string) => (s && !Number.isNaN(Date.parse(s)) ? new Date(s) : undefined);
const id = z.string().trim().min(1).max(80).regex(/^[\w:.-]+$/);

export function financeRoutes(app: FastifyInstance, ctx: Ctx): void {
  const R = { auth: 'staff' as const, tags: ['Finance'] };
  const read = { ...R, permission: 'finance:read' as const };
  const write = { ...R, permission: 'finance:write' as const };

  route(app, ctx, { ...read, method: 'GET', url: '/admin/finance/overview', summary: 'KPI tiles and P&L with provenance (actual / mixed / estimated / unavailable)', query: rangeQ, handler: ({ query }) => overview(ctx, parseRange(query.preset, query.from, query.to, ctx.now())) });
  route(app, ctx, { ...read, method: 'GET', url: '/admin/finance/profitability', summary: 'Profitability by product, supplier, country or order', query: rangeQ.extend({ by: z.enum(['product', 'supplier', 'country', 'order']).default('product') }), handler: ({ query }) => profitabilityReport(ctx, parseRange(query.preset, query.from, query.to, ctx.now()), query.by) });
  route(app, ctx, { ...read, method: 'GET', url: '/admin/finance/cohorts', summary: 'Monthly cohorts: retention and contribution per customer', query: z.object({ months: z.coerce.number().int().min(1).max(24).default(12) }), handler: ({ query }) => cohortReport(ctx, query.months) });
  route(app, ctx, { ...read, method: 'GET', url: '/admin/finance/cashflow', summary: 'Cash position and forecast from already-paid orders, payables, reserves and ad spend', query: z.object({ horizonDays: z.coerce.number().int().min(7).max(180).default(56) }), handler: ({ query }) => cashFlowReport(ctx, query.horizonDays) });
  route(app, ctx, { ...read, method: 'GET', url: '/admin/finance/cost-alerts', summary: 'Supplier cost vs the cost the price was based on', query: z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }), handler: ({ query }) => costAlertReport(ctx, query.days) });
  route(app, ctx, { ...read, method: 'GET', url: '/admin/finance/price-books', summary: 'Country price books (read-only view of market pricing)', query: z.object({ country: z.enum(['US', 'CA', 'IN']).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(20) }), handler: ({ query }) => priceBooks(query.country, query.page, query.pageSize) });
  route(app, ctx, { ...read, method: 'GET', url: '/admin/finance/reconciliation', summary: 'Ledger vs orders / payments / refunds / shipments (read-only)', query: z.object({ sinceDays: z.coerce.number().int().min(1).max(90).default(30) }), handler: ({ query }) => ledgerReconciliation(ctx, { sinceDays: query.sinceDays }) });

  // ---- ledger
  route(app, ctx, { ...read, method: 'GET', url: '/admin/finance/ledger', summary: 'Ledger journal entries (paginated, filterable)', query: ledgerQ, handler: ({ query }) => ledgerPage({ account: query.account, kind: query.kind, orderId: query.orderId, currency: query.currency, from: day(query.from), to: day(query.to) }, query.page, query.pageSize) });
  route(app, ctx, { ...read, method: 'GET', url: '/admin/finance/ledger/balances', summary: 'Account balances per currency and derived totals', query: z.object({ from: z.string().max(30).optional(), to: z.string().max(30).optional() }), handler: async ({ query }) => {
    const balances = await ledgerBalances({ from: day(query.from), to: day(query.to) });
    return { balances, totals: Object.fromEntries(Object.entries(balances).map(([c, b]) => [c, totalsFromBalances(b)])) };
  } });
  route(app, ctx, { ...read, method: 'GET', url: '/admin/finance/ledger/export', summary: 'Ledger lines as CSV', query: ledgerQ.omit({ page: true, pageSize: true }), handler: async ({ query }) => ({ filename: `orvia-ledger-${ctx.now().toISOString().slice(0, 10)}.csv`, csv: await ledgerCsv({ account: query.account, kind: query.kind, orderId: query.orderId, currency: query.currency, from: day(query.from), to: day(query.to) }) }) });
  route(app, ctx, { ...write, method: 'POST', url: '/admin/finance/ledger/sync', summary: 'Post new paid orders, supplier costs, refunds and ad spend to the ledger now (idempotent)', handler: async ({ req }) => {
    const r = await syncLedger(ctx);
    void req;
    return r;
  } });
  route(app, ctx, { ...write, method: 'POST', url: '/admin/finance/ledger/backfill', summary: 'Rebuild ledger entries from existing paid orders (idempotent; queued)', handler: async () => ({ queued: await ctx.queue.enqueue('ledger_backfill', {}, { dedupeKey: 'ledger_backfill' }) }) });
  route(app, ctx, {
    ...write, method: 'POST', url: '/admin/finance/ledger/entries', summary: 'Record a money event with no source collection yet: chargeback, PSP payout, supplier payment or ad spend (idempotent on id)',
    body: z.discriminatedUnion('type', [
      z.object({ type: z.literal('chargeback'), id, orderId: z.string().max(40).optional(), currency: currencySchema, amount: z.number().int().positive(), fee: z.number().int().min(0).default(0), postedAt: z.string().max(30).optional() }),
      z.object({ type: z.literal('psp_settlement'), id, currency: currencySchema, amount: z.number().int().positive(), postedAt: z.string().max(30).optional() }),
      z.object({ type: z.literal('supplier_settlement'), id, supplierId: z.string().regex(/^[a-f0-9]{24}$/), currency: currencySchema, amount: z.number().int().positive(), postedAt: z.string().max(30).optional() }),
      z.object({ type: z.literal('ad_spend'), id, currency: currencySchema, amount: z.number().int().positive(), platform: z.string().max(30).optional(), postedAt: z.string().max(30).optional() }),
    ]),
    handler: ({ req, body }) => postManual(ctx, { ...body, postedAt: day(body.postedAt) } as never, req.actor),
  });

  // ---- FX
  route(app, ctx, { ...read, method: 'GET', url: '/admin/finance/fx', summary: 'Stored FX rates, freshness and policy', handler: () => fxStatus(ctx) });
  route(app, ctx, { ...write, method: 'POST', url: '/admin/finance/fx/refresh', summary: 'Fetch rates from the configured provider now', body: z.object({ acceptLargeMove: z.boolean().default(false) }), handler: async ({ req, body }) => { await refreshFx(ctx, { actor: req.actor, acceptLargeMove: body.acceptLargeMove }); return fxStatus(ctx); } });
  route(app, ctx, { ...write, method: 'POST', url: '/admin/finance/fx/override', summary: 'Allow pricing from expired rates for up to 24h in production (audited), or clear it', body: z.object({ hours: z.number().min(1).max(24).nullable(), reason: z.string().trim().min(10).max(300) }), handler: async ({ req, body }) => { await setFxOverride(ctx, body.hours, req.actor, body.reason); return fxStatus(ctx); } });

  // ---- settings and objective model
  route(app, ctx, { ...read, method: 'GET', url: '/admin/finance/settings', summary: 'Finance assumptions (opex, settlement delays, reserves, opening cash)', handler: async () => ({ settings: await getFinanceSettings(ctx) }) });
  route(app, ctx, { ...write, method: 'PUT', url: '/admin/finance/settings', summary: 'Update finance assumptions (audited)', body: financeSettingsPatchSchema.omit({ fxOverrideUntil: true }).strict(), handler: async ({ req, body }) => ({ settings: await updateFinanceSettings(ctx, body, req.actor) }) });
  route(app, ctx, { ...read, method: 'GET', url: '/admin/finance/model', summary: 'Objective model: scenarios, measured overlay, sensitivity', handler: () => objectiveModel(ctx) });
  route(app, ctx, {
    ...write, method: 'PUT', url: '/admin/finance/model', summary: 'Save objective-model assumptions (audited; edited fields become provenance "admin")', body: scenarioSetsSchema.transform((v) => v),
    handler: async ({ req, body }) => {
      for (const n of ['conservative', 'base', 'aggressive'] as const) if (body[n].assumptions.targetAmountInr <= 0) throw new DomainError('Target must be positive', 'INVALID', 422);
      await saveScenarioSets(ctx, body, req.actor);
      return objectiveModel(ctx);
    },
  });
}
