import type { MetadataRoute } from 'next';
import { SITE_URL, sget } from '@/lib/server';
import type { Meta, StoreProduct } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const meta = await sget<Meta>('/meta', { country: 'US' }).catch(() => null);
  const prods = await sget<{ items: StoreProduct[] }>('/products?pageSize=100&sort=newest', { country: 'US' }).catch(() => null);
  const now = new Date();
  return [
    { url: SITE_URL, lastModified: now, priority: 1 },
    ...(meta?.categories.flatMap((c) => [{ url: `${SITE_URL}/c/${c.slug}`, lastModified: now, priority: 0.8 }, ...c.children.map((ch) => ({ url: `${SITE_URL}/c/${ch.slug}`, lastModified: now, priority: 0.6 }))]) ?? []),
    ...(prods?.items.map((p) => ({ url: `${SITE_URL}/p/${p.slug}`, lastModified: now, priority: 0.7 })) ?? []),
    { url: `${SITE_URL}/help`, lastModified: now, priority: 0.4 },
  ];
}
