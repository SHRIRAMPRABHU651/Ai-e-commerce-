import { FetchBlockedError, guardedFetch } from '../infra/ssrf';

export class SourceBlockedError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'SourceBlockedError';
  }
}

export interface FetchedPage {
  status: number;
  body: string;
  notModified: boolean;
  etag?: string;
  lastModified?: string;
  contentType: string;
}

/**
 * Polite HTTP fetcher for public sources: identifies itself, throttles per host (honouring Crawl-delay),
 * backs off exponentially on 429/5xx, and STOPS on 401/403/451 — it never tries to get around an access control.
 */
export class MarketFetcher {
  private lastAt = new Map<string, number>();
  readonly userAgent: string;
  constructor(private readonly o: { contact: string; allowPrivate?: boolean; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; minDelayMs?: number; now?: () => number }) {
    this.userAgent = `OrviaMarketBot/1.0 (+${o.contact})`;
  }
  private sleep = (ms: number) => (this.o.sleep ?? ((n: number) => new Promise<void>((r) => setTimeout(r, n))))(ms);
  private now = () => (this.o.now ?? Date.now)();

  private async throttle(host: string, crawlDelaySec?: number): Promise<void> {
    const gap = Math.max(this.o.minDelayMs ?? 2000, (crawlDelaySec ?? 0) * 1000);
    // at least `gap` since the previous request to this host — including the robots.txt fetch that taught us the Crawl-delay
    const wait = (this.lastAt.get(host) ?? -Infinity) + gap - this.now();
    if (wait > 0) await this.sleep(Math.min(wait, 60_000));
    this.lastAt.set(host, this.now());
  }

  async get(url: string, o: { crawlDelaySec?: number; etag?: string; lastModified?: string; maxBytes?: number; retries?: number; accept?: string } = {}): Promise<FetchedPage> {
    const host = new URL(url).host;
    let lastErr: Error | undefined;
    for (let attempt = 0; attempt <= (o.retries ?? 2); attempt++) {
      await this.throttle(host, o.crawlDelaySec);
      try {
        const res = await guardedFetch(url, {
          allowPrivate: this.o.allowPrivate, fetchImpl: this.o.fetchImpl, maxBytes: o.maxBytes ?? 2_000_000, timeoutMs: 15_000,
          headers: { 'user-agent': this.userAgent, accept: o.accept ?? 'text/html,application/xhtml+xml,application/xml,application/rss+xml,application/atom+xml,application/json;q=0.9,*/*;q=0.5', ...(o.etag ? { 'if-none-match': o.etag } : {}), ...(o.lastModified ? { 'if-modified-since': o.lastModified } : {}) },
        });
        if (res.status === 304) return { status: 304, body: '', notModified: true, contentType: '' };
        if ([401, 403, 451].includes(res.status)) throw new SourceBlockedError(`Access denied (HTTP ${res.status}) — not retrying`, res.status);
        if (res.status === 404 || res.status === 410) throw new Error(`Not found (HTTP ${res.status})`);
        if (res.status === 429 || res.status >= 500) {
          const ra = Number(res.headers.get('retry-after'));
          lastErr = new Error(`HTTP ${res.status}`);
          if (attempt < (o.retries ?? 2)) { await this.sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 30) * 1000 : 1000 * 2 ** attempt); continue; }
          throw lastErr;
        }
        if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
        const body = res.body.toString('utf8');
        if (/<title>[^<]*(captcha|are you a robot|access denied|attention required)/i.test(body.slice(0, 4000))) throw new SourceBlockedError('Anti-bot / CAPTCHA page detected — not attempting to bypass it');
        return { status: res.status, body, notModified: false, etag: res.headers.get('etag') ?? undefined, lastModified: res.headers.get('last-modified') ?? undefined, contentType: res.headers.get('content-type') ?? '' };
      } catch (e) {
        if (e instanceof SourceBlockedError) throw e;
        if (e instanceof FetchBlockedError && !e.retryable) throw e;
        lastErr = e as Error;
        if (attempt < (o.retries ?? 2)) { await this.sleep(1000 * 2 ** attempt); continue; }
      }
    }
    throw lastErr ?? new Error('fetch failed');
  }
}
