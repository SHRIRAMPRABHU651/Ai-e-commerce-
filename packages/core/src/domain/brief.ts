import { ExceptionModel, Report } from '@orvia/database';
import type { Ctx } from '../infra/context';
import { countryAnalytics, financials, insights, productPerformance } from './reporting';
import type { Range } from './reporting';

const usd = (m: number) => `$${(m / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export interface DailyBrief {
  date: string;
  revenue: number;
  profit: number;
  orders: number;
  adSpend: number;
  bestProduct: string | null;
  worstProduct: string | null;
  bestCountry: string | null;
  biggestProblem: string | null;
  recommendedActions: string[];
  text: string;
  source: 'deterministic' | 'gemini';
  pendingCostOrders: number;
}

/** "Today's business brief" — figures are database aggregates; the LLM (if configured) may only rephrase. */
export async function generateDailyBrief(ctx: Ctx, dateStr?: string): Promise<DailyBrief> {
  const now = ctx.now();
  const day = dateStr ?? new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  const r: Range = { from: new Date(`${day}T00:00:00.000Z`), to: new Date(`${day}T23:59:59.999Z`) };
  const f = await financials(ctx, r);
  const perf = await productPerformance(ctx, r, 5);
  const c = await countryAnalytics(ctx, r);
  const ex = await ExceptionModel.find({ status: { $in: ['open', 'in_progress'] } }).sort({ priority: 1, createdAt: -1 }).limit(3).lean();
  const ins = await insights(ctx);
  const bestCountry = [...c.countries].filter((x) => x.orders > 0).sort((a, b) => b.profit - a.profit)[0];
  const actions = [
    ...ex.slice(0, 2).map((e) => `Resolve: ${e.issue}`),
    ...ins.filter((i) => i.severity === 'positive' || i.severity === 'warning').slice(0, 3).map((i) => i.title),
  ].slice(0, 3);
  while (actions.length < 3) actions.push(actions.length === 0 ? 'Review the exceptions queue' : actions.length === 1 ? 'Check supplier and ad health' : 'Review pricing proposals in Automation');
  const brief: DailyBrief = {
    date: day, revenue: f.netRevenue, profit: f.contributionProfit, orders: f.orders, adSpend: f.adSpend,
    bestProduct: perf.winners[0]?.title ?? null, worstProduct: perf.losers[0]?.title ?? null, bestCountry: bestCountry?.name ?? null,
    biggestProblem: ex[0]?.issue ?? ins.find((i) => i.severity === 'critical' || i.severity === 'warning')?.title ?? null, recommendedActions: actions, source: 'deterministic', pendingCostOrders: f.pendingCostOrders, text: '',
  };
  brief.text = [
    `TODAY’S BUSINESS BRIEF — ${day}`,
    `Revenue (net): ${usd(brief.revenue)}`,
    `Contribution profit: ${usd(brief.profit)}${f.pendingCostOrders ? ` (excludes ${f.pendingCostOrders} unfulfilled order(s))` : ''}`,
    `Orders: ${brief.orders}`,
    `Ad spend: ${usd(brief.adSpend)}`,
    `Best product: ${brief.bestProduct ?? '—'}`,
    `Worst product: ${brief.worstProduct ?? '—'}`,
    `Best country: ${brief.bestCountry ?? '—'}`,
    `Biggest problem: ${brief.biggestProblem ?? 'None detected'}`,
    'Recommended actions:',
    ...brief.recommendedActions.map((a, i) => `${i + 1}. ${a}`),
  ].join('\n');
  const narrative = await ctx.ai.businessNarrative({ date: day, revenueUsdCents: brief.revenue, profitUsdCents: brief.profit, orders: brief.orders, adSpendUsdCents: brief.adSpend, bestProduct: brief.bestProduct, worstProduct: brief.worstProduct, bestCountry: brief.bestCountry, biggestProblem: brief.biggestProblem, actions: brief.recommendedActions });
  if (narrative) {
    brief.source = 'gemini';
    brief.text += `\n\n${narrative.data.headline}\n${narrative.data.bullets.map((b) => `• ${b}`).join('\n')}`;
  }
  await Report.updateOne({ kind: 'daily_brief', date: day }, { $set: { data: brief, narrative: brief.text, source: brief.source } }, { upsert: true });
  return brief;
}
