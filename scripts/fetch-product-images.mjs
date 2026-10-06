// Downloads real photographs for the demo catalogue from Wikimedia Commons (open licences only) into
// apps/web/public/products/, and records author + licence in credits.json (attribution is required for CC-BY/SA).
// Usage: node scripts/fetch-product-images.mjs [productId ...]   (re-run with ids to refresh specific products)
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';

const OUT = 'apps/web/public/products';
const CREDITS = `${OUT}/credits.json`;
mkdirSync(OUT, { recursive: true });
const credits = existsSync(CREDITS) ? JSON.parse(readFileSync(CREDITS, 'utf8')) : {};
const Q = JSON.parse(readFileSync('scripts/product-image-queries.json', 'utf8'));
const only = process.argv.slice(2);
const OK = /^(cc0|cc[- ]by|cc[- ]by[- ]sa|public domain|pd|attribution)/i;
const BAD_TITLE = /(bodleian|library|book|manuscript|illustration|drawing|engraving|painting|map|logo|diagram|poster|stamp|cartoon|svg|gif|screenshot|postcard|advert|catalog)/i;
const UA = { 'user-agent': 'OrviaDemoCatalogue/1.0 (demo shop; contact: shriramprabhu651@gmail.com)' };

async function search(q) {
  const u = new URL('https://commons.wikimedia.org/w/api.php');
  Object.entries({ action: 'query', format: 'json', generator: 'search', gsrnamespace: 6, gsrsearch: `${q} filetype:bitmap`, gsrlimit: 25, prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: 900 }).forEach(([k, v]) => u.searchParams.set(k, v));
  const r = await fetch(u, { headers: UA });
  const j = await r.json();
  return Object.values(j.query?.pages ?? {}).sort((a, b) => a.index - b.index);
}
const plain = (s) => (s ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

for (const [id, spec] of Object.entries(Q)) {
  if (only.length && !only.includes(id)) continue;
  const want = spec.count ?? 3;
  const got = [];
  for (const q of spec.q) {
    if (got.length >= want) break;
    let pages = [];
    try { pages = await search(q); } catch (e) { console.log('  search failed', q, e.message); }
    for (const p of pages) {
      if (got.length >= want) break;
      const ii = p.imageinfo?.[0];
      if (!ii || !/image\/(jpeg|png)/.test(ii.mime) || ii.width < 700 || ii.height < 500) continue;
      if (BAD_TITLE.test(p.title)) continue;
      const m = ii.extmetadata ?? {};
      const lic = plain(m.LicenseShortName?.value);
      if (!OK.test(lic)) continue;
      if (got.some((g) => g.title === p.title)) continue;
      const img = await fetch(ii.thumburl, { headers: UA });
      if (!img.ok) continue;
      const buf = Buffer.from(await img.arrayBuffer());
      const file = `${id}-${got.length + 1}.jpg`;
      writeFileSync(`${OUT}/${file}`, buf);
      got.push({ file, title: p.title, author: plain(m.Artist?.value).slice(0, 120), license: lic, source: ii.descriptionurl });
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  credits[id] = got;
  console.log(id.padEnd(26), got.length ? got.map((g) => g.title.replace('File:', '').slice(0, 40)).join(' | ') : 'NONE');
  writeFileSync(CREDITS, JSON.stringify(credits, null, 1));
}
