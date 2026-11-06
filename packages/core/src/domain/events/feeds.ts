/**
 * Product feeds (Google Merchant RSS 2.0 / Meta catalogue CSV). Eligibility and serialisation are pure.
 * Honesty rules: only sellable, compliant, non-demo products with a real image and a valid price are listed; availability mirrors
 * real stock; compare-at prices are NEVER emitted (no verified price history exists, so no "sale" is claimed).
 */
import { SELLABLE_STATES } from '@orvia/types';

export interface FeedProductInput {
  id: string;
  slug: string;
  sku: string;
  title: string;
  brand?: string | null;
  description?: string | null;
  state: string;
  isDemo?: boolean;
  deleted?: boolean;
  complianceStatus?: string;
  imageStatus?: string;
  images: { url?: string | null }[];
  category?: string | null;
  topCategory?: string | null;
  market: { enabled: boolean; price: number; currency: string; stock: number } | undefined;
}

export interface FeedItem {
  id: string; title: string; description: string; link: string; imageLink: string; additionalImages: string[];
  availability: 'in_stock' | 'out_of_stock'; price: string; brand: string; productType: string;
}

export type Exclusion = 'not_sellable' | 'demo' | 'deleted' | 'compliance' | 'no_real_image' | 'no_market' | 'invalid_price';

const PLACEHOLDER = /placeholder|no-image|noimage|dummy|default\.(png|jpg|svg)/i;
// eslint-disable-next-line no-control-regex
const stripCtl = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
export const absUrl = (u: string, base: string): string | null => { try { return new URL(u, base).toString(); } catch { return null; } };

export function toFeedItem(p: FeedProductInput, siteUrl: string): { item: FeedItem } | { excluded: Exclusion } {
  if (p.isDemo) return { excluded: 'demo' };
  if (p.deleted) return { excluded: 'deleted' };
  if (!(SELLABLE_STATES as readonly string[]).includes(p.state)) return { excluded: 'not_sellable' };
  if (p.complianceStatus !== 'passed') return { excluded: 'compliance' };
  if (!p.market || !p.market.enabled) return { excluded: 'no_market' };
  if (!Number.isInteger(p.market.price) || p.market.price <= 0) return { excluded: 'invalid_price' };
  const imgs = p.images.map((i) => (i.url ? absUrl(i.url, siteUrl) : null)).filter((u): u is string => !!u && !PLACEHOLDER.test(u));
  if (p.imageStatus !== 'READY' || !imgs.length) return { excluded: 'no_real_image' };
  return {
    item: {
      id: p.id, title: stripCtl(p.title).slice(0, 150), description: stripCtl(p.description ?? p.title).slice(0, 5000), link: `${siteUrl.replace(/\/$/, '')}/p/${p.slug}`,
      imageLink: imgs[0]!, additionalImages: imgs.slice(1, 10), availability: p.market.stock > 0 ? 'in_stock' : 'out_of_stock',
      price: `${(p.market.price / 100).toFixed(2)} ${p.market.currency}`, brand: p.brand || 'Orvia', productType: [p.topCategory, p.category].filter(Boolean).join(' > '),
    },
  };
}

export const xmlEscape = (s: string): string => stripCtl(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

export function buildGoogleFeedXml(items: FeedItem[], o: { title: string; link: string; description: string }): string {
  const row = (i: FeedItem) => [
    '<item>', `<g:id>${xmlEscape(i.id)}</g:id>`, `<title>${xmlEscape(i.title)}</title>`, `<description>${xmlEscape(i.description)}</description>`, `<link>${xmlEscape(i.link)}</link>`,
    `<g:image_link>${xmlEscape(i.imageLink)}</g:image_link>`, ...i.additionalImages.map((u) => `<g:additional_image_link>${xmlEscape(u)}</g:additional_image_link>`),
    `<g:availability>${i.availability}</g:availability>`, `<g:price>${xmlEscape(i.price)}</g:price>`, '<g:condition>new</g:condition>', `<g:brand>${xmlEscape(i.brand)}</g:brand>`,
    '<g:identifier_exists>no</g:identifier_exists>', ...(i.productType ? [`<g:product_type>${xmlEscape(i.productType)}</g:product_type>`] : []), '</item>',
  ].join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel><title>${xmlEscape(o.title)}</title><link>${xmlEscape(o.link)}</link><description>${xmlEscape(o.description)}</description>${items.map(row).join('')}</channel></rss>\n`;
}

/** RFC 4180 quoting; also neutralises spreadsheet formula injection (cells starting with = + @). */
export function csvCell(v: string): string {
  let s = stripCtl(v).replace(/\r?\n/g, ' ');
  if (/^[=+@]/.test(s)) s = `'${s}`;
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildMetaFeedCsv(items: FeedItem[]): string {
  const head = ['id', 'title', 'description', 'availability', 'condition', 'price', 'link', 'image_link', 'additional_image_link', 'brand', 'product_type'];
  const rows = items.map((i) => [i.id, i.title, i.description, i.availability === 'in_stock' ? 'in stock' : 'out of stock', 'new', i.price, i.link, i.imageLink, i.additionalImages.join(','), i.brand, i.productType].map(csvCell).join(','));
  return [head.join(','), ...rows].join('\r\n') + '\r\n';
}
