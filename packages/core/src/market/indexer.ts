import { MarketDocument, MarketSource, MarketTopic } from '@orvia/database';
import type { Ctx } from '../infra/context';
import { raiseException } from '../domain/exceptions';
import { MarketFetcher, SourceBlockedError } from './fetcher';
import { hashUrl, parseFeed, parseHtmlListing, parseJsonPublic, parseProductPage, parseSitemap, titleFromUrl } from './parsers';
import type { HtmlListingConfig, JsonPublicConfig, ParsedItem } from './parsers';
import { SAME_ENTITY_THRESHOLD, keywordsOf, normalizeProductName, similarity } from './normalize';
import { parseRobots } from './robots';
import type { RobotsRules } from './robots';

export interface CrawlSummary {
  sourceId: string;
  status: 'ok' | 'unchanged' | 'blocked' | 'robots_disallowed' | 'failed' | 'disabled' | 'skipped';
  fetched: number;
  documents: number;
  topics: number;
  message?: string;
}

const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const MAX_FAILURES_BEFORE_DISABLE = 10;

/** Pick or create the topic for an observed name; matching is deterministic (keywords → similarity), never LLM based. */
export async function assignTopic(name: string, o: { country?: string | null; category?: string | null; at: Date }): Promise<{ topicId: string; created: boolean } | null> {
  const normalized = normalizeProductName(name);
  const keywords = keywordsOf(name);
  if (!normalized || keywords.length < 1 || normalized.length < 3) return null;
  const cands = await MarketTopic.find({ keywords: { $in: keywords }, ...(o.country ? { country: o.country } : {}) }).select('normalizedName displayName').limit(40).lean();
  let best: { id: string; sim: number } | null = null;
  for (const c of cands) {
    const sim = similarity(name, c.displayName ?? c.normalizedName);
    if (sim >= SAME_ENTITY_THRESHOLD && (!best || sim > best.sim)) best = { id: String(c._id), sim };
  }
  if (best) {
    await MarketTopic.updateOne({ _id: best.id }, { $set: { lastSeen: o.at } });
    return { topicId: best.id, created: false };
  }
  const t = await MarketTopic.create({ normalizedName: normalized, displayName: name.slice(0, 160), keywords, category: o.category ?? undefined, country: o.country ?? undefined, firstSeen: o.at, lastSeen: o.at });
  return { topicId: String(t._id), created: true };
}

async function record(source: { _id: unknown; name: string; country?: string | null; category?: string | null }, it: ParsedItem, at: Date): Promise<{ inserted: boolean; topicCreated: boolean }> {
  const name = it.title.trim();
  const normalizedProductName = normalizeProductName(name);
  if (!normalizedProductName) return { inserted: false, topicCreated: false };
  const topic = await assignTopic(name, { country: source.country, category: it.category ?? source.category, at });
  const urlHash = hashUrl(it.url ?? normalizedProductName);
  const day = dayOf(at);
  const r = await MarketDocument.updateOne(
    { sourceId: source._id, urlHash, day },
    {
      $set: { observedAt: at, availability: it.availability ?? 'unknown', ...(it.price ? { price: it.price, currency: it.currency } : {}), ...(it.rank ? { rank: it.rank } : {}), ...(topic ? { topicId: topic.topicId } : {}) },
      $setOnInsert: { source: source.name, sourceUrl: it.url, title: name.slice(0, 200), normalizedProductName, keywords: keywordsOf(name), category: it.category ?? source.category ?? undefined, country: source.country ?? undefined, publishedAt: it.publishedAt, mentionCount: 1 },
    },
    { upsert: true },
  );
  return { inserted: r.upsertedCount > 0, topicCreated: !!topic?.created };
}

async function loadRobots(ctx: Ctx, source: InstanceType<typeof MarketSource>, fetcher: MarketFetcher, now: Date): Promise<{ rules: RobotsRules | null; status: 'allowed' | 'disallowed' | 'unreachable' }> {
  const url = new URL(source.baseUrl!);
  const fresh = source.robotsCheckedAt && now.getTime() - source.robotsCheckedAt.getTime() < 24 * 3_600_000;
  let txt = fresh ? source.robotsTxt : undefined;
  if (txt === undefined) {
    try {
      const page = await fetcher.get(`${url.origin}/robots.txt`, { maxBytes: 200_000, retries: 1 });
      txt = page.body;
    } catch (e) {
      if (/Not found/.test((e as Error).message)) txt = ''; // no robots.txt = no restrictions
      else {
        source.robotsStatus = 'unreachable';
        source.robotsCheckedAt = now;
        return { rules: null, status: 'unreachable' }; // can't prove we're allowed ⇒ don't crawl
      }
    }
    source.robotsTxt = txt.slice(0, 100_000);
    source.robotsCheckedAt = now;
  }
  const rules = parseRobots(txt ?? '', 'orviamarketbot');
  const allowed = rules.isAllowed(url.pathname + url.search);
  source.robotsStatus = allowed ? 'allowed' : 'disallowed';
  return { rules, status: allowed ? 'allowed' : 'disallowed' };
}

export interface CrawlDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  minDelayMs?: number;
}

/** Crawl one configured public source: robots → fetch → parse → observations → topics, with health bookkeeping. */
export async function crawlSource(ctx: Ctx, sourceId: string, deps: CrawlDeps = {}): Promise<CrawlSummary> {
  const source = await MarketSource.findById(sourceId).select('+robotsTxt');
  const sum: CrawlSummary = { sourceId, status: 'ok', fetched: 0, documents: 0, topics: 0 };
  if (!source) return { ...sum, status: 'skipped', message: 'unknown source' };
  if (!source.enabled) return { ...sum, status: 'disabled' };
  if (source.type === 'INTERNAL_ANALYTICS' || source.type === 'SUPPLIER') return { ...sum, status: 'skipped', message: `${source.type} sources are read directly by the trend engine` };
  const now = ctx.now();
  const fetcher = new MarketFetcher({ contact: ctx.cfg.MARKET_CRAWLER_CONTACT, allowPrivate: ctx.cfg.ALLOW_PRIVATE_FETCH, fetchImpl: deps.fetchImpl, sleep: deps.sleep, minDelayMs: deps.minDelayMs });
  source.lastCrawledAt = now;
  source.crawlCount += 1;
  const fail = async (status: CrawlSummary['status'], message: string, health: 'FAILING' | 'BLOCKED' | 'DEGRADED'): Promise<CrawlSummary> => {
    source.failureCount += 1;
    source.lastFailureAt = now;
    source.lastError = message.slice(0, 300);
    source.healthStatus = health === 'BLOCKED' ? 'BLOCKED' : source.failureCount >= 3 ? 'FAILING' : 'DEGRADED';
    source.successRate = Math.round((source.successRate ?? 0) * 0.8 * 100) / 100;
    if (source.failureCount >= MAX_FAILURES_BEFORE_DISABLE) {
      source.enabled = false;
      source.healthStatus = 'DISABLED';
      await raiseException(ctx, { kind: 'MARKET_SOURCE', priority: 'low', issue: `Market source "${source.name}" was disabled after ${source.failureCount} consecutive failures: ${message}`, aiRecommendation: 'Fix the source URL/selectors or remove it.', suggestedAction: 'Review source', dedupeKey: `market-source:${source._id}` });
    }
    await source.save();
    return { ...sum, status, message };
  };
  try {
    if (!source.baseUrl) return await fail('failed', 'source has no URL', 'DEGRADED');
    let crawlDelay: number | undefined;
    if (source.robotsRequired) {
      const r = await loadRobots(ctx, source, fetcher, now);
      if (r.status === 'disallowed') return await fail('robots_disallowed', 'robots.txt disallows this URL for our crawler — not fetching', 'BLOCKED');
      if (r.status === 'unreachable') return await fail('failed', 'robots.txt could not be read — not crawling until it can be', 'DEGRADED');
      crawlDelay = r.rules?.crawlDelay;
    }
    const page = await fetcher.get(source.baseUrl, { crawlDelaySec: crawlDelay, etag: source.etag ?? undefined, lastModified: source.lastModified ?? undefined });
    sum.fetched = 1;
    if (page.notModified) {
      source.healthStatus = 'HEALTHY'; source.failureCount = 0; source.lastSuccessAt = now; source.lastError = undefined;
      await source.save();
      return { ...sum, status: 'unchanged' };
    }
    let items: ParsedItem[] = [];
    const cfg = (source.parserConfig ?? {}) as Record<string, unknown>;
    if (source.type === 'RSS' || source.type === 'ATOM') items = parseFeed(page.body);
    else if (source.type === 'HTML_LISTING') items = parseHtmlListing(page.body, { baseUrl: source.baseUrl, ...(cfg as unknown as HtmlListingConfig) });
    else if (source.type === 'HTML_PRODUCT') { const p = parseProductPage(page.body); if (p) items = [{ ...p, url: source.baseUrl }]; }
    else if (source.type === 'JSON_PUBLIC') items = parseJsonPublic(page.body, cfg as unknown as JsonPublicConfig);
    else if (source.type === 'SITEMAP') {
      const sm = parseSitemap(page.body);
      const urls = sm.urls.slice(0, 500);
      // product pages named in the sitemap: new/updated URLs are a signal even without fetching them
      items = urls.map((u, i) => ({ title: titleFromUrl(u.loc), url: u.loc, publishedAt: u.lastmod, rank: i + 1 }));
      let budget = source.fetchProductPages ?? 0;
      for (const [i, u] of urls.entries()) {
        if (budget <= 0) break;
        if (source.robotsRequired) { const rr = parseRobots(source.robotsTxt ?? '', 'orviamarketbot'); if (!rr.isAllowed(new URL(u.loc).pathname)) continue; }
        try {
          const pp = parseProductPage((await fetcher.get(u.loc, { crawlDelaySec: crawlDelay, retries: 1 })).body);
          budget--;
          sum.fetched++;
          if (pp) items[i] = { ...items[i]!, ...pp, title: pp.title || items[i]!.title, url: u.loc };
        } catch (e) {
          if (e instanceof SourceBlockedError) break; // respect it, stop hitting this host
        }
      }
    }
    for (const it of items.slice(0, 500)) {
      const r = await record(source, it, now);
      if (r.inserted) sum.documents++;
      if (r.topicCreated) sum.topics++;
    }
    if (page.etag) source.etag = page.etag;
    if (page.lastModified) source.lastModified = page.lastModified;
    source.healthStatus = 'HEALTHY'; source.failureCount = 0; source.lastSuccessAt = now; source.lastError = undefined;
    source.documentsCollected += sum.documents;
    source.successRate = Math.round(((source.successRate ?? 0) * 0.8 + 0.2) * 100) / 100;
    await source.save();
    return sum;
  } catch (e) {
    if (e instanceof SourceBlockedError) return fail('blocked', e.message, 'BLOCKED');
    return fail('failed', (e as Error).message, 'DEGRADED');
  }
}

/** Sources whose next crawl is due (interval × exponential backoff after failures). */
export async function dueSources(ctx: Ctx, limit = 5): Promise<string[]> {
  const now = ctx.now().getTime();
  const rows = await MarketSource.find({ enabled: true, type: { $nin: ['INTERNAL_ANALYTICS', 'SUPPLIER'] } }).select('lastCrawledAt crawlIntervalMinutes failureCount healthStatus').limit(500).lean();
  return rows
    .filter((s) => s.healthStatus !== 'BLOCKED' || !s.lastCrawledAt || now - s.lastCrawledAt.getTime() > 24 * 3_600_000)
    .filter((s) => !s.lastCrawledAt || now - s.lastCrawledAt.getTime() >= s.crawlIntervalMinutes * 60_000 * 2 ** Math.min(s.failureCount ?? 0, 4))
    .sort((a, b) => (a.lastCrawledAt?.getTime() ?? 0) - (b.lastCrawledAt?.getTime() ?? 0))
    .slice(0, limit)
    .map((s) => String(s._id));
}
