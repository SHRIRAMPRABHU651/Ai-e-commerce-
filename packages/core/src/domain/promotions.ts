import { Order, Promotion } from '@orvia/database';
import type { CountryCode } from '@orvia/types';

export interface PromoLine {
  productId: string;
  quantity: number;
  unitPrice: number;
  landedCost: number;
}

export interface PromoInput {
  country: CountryCode;
  subtotal: number;
  lines: PromoLine[];
  email?: string;
  couponCode?: string;
  isFirstOrder: boolean;
  now: Date;
}

export interface AppliedPromo {
  promotionId: string;
  name: string;
  type: string;
  amount: number;
  code?: string;
}

export interface PromoResult {
  discount: number;
  freeShipping: boolean;
  applied: AppliedPromo[];
  couponError?: string;
  clamped: boolean;
}

type PromoDoc = Awaited<ReturnType<typeof loadActive>>[number];

async function loadActive(now: Date, country: CountryCode, code?: string) {
  return Promotion.find({
    active: true,
    $and: [
      { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] },
      { $or: [{ endsAt: null }, { endsAt: { $gte: now } }] },
      { $or: [{ countries: { $size: 0 } }, { countries: country }] },
      code ? { $or: [{ code: { $exists: false } }, { code: null }, { code: code.toUpperCase() }] } : { $or: [{ code: { $exists: false } }, { code: null }] },
    ],
  })
    .limit(50)
    .lean();
}

function mapGet(m: unknown, key: string): number | undefined {
  if (!m) return undefined;
  if (m instanceof Map) return m.get(key) as number | undefined;
  return (m as Record<string, number>)[key];
}

function amountFor(p: PromoDoc, i: PromoInput): number {
  const eligibleLines = p.productIds?.length ? i.lines.filter((l) => p.productIds.some((id) => String(id) === l.productId)) : i.lines;
  const base = eligibleLines.reduce((a, l) => a + l.unitPrice * l.quantity, 0);
  const min = mapGet(p.minSubtotal, i.country) ?? 0;
  if (i.subtotal < min) return 0;
  switch (p.type) {
    case 'percentage':
    case 'flash_sale':
    case 'seasonal':
    case 'cart':
      if (p.type === 'cart' && !p.percent) return Math.min(mapGet(p.fixedAmount, i.country) ?? 0, i.subtotal);
      return Math.round(base * (p.percent ?? 0));
    case 'first_order':
      return i.isFirstOrder ? Math.round(base * (p.percent ?? 0)) : 0;
    case 'fixed':
      return Math.min(mapGet(p.fixedAmount, i.country) ?? 0, base);
    case 'bxgy': {
      const buy = p.bxgy?.buy ?? 1;
      const get = p.bxgy?.get ?? 1;
      const units = eligibleLines.flatMap((l) => Array.from({ length: l.quantity }, () => l.unitPrice)).sort((a, b) => b - a);
      const group = buy + get;
      const free = Math.floor(units.length / group) * get;
      return units.slice(units.length - free).reduce((a, b) => a + b, 0);
    }
    default:
      return 0;
  }
}

/**
 * Evaluate promotions. Rules: best single discount promo wins; free shipping stacks; the discount is
 * clamped so the order can never fall below landed cost (promotions must not create negative-margin orders).
 */
export async function evaluatePromotions(i: PromoInput): Promise<PromoResult> {
  const promos = await loadActive(i.now, i.country, i.couponCode);
  let couponError: string | undefined;
  if (i.couponCode) {
    const match = promos.find((p) => p.code === i.couponCode!.toUpperCase());
    if (!match) couponError = 'This code is invalid or has expired';
    else {
      if (match.usageLimit > 0 && match.usedCount >= match.usageLimit) couponError = 'This code has reached its usage limit';
      else if (i.email && match.perUserLimit > 0) {
        const used = await Order.countDocuments({ email: i.email, couponCode: match.code, status: { $nin: ['CANCELLED'] } });
        if (used >= match.perUserLimit) couponError = 'You have already used this code';
      }
      if (!couponError && match.type === 'first_order' && !i.isFirstOrder) couponError = 'This code is for first orders only';
    }
  }
  const usable = promos.filter((p) => !p.code || (p.code === i.couponCode?.toUpperCase() && !couponError));
  let freeShipping = false;
  const discountCandidates: AppliedPromo[] = [];
  for (const p of usable) {
    if (p.type === 'free_shipping') {
      if (i.subtotal >= (mapGet(p.minSubtotal, i.country) ?? 0)) {
        freeShipping = true;
      }
      continue;
    }
    const amount = amountFor(p, i);
    if (amount > 0) discountCandidates.push({ promotionId: String(p._id), name: p.name, type: p.type, amount, code: p.code ?? undefined });
  }
  discountCandidates.sort((a, b) => b.amount - a.amount);
  const best = discountCandidates[0];
  let discount = best?.amount ?? 0;
  const applied = best ? [best] : [];
  if (freeShipping) {
    const fs = usable.find((p) => p.type === 'free_shipping');
    if (fs) applied.push({ promotionId: String(fs._id), name: fs.name, type: 'free_shipping', amount: 0, code: fs.code ?? undefined });
  }
  // margin protection + sanity cap
  const landed = i.lines.reduce((a, l) => a + l.landedCost * l.quantity, 0);
  const maxDiscount = Math.max(0, Math.min(Math.round(i.subtotal * 0.5), i.subtotal - Math.round(landed * 1.05)));
  const clamped = discount > maxDiscount;
  if (clamped) {
    discount = maxDiscount;
    if (best) best.amount = maxDiscount;
  }
  return { discount, freeShipping, applied, couponError, clamped };
}

export async function redeemPromotion(promotionId: string): Promise<boolean> {
  const p = await Promotion.findOneAndUpdate(
    { _id: promotionId, $or: [{ usageLimit: 0 }, { $expr: { $lt: ['$usedCount', '$usageLimit'] } }] },
    { $inc: { usedCount: 1 } },
  );
  return !!p;
}

export async function releasePromotion(promotionId: string): Promise<void> {
  await Promotion.updateOne({ _id: promotionId, usedCount: { $gt: 0 } }, { $inc: { usedCount: -1 } });
}
