import { effectiveImages } from './images';
import { randomToken } from '@orvia/auth';
import { Cart, Order, Product, ProductVariant } from '@orvia/database';
import { estimateDelivery, orderTotals, pickShipping, shippingOptions } from '@orvia/shipping';
import type { OrderTotals, ShippingOption } from '@orvia/shipping';
import type { CountryCode } from '@orvia/types';
import { getCountry } from '../infra/countries';
import { DomainError, notFound } from '../infra/context';
import type { Ctx } from '../infra/context';
import { evaluatePromotions } from './promotions';
import type { AppliedPromo } from './promotions';
import { isSellable } from './catalog';

export interface CartLine {
  productId: string;
  slug: string;
  title: string;
  image?: string;
  sku: string;
  variantLabel?: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  landedCost: number;
  available: boolean;
  maxQty: number;
  issue?: string;
}

export interface CartView {
  token: string;
  country: CountryCode;
  currency: string;
  lines: CartLine[];
  itemCount: number;
  subtotal: number;
  discount: number;
  promotions: AppliedPromo[];
  couponCode?: string;
  couponError?: string;
  shippingOptions: ShippingOption[];
  shippingMethod: string;
  totals: OrderTotals;
  delivery: { label: string } | null;
  issues: string[];
  checkoutBlocked: boolean;
  freeShippingRemaining: number | null;
  legalNotice: string;
}

export async function getOrCreateCart(token: string | undefined, userId: string | undefined, country: CountryCode) {
  if (token) {
    const c = await Cart.findOne({ token });
    if (c && !c.convertedOrderId) {
      if (userId && !c.userId) c.userId = userId as never;
      if (c.country !== country) c.country = country;
      return c;
    }
  }
  if (userId) {
    const existing = await Cart.findOne({ userId, convertedOrderId: { $exists: false } }).sort({ updatedAt: -1 });
    if (existing) return existing;
  }
  return Cart.create({ token: randomToken(24), userId, country, items: [], lastActivityAt: new Date() });
}

export async function addToCart(ctx: Ctx, token: string, input: { productId: string; variantSku?: string; quantity: number }) {
  const cart = await Cart.findOne({ token });
  if (!cart) throw notFound('Cart');
  const product = await Product.findById(input.productId).select('state markets images title').lean();
  if (!product || !isSellable(product.state) || effectiveImages(product as never, cart.country ?? "US").length === 0) throw new DomainError('This product is not available', 'UNAVAILABLE', 409);
  const market = product.markets.find((m) => m.country === cart.country && m.enabled);
  if (!market || market.price <= 0 || market.stock <= 0) throw new DomainError('Not available in your country right now', 'UNAVAILABLE', 409);
  const variants = await ProductVariant.find({ productId: input.productId, active: true }).select('sku').lean();
  const sku = input.variantSku ?? variants[0]?.sku;
  if (!sku || !variants.some((v) => v.sku === sku)) throw new DomainError('Unknown variant', 'BAD_VARIANT', 422);
  const line = cart.items.find((i) => String(i.productId) === input.productId && i.sku === sku);
  const qty = Math.min(10, (line?.quantity ?? 0) + input.quantity, Math.max(1, market.stock));
  if (line) line.quantity = qty;
  else cart.items.push({ productId: input.productId as never, sku, quantity: qty });
  cart.lastActivityAt = ctx.now();
  cart.abandonment = { stage: 0, stopped: false } as never;
  await cart.save();
  return cart;
}

export async function setCartQuantity(ctx: Ctx, token: string, productId: string, sku: string, quantity: number) {
  const cart = await Cart.findOne({ token });
  if (!cart) throw notFound('Cart');
  const idx = cart.items.findIndex((i) => String(i.productId) === productId && i.sku === sku);
  if (idx === -1) throw notFound('Cart item');
  if (quantity <= 0) cart.items.splice(idx, 1);
  else cart.items[idx]!.quantity = Math.min(10, quantity);
  cart.lastActivityAt = ctx.now();
  await cart.save();
  return cart;
}

export async function setCartContact(ctx: Ctx, token: string, email: string, marketingConsent: boolean) {
  await Cart.updateOne({ token }, { $set: { email, marketingConsent, lastActivityAt: ctx.now() } });
}

export async function priceCart(ctx: Ctx, token: string, opts: { region?: string; shippingMethod?: string; email?: string } = {}): Promise<CartView> {
  const cart = await Cart.findOne({ token }).lean();
  if (!cart) throw notFound('Cart');
  const country = cart.country as CountryCode;
  const cfg = await getCountry(country);
  const ids = cart.items.map((i) => i.productId);
  const [products, variants] = await Promise.all([
    Product.find({ _id: { $in: ids } }).select('slug title images markets state').lean(),
    ProductVariant.find({ productId: { $in: ids } }).select('sku label productId image').lean(),
  ]);
  const pMap = new Map(products.map((p) => [String(p._id), p]));
  const vMap = new Map(variants.map((v) => [v.sku, v]));
  const issues: string[] = [];
  const lines: CartLine[] = [];
  for (const it of cart.items) {
    const p = pMap.get(String(it.productId));
    const m = p?.markets.find((x) => x.country === country && x.enabled);
    const v = vMap.get(it.sku);
    const ok = !!p && isSellable(p.state) && !!m && m.price > 0 && m.stock > 0 && !!v;
    let issue: string | undefined;
    if (!p || !m || !isSellable(p.state)) issue = 'No longer available';
    else if (m.stock <= 0) issue = 'Out of stock';
    else if (it.quantity > m.stock) issue = `Only ${m.stock} left`;
    if (issue) issues.push(`${p?.title ?? 'An item'}: ${issue}`);
    lines.push({
      productId: String(it.productId),
      slug: p?.slug ?? '',
      title: p?.title ?? 'Unavailable item',
      image: v?.image ?? p?.images?.[0]?.url ?? undefined,
      sku: it.sku,
      variantLabel: v && v.label !== 'Default' ? (v.label ?? undefined) : undefined,
      quantity: it.quantity,
      unitPrice: m?.price ?? 0,
      lineTotal: (m?.price ?? 0) * it.quantity,
      landedCost: m?.landedCost ?? 0,
      available: ok && it.quantity <= (m?.stock ?? 0),
      maxQty: Math.min(10, m?.stock ?? 0),
      issue,
    });
  }
  const priced = lines.filter((l) => l.available);
  const subtotal = priced.reduce((a, l) => a + l.lineTotal, 0);
  const isFirstOrder = opts.email ? (await Order.countDocuments({ email: opts.email, status: { $nin: ['CANCELLED', 'PENDING_PAYMENT'] } })) === 0 : true;
  const promo = await evaluatePromotions({
    country, subtotal, lines: priced.map((l) => ({ productId: l.productId, quantity: l.quantity, unitPrice: l.unitPrice, landedCost: l.landedCost })),
    email: opts.email ?? cart.email ?? undefined, couponCode: cart.couponCode ?? undefined, isFirstOrder, now: ctx.now(),
  });
  const shipOpts = shippingOptions(cfg, subtotal - promo.discount, promo.freeShipping);
  const chosen = pickShipping(cfg, opts.shippingMethod ?? 'standard', subtotal - promo.discount, promo.freeShipping);
  const totals = orderTotals(cfg, opts.region ?? '', subtotal, promo.discount, priced.length ? chosen.charge : 0);
  const mm = products.flatMap((p) => p.markets.filter((m) => m.country === country && m.maxDays));
  const delivery = priced.length && mm.length ? estimateDelivery(Math.max(...mm.map((m) => m.minDays ?? 0)), Math.max(...mm.map((m) => m.maxDays ?? 0)), cfg.locale, ctx.now()) : null;
  const standard = cfg.shippingMethods.find((s) => s.code === 'standard');
  return {
    token, country, currency: cfg.currency, lines, itemCount: lines.reduce((a, l) => a + l.quantity, 0), subtotal, discount: promo.discount,
    promotions: promo.applied, couponCode: cart.couponCode ?? undefined, couponError: promo.couponError, shippingOptions: shipOpts, shippingMethod: chosen.code, totals,
    delivery: delivery ? { label: delivery.label } : null, issues, checkoutBlocked: !priced.length || issues.length > 0,
    freeShippingRemaining: standard?.freeOver ? Math.max(0, standard.freeOver - (subtotal - promo.discount)) : null, legalNotice: cfg.legalNotice,
  };
}

export async function applyCoupon(ctx: Ctx, token: string, code: string | null) {
  await Cart.updateOne({ token }, { $set: { couponCode: code ? code.trim().toUpperCase() : undefined, lastActivityAt: ctx.now() } });
  if (!code) await Cart.updateOne({ token }, { $unset: { couponCode: '' } });
}
