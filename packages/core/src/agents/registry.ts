import { z } from 'zod';
import type { AutomationKey } from '@orvia/types';
import type { Ctx } from '../infra/context';
import { runAgent } from './runner';
import type { AgentOutput, AgentSpec } from './runner';
import { analyzeProductReviews } from '../domain/reviews';
import { generateDailyBrief } from '../domain/brief';
import { optimizeAds, startProductTests, syncAdMetrics } from '../domain/adsService';
import { refreshTrends, runDiscovery } from '../domain/discovery';
import { syncInventory } from '../domain/inventory';
import { retrySupplierOrder, syncTracking } from '../domain/orders';
import { runPricingAgent } from '../domain/pricing';
import { refreshSupplierReliability, insights, financials, parseRange } from '../domain/reporting';
import { recommendPromotions, runAbandonedCarts } from '../domain/marketing';
import { scoreProduct } from '../domain/importer';
import { Product } from '@orvia/database';

const Out = z.object({ confidence: z.number().min(0).max(1), summary: z.string(), data: z.unknown().optional() });
type Out = z.infer<typeof Out> & AgentOutput;
const Empty = z.object({}).passthrough();
const ok = (summary: string, data: unknown, confidence = 0.9): Out => ({ confidence, summary, data });

function spec<I>(s: { name: string; description: string; input?: z.ZodType<I, z.ZodTypeDef, unknown>; tools: string[]; permissions: AutomationKey[]; timeoutMs?: number; retries?: number; run: (ctx: Ctx, i: I) => Promise<Out> }): AgentSpec<I, Out> {
  return { name: s.name, description: s.description, inputSchema: (s.input ?? (Empty as unknown)) as z.ZodType<I, z.ZodTypeDef, unknown>, outputSchema: Out as z.ZodType<Out, z.ZodTypeDef, unknown>, tools: s.tools, permissions: s.permissions, timeoutMs: s.timeoutMs ?? 120_000, retries: s.retries ?? 1, run: s.run };
}

const ProductId = z.object({ productId: z.string().regex(/^[a-f\d]{24}$/i) });

/** Central orchestration: the 19 specialised agents, each with schemas, tools, permissions, timeout and retry policy. */
export const AGENTS = {
  ProductDiscoveryAgent: spec({ name: 'ProductDiscoveryAgent', description: 'Scans supplier catalogues, scores opportunities, imports or proposes strong candidates', tools: ['SupplierProvider.searchProducts', 'compliance.check', 'scoreOpportunity'], permissions: ['product_discovery'], timeoutMs: 600_000, run: async (c) => { const r = await runDiscovery(c); return ok(`Scanned ${r.suppliersScanned} supplier(s): ${r.imported} imported, ${r.proposed} proposed, ${r.watch} watch, ${r.rejected} rejected`, r, 0.7); } }),
  TrendAgent: spec({ name: 'TrendAgent', description: 'Computes trend velocity from behavioural events', tools: ['analytics events'], permissions: [], run: async (c) => { const r = await refreshTrends(c); return ok(`Updated ${r.updated} trend score(s)`, r); } }),
  SupplierAgent: spec({ name: 'SupplierAgent', description: 'Refreshes supplier reliability from real shipment outcomes', tools: ['shipments', 'suppliers'], permissions: ['inventory_sync'], run: async () => { const n = await refreshSupplierReliability(); return ok(`Reliability refreshed for ${n} supplier(s)`, { n }); } }),
  ProductScoringAgent: spec({ name: 'ProductScoringAgent', description: 'Computes the Product Opportunity Score', tools: ['scoreOpportunity', 'AIService.analyzeProduct'], permissions: [], input: ProductId, run: async (c, i) => { const s = await scoreProduct(c, i.productId); return ok(`Score ${s.finalScore} → ${s.action}`, s, 0.75); } }),
  PricingAgent: spec({ name: 'PricingAgent', description: 'Proposes/applies price changes within margin guardrails', tools: ['planMarket', 'computePrice'], permissions: ['dynamic_pricing'], run: async (c) => { const r = await runPricingAgent(c); return ok(`${r.examined} product(s) examined: ${r.changes} applied, ${r.proposals} proposed, ${r.negativeMargin} negative-margin`, r, 0.8); } }),
  ContentAgent: spec({ name: 'ContentAgent', description: 'Generates listing content with grounding guards (see importer)', tools: ['AIService.productContent'], permissions: ['auto_publishing'], run: async () => ok('Content is generated during import with schema + grounding validation', {}, 1) }),
  SEOAgent: spec({ name: 'SEOAgent', description: 'SEO titles/meta/keywords are produced with content and validated for length', tools: ['AIService.productContent'], permissions: [], run: async () => ok('SEO fields are generated during import', {}, 1) }),
  CreativeAgent: spec({ name: 'CreativeAgent', description: 'Generates ad creative concepts', tools: ['AIService.adCreatives'], permissions: ['ad_optimization'], run: async () => ok('Creatives are generated when a test plan is created', {}, 1) }),
  MarketingAgent: spec({ name: 'MarketingAgent', description: 'Starts product ad tests and recommends promotions', tools: ['createTestPlan', 'launchCampaign', 'recommendPromotions'], permissions: ['ad_optimization', 'promotion_optimization'], run: async (c) => { const t = await startProductTests(c); const p = await recommendPromotions(c); return ok(`${t.started} test(s) started/proposed, ${p.recommended} promotion(s) recommended`, { t, p }, 0.7); } }),
  AdOptimizationAgent: spec({ name: 'AdOptimizationAgent', description: 'Evaluates campaigns against configurable budget rules (safe mode)', tools: ['AdProvider.getMetrics', 'evaluateCampaign', 'evaluateTest'], permissions: ['ad_optimization'], run: async (c) => { await syncAdMetrics(c); const r = await optimizeAds(c); return ok(`Evaluated ${r.evaluated} campaign(s)`, r, 0.8); } }),
  OrderAgent: spec({ name: 'OrderAgent', description: 'Validates paid orders and requests fulfilment according to automation mode', tools: ['requestFulfillment'], permissions: ['order_fulfillment'], run: async () => ok('Order validation runs on payment confirmation', {}, 1) }),
  FulfillmentAgent: spec({ name: 'FulfillmentAgent', description: 'Selects the best supplier and places idempotent supplier orders', tools: ['selectSupplierLive', 'SupplierProvider.createOrder'], permissions: ['order_fulfillment'], input: z.object({ orderId: z.string() }), timeoutMs: 180_000, retries: 0, run: async (c, i) => { await retrySupplierOrder(c, i.orderId, { id: 'FulfillmentAgent', type: 'ai' }); return ok('Fulfilment queued', i); } }),
  CustomerSupportAgent: spec({ name: 'CustomerSupportAgent', description: 'Answers from orders, shipments, policies and products; escalates when unsure', tools: ['orders', 'shipments', 'products'], permissions: ['customer_support'], run: async () => ok('Support assistant runs per message (see /api/v1/support/chat)', {}, 1) }),
  AnalyticsAgent: spec({ name: 'AnalyticsAgent', description: 'Computes insights from aggregates', tools: ['reporting'], permissions: [], run: async (c) => { const i = await insights(c); return ok(`${i.length} insight(s)`, i, 0.9); } }),
  ProfitAgent: spec({ name: 'ProfitAgent', description: 'Computes revenue vs gross/contribution/net profit', tools: ['financials'], permissions: [], run: async (c) => { const f = await financials(c, parseRange('7d')); return ok(`7-day contribution profit ${(f.contributionProfit / 100).toFixed(2)} USD`, f, 0.9); } }),
  FraudAgent: spec({ name: 'FraudAgent', description: 'Risk scoring at checkout (velocity, geo, value, address, email)', tools: ['assessFraud'], permissions: ['order_fulfillment'], run: async () => ok('Fraud scoring runs at checkout', {}, 1) }),
  ComplianceAgent: spec({ name: 'ComplianceAgent', description: 'Rule-based product safety/compliance gate (AI can add flags, never clear them)', tools: ['checkCompliance'], permissions: ['auto_publishing'], run: async () => ok('Compliance runs on import and before publishing', {}, 1) }),
  InventoryAgent: spec({ name: 'InventoryAgent', description: 'Syncs supplier stock/price, switches supplier, pauses or restores products', tools: ['syncProductOffers', 'refreshProductMarkets'], permissions: ['inventory_sync'], timeoutMs: 300_000, run: async (c) => { const r = await syncInventory(c, 60); return ok(`${r.products} product(s) synced, ${r.paused} paused, ${r.restored} restored`, r, 0.9); } }),
  BusinessIntelligenceAgent: spec({ name: 'BusinessIntelligenceAgent', description: 'Daily brief, review analysis and Copilot answers grounded in the database', tools: ['reporting', 'copilot'], permissions: ['ai_reports'], timeoutMs: 180_000, run: async (c) => { const b = await generateDailyBrief(c); const prods = await Product.find({ state: { $in: ['PUBLISHED', 'TESTING', 'WINNER', 'SCALING'] } }).select('_id').limit(30).lean(); let alerts = 0; for (const p of prods) { const r = await analyzeProductReviews(c, String(p._id)); if (r.alert) alerts++; } return ok(`Daily brief ${b.date} generated; ${alerts} review-sentiment alert(s)`, { brief: b.date, alerts }, 0.85); } }),
  TrackingAgent: spec({ name: 'TrackingAgent', description: 'Synchronises shipment tracking from supplier APIs', tools: ['SupplierProvider.getTracking'], permissions: ['tracking'], run: async (c) => { const r = await syncTracking(c); return ok(`${r.checked} shipment(s) checked, ${r.updated} updated, ${r.failures} failure(s)`, r, 0.95); } }),
  AbandonedCartAgent: spec({ name: 'AbandonedCartAgent', description: 'Runs the consent-based abandoned cart sequence', tools: ['notify'], permissions: ['abandoned_cart'], run: async (c) => { const r = await runAbandonedCarts(c); return ok(`${r.sent} message(s) sent, ${r.stopped} sequence(s) stopped`, r); } }),
} as const;

export type AgentName = keyof typeof AGENTS;

export async function runNamedAgent(ctx: Ctx, name: AgentName, input: unknown = {}) {
  const spec = AGENTS[name] as unknown as AgentSpec<unknown, Out>;
  return runAgent(ctx, spec, input);
}

export const agentCatalog = () => Object.values(AGENTS).map((a) => ({ name: a.name, description: a.description, tools: a.tools, permissions: a.permissions, timeoutMs: a.timeoutMs, retries: a.retries }));
