import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/server';

/** Private/transactional areas and the unlisted API are never crawled; product feeds stay fetchable. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: ['/', '/feeds/'], disallow: ['/admin', '/account', '/checkout', '/cart', '/orders', '/api/', '/login', '/register', '/forgot-password', '/reset-password', '/verify-email'] }],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
