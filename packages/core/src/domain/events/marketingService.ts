/** Segments, email campaigns, experiments, attribution/performance reports and feeds: the Mongo-backed side of the events workstream. */
import { AdMetric, AnalyticsEvent, Cart, Job, Customer, EventsCampaign, EventsCampaignRecipient, EventsExperiment, EventsExperimentEvent, EventsSegment, EventsSession, EventsUnsubscribe, MeasuredCpa, Notification, Order, Product, User } from '@orvia/database';
import { SELLABLE_STATES, convertMinor } from '@orvia/types';
import type { CountryCode, Currency, SegmentRule } from '@orvia/types';
import { audit } from '../../infra/audit';
import { DomainError, notFound } from '../../infra/context';
import type { Actor, Ctx } from '../../infra/context';
import { notify } from '../notify';
import { canContactUser } from '../customer360/service';
import { PLATFORM_CHANNEL, classifyChannel, reportChannel } from './attributionRules';
import type { Channel, ChannelRow } from './attributionRules';
import { emailEligibility, maskRecipientEmail, planRecipients } from './campaignRules';
import { assessExperiment, assignVariant } from './experimentsMath';
import { buildGoogleFeedXml, buildMetaFeedCsv, toFeedItem } from './feeds';
import type { Exclusion, FeedItem } from './feeds';
import { buildCustomerPrefilter, evaluateSegment } from './segments';
import type { CustomerFacts } from './segments';
import { clickUrl, isAllowedRedirect, signToken, unsubscribeUrl, verifyToken } from './tokens';

const DAY = 86_400_000;
const PAID = ['succeeded', 'partially_refunded', 'refunded'];
const MAX_SCAN = 20_000;
const secret = (ctx: Ctx) => ctx.cfg.JWT_SECRET;
const chunk = <T>(a: T[], n: number): T[][] => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

/* ------------------------------- segments ------------------------------- */
export async function loadCustomerFacts(ctx: Ctx, rules: SegmentRule[], cap = MAX_SCAN): Promise<{ facts: CustomerFacts[]; truncated: boolean }> {
  const fx = (await ctx.settings.get('ops')).fx;
  const customers = await Customer.find({ isDemo: { $ne: true }, ...buildCustomerPrefilter(rules) }).select('email country marketingConsent').limit(cap + 1).lean();
  const truncated = customers.length > cap;
  const list = customers.slice(0, cap);
  const agg = new Map<string, { n: number; usd: number; last: Date | null }>();
  const cats = new Map<string, Set<string>>();
  const needCats = rules.some((r) => r.field === 'categoryAffinity');
  for (const emails of chunk(list.map((c) => c.email), 2000)) {
    const rows = await Order.aggregate<{ _id: { email: string; cur: string }; n: number; total: number; last: Date }>([
      { $match: { email: { $in: emails }, 'payment.status': { $in: PAID }, isDemo: { $ne: true } } },
      { $group: { _id: { email: '$email', cur: '$currency' }, n: { $sum: 1 }, total: { $sum: '$amounts.total' }, last: { $max: '$payment.paidAt' } } },
    ]);
    for (const r of rows) {
      const a = agg.get(r._id.email) ?? { n: 0, usd: 0, last: null };
      a.n += r.n; a.usd += convertMinor(r.total, r._id.cur as Currency, 'USD', fx);
      if (r.last && (!a.last || r.last > a.last)) a.last = r.last;
      agg.set(r._id.email, a);
    }
    if (needCats) {
      const rs = await Order.aggregate<{ _id: { email: string; productId: unknown } }>([
        { $match: { email: { $in: emails }, 'payment.status': { $in: PAID }, isDemo: { $ne: true } } }, { $unwind: '$items' }, { $group: { _id: { email: '$email', productId: '$items.productId' } } },
      ]);
      const prods = new Map((await Product.find({ _id: { $in: [...new Set(rs.map((r) => r._id.productId))] } }).select('category topCategory').lean()).map((p) => [String(p._id), [p.category, p.topCategory].filter(Boolean) as string[]]));
      for (const r of rs) { const s = cats.get(r._id.email) ?? new Set<string>(); (prods.get(String(r._id.productId)) ?? []).forEach((c) => s.add(c)); cats.set(r._id.email, s); }
    }
  }
  return {
    truncated,
    facts: list.map((c) => { const a = agg.get(c.email); return { email: c.email, ordersCount: a?.n ?? 0, lifetimeValueUsd: Math.round(a?.usd ?? 0), lastOrderAt: a?.last ?? null, country: c.country ?? null, marketingConsent: c.marketingConsent === true, categories: [...(cats.get(c.email) ?? [])] }; }),
  };
}

export async function computeSegment(ctx: Ctx, rules: SegmentRule[]) {
  const { facts, truncated } = await loadCustomerFacts(ctx, rules);
  const now = ctx.now();
  const members = facts.filter((f) => evaluateSegment(rules, f, now));
  const consented = members.filter((m) => m.marketingConsent);
  return { count: members.length, emailableCount: consented.length, sample: consented.slice(0, 5).map((m) => maskRecipientEmail(m.email)), truncated, members };
}

/* ------------------------------- campaigns ------------------------------- */
/**
 * Account holders must pass customer360's central decision (marketing consent + per-topic opt-in, fail closed).
 * Guest customers have no account preferences, so their checkout opt-in (Customer.marketingConsent, already required) is the record.
 */
export async function accountAllowsPromotions(email: string): Promise<boolean> {
  return (await User.exists({ email })) ? canContactUser({ email }, 'promotions', 'email') : true;
}

export async function unsubscribedSet(emails: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const c of chunk(emails, 2000)) for (const u of await EventsUnsubscribe.find({ email: { $in: c } }).select('email').lean()) out.add(u.email);
  return out;
}

export async function unsubscribeEmail(ctx: Ctx, email: string, source: string, campaignId?: string): Promise<void> {
  const e = email.trim().toLowerCase();
  await EventsUnsubscribe.updateOne({ email: e }, { $setOnInsert: { email: e, source, campaignId } }, { upsert: true });
  // withdrawing marketing email consent everywhere we hold it, so abandoned-cart and other consent-based flows stop too
  await Promise.all([Customer.updateOne({ email: e }, { $set: { marketingConsent: false } }), Cart.updateMany({ email: e }, { $set: { marketingConsent: false } })]);
  await EventsSession.updateMany({ cartToken: { $in: (await Cart.find({ email: e }).select('token').lean()).map((c) => c.token) } }, { $set: { 'consent.marketing': false } });
  await audit(ctx, { id: 'unsubscribe', type: 'anonymous' }, { action: 'marketing.unsubscribed', resource: 'customer', reason: source, newValue: { campaignId } });
}

export async function startCampaign(ctx: Ctx, id: string, actor: Actor) {
  const c = await EventsCampaign.findOneAndUpdate({ _id: id, status: { $in: ['draft', 'scheduled'] } }, { $set: { status: 'sending', startedAt: ctx.now(), approvedBy: actor.id } }, { new: true });
  if (!c) throw new DomainError('Campaign is not in a sendable state', 'CONFLICT', 409);
  try {
    const seg = await EventsSegment.findById(c.segmentId).lean();
    if (!seg) throw notFound('Segment');
    const { members } = await computeSegment(ctx, seg.rules as SegmentRule[]);
    const emails = members.map((m) => m.email);
    const unsub = await unsubscribedSet(emails);
    const recent = new Set<string>();
    for (const ch of chunk(emails, 2000)) for (const r of await EventsCampaignRecipient.find({ email: { $in: ch }, status: { $ne: 'skipped' }, createdAt: { $gte: new Date(ctx.now().getTime() - 3 * DAY) } }).select('email').lean()) recent.add(r.email);
    const dayStart = new Date(Date.UTC(ctx.now().getUTCFullYear(), ctx.now().getUTCMonth(), ctx.now().getUTCDate()));
    const sentToday = await EventsCampaignRecipient.countDocuments({ createdAt: { $gte: dayStart }, status: { $ne: 'skipped' } });
    const plan = planRecipients(members.map((m) => ({ email: m.email, marketingConsent: m.marketingConsent })), { unsubscribed: unsub, recentlyEmailed: recent, maxRecipients: c.maxRecipients, dailyRemaining: Math.max(0, ctx.cfg.EVENTS_EMAIL_DAILY_LIMIT - sentToday) });
    const allowed: string[] = [];
    let blocked = 0;
    for (const email of plan.recipients) { if (await accountAllowsPromotions(email)) allowed.push(email); else blocked++; }
    plan.recipients = allowed;
    plan.excluded.no_consent += blocked;
    c.plan = { eligible: plan.recipients.length, excludedNoConsent: plan.excluded.no_consent, excludedUnsubscribed: plan.excluded.unsubscribed, excludedFrequency: plan.excluded.frequency_cap, excludedCap: plan.excluded.campaign_cap + plan.excluded.daily_limit } as never;
    await c.save();
    if (plan.recipients.length) await EventsCampaignRecipient.insertMany(plan.recipients.map((email) => ({ campaignId: c._id, email, status: 'queued' })), { ordered: false }).catch((e: { code?: number }) => { if (e.code !== 11000 && !(e as { writeErrors?: unknown }).writeErrors) throw e; });
    for (const email of plan.recipients) await ctx.queue.enqueue('events_campaign_send', { campaignId: String(c._id), email }, { dedupeKey: `campsend:${c._id}:${email}`, maxAttempts: 4 });
    await audit(ctx, actor, { action: 'campaign.email.started', resource: 'email_campaign', resourceId: String(c._id), newValue: c.plan, reason: 'consent-filtered send' });
    if (!plan.recipients.length) { c.status = 'sent'; c.finishedAt = ctx.now(); await c.save(); }
    return c;
  } catch (e) {
    c.status = 'failed'; await c.save();
    throw e;
  }
}

/** Queue handler: consent and suppression are re-checked immediately before the message is created. */
export async function sendCampaignEmail(ctx: Ctx, p: { campaignId: string; email: string }): Promise<{ sent: boolean; reason?: string }> {
  const [c, cust, unsub] = await Promise.all([EventsCampaign.findById(p.campaignId).lean(), Customer.findOne({ email: p.email }).select('marketingConsent name').lean(), EventsUnsubscribe.exists({ email: p.email })]);
  if (!c || c.status === 'cancelled') return { sent: false, reason: 'cancelled' };
  const ok = emailEligibility({ email: p.email, marketingConsent: cust?.marketingConsent === true }, { unsubscribed: unsub ? new Set([p.email]) : new Set() });
  if (!ok.ok) { await EventsCampaignRecipient.updateOne({ campaignId: p.campaignId, email: p.email }, { $set: { status: 'skipped', skipReason: ok.reason } }); return { sent: false, reason: ok.reason }; }
  if (!(await accountAllowsPromotions(p.email))) { await EventsCampaignRecipient.updateOne({ campaignId: p.campaignId, email: p.email }, { $set: { status: 'skipped', skipReason: 'no_consent' } }); return { sent: false, reason: 'no_consent' }; }
  const id = await notify(ctx, { template: 'marketing_campaign', to: p.email, data: campaignData(ctx, c, p.email, cust?.name ?? undefined), dedupeKey: `camp:${p.campaignId}:${p.email}` });
  await EventsCampaignRecipient.updateOne({ campaignId: p.campaignId, email: p.email }, { $set: { ...(id ? { notificationId: id } : {}), status: 'sent' } });
  return { sent: true };
}

function campaignData(ctx: Ctx, c: { _id: unknown; subject: string; message: string; ctaLabel?: string | null; ctaUrl?: string | null }, email: string, name?: string) {
  const target = c.ctaUrl && isAllowedRedirect(c.ctaUrl, ctx.cfg.WEB_URL) ? clickUrl(ctx.cfg.API_URL, String(c._id), email, c.ctaUrl, secret(ctx)) : undefined;
  return { name, subject: c.subject, message: c.message, url: target, ctaLabel: c.ctaLabel ?? undefined, unsubscribeUrl: unsubscribeUrl(ctx.cfg.API_URL, email, secret(ctx), String(c._id)) };
}

/** Test send goes only to the signed-in staff member's own address. It is clearly marked and never counted in results. */
export async function testSendCampaign(ctx: Ctx, id: string, to: string) {
  const c = await EventsCampaign.findById(id).lean();
  if (!c) throw notFound('Campaign');
  const data = campaignData(ctx, c, to);
  await notify(ctx, { template: 'marketing_campaign', to, data: { ...data, subject: `[TEST] ${c.subject}` }, dedupeKey: `camptest:${id}:${ctx.now().getTime()}` });
}

export function campaignClickRedirect(ctx: Ctx, token: string): { url: string; campaignId: string; email: string } | null {
  const d = verifyToken('click', token, secret(ctx));
  if (!d?.['u'] || !d['c'] || !d['e'] || !isAllowedRedirect(d['u'], ctx.cfg.WEB_URL)) return null;
  return { url: d['u'], campaignId: d['c'], email: d['e'] };
}
export async function recordClick(ctx: Ctx, campaignId: string, email: string) {
  await EventsCampaignRecipient.updateOne({ campaignId, email }, { $inc: { clicks: 1 }, $min: { firstClickAt: ctx.now() } });
}

export async function campaignResults(id: string) {
  const c = await EventsCampaign.findById(id).lean();
  if (!c) throw notFound('Campaign');
  const [recipients, byNotif, clicked, clicks] = await Promise.all([
    EventsCampaignRecipient.aggregate<{ _id: string; n: number }>([{ $match: { campaignId: c._id } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    Notification.aggregate<{ _id: string; n: number }>([{ $match: { dedupeKey: { $regex: `^camp:${id}:` } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    EventsCampaignRecipient.countDocuments({ campaignId: c._id, clicks: { $gt: 0 } }),
    EventsCampaignRecipient.aggregate<{ t: number }>([{ $match: { campaignId: c._id } }, { $group: { _id: null, t: { $sum: '$clicks' } } }]),
  ]);
  const n = (rows: { _id: string; n: number }[], k: string) => rows.find((r) => r._id === k)?.n ?? 0;
  return {
    campaign: { id: String(c._id), name: c.name, status: c.status, subject: c.subject, plan: c.plan, startedAt: c.startedAt, finishedAt: c.finishedAt },
    recipients: { planned: recipients.reduce((a, r) => a + r.n, 0), skippedAtSend: n(recipients, 'skipped') },
    delivery: { sent: n(byNotif, 'sent'), loggedNotDelivered: n(byNotif, 'logged_dev'), failed: n(byNotif, 'failed'), skippedNoProvider: n(byNotif, 'skipped'), queued: n(byNotif, 'queued') },
    clicks: { uniqueClickers: clicked, totalClicks: clicks[0]?.t ?? 0 },
    note: 'Opens are not tracked (no tracking pixel, by design). Clicks are counted through signed redirects.',
  };
}

export async function dispatchCampaigns(ctx: Ctx): Promise<{ started: number; finished: number }> {
  const out = { started: 0, finished: 0 };
  for (const c of await EventsCampaign.find({ status: 'scheduled', scheduledAt: { $lte: ctx.now() } }).limit(5).lean()) {
    try { await startCampaign(ctx, String(c._id), { id: 'scheduler', type: 'system' }); out.started++; } catch (e) { ctx.log.warn({ channel: 'events', campaign: String(c._id), err: (e as Error).message }, 'scheduled campaign failed to start'); }
  }
  for (const c of await EventsCampaign.find({ status: 'sending' }).limit(20)) {
    const pending = await Job.countDocuments({ name: 'events_campaign_send', 'payload.campaignId': String(c._id), status: { $in: ['queued', 'active'] } });
    if (!pending) { c.status = 'sent'; c.finishedAt = ctx.now(); await c.save(); out.finished++; }
  }
  return out;
}

/* ------------------------------- experiments ------------------------------- */
export async function assignExperiment(key: string, visitorId: string) {
  const e = await EventsExperiment.findOne({ key, status: 'running' }).lean();
  if (!e) return null;
  return { key, variant: assignVariant(key, visitorId, e.variants as { key: string; weight: number }[]) };
}
/** Exposure is recorded server-side from the deterministic assignment; the client cannot choose its own variant. */
export async function exposeExperiment(key: string, visitorId: string) {
  const a = await assignExperiment(key, visitorId);
  if (!a) return null;
  await EventsExperimentEvent.updateOne({ experimentKey: key, visitorId, kind: 'exposure' }, { $setOnInsert: { variant: a.variant, ts: new Date() } }, { upsert: true });
  return a;
}
export async function convertExperiment(key: string, visitorId: string) {
  const exp = await EventsExperimentEvent.findOne({ experimentKey: key, visitorId, kind: 'exposure' }).lean();
  if (!exp) return false;
  await EventsExperimentEvent.updateOne({ experimentKey: key, visitorId, kind: 'conversion' }, { $setOnInsert: { variant: exp.variant, ts: new Date() } }, { upsert: true });
  return true;
}
export async function convertByEvent(visitorId: string, eventName: string): Promise<number> {
  let n = 0;
  for (const e of await EventsExperiment.find({ status: 'running', conversionEvent: eventName }).select('key').limit(20).lean()) if (await convertExperiment(e.key, visitorId)) n++;
  return n;
}
export async function experimentResults(key: string) {
  const e = await EventsExperiment.findOne({ key }).lean();
  if (!e) throw notFound('Experiment');
  const rows = await EventsExperimentEvent.aggregate<{ _id: { v: string; k: string }; n: number }>([{ $match: { experimentKey: key } }, { $group: { _id: { v: '$variant', k: '$kind' }, n: { $sum: 1 } } }]);
  const stat = (v: string) => ({ key: v, exposures: rows.find((r) => r._id.v === v && r._id.k === 'exposure')?.n ?? 0, conversions: rows.find((r) => r._id.v === v && r._id.k === 'conversion')?.n ?? 0 });
  return { experiment: { key: e.key, name: e.name, status: e.status, conversionEvent: e.conversionEvent, hypothesis: e.hypothesis, startedAt: e.startedAt }, ...assessExperiment((e.variants as { key: string }[]).map((v) => stat(v.key))), autoShip: false };
}

/* ------------------------------- attribution & performance ------------------------------- */
export async function attributionReport(ctx: Ctx, days: number, model: 'last' | 'first') {
  const fx = (await ctx.settings.get('ops')).fx;
  const since = new Date(ctx.now().getTime() - days * DAY);
  const usd = (n: number, cur: string) => convertMinor(n, cur as Currency, 'USD', fx);
  const orders = await Order.find({ 'payment.status': { $in: PAID }, 'payment.paidAt': { $gte: since }, isDemo: { $ne: true } }).select('currency amounts costs profit').limit(5000).lean();
  const carts = await Cart.find({ convertedOrderId: { $in: orders.map((o) => o._id) } }).select('token convertedOrderId').lean();
  const sessions = new Map((await EventsSession.find({ cartToken: { $in: carts.map((c) => c.token) } }).select('cartToken firstTouch lastTouch').lean()).map((s) => [s.cartToken, s]));
  const tokenByOrder = new Map(carts.map((c) => [String(c.convertedOrderId), c.token]));
  const own = new URL(ctx.cfg.WEB_URL).host;
  const rows = new Map<Channel, ChannelRow>();
  let attributed = 0;
  for (const o of orders) {
    const s = sessions.get(tokenByOrder.get(String(o._id)) ?? '');
    const touch = s ? (model === 'first' ? s.firstTouch : s.lastTouch) : null;
    const ch = classifyChannel(touch && (touch.utmSource || touch.utmMedium || touch.clickId || touch.referrerHost || touch.at) ? { utmSource: touch.utmSource, utmMedium: touch.utmMedium, clickIdType: touch.clickIdType, referrerHost: touch.referrerHost } : null, own);
    if (ch !== 'unattributed') attributed++;
    const r = rows.get(ch) ?? { channel: ch, orders: 0, netSalesUsd: 0, contributionKnownOrders: 0, contributionUsd: 0, adSpendUsd: 0 };
    const refunded = o.costs?.refunded ?? 0;
    r.orders++;
    r.netSalesUsd += usd(Math.max(0, (o.amounts?.subtotal ?? 0) - (o.amounts?.discount ?? 0) - refunded), o.currency);
    if ((o.costs?.supplierCost ?? 0) > 0) { r.contributionKnownOrders++; r.contributionUsd += usd((o.profit?.contribution ?? 0) - refunded, o.currency); }
    rows.set(ch, r);
  }
  const spend = await AdMetric.aggregate<{ _id: string; s: number }>([{ $match: { date: { $gte: since }, isDemo: { $ne: true } } }, { $group: { _id: '$platform', s: { $sum: '$spend' } } }]);
  for (const sp of spend) {
    const ch = PLATFORM_CHANNEL[sp._id];
    if (!ch) continue;
    const r = rows.get(ch) ?? { channel: ch, orders: 0, netSalesUsd: 0, contributionKnownOrders: 0, contributionUsd: 0, adSpendUsd: 0 };
    r.adSpendUsd = sp.s; rows.set(ch, r);
  }
  const measured = await MeasuredCpa.find({ scope: 'store', key: 'store', country: '*' }).lean();
  return {
    model, days, totalOrders: orders.length, attributionCoverage: orders.length ? attributed / orders.length : null,
    channels: [...rows.values()].map(reportChannel).sort((a, b) => b.orders - a.orders),
    measuredCpaStore: measured.map((m) => ({ channel: m.channel, spendUsd: m.spend, orders: m.orders, cpaUsd: m.orders ? Math.round(m.spend / m.orders) : null, source: m.source })),
    caveats: ['Only orders whose shopper granted tracking consent carry attribution; the rest are "unattributed". Platform spend covers all clicks, so CAC here is an upper bound.', 'Contribution is the order ledger figure minus refunds; orders awaiting supplier cost are excluded from contribution.', 'Nothing here changes budgets. Ad activation stays a capped, authorised proposal.'],
  };
}

export async function campaignProductPerformance(ctx: Ctx, days: number, limit = 50) {
  const fx = (await ctx.settings.get('ops')).fx;
  const since = new Date(ctx.now().getTime() - days * DAY);
  const usd = (n: number, cur: string) => convertMinor(n, cur as Currency, 'USD', fx);
  const ev = await AnalyticsEvent.aggregate<{ _id: { p: unknown; t: string }; n: number }>([{ $match: { ts: { $gte: since }, productId: { $exists: true }, type: { $in: ['product_view', 'add_to_cart'] } } }, { $group: { _id: { p: '$productId', t: '$type' }, n: { $sum: 1 } } }]);
  const by = new Map<string, { views: number; carts: number; orders: number; units: number; netSalesUsd: number; contributionUsd: number }>();
  const row = (id: string) => by.get(id) ?? (by.set(id, { views: 0, carts: 0, orders: 0, units: 0, netSalesUsd: 0, contributionUsd: 0 }), by.get(id)!);
  for (const e of ev) { const r = row(String(e._id.p)); if (e._id.t === 'product_view') r.views = e.n; else r.carts = e.n; }
  const orders = await Order.find({ 'payment.status': { $in: PAID }, 'payment.paidAt': { $gte: since }, isDemo: { $ne: true } }).select('currency items amounts costs profit').limit(5000).lean();
  for (const o of orders) {
    const gross = o.items.reduce((a, i) => a + i.unitPrice * i.quantity, 0) || 1;
    const keep = Math.max(0, 1 - (o.costs?.refunded ?? 0) / Math.max(1, o.amounts?.total ?? 1));
    for (const i of o.items) {
      const share = (i.unitPrice * i.quantity) / gross;
      const r = row(String(i.productId));
      r.orders++; r.units += i.quantity; r.netSalesUsd += usd(i.unitPrice * i.quantity * keep, o.currency);
      if ((o.costs?.supplierCost ?? 0) > 0) r.contributionUsd += usd((o.profit?.contribution ?? 0) * share * keep, o.currency);
    }
  }
  const top = [...by.entries()].sort((a, b) => b[1].netSalesUsd - a[1].netSalesUsd).slice(0, limit);
  const titles = new Map((await Product.find({ _id: { $in: top.map(([id]) => id) } }).select('title').lean()).map((p) => [String(p._id), p.title]));
  return { days, items: top.map(([id, r]) => ({ productId: id, title: titles.get(id) ?? id, ...r, viewToCart: r.views ? r.carts / r.views : null, cartToOrder: r.carts ? r.orders / r.carts : null })) };
}

/* ------------------------------- feeds ------------------------------- */
export async function loadFeed(ctx: Ctx, country: CountryCode, limit = 5000): Promise<{ items: FeedItem[]; excluded: Partial<Record<Exclusion, number>> }> {
  const prods = await Product.find({ state: { $in: SELLABLE_STATES as unknown as string[] }, isDemo: { $ne: true }, deletedAt: { $exists: false }, 'markets.country': country }).sort({ updatedAt: -1 }).limit(limit).lean();
  const items: FeedItem[] = [];
  const excluded: Partial<Record<Exclusion, number>> = {};
  for (const p of prods) {
    const m = p.markets.find((x) => x.country === country);
    const r = toFeedItem({ id: String(p._id), slug: p.slug, sku: p.sku, title: p.title, brand: p.brand, description: p.description, state: p.state, isDemo: p.isDemo, complianceStatus: p.compliance?.status, imageStatus: p.imageStatus, images: p.images ?? [], category: p.category, topCategory: p.topCategory, market: m ? { enabled: m.enabled !== false, price: m.price, currency: m.currency ?? '', stock: m.stock ?? 0 } : undefined }, ctx.cfg.WEB_URL);
    if ('item' in r) items.push(r.item); else excluded[r.excluded] = (excluded[r.excluded] ?? 0) + 1;
  }
  return { items, excluded };
}
export const googleFeed = async (ctx: Ctx, country: CountryCode) => { const f = await loadFeed(ctx, country); return { ...f, body: buildGoogleFeedXml(f.items, { title: `Orvia ${country}`, link: ctx.cfg.WEB_URL, description: 'Orvia product feed' }) }; };
export const metaFeed = async (ctx: Ctx, country: CountryCode) => { const f = await loadFeed(ctx, country); return { ...f, body: buildMetaFeedCsv(f.items) }; };

export { signToken };
