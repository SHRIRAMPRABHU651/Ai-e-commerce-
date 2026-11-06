import { SITE_URL } from '@/lib/server';
import { buildBreadcrumbJsonLd, buildProductJsonLd, serializeJsonLd } from '@/lib/structured-data';
import type { LdProductInput } from '@/lib/structured-data';

/**
 * Server component for the product page: `<ProductStructuredData product={...} breadcrumbs={d.breadcrumbs} />`.
 * Maps from the storefront's ProductPage payload (`p.rating.count` is only emitted when real reviews exist).
 */
export function ProductStructuredData({ product, breadcrumbs }: { product: LdProductInput; breadcrumbs: { label: string; href: string }[] }) {
  const ld = [buildProductJsonLd(product, SITE_URL), buildBreadcrumbJsonLd(breadcrumbs, SITE_URL)];
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(ld) }} />;
}
