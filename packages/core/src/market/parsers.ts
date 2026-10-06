import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { XMLParser } from 'fast-xml-parser';

export interface ParsedItem {
  title: string;
  url?: string;
  publishedAt?: Date;
  price?: number; // minor units
  currency?: string;
  availability?: 'in_stock' | 'out_of_stock' | 'unknown';
  rank?: number;
  category?: string;
}

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text', processEntities: true, allowBooleanAttributes: true });
const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const text = (v: unknown): string => (typeof v === 'string' ? v : v && typeof v === 'object' && '#text' in (v as object) ? String((v as Record<string, unknown>)['#text']) : v === undefined || v === null ? '' : String(v)).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const date = (v: unknown): Date | undefined => { const d = new Date(text(v)); return Number.isNaN(d.getTime()) ? undefined : d; };

/** RSS 2.0 and Atom feeds. */
export function parseFeed(body: string): ParsedItem[] {
  const j = xml.parse(body) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const items: ParsedItem[] = [];
  const rss = j['rss']?.channel;
  if (rss) {
    for (const [i, it] of arr(rss.item).entries()) items.push({ title: text(it.title), url: text(it.link) || undefined, publishedAt: date(it.pubDate), rank: i + 1, category: text(arr(it.category)[0]) || undefined });
  }
  const atom = j['feed'];
  if (atom) {
    for (const [i, e] of arr(atom.entry).entries()) {
      const link = arr(e.link).find((l: any) => !l['@_rel'] || l['@_rel'] === 'alternate') ?? arr(e.link)[0]; // eslint-disable-line @typescript-eslint/no-explicit-any
      items.push({ title: text(e.title), url: link?.['@_href'], publishedAt: date(e.published ?? e.updated), rank: i + 1, category: text(arr(e.category)[0]?.['@_term']) || undefined });
    }
  }
  return items.filter((i) => i.title);
}

export interface SitemapResult {
  urls: { loc: string; lastmod?: Date }[];
  /** child sitemap URLs when this is a sitemap index */
  children: string[];
}

export function parseSitemap(body: string): SitemapResult {
  const j = xml.parse(body) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  return {
    urls: arr(j['urlset']?.url).map((u: any) => ({ loc: text(u.loc), lastmod: date(u.lastmod) })).filter((u) => u.loc), // eslint-disable-line @typescript-eslint/no-explicit-any
    children: arr(j['sitemapindex']?.sitemap).map((s: any) => text(s.loc)).filter(Boolean), // eslint-disable-line @typescript-eslint/no-explicit-any
  };
}

/** Product name guessed from a URL slug (sitemap sources, where we do not fetch the page). */
export function titleFromUrl(url: string): string {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
    return decodeURIComponent(last).replace(/\.(html?|php|aspx?)$/i, '').replace(/[-_+]+/g, ' ').replace(/\b\d{5,}\b/g, ' ').replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

const toMinor = (v: unknown): number | undefined => {
  const n = Number(String(v ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : undefined;
};
const avail = (v: unknown): ParsedItem['availability'] => {
  const s = String(v ?? '').toLowerCase();
  if (/instock|in_stock|in stock|limitedavailability|preorder/.test(s)) return 'in_stock';
  if (/outofstock|out_of_stock|out of stock|soldout|discontinued/.test(s)) return 'out_of_stock';
  return 'unknown';
};

/** schema.org Product/Offer from JSON-LD (+ OpenGraph product tags as a fallback) on a public product page. */
export function parseProductPage(html: string): ParsedItem | null {
  const $ = cheerio.load(html);
  const nodes: Record<string, any>[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const j = JSON.parse($(el).contents().text());
      const walk = (n: any) => { if (Array.isArray(n)) n.forEach(walk); else if (n && typeof n === 'object') { nodes.push(n); if (n['@graph']) walk(n['@graph']); } }; // eslint-disable-line @typescript-eslint/no-explicit-any
      walk(j);
    } catch { /* malformed JSON-LD is common; skip it */ }
  });
  const product = nodes.find((n) => [].concat(n['@type'] ?? []).map(String).includes('Product'));
  if (product) {
    const offer = arr<any>(product['offers'])[0] ?? {}; // eslint-disable-line @typescript-eslint/no-explicit-any
    const spec = arr<any>(offer['priceSpecification'])[0] ?? {}; // eslint-disable-line @typescript-eslint/no-explicit-any
    const price = toMinor(offer['price'] ?? offer['lowPrice'] ?? spec['price']);
    return { title: text(product['name']), price, currency: text(offer['priceCurrency'] ?? spec['priceCurrency']) || undefined, availability: avail(offer['availability']), category: text(product['category']) || undefined };
  }
  const og = (p: string) => $(`meta[property="${p}"]`).attr('content');
  const ogTitle = og('og:title');
  const ogPrice = og('product:price:amount') ?? og('og:price:amount');
  if (ogTitle && ogPrice) return { title: ogTitle.trim(), price: toMinor(ogPrice), currency: og('product:price:currency') ?? og('og:price:currency'), availability: avail(og('product:availability') ?? og('og:availability')) };
  return null;
}

export interface HtmlListingConfig {
  itemSelector: string;
  titleSelector?: string;
  linkSelector?: string;
  priceSelector?: string;
  currency?: string;
  baseUrl?: string;
}

/** A public listing/ranking page described by CSS selectors (rank = position on the page). */
export function parseHtmlListing(html: string, cfg: HtmlListingConfig): ParsedItem[] {
  const $ = cheerio.load(html);
  const out: ParsedItem[] = [];
  $(cfg.itemSelector).slice(0, 200).each((i, el) => {
    const node = $(el);
    const title = (cfg.titleSelector ? node.find(cfg.titleSelector).first().text() : node.text()).replace(/\s+/g, ' ').trim();
    const href = (cfg.linkSelector ? node.find(cfg.linkSelector).first() : node.find('a').first()).attr('href');
    let url: string | undefined;
    try { url = href ? new URL(href, cfg.baseUrl).toString() : undefined; } catch { url = undefined; }
    const price = cfg.priceSelector ? toMinor(node.find(cfg.priceSelector).first().text()) : undefined;
    if (title && title.length > 2 && title.length < 200) out.push({ title, url, price, currency: price ? cfg.currency : undefined, rank: i + 1, availability: 'unknown' });
  });
  return out;
}

export interface JsonPublicConfig { list: string; title: string; url?: string; price?: string; currency?: string; priceUnit?: 'major' | 'minor'; publishedAt?: string }
const dot = (o: unknown, p?: string): unknown => (p ? p.split('.').reduce<unknown>((a, k) => (a && typeof a === 'object' ? (a as Record<string, unknown>)[k] : undefined), o) : o);

export function parseJsonPublic(body: string, cfg: JsonPublicConfig): ParsedItem[] {
  const j = JSON.parse(body) as unknown;
  const list = dot(j, cfg.list);
  if (!Array.isArray(list)) return [];
  return list.slice(0, 500).map((it, i) => {
    const raw = cfg.price ? dot(it, cfg.price) : undefined;
    const n = Number(raw);
    return { title: String(dot(it, cfg.title) ?? '').trim(), url: cfg.url ? String(dot(it, cfg.url) ?? '') || undefined : undefined, price: Number.isFinite(n) && n > 0 ? (cfg.priceUnit === 'minor' ? Math.round(n) : Math.round(n * 100)) : undefined, currency: cfg.currency, publishedAt: cfg.publishedAt ? date(dot(it, cfg.publishedAt)) : undefined, rank: i + 1 };
  }).filter((i) => i.title);
}

export const hashUrl = (u: string): string => createHash('sha1').update(u).digest('hex').slice(0, 20);
