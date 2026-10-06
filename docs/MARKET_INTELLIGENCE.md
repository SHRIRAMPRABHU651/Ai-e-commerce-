# Market intelligence (zero-cost, no API keys)

Orvia does not scrape Google/Instagram/TikTok and does not ask an LLM what is trending. Pipeline: **public RSS/Atom/sitemaps/pages + supplier catalogs + Orvia's own search/view/cart/purchase signals → deterministic trend score → AI explanation of the evidence only.**

- **Crawler**: identifies itself (`MARKET_CRAWLER_CONTACT`), obeys robots.txt and Crawl-delay, backs off on 429/5xx, stops at 403/CAPTCHA/login/paywall, auto-disables repeatedly failing sources, SSRF-guarded.
- **Parsers**: RSS/Atom, XML sitemap, JSON-LD Product/Offer, configurable HTML listing selectors, public JSON.
- **Trend score** (0–100): recency .20, velocity .25, cross-source .15, mention growth .15, search growth .10, availability .05, price momentum .05, internal conversion .05; shrinkage for small samples; confidence capped at 0.45 for single-source topics; `INSUFFICIENT_DATA` rather than a guess.
- **Competitor prices**: median/low/high with LOW/MEDIUM/HIGH confidence; LOW confidence never drives pricing. FX uses a static settings table and is recorded as such.
- **Copilot**: `trend_explain` answers only from stored evidence and says so when evidence is thin.
- **UI**: Admin → Market intel. Add sources there; nothing is crawled by default.

Limits: only public pages you configure; no search-volume data; trends reflect your sources, not "the market".
