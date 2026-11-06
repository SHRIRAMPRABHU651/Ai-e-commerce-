/**
 * Tiny leaf module called from the order lifecycle (cart.ts / orders.ts). Imports nothing from orders/cart, so no cycles.
 * Everything here is best-effort: a creator-program failure must never block checkout or delivery handling.
 */
import { getCountry } from '../../infra/countries';
import type { Ctx } from '../../infra/context';
import { getRules } from './config';

/** Plain copy of the cart's creator attribution for the order document (undefined = none, or already lapsed at checkout). */
export function attributionForOrder(cart: { toObject?: () => unknown } | { creatorAttribution?: unknown }, now: Date = new Date()): Record<string, unknown> | undefined {
  const raw = (typeof (cart as { toObject?: unknown }).toObject === 'function' ? (cart as { toObject: () => { creatorAttribution?: unknown } }).toObject() : cart) as { creatorAttribution?: Record<string, unknown> };
  const a = raw.creatorAttribution;
  if (!a || !a.creatorId) return undefined;
  const exp = a.expiresAt instanceof Date ? a.expiresAt : undefined;
  if (exp && exp.getTime() < now.getTime()) return undefined; // window lapsed before the order was placed
  return { ...a };
}

/** Enqueue commission accrual + loyalty earning when an order is delivered. */
export async function enqueueDeliveryJobs(
  ctx: Ctx,
  order: { _id: unknown; userId?: unknown; country: string; creatorAttribution?: { creatorId?: unknown } | null },
): Promise<void> {
  try {
    const orderId = String(order._id);
    if (order.creatorAttribution?.creatorId) {
      await ctx.queue.enqueue('creator_commission_accrue', { orderId }, { delayMs: ctx.cfg.isProduction ? 60_000 : 1_000, dedupeKey: `creator-accrue:${orderId}` });
    }
    if (order.userId) {
      const [cfg, rules] = await Promise.all([getCountry(order.country as 'US'), getRules()]);
      const days = cfg.returnWindowDays + rules.holdBufferDays;
      await ctx.queue.enqueue('loyalty_earn', { orderId }, { delayMs: ctx.cfg.isProduction ? days * 86_400_000 : 60_000, dedupeKey: `loyalty-earn:${orderId}` });
    }
  } catch (e) {
    ctx.log.error({ channel: 'error', err: (e as Error).message }, 'creator/loyalty enqueue failed');
  }
}
