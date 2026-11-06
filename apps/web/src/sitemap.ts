import type { MetadataRoute } from 'next';
import { SITE_URL, sget } from '@/lib/server';
import type { Meta, StoreProduct } from '@/lib/types';

export const dynamic = 'force-dynamic';

const MAX_PAGES = 20; // 20 x 100 = 2,000 products per sitemap (the protocol limit is 50,000 URLs)

/**
 * Home, categories, shop-by-need pages, products (paginated, real catalogue only), help/legal/track pages.
 * Creator pages are added by the creators workstream. The storefront has ONE URL per page for all countries (country comes from a
 * cookie / geo header), so there are no per-country alternates and no hreflang.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const meta = await sget<Meta>('/meta', { country: 'US' }).catch(() => null);
  const needs = await sget<{ needs: { slug: string }[] }>('/needs', { country: 'US' }).catch(() => null);
  const products: StoreProduct[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await sget<{ items: StoreProduct[]; total: number }>(`/products?pageSize=100&page=${page}&sort=newest`, { country: 'US' }).catch(() => null);
    if (!r?.items.length) break;
    products.push(...r.items);
    if (products.length >= r.total) break;
  }
  const now = new Date();
  const u = (path: string, priority: number, changeFrequency: 'daily' | 'weekly' | 'monthly' = 'weekly') => ({ url: `${SITE_URL}${path}`, lastModified: now, changeFrequency, priority });
  return [
    u('', 1, 'daily'),
    ...(meta?.categories.flatMap((c) => [u(`/c/${c.slug}`, 0.8, 'daily'), ...c.children.map((ch) => u(`/c/${ch.slug}`, 0.6))]) ?? []),
    ...(needs?.needs.map((n) => u(`/needs/${n.slug}`, 0.7)) ?? []),
    ...products.map((p) => u(`/p/${p.slug}`, 0.7)),
    u('/help', 0.4, 'monthly'), u('/track', 0.3, 'monthly'),
    ...['returns', 'shipping', 'privacy', 'terms'].map((d) => u(`/legal/${d}`, 0.3, 'monthly')),
  ];
}
