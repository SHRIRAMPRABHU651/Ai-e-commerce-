import { AdMetric, AiDecision, Campaign, ExceptionModel, Inventory, Order, Product } from '@orvia/database';
import { DEFAULT_COUNTRIES } from '@orvia/types';
import type { Ctx } from '../infra/context';
import type { Actor } from '../infra/context';
import { proposeOrExecute } from './automation';
import { adsOverview } from './adsService';
import { countryAnalytics, financials, insights, parseRange, productPerformance, supplierHealth, timeseries } from './reporting';
import type { Range } from './reporting';
import { audit } from '../infra/audit';

export interface CopilotAnswer {
  intent: string;
  answer: string;
  tables?: { title: string; columns: string[]; rows: (string | number)[][] }[];
  plan?: { kind: string; description: string; payload: Record<string, unknown> }[];
  requiresConfirmation?: boolean;
  executed?: { description: string; status: string }[];
  sources: string[];
  note?: string;
}

const usd = (minor: number) => `$${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

const INTENTS: [string, RegExp][] = [
  ['pause_losers', /\b(pause|stop|kill)\b.*\b(losing|unprofitable|negative|loss)/i],
  ['profit_change', /\bwhy\b.*\b(profit|revenue)\b.*\b(fall|fell|drop|dropped|down|decline|increase|rose|up)\b|\b(profit|revenue)\b.*\b(yesterday|vs|compared)\b/i],
  ['scale', /\b(scale|best products|winners|top products|what should i scale)\b/i],
  ['losers', /\b(losing money|worst|unprofitable|loss)\b/i],
  ['country', /\b(country|countries|usa|canada|india|market|expand)\b/i],
  ['suppliers', /\b(supplier|suppliers)\b/i],
  ['exceptions', /\b(exception|problem|issues|attention|fraud)\b/i],
  ['inventory', /\b(stock|inventory)\b/i],
  ['ads', /\b(ad|ads|campaign|roas|cpa|spend)\b/i],
  ['summary', /\b(today|summary|brief|overview|how (are|is) (we|business|it) doing|revenue|profit|orders)\b/i],
];

const dayRange = (offset: number, now: Date): Range => {
  const s = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - offset * 86_400_000;
  return { from: new Date(s), to: new Date(s + 86_399_999) };
};

/**
 * Business Copilot. Every number comes from a database query executed here; the optional LLM may only
 * route the question (intent), never produce figures. Actions are shown as a plan first and are only
 * applied with confirm=true — and then still pass through the automation-mode gate.
 */
export async function askCopilot(ctx: Ctx, a: { question: string; confirm?: boolean; actor: Actor }): Promise<CopilotAnswer> {
  let intent = INTENTS.find(([, re]) => re.test(a.question))?.[0];
  if (!intent && ctx.ai.llmConfigured) {
    const c = await ctx.ai.classify(a.question, ['pause_losers', 'profit_change', 'scale', 'losers', 'country', 'suppliers', 'exceptions', 'inventory', 'ads', 'summary', 'unknown']);
    if (c.confidence >= 0.6 && c.label !== 'unknown') intent = c.label;
  }
  await audit(ctx, a.actor, { action: 'copilot.ask', resource: 'copilot', reason: a.question.slice(0, 200) });
  const now = ctx.now();
  switch (intent) {
    case 'profit_change': {
      const [y, p] = [dayRange(1, now), dayRange(2, now)];
      const [fy, fp] = [await financials(ctx, y), await financials(ctx, p)];
      const ads = async (r: Range) => (await adsOverview(ctx, r.from, r.to));
      const [ay, ap] = [await ads(y), await ads(p)];
      const perfY = await productPerformance(ctx, y, 50);
      const perfP = await productPerformance(ctx, p, 50);
      const pm = new Map(perfP.all.map((x) => [x.productId, x]));
      const deltas = perfY.all.map((x) => ({ title: x.title, delta: x.profit - (pm.get(x.productId)?.profit ?? 0), adNow: x.adSpend, adBefore: pm.get(x.productId)?.adSpend ?? 0 })).sort((l, r) => l.delta - r.delta);
      const netNow = fy.contributionProfit;
      const netPrev = fp.contributionProfit;
      const dir = netNow < netPrev ? 'fell' : 'rose';
      const worst = deltas[0];
      const countryAd = (list: typeof ay) => Object.entries(list.reduce<Record<string, number>>((m, r) => ((m[r.country] = (m[r.country] ?? 0) + r.spend), m), {}));
      const cy = new Map(countryAd(ay));
      const cp = new Map(countryAd(ap));
      const adLines = [...cy.entries()].map(([c, s]) => `${c} ad spend ${usd(s)} vs ${usd(cp.get(c) ?? 0)}`);
      const total = Math.abs(netNow - netPrev);
      const share = worst && total > 0 ? Math.round((Math.abs(worst.delta) / total) * 100) : 0;
      return {
        intent, sources: ['orders', 'ad_metrics'],
        answer: `Contribution profit ${dir} from ${usd(netPrev)} to ${usd(netNow)} yesterday. Revenue was ${usd(fy.netRevenue)} vs ${usd(fp.netRevenue)} the day before; ad spend ${usd(fy.adSpend)} vs ${usd(fp.adSpend)}.${adLines.length ? ` By country: ${adLines.join('; ')}.` : ''}${worst && worst.delta < 0 ? ` The biggest drag was "${worst.title}" (${usd(worst.delta)} change, about ${share}% of the movement).` : ''}${fy.pendingCostOrders ? ` Note: ${fy.pendingCostOrders} paid order(s) are not yet fulfilled, so their costs are not counted.` : ''}`,
        tables: [{ title: 'Yesterday vs day before (USD)', columns: ['Metric', 'Yesterday', 'Day before'], rows: [['Net revenue', usd(fy.netRevenue), usd(fp.netRevenue)], ['Gross profit', usd(fy.grossProfit), usd(fp.grossProfit)], ['Contribution profit', usd(fy.contributionProfit), usd(fp.contributionProfit)], ['Ad spend', usd(fy.adSpend), usd(fp.adSpend)], ['Orders', fy.orders, fp.orders]] }],
      };
    }
    case 'scale': {
      const range = parseRange('30d', undefined, undefined, now);
      const perf = await productPerformance(ctx, range, 8);
      const camps = await Campaign.find({ status: 'active', 'recommendation.action': 'SCALE' }).select('name recommendation').limit(8).lean();
      return { intent, sources: ['orders', 'ad_metrics', 'campaigns'], answer: perf.winners.length ? `${perf.winners.length} product(s) are profitable over the last 30 days. Top: ${perf.winners.slice(0, 3).map((w) => `${w.title} (${usd(w.profit)})`).join(', ')}.${camps.length ? ` ${camps.length} campaign(s) currently have a SCALE recommendation.` : ''}` : 'No product has positive contribution profit in the last 30 days yet, so I would not scale anything.', tables: [{ title: 'Best products (30 days, USD)', columns: ['Product', 'Units', 'Revenue', 'Ad spend', 'Contribution'], rows: perf.winners.map((w) => [w.title, w.units, usd(w.revenue), usd(w.adSpend), usd(w.profit)]) }] };
    }
    case 'losers':
    case 'pause_losers': {
      const range = parseRange('30d', undefined, undefined, now);
      const perf = await productPerformance(ctx, range, 20);
      const losers = perf.losers;
      const ids = losers.map((l) => l.productId);
      const camps = await Campaign.find({ productId: { $in: ids }, status: 'active' }).select('name productId').lean();
      const plan = camps.map((c) => ({ kind: 'ad_action', description: `Pause campaign "${c.name}"`, payload: { campaignId: String(c._id), action: 'PAUSE', reason: 'Copilot: product losing money' } }));
      const base: CopilotAnswer = { intent, sources: ['orders', 'ad_metrics', 'campaigns'], answer: losers.length ? `${losers.length} product(s) have negative contribution profit over 30 days: ${losers.slice(0, 5).map((l) => `${l.title} (${usd(l.profit)})`).join(', ')}.` : 'No product is losing money over the last 30 days.', tables: [{ title: 'Losing products (30 days, USD)', columns: ['Product', 'Revenue', 'Ad spend', 'Contribution'], rows: losers.map((l) => [l.title, usd(l.revenue), usd(l.adSpend), usd(l.profit)]) }] };
      if (intent === 'losers' || !plan.length) return base;
      if (!a.confirm) return { ...base, plan, requiresConfirmation: true, answer: `${base.answer}\nI would make ${plan.length} change(s): ${plan.map((p) => p.description).join('; ')}. Confirm to apply (subject to your automation settings).` };
      const executed: NonNullable<CopilotAnswer['executed']> = [];
      for (const p of plan) {
        const r = await proposeOrExecute(ctx, { automationKey: 'ad_optimization', agent: 'BusinessIntelligenceAgent', kind: p.kind, resource: 'campaign', resourceId: String(p.payload['campaignId']), summary: `${p.description} (requested via Copilot by ${a.actor.id})`, payload: p.payload, confidence: 0.8, dedupeKey: `copilot:${p.payload['campaignId']}` });
        executed.push({ description: p.description, status: r.status === 'executed' ? 'executed' : r.status === 'proposed' ? 'awaiting approval (ASSISTED mode)' : r.status === 'failed' ? `failed: ${r.error}` : 'skipped (automation OFF)' });
      }
      return { ...base, executed, answer: `${base.answer}\nResult: ${executed.map((e) => `${e.description} → ${e.status}`).join('; ')}.` };
    }
    case 'country': {
      const range = parseRange('30d', undefined, undefined, now);
      const c = await countryAnalytics(ctx, range);
      return { intent, sources: ['orders', 'ad_metrics', 'analytics'], answer: c.recommendation, tables: [{ title: 'Countries (30 days, USD)', columns: ['Country', 'Revenue', 'Orders', 'Profit', 'ROAS', 'Conversion'], rows: c.countries.map((k) => [k.name, usd(k.revenue), k.orders, usd(k.profit), k.roas ? k.roas.toFixed(2) : '—', pct(k.conversionRate)]) }] };
    }
    case 'suppliers': {
      const s = await supplierHealth();
      const bad = s.filter((x) => x.apiStatus !== 'ok');
      return { intent, sources: ['suppliers', 'shipments'], answer: bad.length ? `${bad.length} supplier(s) need attention: ${bad.map((b) => `${b.name} (${b.apiStatus})`).join(', ')}.` : 'All configured suppliers report a healthy API status.', tables: [{ title: 'Suppliers', columns: ['Supplier', 'API', 'Reliability', 'Orders', 'Fail rate'], rows: s.map((x) => [x.name, x.apiStatus, x.reliability, x.ordersTotal, pct(x.failRate)]) }] };
    }
    case 'exceptions': {
      const ex = await ExceptionModel.find({ status: { $in: ['open', 'in_progress'] } }).sort({ createdAt: -1 }).limit(10).lean();
      return { intent, sources: ['exceptions'], answer: ex.length ? `${ex.length} open exception(s).` : 'There are no open exceptions.', tables: [{ title: 'Open exceptions', columns: ['Priority', 'Kind', 'Issue'], rows: ex.map((e) => [e.priority, e.kind, e.issue]) }] };
    }
    case 'inventory': {
      const inv = await Inventory.find({ status: { $in: ['LOW_STOCK', 'OUT_OF_STOCK', 'SUPPLIER_UNAVAILABLE', 'PRICE_CHANGED'] } }).limit(20).lean();
      const names = new Map((await Product.find({ _id: { $in: inv.map((i) => i.productId) } }).select('title').lean()).map((p) => [String(p._id), p.title]));
      return { intent, sources: ['inventory'], answer: inv.length ? `${inv.length} product/country combination(s) have inventory problems.` : 'Inventory looks healthy.', tables: [{ title: 'Inventory problems', columns: ['Product', 'Country', 'Status', 'Available'], rows: inv.map((i) => [names.get(String(i.productId)) ?? '', i.country, i.status, i.available]) }] };
    }
    case 'ads': {
      const range = parseRange('7d', undefined, undefined, now);
      const rows = await adsOverview(ctx, range.from, range.to);
      const spend = rows.reduce((s, r) => s + r.spend, 0);
      const rev = rows.reduce((s, r) => s + r.revenue, 0);
      return { intent, sources: ['ad_metrics', 'campaigns'], answer: rows.length ? `Last 7 days: ad spend ${usd(spend)}, platform-attributed revenue ${usd(rev)} (ROAS ${spend ? (rev / spend).toFixed(2) : '—'}) across ${rows.length} campaign/country row(s).` : 'No ad activity in the last 7 days.', tables: [{ title: 'Campaigns (7 days)', columns: ['Campaign', 'Country', 'Spend', 'ROAS', 'Recommendation'], rows: rows.slice(0, 15).map((r) => [r.name, r.country, usd(r.spend), r.roas.toFixed(2), r.recommendation]) }] };
    }
    case 'summary': {
      const f = await financials(ctx, parseRange('today', undefined, undefined, now));
      const live = (await import('./reporting')).liveStats;
      const l = await live(ctx);
      const ins = await insights(ctx);
      return { intent, sources: ['orders', 'ad_metrics', 'analytics'], answer: `Today: ${f.orders} order(s), net revenue ${usd(f.netRevenue)}, ad spend ${usd(f.adSpend)}, contribution profit ${usd(f.contributionProfit)}. ${l.openExceptions} open exception(s); ${l.pendingSupplierOrders} order(s) awaiting supplier placement.${ins[0] ? ` Top insight: ${ins[0].title}.` : ''}${f.pendingCostOrders ? ` (${f.pendingCostOrders} paid order(s) not yet fulfilled; their costs are not in profit.)` : ''}` };
    }
    default: {
      void timeseries; void AiDecision; void AdMetric; void Order; void DEFAULT_COUNTRIES;
      return { intent: 'unknown', sources: [], answer: 'I can answer from your live data: “why did profit fall yesterday?”, “best products to scale”, “which products are losing money”, “pause products losing money”, “country performance”, “supplier health”, “open exceptions”, “inventory problems”, “ad performance”, or “how are we doing today?”.' };
    }
  }
}
