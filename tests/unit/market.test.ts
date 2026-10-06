import { describe, expect, it } from 'vitest';
import { hashUrl, keywordsOf, normalizeProductName, parseFeed, parseHtmlListing, parseJsonPublic, parseProductPage, parseRobots, parseSitemap, priceStats, scoreTopic, shrunkGrowth, similarity, titleFromUrl, tokens } from '@orvia/core';
import type { Obs, TrendWeights } from '@orvia/core';

const W: TrendWeights = { recency: 0.2, velocity: 0.25, crossSource: 0.15, mentionGrowth: 0.15, searchGrowth: 0.1, availability: 0.05, priceMomentum: 0.05, internalConversion: 0.05 };
const NOW = new Date('2026-06-30T12:00:00Z');
const DAY = 86_400_000;
/** n observations on a source, spread over the given day offsets (one per day). */
const obs = (sourceId: string, daysAgo: number[], extra: Partial<Obs> = {}): Obs[] => daysAgo.map((d) => ({ sourceId, source: `site-${sourceId}`, observedAt: new Date(NOW.getTime() - d * DAY - 3600_000), day: new Date(NOW.getTime() - d * DAY).toISOString().slice(0, 10), url: `https://${sourceId}.example/p/${d}`, ...extra }));

describe('robots.txt', () => {
  const txt = `User-agent: *\nDisallow: /private/\nAllow: /private/public\nCrawl-delay: 5\n\nUser-agent: OrviaMarketBot\nDisallow: /nope\nDisallow: /*.json$\n`;
  it('prefers the most specific group, longest match wins, wildcards and crawl-delay', () => {
    const star = parseRobots(txt.replace(/User-agent: OrviaMarketBot[\s\S]*/, ''), 'orviamarketbot');
    expect(star.isAllowed('/private/x')).toBe(false);
    expect(star.isAllowed('/private/public/page')).toBe(true);
    expect(star.isAllowed('/shop')).toBe(true);
    expect(star.crawlDelay).toBe(5);
    const mine = parseRobots(txt, 'orviamarketbot');
    expect(mine.isAllowed('/nope')).toBe(false);
    expect(mine.isAllowed('/private/x')).toBe(true); // our own group replaces '*'
    expect(mine.isAllowed('/data/list.json')).toBe(false);
    expect(mine.isAllowed('/data/list.json.bak')).toBe(true);
    expect(parseRobots('Disallow: /', 'x').isAllowed('/a')).toBe(true); // rule outside any group is ignored
    expect(parseRobots('User-agent: *\nDisallow: /', 'x').isAllowed('/a')).toBe(false);
    expect(parseRobots('User-agent: *\nDisallow:', 'x').isAllowed('/a')).toBe(true);
  });
});

describe('entity normalisation (deterministic, no LLM)', () => {
  it('strips noise and groups spelling/word-order variants of the same product', () => {
    expect(tokens('Premium SLOW Feeder Dog Bowl - Blue (500ml) ASIN B08XYZ12345')).toEqual(['slow', 'feeder', 'dog', 'bowl']);
    expect(normalizeProductName('Dog Bowl, Slow-Feeder!')).toBe(normalizeProductName('slow feeder dog bowls'));
    expect(similarity('Slow Feeder Dog Bowl', 'Dog slow-feeding bowl')).toBeGreaterThan(0.45);
    expect(similarity('Slow Feeder Dog Bowl', 'Slow Feeder Dog Bowls Blue')).toBeGreaterThan(0.62);
    expect(similarity('Slow Feeder Dog Bowl', 'Magnetic Phone Stand')).toBeLessThan(0.2);
    expect(keywordsOf('Magnetic Phone Stand for desk')).toEqual(['desk', 'magnetic', 'phone', 'stand']);
  });
});

describe('source parsers', () => {
  it('parses RSS and Atom feeds', () => {
    const rss = `<?xml version="1.0"?><rss version="2.0"><channel><item><title>Silicone lick mat</title><link>https://a.example/1</link><pubDate>Mon, 29 Jun 2026 10:00:00 GMT</pubDate><category>Pets</category></item><item><title><![CDATA[Cat <b>wand</b>]]></title><link>https://a.example/2</link></item></channel></rss>`;
    const items = parseFeed(rss);
    expect(items.map((i) => i.title)).toEqual(['Silicone lick mat', 'Cat wand']);
    expect(items[0]).toMatchObject({ url: 'https://a.example/1', rank: 1, category: 'Pets' });
    expect(items[0]!.publishedAt!.toISOString()).toBe('2026-06-29T10:00:00.000Z');
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Pet hair roller</title><link rel="alternate" href="https://b.example/x"/><updated>2026-06-28T00:00:00Z</updated></entry></feed>`;
    expect(parseFeed(atom)[0]).toMatchObject({ title: 'Pet hair roller', url: 'https://b.example/x' });
    expect(parseFeed('<html>not a feed</html>')).toEqual([]);
  });
  it('parses sitemaps, sitemap indexes and URL slugs', () => {
    const sm = parseSitemap(`<urlset><url><loc>https://s.example/products/magnetic-phone-stand-12345</loc><lastmod>2026-06-01</lastmod></url></urlset>`);
    expect(sm.urls[0]!.loc).toContain('magnetic-phone-stand');
    expect(titleFromUrl(sm.urls[0]!.loc)).toBe('magnetic phone stand');
    expect(parseSitemap(`<sitemapindex><sitemap><loc>https://s.example/sm1.xml</loc></sitemap></sitemapindex>`).children).toEqual(['https://s.example/sm1.xml']);
  });
  it('extracts schema.org Product/Offer data (JSON-LD, @graph, OpenGraph fallback)', () => {
    const ld = `<script type="application/ld+json">{"@graph":[{"@type":"WebSite"},{"@type":"Product","name":"Desk Fidget Cube","category":"Toys","offers":{"@type":"Offer","price":"12.99","priceCurrency":"USD","availability":"https://schema.org/InStock"}}]}</script>`;
    expect(parseProductPage(`<html><head>${ld}</head></html>`)).toMatchObject({ title: 'Desk Fidget Cube', price: 1299, currency: 'USD', availability: 'in_stock' });
    expect(parseProductPage(`<html><head><script type="application/ld+json">{broken</script><meta property="og:title" content="Lamp"><meta property="product:price:amount" content="24.50"><meta property="product:price:currency" content="CAD"></head></html>`)).toMatchObject({ title: 'Lamp', price: 2450, currency: 'CAD' });
    expect(parseProductPage('<html><body>nothing</body></html>')).toBeNull();
  });
  it('parses selector-based listings and public JSON', () => {
    const html = `<ul><li class="p"><a href="/p/1"><span class="t">Slow bowl</span></a><b class="pr">$14.99</b></li><li class="p"><a href="/p/2"><span class="t">Lick mat</span></a><b class="pr">$9.50</b></li></ul>`;
    const items = parseHtmlListing(html, { itemSelector: 'li.p', titleSelector: '.t', priceSelector: '.pr', currency: 'USD', baseUrl: 'https://shop.example' });
    expect(items).toEqual([expect.objectContaining({ title: 'Slow bowl', url: 'https://shop.example/p/1', price: 1499, rank: 1 }), expect.objectContaining({ title: 'Lick mat', price: 950, rank: 2 })]);
    expect(parseJsonPublic(JSON.stringify({ data: { products: [{ n: 'A thing', p: 3.5 }] } }), { list: 'data.products', title: 'n', price: 'p', currency: 'USD' })[0]).toMatchObject({ title: 'A thing', price: 350 });
    expect(hashUrl('https://a')).toHaveLength(20);
  });
});

describe('trend engine', () => {
  const risingSource = (id: string) => obs(id, [0, 1, 2, 2, 3, 4, 5, 6, 8, 12]); // 8 mentions this week vs 2 before
  it('flags a product rising across several independent sources as TRENDING with high confidence', () => {
    const r = scoreTopic({ observations: [...risingSource('a'), ...risingSource('b'), ...risingSource('c')], weights: W, now: NOW });
    expect(r.status).toBe('TRENDING');
    expect(r.confidence).toBeGreaterThanOrEqual(0.6);
    expect(r.evidence.sources).toHaveLength(3);
    expect(r.reasons.join(' ')).toMatch(/site-a: 8 mention/);
  });
  it('never calls a single-source spike TRENDING and caps its confidence', () => {
    const spike = obs('x', [0, 0, 0, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 6]); // huge growth, one source
    const r = scoreTopic({ observations: spike, weights: W, now: NOW });
    expect(r.confidence).toBeLessThanOrEqual(0.45);
    expect(r.status).not.toBe('TRENDING');
    expect(r.warnings.join(' ')).toMatch(/Single-source/);
    const multi = scoreTopic({ observations: [...risingSource('a'), ...risingSource('b'), ...risingSource('c')], weights: W, now: NOW });
    expect(multi.confidence).toBeGreaterThan(r.confidence);
  });
  it('reports INSUFFICIENT_DATA instead of guessing when evidence is thin, and uses neutral values for missing signals', () => {
    const r = scoreTopic({ observations: obs('a', [0, 1]), weights: W, now: NOW });
    expect(r.status).toBe('INSUFFICIENT_DATA');
    expect(r.components.searchGrowth).toMatchObject({ available: false, score: 0.5 });
    expect(r.components.priceMomentum).toMatchObject({ available: false, score: 0.5 });
    expect(scoreTopic({ observations: [], weights: W, now: NOW }).status).toBe('INSUFFICIENT_DATA');
  });
  it('detects a declining topic', () => {
    const dying = [...obs('a', [8, 9, 10, 11, 12, 13, 13, 14, 1]), ...obs('b', [8, 9, 10, 11, 12, 13, 14, 14, 2])];
    const r = scoreTopic({ observations: dying, weights: W, now: NOW });
    expect(r.status).toBe('DECLINING');
    expect(r.growthPct).toBeLessThan(-25);
  });
  it('Orvia behaviour needs a minimum sample: two purchases cannot make a product look viral', () => {
    const base = [...risingSource('a'), ...risingSource('b')];
    const tiny = scoreTopic({ observations: base, weights: W, now: NOW, internal: { searchRecent: 2, searchPrior: 0, viewsRecent: 0, viewsPrior: 0, cartsRecent: 0, cartsPrior: 0, purchasesRecent: 2, purchasesPrior: 0 } });
    expect(tiny.components.internalConversion.available).toBe(false);
    expect(tiny.components.searchGrowth.available).toBe(false);
    const real = scoreTopic({ observations: base, weights: W, now: NOW, internal: { searchRecent: 40, searchPrior: 10, viewsRecent: 300, viewsPrior: 120, cartsRecent: 30, cartsPrior: 10, purchasesRecent: 8, purchasesPrior: 2 } });
    expect(real.components.internalConversion.available).toBe(true);
    expect(real.components.searchGrowth.score).toBeGreaterThan(0.7);
    expect(real.trendScore).toBeGreaterThan(tiny.trendScore);
  });
  it('shrinks growth for small samples and reports windows with sufficiency', () => {
    expect(shrunkGrowth(1, 0)).toBe(1); // 1 mention vs none is +100%, not +infinity
    expect(shrunkGrowth(20, 10)).toBeCloseTo(0.909, 2);
    const r = scoreTopic({ observations: obs('a', [0, 1, 2, 3]), weights: W, now: NOW });
    expect(r.windows['30d']!.sufficient).toBe(false);
    expect(r.windows['7d']!.observations).toBe(4);
  });
  it('weights are configurable', () => {
    const o = [...risingSource('a'), ...risingSource('b'), ...risingSource('c')];
    const onlyRecency = scoreTopic({ observations: o, weights: { ...Object.fromEntries(Object.keys(W).map((k) => [k, 0])), recency: 1 } as unknown as TrendWeights, now: NOW });
    expect(onlyRecency.trendScore).toBe(Math.round(onlyRecency.components.recency.score * 100));
  });
});

describe('competitor price statistics', () => {
  const row = (url: string, host: string, price: number, ago: number) => ({ url, host, price, observedAt: new Date(NOW.getTime() - ago * DAY) });
  it('uses the newest price per URL, reports spread and confidence, and ignores stale rows', () => {
    const s = priceStats([row('a', 'a.com', 2000, 5), row('a', 'a.com', 1800, 1), row('b', 'b.com', 2400, 2), row('c', 'c.com', 2200, 3), row('d', 'd.com', 999, 40)], { now: NOW, staleDays: 14, currency: 'USD' })!;
    expect(s).toMatchObject({ n: 3, hosts: 3, low: 1800, high: 2400, median: 2200, confidence: 'MEDIUM' });
    const hi = priceStats(Array.from({ length: 6 }, (_, i) => row(`u${i}`, `h${i % 3}.com`, 2000 + i * 10, 1)), { now: NOW, staleDays: 14, currency: 'USD' })!;
    expect(hi.confidence).toBe('HIGH');
    expect(priceStats([row('a', 'a.com', 1000, 1)], { now: NOW, staleDays: 14, currency: 'USD' })!.confidence).toBe('LOW');
    expect(priceStats([row('a', 'a.com', 1000, 30)], { now: NOW, staleDays: 14, currency: 'USD' })).toBeNull();
  });
});
