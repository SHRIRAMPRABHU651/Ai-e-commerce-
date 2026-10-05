import mongoose from 'mongoose';
import { AdCreative, AdMetric, Campaign, Product } from '@orvia/database';
import { evaluateCampaign, evaluateTest, rankCreatives, PartialCreationError } from '@orvia/ads';
import type { AdPlatform, AdRulesConfig, CampaignSpec } from '@orvia/ads';
import { convertMinor } from '@orvia/types';
import type { CountryCode, Currency } from '@orvia/types';
import { audit } from '../infra/audit';
import { aiActor, DomainError, notFound } from '../infra/context';
import type { Actor, Ctx } from '../infra/context';
import { proposeOrExecute, registerExecutor } from './automation';
import { isSellable, transitionProduct } from './catalog';

const oid = (s: string) => new mongoose.Types.ObjectId(s);
const day = (d: Date) => d.toISOString().slice(0, 10);

/** Spend so far today / this month across all platforms (USD cents) for hard-limit enforcement. */
export async function spendHeadroom(ctx: Ctx, rules: AdRulesConfig) {
  const now = ctx.now();
  const startDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const startMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [today] = await AdMetric.aggregate<{ s: number }>([{ $match: { date: { $gte: startDay } } }, { $group: { _id: null, s: { $sum: '$spend' } } }]);
  const [month] = await AdMetric.aggregate<{ s: number }>([{ $match: { date: { $gte: startMonth } } }, { $group: { _id: null, s: { $sum: '$spend' } } }]);
  const [committed] = await Campaign.aggregate<{ b: number }>([{ $match: { status: 'active' } }, { $group: { _id: null, b: { $sum: '$dailyBudget' } } }]);
  return {
    spentToday: today?.s ?? 0,
    spentMonth: month?.s ?? 0,
    committedDaily: committed?.b ?? 0,
    dailyRemaining: rules.dailyLimit - (committed?.b ?? 0),
    monthlyRemaining: rules.monthlyLimit - (month?.s ?? 0),
  };
}

/** Generate the test plan: campaign draft + 5 creative concepts + success criteria (nothing is launched). */
export async function createTestPlan(ctx: Ctx, productId: string, country: CountryCode, platform: AdPlatform, actor: Actor) {
  const product = await Product.findById(productId).lean();
  if (!product) throw notFound('Product');
  const market = product.markets.find((m) => m.country === country && m.enabled);
  if (!market || !market.price) throw new DomainError('Product has no priced market in that country', 'NO_MARKET', 422);
  const ops = await ctx.settings.get('ops');
  const td = ops.testDefaults;
  const c = await Campaign.create({
    platform, productId, country, name: `Test · ${product.title} · ${country}`, objective: 'sales', status: 'draft', dailyBudget: td.dailyBudget,
    test: { isTest: true, durationDays: td.durationDays, minImpressions: td.minImpressions, minClicks: td.minClicks, minSpend: td.minSpend, targetCpa: td.targetCpa, targetRoas: td.targetRoas, verdict: 'PENDING' },
    isDemo: ctx.cfg.ADS_MODE === 'mock',
  });
  const out = await ctx.ai.adCreatives({
    title: product.title, description: product.description ?? '', category: product.category ?? '', attributes: product.attributes ? Object.fromEntries(Object.entries(product.attributes as unknown as Record<string, string>)) : {}, tags: product.tags, safetyStandards: [], variants: [],
  });
  const creatives = await AdCreative.insertMany(out.data.map((cr) => ({ campaignId: c._id, productId, concept: cr.concept, hook: cr.hook, primaryText: cr.primaryText, headline: cr.headline, description: cr.description, cta: cr.cta, videoScript: cr.videoScript, status: 'draft', source: out.source, isDemo: ctx.cfg.ADS_MODE === 'mock' })));
  await audit(ctx, actor, { action: 'campaign.plan_created', resource: 'campaign', resourceId: String(c._id), aiSummary: `${creatives.length} creative concepts (${out.source}), daily budget ${td.dailyBudget}, ${td.durationDays} days` });
  return { campaignId: String(c._id), creatives: creatives.length, source: out.source };
}

/** Launch: safety checks -> create PAUSED remotely -> activate. A failed API call leaves a FAILED campaign, never a fake active one. */
export async function launchCampaign(ctx: Ctx, campaignId: string, actor: Actor) {
  const c = await Campaign.findById(campaignId);
  if (!c) throw notFound('Campaign');
  if (c.status === 'active') return c;
  const product = await Product.findById(c.productId).lean();
  if (!product) throw notFound('Product');
  if (!isSellable(product.state) && product.state !== 'DRAFT') throw new DomainError('Product is not sellable', 'NOT_SELLABLE', 409);
  if (product.compliance?.status !== 'passed') throw new DomainError('Product has not passed compliance', 'COMPLIANCE', 409);
  const market = product.markets.find((m) => m.country === c.country && m.enabled);
  if (!market || market.stock <= 0) throw new DomainError('Product is out of stock in the target country', 'NO_STOCK', 409);
  const rules = await ctx.settings.get('ads');
  const head = await spendHeadroom(ctx, rules);
  if (c.dailyBudget > rules.maxDailyBudget) throw new DomainError('Budget exceeds the per-campaign maximum', 'BUDGET_CAP', 422);
  if (head.committedDaily + c.dailyBudget > rules.dailyLimit) throw new DomainError('Launching would exceed the global daily spend limit', 'DAILY_LIMIT', 422);
  if (head.monthlyRemaining < c.dailyBudget) throw new DomainError('Monthly spend limit reached', 'MONTHLY_LIMIT', 422);
  const creatives = await AdCreative.find({ campaignId: c._id }).limit(10).lean();
  const ops = await ctx.settings.get('ops');
  const aovUsd = convertMinor(market.price, market.currency as Currency, 'USD', ops.fx);
  const spec: CampaignSpec = {
    name: c.name ?? `Campaign ${c._id}`, country: c.country, currency: 'USD', objective: 'sales', dailyBudget: c.dailyBudget,
    landingUrl: `${ctx.cfg.WEB_URL}/p/${product.slug}?utm_source=${c.platform}&utm_campaign=${c._id}`, audience: { ageMin: 18 },
    creatives: creatives.map((cr) => ({ id: String(cr._id), concept: cr.concept ?? 'other', headline: cr.headline ?? '', primaryText: cr.primaryText ?? '', description: cr.description ?? '', cta: cr.cta ?? 'Shop now', imageUrl: product.images?.[0]?.url ? new URL(product.images[0].url, ctx.cfg.WEB_URL).toString() : undefined })),
    mockHints: { aov: aovUsd },
  };
  let provider;
  try {
    provider = ctx.ads.get(c.platform as AdPlatform);
  } catch (e) {
    c.status = 'failed';
    c.failureReason = (e as Error).message;
    await c.save();
    throw new DomainError(`Ad platform unavailable: ${(e as Error).message}`, 'AD_PLATFORM_UNAVAILABLE', 503);
  }
  try {
    const created = await provider.createCampaign(spec);
    c.externalId = created.externalId;
    c.adSets = created.adSetIds.map((id) => ({ externalId: id, name: 'Ad set', dailyBudget: c.dailyBudget })) as never;
    await c.save();
    for (const cr of creatives) {
      const adId = created.creativeIds[String(cr._id)];
      if (adId) await AdCreative.updateOne({ _id: cr._id }, { $set: { externalId: adId, status: 'active' } });
    }
    await provider.setStatus(created.externalId, 'active');
    c.status = 'active';
    c.launchedAt = ctx.now();
    c.failureReason = undefined;
    await c.save();
    await audit(ctx, actor, { action: 'campaign.launched', resource: 'campaign', resourceId: campaignId, provider: c.platform, newValue: { externalId: created.externalId, dailyBudget: c.dailyBudget, creativesWithAds: Object.keys(created.creativeIds).length } });
    return c;
  } catch (e) {
    c.status = 'failed';
    c.failureReason = (e as Error).message;
    if (e instanceof PartialCreationError && e.partial.externalId) c.externalId = e.partial.externalId;
    await c.save();
    ctx.log.error({ channel: 'ad', campaign: campaignId, err: (e as Error).message }, 'campaign launch failed');
    await audit(ctx, actor, { action: 'campaign.launch_failed', resource: 'campaign', resourceId: campaignId, provider: c.platform, reason: (e as Error).message });
    throw new DomainError(`Campaign launch failed: ${(e as Error).message}`, 'LAUNCH_FAILED', 502);
  }
}

registerExecutor('launch_campaign', async (ctx, p, actor) => {
  const c = await launchCampaign(ctx, String(p['campaignId']), actor);
  const prod = await Product.findById(c.productId).select('state').lean();
  if (prod && ['PUBLISHED'].includes(prod.state)) await transitionProduct(ctx, String(c.productId), 'TESTING', actor, 'ad test started').catch(() => undefined);
  return { status: c.status, externalId: c.externalId };
});

/** ProductTesting: plan + (mode-gated) launch of test campaigns for published products that have none. */
export async function startProductTests(ctx: Ctx, platform: AdPlatform = 'meta', limit = 3) {
  const products = await Product.find({ state: 'PUBLISHED', 'compliance.status': 'passed' }).sort({ 'opportunity.finalScore': -1 }).limit(limit * 4).lean();
  let started = 0;
  for (const p of products) {
    if (started >= limit) break;
    const m = p.markets.filter((x) => x.enabled && x.stock > 0).sort((a, b) => b.expectedMargin - a.expectedMargin)[0];
    if (!m) continue;
    if (await Campaign.exists({ productId: p._id, country: m.country, status: { $in: ['draft', 'active', 'paused', 'pending_launch'] } })) continue;
    if ((p.opportunity?.finalScore ?? 0) < 70) continue;
    const plan = await createTestPlan(ctx, String(p._id), m.country as CountryCode, platform, aiActor('MarketingAgent'));
    const out = await proposeOrExecute(ctx, { automationKey: 'ad_optimization', agent: 'MarketingAgent', kind: 'launch_campaign', resource: 'campaign', resourceId: plan.campaignId, summary: `Launch ${platform} test for "${p.title}" in ${m.country} (${plan.creatives} creatives)`, payload: { campaignId: plan.campaignId }, confidence: 0.7, dedupeKey: `launch:${plan.campaignId}` });
    if (out.status === 'executed' || out.status === 'proposed') started++;
  }
  return { started };
}

export async function syncAdMetrics(ctx: Ctx, days = 3): Promise<{ campaigns: number; rows: number; failures: string[] }> {
  const sum = { campaigns: 0, rows: 0, failures: [] as string[] };
  const camps = await Campaign.find({ status: { $in: ['active', 'paused'] }, externalId: { $exists: true } }).limit(500).lean();
  const range = { from: day(new Date(ctx.now().getTime() - days * 86_400_000)), to: day(ctx.now()) };
  for (const platform of ['meta', 'tiktok', 'google'] as AdPlatform[]) {
    const list = camps.filter((c) => c.platform === platform);
    if (!list.length) continue;
    let provider;
    try {
      provider = ctx.ads.get(platform);
    } catch (e) {
      sum.failures.push(`${platform}: ${(e as Error).message}`);
      continue;
    }
    try {
      const rows = await provider.getMetrics(list.map((c) => c.externalId!), range);
      const byExt = new Map(list.map((c) => [c.externalId!, c]));
      for (const r of rows) {
        const c = byExt.get(r.externalCampaignId);
        if (!c) continue;
        await AdMetric.updateOne(
          { campaignId: c._id, creativeId: r.creativeId ? oid(r.creativeId) : null, date: new Date(r.date) },
          { $set: { productId: c.productId, platform, country: c.country, impressions: r.impressions, clicks: r.clicks, spend: r.spend, addToCart: r.addToCart, checkouts: r.checkouts, purchases: r.purchases, revenue: r.revenue, isDemo: ctx.cfg.ADS_MODE === 'mock' } },
          { upsert: true },
        );
        sum.rows++;
      }
      sum.campaigns += list.length;
      for (const c of list) {
        const [t] = await AdMetric.aggregate<{ s: number }>([{ $match: { campaignId: c._id } }, { $group: { _id: null, s: { $sum: '$spend' } } }]);
        await Campaign.updateOne({ _id: c._id }, { $set: { spent: t?.s ?? 0 } });
      }
    } catch (e) {
      sum.failures.push(`${platform}: ${(e as Error).message}`);
      ctx.log.error({ channel: 'ad', platform, err: (e as Error).message }, 'ad metrics sync failed');
    }
  }
  return sum;
}

async function campaignWindow(ctx: Ctx, campaignId: string, hours: number) {
  const since = new Date(ctx.now().getTime() - hours * 3_600_000);
  const [a] = await AdMetric.aggregate<{ impressions: number; clicks: number; spend: number; purchases: number; revenue: number }>([
    { $match: { campaignId: oid(campaignId), date: { $gte: new Date(day(since)) } } },
    { $group: { _id: null, impressions: { $sum: '$impressions' }, clicks: { $sum: '$clicks' }, spend: { $sum: '$spend' }, purchases: { $sum: '$purchases' }, revenue: { $sum: '$revenue' } } },
  ]);
  return a ?? { impressions: 0, clicks: 0, spend: 0, purchases: 0, revenue: 0 };
}

/** Contribution profit of a campaign: revenue minus product costs/fees/refunds minus ad spend (USD). */
async function campaignProfit(ctx: Ctx, productId: string, country: CountryCode, w: { revenue: number; spend: number }) {
  const p = await Product.findById(productId).select('markets stats').lean();
  const m = p?.markets.find((x) => x.country === country);
  const pricing = await ctx.settings.get('pricing');
  const preAd = m && m.price > 0 ? 1 - m.landedCost / m.price - 0.029 - Math.max(pricing.baseRefundRate, p?.stats?.refundRate ?? 0) : 0.3;
  return { profit: Math.round(w.revenue * preAd - w.spend), refundRate: p?.stats?.refundRate ?? 0 };
}

export async function optimizeAds(ctx: Ctx): Promise<{ evaluated: number; actions: Record<string, number>; tests: Record<string, number> }> {
  const rules = await ctx.settings.get('ads');
  const out = { evaluated: 0, actions: { SCALE: 0, MAINTAIN: 0, REDUCE: 0, PAUSE: 0 } as Record<string, number>, tests: { WIN: 0, CONTINUE: 0, KILL: 0 } as Record<string, number> };
  const camps = await Campaign.find({ status: 'active' }).limit(200);
  for (const c of camps) {
    out.evaluated++;
    const w = await campaignWindow(ctx, String(c._id), 72);
    const { profit, refundRate } = await campaignProfit(ctx, String(c.productId), c.country as CountryCode, w);
    const head = await spendHeadroom(ctx, rules);
    const d = evaluateCampaign({ ...w, profit, refundRate }, c.dailyBudget, rules, { dailyRemaining: head.dailyRemaining, monthlyRemaining: head.monthlyRemaining });
    out.actions[d.action] = (out.actions[d.action] ?? 0) + 1;
    c.recommendation = { action: d.action, reason: d.reasons.join('; '), at: ctx.now() } as never;
    // creative ranking
    const rows = await AdMetric.aggregate<{ _id: mongoose.Types.ObjectId; impressions: number; clicks: number; spend: number; purchases: number; revenue: number }>([
      { $match: { campaignId: c._id, creativeId: { $ne: null } } }, { $group: { _id: '$creativeId', impressions: { $sum: '$impressions' }, clicks: { $sum: '$clicks' }, spend: { $sum: '$spend' }, purchases: { $sum: '$purchases' }, revenue: { $sum: '$revenue' } } },
    ]);
    if (rows.length) {
      const ranked = rankCreatives(rows.map((r) => ({ creativeId: String(r._id), ...r })), { minImpressions: 800, minSpend: 500, targetRoas: rules.targetRoas });
      for (const r of ranked) await AdCreative.updateOne({ _id: r.creativeId }, { $set: { status: r.status === 'testing' ? 'active' : r.status } });
    }
    if (c.test?.isTest && c.test.verdict === 'PENDING') {
      const all = await campaignWindow(ctx, String(c._id), 24 * 60);
      const prof = await campaignProfit(ctx, String(c.productId), c.country as CountryCode, all);
      const ended = c.launchedAt && ctx.now().getTime() - c.launchedAt.getTime() >= (c.test.durationDays ?? 5) * 86_400_000;
      const t = evaluateTest({ ...all, profit: prof.profit }, { minImpressions: c.test.minImpressions ?? 1500, minClicks: c.test.minClicks ?? 30, minSpend: c.test.minSpend ?? 3000, targetCpa: c.test.targetCpa ?? 1500, targetRoas: c.test.targetRoas ?? 2.5 });
      if (t.verdict === 'WIN' || t.verdict === 'KILL' || (ended && t.verdict === 'CONTINUE' && all.spend >= (c.test.minSpend ?? 0))) {
        const verdict = t.verdict === 'CONTINUE' ? 'KILL' : t.verdict;
        out.tests[verdict] = (out.tests[verdict] ?? 0) + 1;
        if (verdict === 'WIN') {
          c.test.verdict = 'WIN';
          await proposeOrExecute(ctx, { automationKey: 'ad_optimization', agent: 'AdOptimizationAgent', kind: 'pause_product', resource: 'product', resourceId: String(c.productId), summary: `Test WON: ${t.reasons.join('; ')} — mark product WINNER`, payload: { productId: String(c.productId), to: 'WINNER', reason: t.reasons.join('; ') }, confidence: 0.8, dedupeKey: `win:${c._id}` });
        } else {
          c.test.verdict = 'KILL';
          await proposeOrExecute(ctx, { automationKey: 'ad_optimization', agent: 'AdOptimizationAgent', kind: 'ad_action', resource: 'campaign', resourceId: String(c._id), summary: `Test failed on a sufficient sample: ${t.reasons.join('; ')} — pause campaign`, payload: { campaignId: String(c._id), action: 'PAUSE', reason: 'test KILL' }, confidence: 0.8, dedupeKey: `kill:${c._id}` });
        }
      } else out.tests['CONTINUE'] = (out.tests['CONTINUE'] ?? 0) + 1;
    }
    await c.save();
    if (d.action === 'MAINTAIN') continue;
    await proposeOrExecute(ctx, {
      automationKey: 'ad_optimization', agent: 'AdOptimizationAgent', kind: 'ad_action', resource: 'campaign', resourceId: String(c._id),
      summary: `${d.action} "${c.name}": ${d.reasons.join('; ')}${d.action === 'SCALE' || d.action === 'REDUCE' ? ` (budget ${c.dailyBudget} → ${d.newDailyBudget})` : ''}`,
      payload: { campaignId: String(c._id), action: d.action, newDailyBudget: d.newDailyBudget, reason: d.reasons.join('; ') }, confidence: d.sufficientData ? 0.8 : 0.5, dedupeKey: `ad:${c._id}:${d.action}`,
    });
  }
  return out;
}

registerExecutor('ad_action', async (ctx, p, actor) => {
  const c = await Campaign.findById(String(p['campaignId']));
  if (!c) throw notFound('Campaign');
  if (!c.externalId) throw new DomainError('Campaign was never created on the platform', 'NOT_LAUNCHED', 409);
  const provider = ctx.ads.get(c.platform as AdPlatform);
  const action = String(p['action']);
  const rules = await ctx.settings.get('ads');
  if (action === 'PAUSE') {
    await provider.setStatus(c.externalId, 'paused'); // throws on failure -> decision marked failed, local state untouched
    c.status = 'paused';
  } else if (action === 'SCALE' || action === 'REDUCE') {
    let nb = Math.round(Number(p['newDailyBudget']));
    const head = await spendHeadroom(ctx, rules);
    if (action === 'SCALE') nb = Math.min(nb, rules.maxDailyBudget, c.dailyBudget + Math.max(0, head.dailyRemaining), head.monthlyRemaining);
    nb = Math.max(rules.minDailyBudget, nb);
    await provider.updateDailyBudget(c.externalId, nb);
    c.dailyBudget = nb;
  } else if (action === 'RESUME') {
    await provider.setStatus(c.externalId, 'active');
    c.status = 'active';
  }
  await c.save();
  await audit(ctx, actor, { action: `campaign.${action.toLowerCase()}`, resource: 'campaign', resourceId: String(c._id), newValue: { dailyBudget: c.dailyBudget, status: c.status }, reason: String(p['reason'] ?? ''), provider: c.platform });
  return { status: c.status, dailyBudget: c.dailyBudget };
});

export async function adsOverview(ctx: Ctx, from: Date, to: Date) {
  const rows = await AdMetric.aggregate<{ _id: { campaignId: mongoose.Types.ObjectId; country: string; productId: mongoose.Types.ObjectId }; impressions: number; clicks: number; spend: number; purchases: number; revenue: number; atc: number }>([
    { $match: { date: { $gte: from, $lte: to } } },
    { $group: { _id: { campaignId: '$campaignId', country: '$country', productId: '$productId' }, impressions: { $sum: '$impressions' }, clicks: { $sum: '$clicks' }, spend: { $sum: '$spend' }, purchases: { $sum: '$purchases' }, revenue: { $sum: '$revenue' }, atc: { $sum: '$addToCart' } } },
    { $limit: 500 },
  ]);
  const camps = await Campaign.find({ _id: { $in: rows.map((r) => r._id.campaignId) } }).select('name platform status country productId recommendation dailyBudget').lean();
  const prods = await Product.find({ _id: { $in: camps.map((c) => c.productId) } }).select('title').lean();
  const pt = new Map(prods.map((p) => [String(p._id), p.title]));
  const cm = new Map(camps.map((c) => [String(c._id), c]));
  return rows.map((r) => {
    const c = cm.get(String(r._id.campaignId));
    const revenueUsd = r.revenue; // ad revenue is recorded in USD cents by providers/mocks
    return {
      campaignId: String(r._id.campaignId), name: c?.name ?? '', platform: c?.platform ?? '', status: c?.status ?? '', country: r._id.country, productId: String(r._id.productId), product: pt.get(String(r._id.productId)) ?? '',
      dailyBudget: c?.dailyBudget ?? 0, impressions: r.impressions, clicks: r.clicks, spend: r.spend, purchases: r.purchases, revenue: revenueUsd, addToCart: r.atc,
      ctr: r.impressions ? r.clicks / r.impressions : 0, cpc: r.clicks ? r.spend / r.clicks : 0, cpm: r.impressions ? (r.spend / r.impressions) * 1000 : 0, cpa: r.purchases ? r.spend / r.purchases : null, roas: r.spend ? revenueUsd / r.spend : 0,
      recommendation: c?.recommendation?.action ?? 'MAINTAIN', reason: c?.recommendation?.reason ?? '',
    };
  });
}
