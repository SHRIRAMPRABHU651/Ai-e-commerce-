import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnalyticsEvent, ExceptionModel, MarketDocument, MarketSource, MarketTopic, Product } from '@orvia/database';
import { crawlSource, dueSources, intelFromIndex, keywordsOf, marketIntelFor, recomputeTrends } from '@orvia/core';
import type { Ctx } from '@orvia/core';
import { closeCtx, testCtx } from '../helpers/ctx';
import { Client, startApi } from '../helpers/client';
import { runSeed } from '../../scripts/lib/seed';

const PORT = 47841;
const base = `http://127.0.0.1:${PORT}`;
const hits: string[] = [];
let flakyCalls = 0;
const sleeps: number[] = [];
const sleep = async (ms: number) => { sleeps.push(ms); };
let server: Server;
const rss = (items: string[]) => `<?xml version="1.0"?><rss version="2.0"><channel>${items.map((t, i) => `<item><title>${t}</title><link>${base}/item/${encodeURIComponent(t)}</link><pubDate>Mon, 29 Jun 2026 10:0${i}:00 GMT</pubDate></item>`).join('')}</channel></rss>`;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url!, base).pathname;
    hits.push(path);
    const send = (status: number, body: string, type = 'text/html', extra: Record<string, string> = {}) => { res.writeHead(status, { 'content-type': type, ...extra }); res.end(body); };
    if (path === '/robots.txt') return send(200, 'User-agent: *\nDisallow: /private\nCrawl-delay: 3\n', 'text/plain');
    if (path === '/feed.xml') { if (req.headers['if-none-match'] === '"v1"') { res.writeHead(304); return res.end(); } return send(200, rss(['Slow Feeder Dog Bowl', 'Silicone Lick Mat for Dogs', 'Magnetic Phone Stand']), 'application/rss+xml', { etag: '"v1"' }); }
    if (path === '/blocked.xml') return send(403, 'forbidden');
    if (path === '/flaky.xml') { flakyCalls++; return flakyCalls <= 2 ? send(429, 'slow down', 'text/plain', { 'retry-after': '1' }) : send(200, rss(['Cat Feather Wand Toy']), 'application/rss+xml'); }
    if (path === '/captcha.html') return send(200, '<html><head><title>Are you a robot? Captcha</title></head></html>');
    if (path === '/listing.html') return send(200, `<ul>${[['Slow Feeder Dog Bowl', '14.99'], ['Lick Mat Dogs', '9.50']].map(([t, p]) => `<li class="p"><a href="/p/${t!.replace(/ /g, '-')}"><span class="t">${t}</span></a><b class="pr">$${p}</b></li>`).join('')}</ul>`);
    if (path === '/sitemap.xml') return send(200, `<urlset><url><loc>${base}/p/desk-fidget-cube</loc><lastmod>2026-06-20</lastmod></url><url><loc>${base}/private/secret-thing</loc></url></urlset>`, 'application/xml');
    if (path === '/p/desk-fidget-cube') return send(200, `<html><head><script type="application/ld+json">{"@type":"Product","name":"Desk Fidget Cube","offers":{"price":"12.99","priceCurrency":"USD","availability":"InStock"}}</script></head></html>`);
    return send(404, 'nope');
  });
  await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', r));
  ctx = await testCtx('market', { ALLOW_PRIVATE_FETCH: 'true' });
  await runSeed(ctx, { withHistory: false });
  api = (await startApi(ctx)).client;
  admin = api();
  expect((await admin.post('/api/v1/auth/admin/login', { email: 'owner@orvia.test', password: 'Orvia-Demo-2026!' })).status).toBe(200);
}, 180_000);
afterAll(async () => { await new Promise((r) => server.close(r)); await closeCtx(); });
let ctx: Ctx; let api: () => Client; let admin: Client;

const mkSource = (over: Record<string, unknown>) => MarketSource.create({ name: 'src', type: 'RSS', baseUrl: `${base}/feed.xml`, country: 'US', category: 'pet', crawlIntervalMinutes: 15, ...over });
const deps = { sleep, minDelayMs: 0 };

describe('polite crawling of public sources', () => {
  it('fetches a feed, indexes observations and topics, dedupes within a day, and uses conditional requests', async () => {
    const s = await mkSource({ name: 'Pet blog feed' });
    const r1 = await crawlSource(ctx, String(s._id), deps);
    expect(r1).toMatchObject({ status: 'ok', documents: 3, topics: 3 });
    expect(hits).toContain('/robots.txt');
    const src = await MarketSource.findById(s._id).lean();
    expect(src).toMatchObject({ healthStatus: 'HEALTHY', robotsStatus: 'allowed', failureCount: 0, documentsCollected: 3 });
    expect(src!.etag).toBe('"v1"');
    // same day again: server answers 304 → nothing new, still healthy
    const r2 = await crawlSource(ctx, String(s._id), deps);
    expect(r2.status).toBe('unchanged');
    expect(await MarketDocument.countDocuments({ sourceId: s._id })).toBe(3);
    // a different source reporting the same product joins the same topic (deterministic matching)
    const s2 = await mkSource({ name: 'Second feed', baseUrl: `${base}/listing.html`, type: 'HTML_LISTING', parserConfig: { itemSelector: 'li.p', titleSelector: '.t', priceSelector: '.pr', currency: 'USD' } });
    const r3 = await crawlSource(ctx, String(s2._id), deps);
    expect(r3).toMatchObject({ status: 'ok', documents: 2 });
    expect(r3.topics).toBe(0); // "Slow Feeder Dog Bowl" and "Lick Mat Dogs" matched topics from the first feed
    const bowl = await MarketTopic.findOne({ displayName: 'Slow Feeder Dog Bowl' }).lean();
    expect(await MarketDocument.countDocuments({ topicId: bowl!._id })).toBe(2);
    expect((await MarketDocument.findOne({ topicId: bowl!._id, price: { $gt: 0 } }).lean())!.price).toBe(1499);
  });

  it('honours Crawl-delay and robots.txt Disallow (never fetches a disallowed URL)', async () => {
    sleeps.length = 0;
    await crawlSource(ctx, String((await mkSource({ name: 'delay', baseUrl: `${base}/feed.xml`, etag: undefined }))._id), { sleep });
    expect(Math.max(...sleeps)).toBeGreaterThanOrEqual(2900); // Crawl-delay: 3 between robots.txt and the feed
    const before = hits.length;
    const s = await mkSource({ name: 'private', baseUrl: `${base}/private/feed.xml` });
    const r = await crawlSource(ctx, String(s._id), deps);
    expect(r.status).toBe('robots_disallowed');
    expect(hits.slice(before)).not.toContain('/private/feed.xml');
    expect(await MarketSource.findById(s._id).lean()).toMatchObject({ healthStatus: 'BLOCKED', robotsStatus: 'disallowed' });
  });

  it('stops on 403 and CAPTCHA pages without retrying or trying to bypass them', async () => {
    const before = hits.filter((h) => h === '/blocked.xml').length;
    const s = await mkSource({ name: 'blocked', baseUrl: `${base}/blocked.xml` });
    expect((await crawlSource(ctx, String(s._id), deps)).status).toBe('blocked');
    expect(hits.filter((h) => h === '/blocked.xml').length - before).toBe(1);
    const c = await mkSource({ name: 'captcha', type: 'HTML_LISTING', baseUrl: `${base}/captcha.html`, parserConfig: { itemSelector: 'li' } });
    const rc = await crawlSource(ctx, String(c._id), deps);
    expect(rc.status).toBe('blocked');
    expect(rc.message).toMatch(/CAPTCHA/i);
  });

  it('backs off on 429 (Retry-After) then succeeds', async () => {
    sleeps.length = 0; flakyCalls = 0;
    const s = await mkSource({ name: 'flaky', baseUrl: `${base}/flaky.xml` });
    const r = await crawlSource(ctx, String(s._id), deps);
    expect(r.status).toBe('ok');
    expect(flakyCalls).toBe(3);
    expect(sleeps.filter((x) => x === 1000).length).toBeGreaterThanOrEqual(2);
  });

  it('tracks failures, backs off the schedule and auto-disables a dead source with an exception', async () => {
    const s = await mkSource({ name: 'dead', baseUrl: `${base}/gone.xml`, failureCount: 9 });
    const r = await crawlSource(ctx, String(s._id), deps);
    expect(r.status).toBe('failed');
    const after = await MarketSource.findById(s._id).lean();
    expect(after).toMatchObject({ enabled: false, healthStatus: 'DISABLED', failureCount: 10 });
    expect(await ExceptionModel.countDocuments({ kind: 'MARKET_SOURCE', dedupeKey: `market-source:${String(s._id)}` })).toBe(1);
    expect(await dueSources(ctx, 50)).not.toContain(String(s._id));
    expect((await crawlSource(ctx, String(s._id), deps)).status).toBe('disabled');
  });

  it('reads product prices from JSON-LD on sitemap product pages, skipping robots-disallowed URLs', async () => {
    const before = hits.length;
    const s = await mkSource({ name: 'sitemap', type: 'SITEMAP', baseUrl: `${base}/sitemap.xml`, fetchProductPages: 5 });
    const r = await crawlSource(ctx, String(s._id), deps);
    expect(r.status).toBe('ok');
    expect(hits.slice(before)).toContain('/p/desk-fidget-cube');
    expect(hits.slice(before)).not.toContain('/private/secret-thing');
    expect(await MarketDocument.findOne({ sourceId: s._id, price: 1299 })).toBeTruthy();
  });
});

describe('trend engine on collected evidence', () => {
  const day = (n: number) => new Date(Date.now() - n * 86_400_000 - 3_600_000);
  const addObs = async (sourceName: string, topicId: unknown, name: string, daysAgo: number[], price?: number) => {
    let src = await MarketSource.findOne({ name: sourceName });
    if (!src) src = await MarketSource.create({ name: sourceName, type: 'RSS', baseUrl: `${base}/x/${sourceName}`, country: 'US', enabled: false });
    for (const d of daysAgo) await MarketDocument.create({ sourceId: src._id, source: sourceName, sourceUrl: `https://${sourceName}.example/${encodeURIComponent(name)}/${d}`, urlHash: `${sourceName}-${name}-${d}-${Math.random().toString(36).slice(2, 7)}`, day: day(d).toISOString().slice(0, 10), topicId, normalizedProductName: name.toLowerCase(), title: name, keywords: keywordsOf(name), country: 'US', observedAt: day(d), price, currency: price ? 'USD' : undefined, availability: price ? 'in_stock' : 'unknown' });
  };

  it('labels multi-source growth TRENDING, caps a single-source spike, and links evidence to matching products', async () => {
    const prod = await Product.create({ slug: 'slow-feeder-maze-bowl-x', sku: 'SF-X', title: 'Slow Feeder Dog Bowl Maze', description: 'Slow feeder bowl description long enough.', state: 'PUBLISHED', imageStatus: 'READY', images: [{ url: '/art/x' }], compliance: { status: 'passed', flags: [] }, markets: [{ country: 'US', enabled: true, currency: 'USD', price: 2500, stock: 5 }] });
    await MarketTopic.deleteMany({ displayName: 'Slow Feeder Dog Bowl' }); // start from a clean topic (earlier crawls created one)
    const hot = await MarketTopic.create({ normalizedName: 'bowl dog feeder slow', displayName: 'Slow Feeder Dog Bowl', keywords: keywordsOf('Slow Feeder Dog Bowl'), country: 'US', firstSeen: day(20), lastSeen: day(0) });
    const rising = [0, 1, 2, 2, 3, 4, 5, 6, 8, 12];
    for (const s of ['alpha-blog', 'beta-shop', 'gamma-news']) await addObs(s, hot._id, 'Slow Feeder Dog Bowl', rising, s === 'alpha-blog' ? undefined : 1800 + (s === 'beta-shop' ? 0 : 400));
    for (const d of [0, 1, 2, 3]) await addObs('delta-shop', hot._id, 'Slow Feeder Dog Bowl', [d], 2200 + d * 10);
    const spike = await MarketTopic.create({ normalizedName: 'novelty spike', displayName: 'Novelty Spike Gadget', keywords: keywordsOf('Novelty Spike Gadget'), country: 'US', firstSeen: day(10), lastSeen: day(0) });
    await addObs('lonely-site', spike._id, 'Novelty Spike Gadget', [0, 0, 0, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 6]);
    const thin = await MarketTopic.create({ normalizedName: 'thin topic', displayName: 'Thin Topic Thing', keywords: keywordsOf('Thin Topic Thing'), country: 'US', firstSeen: day(0), lastSeen: day(0) });
    await addObs('alpha-blog', thin._id, 'Thin Topic Thing', [0]);
    // Orvia behaviour for the matching product: enough events to count
    await AnalyticsEvent.insertMany([...Array(60).fill(0).map(() => ({ type: 'product_view', productId: prod._id, country: 'US', ts: day(2) })), ...Array(20).fill(0).map(() => ({ type: 'product_view', productId: prod._id, country: 'US', ts: day(10) })), ...Array(6).fill(0).map(() => ({ type: 'add_to_cart', productId: prod._id, country: 'US', ts: day(1) }))]);
    const sum = await recomputeTrends(ctx);
    expect(sum.scored).toBeGreaterThanOrEqual(3);

    const h = await MarketTopic.findById(hot._id).lean();
    expect(h!.status).toBe('TRENDING');
    expect(h!.confidence).toBeGreaterThanOrEqual(0.6);
    expect(h!.sourceCount).toBe(4);
    const sp = await MarketTopic.findById(spike._id).lean();
    expect(sp!.status).not.toBe('TRENDING');
    expect(sp!.confidence).toBeLessThanOrEqual(0.45);
    expect((await MarketTopic.findById(thin._id).lean())!.status).toBe('INSUFFICIENT_DATA');

    // competitor prices come from observed pages only
    expect(h!.price).toMatchObject({ n: expect.any(Number), currency: 'USD' });
    expect((h!.price as { confidence: string }).confidence).not.toBe('LOW');
    // linking: the matching product now carries market evidence (source, confidence, competitor prices)
    const p = await Product.findById(prod._id).lean();
    expect((p!.intel as { source: string }).source).toBe('market-index');
    expect((p!.intel as { competitorPrices: Record<string, number[]> }).competitorPrices['US']!.length).toBe(3);
    expect(p!.stats.trendScore).toBe(h!.trendScore);
    // …and import-time intelligence resolves from the index, never from the mock table
    const intel = await marketIntelFor(ctx, 'whatever-id', 'Slow Feeder Dog Bowl Blue 500ml');
    expect(intel).toMatchObject({ source: 'market-index', status: 'TRENDING' });
    expect(intel!.competitorPricesUsd).toHaveLength(3);
    expect(await intelFromIndex(ctx, 'Completely Unrelated Garden Hose')).toBeNull();
  });

  it('admin API: filterable topics, evidence-only explanation, source management and RBAC', async () => {
    const list = await admin.get('/api/v1/admin/market/topics?status=TRENDING');
    expect(list.body.items.map((t: { name: string }) => t.name)).toContain('Slow Feeder Dog Bowl');
    const id = list.body.items.find((t: { name: string }) => t.name === 'Slow Feeder Dog Bowl').id;
    const detail = await admin.get(`/api/v1/admin/market/topics/${id}`);
    expect(detail.body.explanation.text).toMatch(/Evidence:/);
    expect(detail.body.explanation.text).toMatch(/Source "alpha-blog": observed 8× in the last 7 days vs 2×/);
    expect(detail.body.explanation.text).toMatch(/Orvia customer activity|Orvia search/);
    expect(detail.body.explanation.text).not.toMatch(/according to current market trends/i);
    const thinDetail = await admin.get(`/api/v1/admin/market/topics/${String((await MarketTopic.findOne({ displayName: 'Thin Topic Thing' }).lean())!._id)}`);
    expect(thinDetail.body.explanation.text).toMatch(/not enough evidence/i);
    const ov = await admin.get('/api/v1/admin/market/overview');
    expect(ov.body.statusCounts.TRENDING).toBeGreaterThanOrEqual(1);
    expect(ov.body.note).toMatch(/no fake data/i);
    // create + test a source through the API
    const created = await admin.post('/api/v1/admin/market/sources', { name: 'API source', type: 'RSS', baseUrl: `${base}/flaky.xml`, country: 'US' });
    expect(created.status).toBe(201);
    expect((await admin.post('/api/v1/admin/market/sources', { name: 'No URL', type: 'RSS' })).status).toBe(422);
    const crawl = await admin.post(`/api/v1/admin/market/sources/${created.body.id}/crawl`);
    expect(crawl.status).toBe(200);
    expect((await admin.patch(`/api/v1/admin/market/sources/${created.body.id}`, { enabled: false })).status).toBe(200);
    // analyst can read, cannot change
    const analyst = api();
    await analyst.post('/api/v1/auth/admin/login', { email: 'analyst@orvia.test', password: 'Orvia-Demo-2026!' });
    expect((await analyst.get('/api/v1/admin/market/topics')).status).toBe(200);
    expect((await analyst.post('/api/v1/admin/market/sources', { name: 'x y', type: 'RSS', baseUrl: `${base}/feed.xml` })).status).toBe(403);
    expect((await api().get('/api/v1/admin/market/topics')).status).toBe(401);
  });

  it('records searches from the storefront as a demand signal (no personal data)', async () => {
    const c = api();
    await c.get('/api/v1/products?q=slow%20feeder%20bowl&country=US');
    await new Promise((r) => setTimeout(r, 200));
    const ev = await AnalyticsEvent.findOne({ type: 'search', 'meta.q': 'slow feeder bowl' }).lean();
    expect(ev).toBeTruthy();
    expect(ev!.userId).toBeUndefined();
    expect(ev!.sessionId).toBe('server-search');
  });

  it('Copilot explains a trend only from stored evidence, and refuses to guess when there is none', async () => {
    const why = await admin.post('/api/v1/admin/copilot', { question: 'Why is the slow feeder dog bowl trending?' });
    expect(why.body.intent).toBe('trend_explain');
    expect(why.body.answer).toMatch(/Evidence:/);
    expect(why.body.answer).toMatch(/Source "alpha-blog"/);
    expect(why.body.sources).toContain('market_index');
    const list = await admin.post('/api/v1/admin/copilot', { question: 'What is trending right now?' });
    expect(list.body.tables[0].rows.map((r: string[]) => r[0])).toContain('Slow Feeder Dog Bowl');
    await MarketTopic.updateMany({}, { $set: { status: 'INSUFFICIENT_DATA' } });
    const none = await admin.post('/api/v1/admin/copilot', { question: 'What is trending right now?' });
    expect(none.body.answer).toMatch(/only report trends that .* actually support|No market sources/i);
    expect(none.body.tables).toBeUndefined();
  });
});
