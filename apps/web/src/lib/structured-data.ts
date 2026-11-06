/** schema.org JSON-LD generators (pure). Only claims what the data supports: aggregateRating needs real review data, no invented prices or availability. */

export interface LdProductInput {
  id: string;
  slug: string;
  title: string;
  description?: string | null;
  brand?: string | null;
  images: { url: string }[];
  /** Minor units; null/0 means "no valid price" and the Offer is omitted entirely. */
  price: number | null;
  currency?: string | null;
  available: boolean;
  /** Only passed through when count > 0. */
  rating?: { avg: number; count: number } | null;
}

const abs = (u: string, site: string) => { try { return new URL(u, site).toString(); } catch { return undefined; } };

export function buildProductJsonLd(p: LdProductInput, siteUrl: string): Record<string, unknown> {
  const site = siteUrl.replace(/\/$/, '');
  const images = p.images.map((i) => abs(i.url, site)).filter((u): u is string => !!u);
  const hasPrice = typeof p.price === 'number' && p.price > 0 && !!p.currency;
  const rated = !!p.rating && p.rating.count > 0 && p.rating.avg >= 1 && p.rating.avg <= 5;
  return {
    '@context': 'https://schema.org', '@type': 'Product', '@id': `${site}/p/${p.slug}#product`, name: p.title,
    ...(p.description ? { description: p.description } : {}), ...(images.length ? { image: images } : {}), sku: p.id, brand: { '@type': 'Brand', name: p.brand || 'Orvia' },
    ...(rated ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: Number(p.rating!.avg.toFixed(2)), reviewCount: p.rating!.count } } : {}),
    ...(hasPrice ? { offers: { '@type': 'Offer', url: `${site}/p/${p.slug}`, priceCurrency: p.currency, price: (p.price! / 100).toFixed(2), availability: p.available ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock', itemCondition: 'https://schema.org/NewCondition' } } : {}),
  };
}

export function buildBreadcrumbJsonLd(crumbs: { label: string; href: string }[], siteUrl: string): Record<string, unknown> {
  const site = siteUrl.replace(/\/$/, '');
  return { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: crumbs.map((b, i) => ({ '@type': 'ListItem', position: i + 1, name: b.label, item: `${site}${b.href}` })) };
}

/** Serialise for a <script type="application/ld+json"> tag: `<` is escaped so data can never close the tag. */
export const serializeJsonLd = (data: unknown): string => JSON.stringify(data).replace(/</g, '\\u003c').replace(new RegExp('\\u2028', 'g'), '\\u2028').replace(new RegExp('\\u2029', 'g'), '\\u2029');

/**
 * hreflang/canonical: the storefront resolves the country from a cookie / geo header, not from the URL, so every country shares one URL.
 * There are therefore NO per-country alternates to declare; the canonical is the single URL. (Returns null so callers do not emit false hreflang.)
 */
export const hreflangAlternates = (): null => null;
