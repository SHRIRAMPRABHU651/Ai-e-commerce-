/**
 * Staff-facing tools: READ-ONLY calls into the existing domain services (trust, suppliernet, finance, economics, events attribution,
 * rescue, after-sales analytics, the Business Copilot). Each requires the underlying read permission of the staff member who runs
 * the agent. None of them mutates anything; the Copilot is always called with confirm=false so its action plans are never applied.
 */
import { z } from 'zod';
import { Supplier } from '@orvia/database';
import { DomainError } from '../../infra/context';
import { askCopilot } from '../copilot';
import { decisionSheet } from '../economics';
import { attributionReport, campaignProductPerformance } from '../events';
import { costAlertReport, ledgerReconciliation, overview } from '../finance';
import { listReturnsAdmin, returnAnalytics } from '../aftersales';
import { caseDetail, listCases, rescueKpis } from '../rescue';
import { productPerformance } from '../reporting';
import { fairDealForProduct, listProductRisk, listSupplierTrust } from '../trust';
import { getSupplierSlaFacts } from '../suppliernet';
import type { AgentIO } from './tools.customer';
import type { AnyTool } from './framework';

const strict = <T extends z.ZodRawShape>(s: T) => z.strictObject(s);
const STAFF: ('staff' | 'system')[] = ['staff'];
const objectId = z.string().regex(/^[a-f\d]{24}$/i);
const limitIn = z.number().int().min(1).max(25).default(10);
const days = z.number().int().min(1).max(180).default(30);
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

const trustSuppliers: AnyTool<AgentIO> = {
  name: 'trust_suppliers', description: 'TrustGraph supplier reliability scores with status, confidence and sample size (insufficient data is reported as such).', sideEffect: 'read', audience: STAFF, permission: 'trust:read',
  input: strict({ limit: limitIn }),
  output: z.object({ total: z.number(), items: z.array(z.object({ name: z.string(), active: z.boolean(), status: z.string(), score: z.number().nullable(), confidence: z.number().nullable(), sampleSize: z.number() })).max(25) }),
  limits: { maxCallsPerRun: 1, maxOutputBytes: 8_000 },
  async run({ ctx }, i) {
    const r = await listSupplierTrust(ctx, { page: 1, pageSize: i.limit });
    return { total: r.total, items: r.items.map((s) => ({ name: s.name, active: !!s.active, status: String(s.status), score: num(s.trust?.score), confidence: num(s.trust?.confidence), sampleSize: num(s.trust?.sampleSize) ?? 0 })) };
  },
};

const trustProductRisk: AnyTool<AgentIO> = {
  name: 'trust_product_risk', description: 'TrustGraph product risk snapshots (highest risk first) with status and sample size.', sideEffect: 'read', audience: STAFF, permission: 'trust:read',
  input: strict({ limit: limitIn }),
  output: z.object({ total: z.number(), items: z.array(z.object({ title: z.string(), level: z.string(), status: z.string(), score: z.number().nullable(), confidence: z.number().nullable(), sampleSize: z.number() })).max(25) }),
  limits: { maxCallsPerRun: 1, maxOutputBytes: 8_000 },
  async run({ ctx }, i) {
    const r = await listProductRisk(ctx, { page: 1, pageSize: i.limit });
    return { total: r.total, items: r.items.map((p) => ({ title: p.title, level: String(p.level), status: String(p.status), score: num(p.score), confidence: num(p.confidence), sampleSize: num(p.sampleSize) ?? 0 })) };
  },
};

const trustFairDeal: AnyTool<AgentIO> = {
  name: 'trust_fair_deal', description: 'Fair Deal ranking of the supplier offers for one product (staff view; includes supplier names and landed cost).', sideEffect: 'read', audience: STAFF, permission: 'trust:read',
  input: strict({ productId: objectId, country: z.enum(['US', 'CA', 'IN']).default('US') }),
  output: z.object({ note: z.string(), ranked: z.array(z.object({ rank: z.number(), supplier: z.string(), fairValueScore: z.number(), totalDeliveredPrice: z.number(), currency: z.string(), isCheapest: z.boolean(), summary: z.string() })).max(10), excluded: z.number() }),
  limits: { maxCallsPerRun: 2, maxOutputBytes: 6_000 },
  async run({ ctx }, i) {
    const r = await fairDealForProduct(ctx, i.productId, i.country, 1, { priceMode: 'landed_cost' });
    return { note: r.note, ranked: r.ranked.slice(0, 10).map((x) => ({ rank: x.rank, supplier: x.supplierDisplayName, fairValueScore: x.fairValueScore, totalDeliveredPrice: x.totalDeliveredPrice, currency: x.currency, isCheapest: x.isCheapest, summary: x.summary })), excluded: r.excluded.length };
  },
};

const supplierSla: AnyTool<AgentIO> = {
  name: 'supplier_sla', description: 'Latest stored supplier SLA facts (fulfilment, on-time, cancellation, stock accuracy, refund and defect rates) for active suppliers.', sideEffect: 'read', audience: STAFF, permission: 'suppliers:read',
  input: strict({ limit: z.number().int().min(1).max(15).default(8) }),
  output: z.object({ items: z.array(z.object({ supplier: z.string(), computedAt: z.string().nullable(), windowDays: z.number(), fulfilmentRate: z.number().nullable(), onTimeRate: z.number().nullable(), cancellationRate: z.number().nullable(), stockAccuracy: z.number().nullable(), refundRate: z.number().nullable(), defectRate: z.number().nullable(), delivered: z.number() })).max(15) }),
  limits: { maxCallsPerRun: 1, maxOutputBytes: 8_000 },
  async run(_io, i) {
    const sups = await Supplier.find({ active: true }).sort({ name: 1 }).limit(i.limit).select('name').lean();
    const items = [];
    for (const s of sups) {
      const f = await getSupplierSlaFacts(String(s._id));
      items.push({ supplier: s.name, computedAt: f.computedAt, windowDays: f.windowDays, fulfilmentRate: f.fulfilmentRate, onTimeRate: f.onTimeRate, cancellationRate: f.cancellationRate, stockAccuracy: f.stockAccuracy, refundRate: f.refundRate, defectRate: f.defectRate, delivered: f.samples.delivered });
    }
    return { items };
  },
};

const financeOverview: AnyTool<AgentIO> = {
  name: 'finance_overview', description: 'Finance KPIs for a period (GMV, net sales, contribution, refund rate, CAC...) with provenance of each figure.', sideEffect: 'read', audience: STAFF, permission: 'finance:read',
  input: strict({ days }),
  output: z.object({ currency: z.string(), days: z.number(), orders: z.number(), truncated: z.boolean(), kpis: z.array(z.object({ key: z.string(), value: z.number().nullable(), provenance: z.string() })).max(40), caveats: z.array(z.string()).max(8) }),
  limits: { maxCallsPerRun: 2, maxOutputBytes: 8_000 },
  async run({ ctx }, i) {
    const to = ctx.now();
    const r = await overview(ctx, { from: new Date(to.getTime() - i.days * 86_400_000), to });
    const k = r.kpis as unknown as Record<string, unknown>;
    const kpis = Object.entries(k).filter(([, v]) => v && typeof v === 'object' && 'provenance' in (v as object)).map(([key, v]) => ({ key, value: num((v as { value: unknown }).value), provenance: String((v as { provenance: unknown }).provenance) }));
    return { currency: r.currency, days: i.days, orders: r.kpis.orders, truncated: !!r.truncated, kpis, caveats: r.kpis.caveats.slice(0, 8) };
  },
};

const financeCostAlerts: AnyTool<AgentIO> = {
  name: 'finance_cost_alerts', description: 'Supplier cost changes above the cost a selling price was based on.', sideEffect: 'read', audience: STAFF, permission: 'finance:read',
  input: strict({ days }),
  output: z.object({ checked: z.number(), thresholdPct: z.number(), alerts: z.array(z.object({ label: z.string(), changePct: z.number(), extraCost: z.number(), severity: z.string() })).max(20) }),
  limits: { maxCallsPerRun: 1, maxOutputBytes: 6_000 },
  async run({ ctx }, i) {
    const r = await costAlertReport(ctx, i.days);
    return { checked: r.checked, thresholdPct: r.thresholdPct, alerts: r.alerts.slice(0, 20).map((a) => ({ label: a.label, changePct: a.changePct, extraCost: a.extraCost, severity: a.severity })) };
  },
};

const financeReconciliation: AnyTool<AgentIO> = {
  name: 'finance_reconciliation', description: 'Ledger-vs-orders/payments/refunds reconciliation findings (read only).', sideEffect: 'read', audience: STAFF, permission: 'finance:read',
  input: strict({ days: z.number().int().min(1).max(90).default(14) }),
  output: z.object({ total: z.number(), findings: z.array(z.object({ kind: z.string(), detail: z.string(), severity: z.string() })).max(20) }),
  limits: { maxCallsPerRun: 1, maxOutputBytes: 6_000 },
  async run({ ctx }, i) {
    const r = await ledgerReconciliation(ctx, { sinceDays: i.days, limit: 200 });
    return { total: r.findings.length, findings: r.findings.slice(0, 20).map((f) => ({ kind: f.kind, detail: f.detail, severity: f.severity })) };
  },
};

const economicsSheet: AnyTool<AgentIO> = {
  name: 'economics_sheet', description: 'Unit economics decision sheet per product x market (contribution at three CAC scenarios, verdict, basis of each figure).', sideEffect: 'read', audience: STAFF, permission: 'products:read',
  input: strict({ limit: z.number().int().min(1).max(40).default(20) }),
  output: z.object({ rows: z.array(z.object({ title: z.string(), country: z.string(), currency: z.string(), verdict: z.string(), sellingPrice: z.number(), expectedContribution: z.number(), expectedMarginPct: z.number(), cpaSource: z.string(), cpaSampleSize: z.number(), needsHumanApproval: z.boolean() })).max(40) }),
  limits: { maxCallsPerRun: 1, maxOutputBytes: 10_000 },
  async run({ ctx }, i) {
    const rows = await decisionSheet(ctx, { limit: i.limit });
    return { rows: rows.slice(0, i.limit).map((r) => ({ title: r.title, country: r.country, currency: r.currency, verdict: r.verdict, sellingPrice: r.sellingPrice.value, expectedContribution: r.contribution.expected.value, expectedMarginPct: r.marginPct.expected.value, cpaSource: String(r.cpaSource), cpaSampleSize: r.cpaSampleSize, needsHumanApproval: r.needsHumanApproval })) };
  },
};

const eventsAttribution: AnyTool<AgentIO> = {
  name: 'events_attribution', description: 'Channel attribution of paid orders (consent-based; unattributed share shown) with measured CPA.', sideEffect: 'read', audience: STAFF, permission: 'marketing:read',
  input: strict({ days, model: z.enum(['last', 'first']).default('last') }),
  output: z.object({ totalOrders: z.number(), attributionCoverage: z.number().nullable(), channels: z.array(z.object({ channel: z.string(), orders: z.number() })).max(20), caveats: z.array(z.string()).max(6) }),
  limits: { maxCallsPerRun: 1, maxOutputBytes: 6_000 },
  async run({ ctx }, i) {
    const r = await attributionReport(ctx, i.days, i.model);
    return { totalOrders: r.totalOrders, attributionCoverage: r.attributionCoverage, channels: r.channels.slice(0, 20).map((c) => ({ channel: String((c as { channel: unknown }).channel), orders: Number((c as { orders: unknown }).orders) || 0 })), caveats: r.caveats.slice(0, 6) };
  },
};

const eventsProducts: AnyTool<AgentIO> = {
  name: 'events_product_performance', description: 'Product funnel: views to carts to orders to net sales.', sideEffect: 'read', audience: STAFF, permission: 'marketing:read',
  input: strict({ days, limit: limitIn }),
  output: z.object({ items: z.array(z.object({ title: z.string(), views: z.number(), carts: z.number(), orders: z.number(), netSalesUsd: z.number(), viewToCart: z.number().nullable(), cartToOrder: z.number().nullable() })).max(25) }),
  limits: { maxCallsPerRun: 1, maxOutputBytes: 8_000 },
  async run({ ctx }, i) {
    const r = await campaignProductPerformance(ctx, i.days, i.limit);
    return { items: r.items.slice(0, i.limit).map((p) => ({ title: p.title, views: p.views, carts: p.carts, orders: p.orders, netSalesUsd: Math.round(p.netSalesUsd), viewToCart: p.viewToCart, cartToOrder: p.cartToOrder })) };
  },
};

const productPerf: AnyTool<AgentIO> = {
  name: 'product_performance', description: 'Product revenue, ad spend and contribution over a period (winners and losers).', sideEffect: 'read', audience: STAFF, permission: 'analytics:read',
  input: strict({ days, limit: limitIn }),
  output: z.object({ winners: z.array(z.object({ title: z.string(), units: z.number(), revenue: z.number(), adSpend: z.number(), profit: z.number() })).max(25), losers: z.array(z.object({ title: z.string(), units: z.number(), revenue: z.number(), adSpend: z.number(), profit: z.number() })).max(25) }),
  limits: { maxCallsPerRun: 1, maxOutputBytes: 8_000 },
  async run({ ctx }, i) {
    const to = ctx.now();
    const r = await productPerformance(ctx, { from: new Date(to.getTime() - i.days * 86_400_000), to }, i.limit);
    const p = (x: { title: string; units: number; revenue: number; adSpend: number; profit: number }) => ({ title: x.title, units: x.units, revenue: x.revenue, adSpend: x.adSpend, profit: x.profit });
    return { winners: r.winners.slice(0, i.limit).map(p), losers: r.losers.slice(0, i.limit).map(p) };
  },
};

const rescueSummary: AnyTool<AgentIO> = {
  name: 'rescue_summary', description: 'Delivery Rescue KPIs and the currently open cases (engine decisions; read only).', sideEffect: 'read', audience: STAFF, permission: 'rescue:read',
  input: strict({ days, limit: z.number().int().min(1).max(15).default(8) }),
  output: z.object({
    kpis: z.object({ detected: z.number(), active: z.number(), awaitingCustomer: z.number(), awaitingStaff: z.number(), resolved: z.number(), autoResolvedPct: z.number().nullable(), avgTimeToResolutionHours: z.number().nullable(), consentAcceptRate: z.number().nullable(), consentSample: z.number() }),
    byKind: z.record(z.string(), z.number()),
    open: z.array(z.object({ caseId: z.string(), orderNumber: z.string(), kind: z.string(), severity: z.string(), state: z.string(), daysOverdue: z.number() })).max(15),
  }),
  limits: { maxCallsPerRun: 1, maxOutputBytes: 6_000 },
  async run({ ctx }, i) {
    const [k, c] = await Promise.all([rescueKpis(ctx, i.days), listCases({ page: 1, pageSize: i.limit, active: 'true' })]);
    return {
      kpis: { detected: k.detected, active: k.active, awaitingCustomer: k.awaitingCustomer, awaitingStaff: k.awaitingStaff, resolved: k.resolved, autoResolvedPct: k.autoResolvedPct, avgTimeToResolutionHours: k.avgTimeToResolutionHours, consentAcceptRate: k.consentAcceptRate, consentSample: k.consentSample },
      byKind: k.byKind,
      open: c.items.map((x) => ({ caseId: String(x._id), orderNumber: x.orderNumber, kind: x.kind, severity: x.severity, state: x.state, daysOverdue: x.daysOverdue ?? 0 })),
    };
  },
};

const rescueCaseExplain: AnyTool<AgentIO> = {
  name: 'rescue_case', description: 'One Delivery Rescue case with the options the deterministic engine considered and which it recommended (to be explained, not decided, by the agent).', sideEffect: 'read', audience: STAFF, permission: 'rescue:read',
  input: strict({ caseId: objectId }),
  output: z.object({
    caseId: z.string(), orderNumber: z.string(), kind: z.string(), severity: z.string(), state: z.string(), daysOverdue: z.number(), recommendedId: z.string().nullable(), recommendationReason: z.string().nullable(),
    evidence: z.array(z.object({ code: z.string(), detail: z.string() })).max(10),
    options: z.array(z.object({ id: z.string(), kind: z.string(), label: z.string(), feasible: z.boolean(), infeasibleReason: z.string().nullable(), staffText: z.string(), refund: z.number(), extraCost: z.number(), requiresCustomerConsent: z.boolean() })).max(10),
  }),
  limits: { maxCallsPerRun: 2, maxOutputBytes: 10_000 },
  async run(_io, i) {
    const { case: c } = await caseDetail(i.caseId);
    const opts = (c.options ?? []) as unknown as { id: string; kind: string; label: string; feasible: boolean; infeasibleReason?: string; staffText: string; impact: { refund: number; extraCost: number }; requiresCustomerConsent: boolean }[];
    return {
      caseId: String(c._id), orderNumber: c.orderNumber, kind: c.kind, severity: c.severity, state: c.state, daysOverdue: c.daysOverdue ?? 0, recommendedId: c.recommendedId ?? null, recommendationReason: c.recommendationReason ?? null,
      evidence: (c.evidence ?? []).slice(0, 10).map((e) => ({ code: String(e.code ?? ''), detail: String(e.detail ?? '') })),
      options: opts.slice(0, 10).map((o) => ({ id: o.id, kind: o.kind, label: o.label, feasible: o.feasible, infeasibleReason: o.infeasibleReason ?? null, staffText: o.staffText, refund: o.impact?.refund ?? 0, extraCost: o.impact?.extraCost ?? 0, requiresCustomerConsent: o.requiresCustomerConsent })),
    };
  },
};

const aftersalesAnalytics: AnyTool<AgentIO> = {
  name: 'aftersales_analytics', description: 'Return analytics: reasons, resolutions, rates by country/product/supplier (rates only where the sample is large enough).', sideEffect: 'read', audience: STAFF, permission: 'returns:read',
  input: strict({ days: z.number().int().min(7).max(365).default(90) }),
  output: z.object({ totalReturns: z.number(), windowDays: z.number(), minSampleForRates: z.number(), byReason: z.array(z.object({ reason: z.string(), count: z.number() })).max(12), byProduct: z.array(z.object({ name: z.string(), returnedUnits: z.number(), soldUnits: z.number(), rate: z.number().nullable() })).max(10), bySupplier: z.array(z.object({ name: z.string(), returnedUnits: z.number(), soldUnits: z.number(), rate: z.number().nullable() })).max(10), note: z.string() }),
  limits: { maxCallsPerRun: 1, maxOutputBytes: 8_000 },
  async run({ ctx }, i) {
    const r = await returnAnalytics(ctx, i.days);
    const rate = (x: unknown): number | null => (typeof x === 'number' ? x : null);
    return {
      totalReturns: r.totalReturns, windowDays: r.windowDays, minSampleForRates: r.minSampleForRates, byReason: r.byReason.slice(0, 12),
      byProduct: r.byProduct.slice(0, 10).map((p) => ({ name: p.name, returnedUnits: p.returnedUnits, soldUnits: p.soldUnits, rate: rate(p.rate) })),
      bySupplier: r.bySupplier.slice(0, 10).map((p) => ({ name: p.name, returnedUnits: p.returnedUnits, soldUnits: p.soldUnits, rate: rate(p.rate) })), note: r.note,
    };
  },
};

const returnsQueue: AnyTool<AgentIO> = {
  name: 'returns_queue', description: 'Latest return requests in a workflow state (read only).', sideEffect: 'read', audience: STAFF, permission: 'returns:read',
  input: strict({ state: z.enum(['submitted', 'authorized', 'in_transit', 'received', 'inspected', 'refund_pending', 'resolved', 'rejected', 'cancelled']).optional(), limit: limitIn }),
  output: z.object({ total: z.number(), items: z.array(z.object({ rmaNumber: z.string(), orderNumber: z.string(), state: z.string(), reasonCode: z.string(), resolution: z.string().nullable(), needsStaffReview: z.boolean() })).max(25) }),
  limits: { maxCallsPerRun: 1, maxOutputBytes: 6_000 },
  async run(_io, i) {
    const r = await listReturnsAdmin({ page: 1, pageSize: i.limit, state: i.state });
    return { total: r.total, items: r.items.map((x) => ({ rmaNumber: x.rmaNumber, orderNumber: x.orderNumber, state: x.state, reasonCode: x.reasonCode, resolution: x.resolution ?? null, needsStaffReview: !!x.needsStaffReview })) };
  },
};

const copilotQuery: AnyTool<AgentIO> = {
  name: 'copilot_query', description: 'Ask the existing Business Copilot a question. It answers from database queries; action plans are discarded and never confirmed.', sideEffect: 'read', audience: STAFF, permission: 'copilot:use',
  input: strict({ question: z.string().trim().min(3).max(300) }),
  output: z.object({ intent: z.string(), answer: z.string(), sources: z.array(z.string()).max(8), tables: z.array(z.object({ title: z.string(), columns: z.array(z.string()), rows: z.array(z.array(z.union([z.string(), z.number()]))).max(15) })).max(2) }),
  limits: { maxCallsPerRun: 3, maxOutputBytes: 10_000 },
  async run({ ctx }, i, auth) {
    if (!auth.userId) throw new DomainError('Copilot needs a staff user', 'FORBIDDEN', 403);
    const r = await askCopilot(ctx, { question: i.question, confirm: false, actor: { id: auth.userId, type: 'user' } });
    return { intent: r.intent, answer: r.answer, sources: r.sources.slice(0, 8), tables: (r.tables ?? []).slice(0, 2).map((t) => ({ title: t.title, columns: t.columns, rows: t.rows.slice(0, 15) })) };
  },
};

export const STAFF_TOOLS: AnyTool<AgentIO>[] = [trustSuppliers, trustProductRisk, trustFairDeal, supplierSla, financeOverview, financeCostAlerts, financeReconciliation, economicsSheet, eventsAttribution, eventsProducts, productPerf, rescueSummary, rescueCaseExplain, aftersalesAnalytics, returnsQueue, copilotQuery];
