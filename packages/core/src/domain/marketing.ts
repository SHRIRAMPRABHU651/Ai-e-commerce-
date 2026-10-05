import { randomBytes } from 'node:crypto';
import { AnalyticsEvent, Cart, Order, Product, Promotion } from '@orvia/database';
import { DEFAULT_COUNTRIES } from '@orvia/types';
import type { CountryCode } from '@orvia/types';
import type { Ctx } from '../infra/context';
import { proposeOrExecute, registerExecutor } from './automation';
import { notify } from './notify';
import { countryAnalytics, parseRange } from './reporting';
import { audit } from '../infra/audit';
import { aiActor } from '../infra/context';

export interface TrackInput {
  type: 'page_view' | 'product_view' | 'add_to_cart' | 'checkout_start' | 'search';
  sessionId: string;
  productId?: string;
  category?: string;
  country?: CountryCode;
  userId?: string;
  meta?: Record<string, string | number>;
}

export async function trackEvent(ctx: Ctx, e: TrackInput): Promise<void> {
  await AnalyticsEvent.create({ ...e, ts: ctx.now() });
  if (e.type === 'product_view' && e.productId) await Product.updateOne({ _id: e.productId }, { $inc: { 'stats.views': 1 } });
}

/**
 * Abandoned-cart sequence: reminder -> benefits -> optional one-time discount. Only for shoppers who gave
 * marketing consent; stops permanently once they purchase.
 */
export async function runAbandonedCarts(ctx: Ctx): Promise<{ sent: number; stopped: number }> {
  const mode = await ctx.settings.automationMode('abandoned_cart');
  if (mode === 'OFF') return { sent: 0, stopped: 0 };
  const ops = await ctx.settings.get('ops');
  const out = { sent: 0, stopped: 0 };
  const carts = await Cart.find({ email: { $exists: true, $ne: null }, marketingConsent: true, convertedOrderId: { $exists: false }, 'abandonment.stopped': { $ne: true }, 'items.0': { $exists: true } }).limit(200);
  for (const c of carts) {
    const bought = await Order.exists({ email: c.email, createdAt: { $gte: c.createdAt }, 'payment.status': 'succeeded' });
    if (bought) {
      c.abandonment = { ...(c.abandonment as object), stopped: true } as never;
      await c.save();
      out.stopped++;
      continue;
    }
    const stage = c.abandonment?.stage ?? 0;
    if (stage >= 3) continue;
    const delayMin = ops.abandonedCartDelayMinutes[stage] ?? 1440;
    const since = stage === 0 ? c.lastActivityAt : (c.abandonment?.lastSentAt ?? c.lastActivityAt);
    if (ctx.now().getTime() - since.getTime() < delayMin * 60_000) continue;
    const first = await Product.findById(c.items[0]!.productId).select('title benefits slug').lean();
    const url = `${ctx.cfg.WEB_URL}/cart`;
    let code: string | undefined;
    if (stage === 2) {
      const pm = await ctx.settings.automationMode('promotion_optimization');
      if (pm === 'AUTOMATIC') {
        code = `BACK-${randomBytes(3).toString('hex').toUpperCase()}`;
        await Promotion.create({ name: `Abandoned cart ${code}`, type: 'percentage', code, percent: 0.05, countries: [c.country], usageLimit: 1, perUserLimit: 1, endsAt: new Date(ctx.now().getTime() + 3 * 86_400_000), automated: true, recommendedBy: 'abandoned-cart' });
      }
    }
    const template = (['abandoned_cart_1', 'abandoned_cart_2', 'abandoned_cart_3'] as const)[stage]!;
    const id = await notify(ctx, { template: stage === 2 && !code ? 'abandoned_cart_2' : template, to: c.email!, data: { productTitle: first?.title, items: first?.title, benefits: first?.benefits?.slice(0, 2).join(' · ') || undefined, code, discount: code ? '5% off' : undefined, url }, dedupeKey: `abandoned:${c._id}:${stage}` });
    c.abandonment = { stage: stage + 1, lastSentAt: ctx.now(), stopped: false } as never;
    await c.save();
    if (id) out.sent++;
  }
  return out;
}

/**
 * Promotion agent: if a market converts far below the best market, recommend a first-order promotion
 * (only where margins can afford it). ASSISTED by default: an admin approves.
 */
export async function recommendPromotions(ctx: Ctx): Promise<{ recommended: number }> {
  const range = parseRange('30d', undefined, undefined, ctx.now());
  const { countries } = await countryAnalytics(ctx, range);
  const withData = countries.filter((c) => c.sessions >= 100);
  if (withData.length < 2) return { recommended: 0 };
  const best = [...withData].sort((a, b) => b.conversionRate - a.conversionRate)[0]!;
  let n = 0;
  for (const c of withData) {
    if (c.country === best.country || best.conversionRate === 0) continue;
    const gap = 1 - c.conversionRate / best.conversionRate;
    if (gap < 0.2) continue;
    if (c.orders > 0 && c.profitPerOrder < 0) continue; // cannot afford a discount
    const exists = await Promotion.exists({ type: 'first_order', countries: c.country, active: true });
    if (exists) continue;
    const r = await proposeOrExecute(ctx, {
      automationKey: 'promotion_optimization', agent: 'MarketingAgent', kind: 'create_promotion', resource: 'promotion',
      summary: `${DEFAULT_COUNTRIES[c.country].name} conversion rate is ${(gap * 100).toFixed(0)}% below ${DEFAULT_COUNTRIES[best.country].name} (${(c.conversionRate * 100).toFixed(2)}% vs ${(best.conversionRate * 100).toFixed(2)}%). Recommend a 10% first-order promotion.`,
      payload: { country: c.country, percent: 0.1 }, confidence: 0.6, dedupeKey: `promo:${c.country}`,
    });
    if (r.status !== 'skipped') n++;
  }
  return { recommended: n };
}

registerExecutor('create_promotion', async (ctx, p, actor) => {
  const country = String(p['country']) as CountryCode;
  const percent = Number(p['percent'] ?? 0.1);
  const pricing = await ctx.settings.get('pricing');
  if (percent > pricing.maxDiscountPct + 0.1) throw new Error('Promotion exceeds the configured discount limits');
  const promo = await Promotion.create({ name: `First order ${percent * 100}% — ${country}`, type: 'first_order', code: `FIRST${Math.round(percent * 100)}${country}`, countries: [country], percent, perUserLimit: 1, active: true, automated: true, recommendedBy: actor.id });
  await audit(ctx, actor.type === 'ai' ? actor : aiActor('MarketingAgent'), { action: 'promotion.created', resource: 'promotion', resourceId: String(promo._id), newValue: { country, percent } });
  return { promotionId: String(promo._id), code: promo.code };
});
