import { Product } from '@orvia/database';
import type { Client } from './client';
import { address } from './client';

export async function firstProducts(c: Client, country = 'US', n = 3) {
  const r = await c.get(`/api/v1/products?pageSize=48&country=${country}`);
  return r.body.items.filter((x: any) => x.available).slice(0, n) as { id: string; slug: string; title: string; price: number }[];
}

/** Add to cart + checkout; returns order + payment intent. */
export async function placeOrder(c: Client, opts: { country?: 'US' | 'CA' | 'IN'; productIdx?: number; qty?: number; email?: string; key?: string; products?: { id: string; slug: string }[] } = {}) {
  const country = opts.country ?? 'US';
  const prods = opts.products ?? (await firstProducts(c, country, 6));
  const p = prods[opts.productIdx ?? 0]!;
  const d = await c.get(`/api/v1/products/${p.slug}?country=${country}`);
  const add = await c.post(`/api/v1/cart/items?country=${country}`, { productId: p.id, variantSku: d.body.variants[0].sku, quantity: opts.qty ?? 1 });
  if (add.status !== 200) throw new Error(`add to cart failed: ${JSON.stringify(add.body)}`);
  const co = await c.post(`/api/v1/checkout`, { email: opts.email ?? `buyer${Math.random().toString(36).slice(2, 7)}@example.com`, address: address[country], shippingMethod: 'standard', idempotencyKey: opts.key ?? `k-${Math.random().toString(36).slice(2)}-${Date.now()}` });
  return { co, product: p };
}

export async function pay(c: Client, intent: string) {
  return c.post(`/api/v1/dev/payments/${intent}/simulate`, { outcome: 'succeeded' });
}

export const setStock = (id: string, country: string, stock: number) => Product.updateOne({ _id: id, 'markets.country': country }, { $set: { 'markets.$.stock': stock } });
