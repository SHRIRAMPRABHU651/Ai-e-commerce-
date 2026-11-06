// Load scenarios for the ORVIA API (autocannon). Complements scripts/perf.mjs (which stays the quick local baseline).
//
//   npm run load                                   # local: ephemeral MongoDB (mongodb-memory-server) → seed → built API → every scenario
//   npm run load -- --scenario search,find         # a subset
//   node scripts/load-scenarios.mjs --target https://staging-api.example.com --connections 25 --duration 30 --scenario search,browse,find
//   node scripts/load-scenarios.mjs --target https://staging-api.example.com --allow-writes --scenario cart,checkout,support
//
// Scenarios: search, browse, find (ORVIA Find), cart, checkout (order creation), support (assistant). Supplier sync / tracking-update job
// throughput is a separate in-process measurement: scripts/load-jobs.ts (`npm run load:jobs`).
//
// Every scenario prints measured p50/p95/p99, requests/s and error rate, compares them with a documented TARGET, and writes perf-results.json
// (key `load`, merged into an existing file). The targets are engineering hypotheses TO BE VALIDATED, not measured claims: see docs/PERFORMANCE.md.
// Nothing in this repository claims a measured number until someone has run this against a named environment and committed the output.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import autocannon from 'autocannon';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i > -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const flag = (n) => argv.includes(`--${n}`);
const connections = Number(opt('connections', 25));
const duration = Number(opt('duration', 20));
const warmup = Number(opt('warmup', 3));
const out = opt('out', 'perf-results.json');
const target = opt('target', '');
const allowWrites = flag('allow-writes');
const spoofIp = !flag('no-spoof-ip'); // distinct X-Forwarded-For per simulated shopper: per-IP rate limits are a security control and are NOT loosened
const ALL = ['search', 'browse', 'find', 'cart', 'checkout', 'support'];
const wanted = opt('scenario', 'all') === 'all' ? ALL : opt('scenario', 'all').split(',').map((s) => s.trim()).filter(Boolean);
for (const s of wanted) if (!ALL.includes(s)) { console.error(`unknown scenario "${s}" (choose from ${ALL.join(', ')})`); process.exit(2); }
const WRITES = new Set(['cart', 'checkout', 'support']);

/** Targets to be validated. p95 in ms, errorRate as a fraction. Chosen as plausible storefront SLO starting points for a single API replica; edit with evidence. */
const TARGETS = {
  search: { p95Ms: 400, errorRate: 0.005, note: 'GET /products?q= (in-process search index; see docs/LIMITATIONS.md #7)' },
  browse: { p95Ms: 350, errorRate: 0.005, note: 'GET /products list + GET /products/:slug' },
  find: { p95Ms: 900, errorRate: 0.01, note: 'POST /find natural-language query (deterministic parser; AI refinement is time-boxed)' },
  cart: { p95Ms: 300, errorRate: 0.005, note: 'add → read → change quantity → remove, per guest cart' },
  checkout: { p95Ms: 1200, errorRate: 0.01, note: 'POST /cart/items then POST /checkout (order creation, mock/sandbox payment intent)' },
  support: { p95Ms: 1500, errorRate: 0.01, note: 'POST /support/chat (grounded assistant; no LLM configured => deterministic replies)' },
};

// local mode may always write (ephemeral database); a remote target must be opted into explicitly
if (target && wanted.some((s) => WRITES.has(s)) && !allowWrites) {
  console.error(`Scenarios ${wanted.filter((s) => WRITES.has(s)).join(', ')} WRITE data (guest carts, orders, support tickets) on ${target}.\nRe-run with --allow-writes against a non-production environment you own.`);
  process.exit(2);
}

const pct = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] : 0);
const run = (opts, conns = connections, secs = duration) => new Promise((res, rej) => {
  const times = []; const codes = {};
  const inst = autocannon({ connections: conns, duration: secs, ...opts }, (e, r) => {
    if (e) return rej(e);
    times.sort((a, b) => a - b);
    res({ ...r, exact: { p50: pct(times, 0.5), p95: pct(times, 0.95), p99: pct(times, 0.99), n: times.length }, codes });
  });
  inst.on('response', (_c, status, _b, ms) => { times.push(ms); codes[status] = (codes[status] ?? 0) + 1; });
});

const ms = (n) => Number(n.toFixed(1));
function summarize(name, r) {
  const total = Object.values(r.codes).reduce((a, b) => a + b, 0);
  const ok = Object.entries(r.codes).filter(([c]) => Number(c) >= 200 && Number(c) < 300).reduce((a, [, n]) => a + n, 0);
  const limited = r.codes[429] ?? 0;
  const bad = total - ok - limited;
  const attempts = total + (r.errors ?? 0) + (r.timeouts ?? 0);
  const errorRate = attempts ? (bad + (r.errors ?? 0) + (r.timeouts ?? 0)) / attempts : 0;
  const t = TARGETS[name];
  const row = {
    scenario: name, note: t.note, connections, durationS: duration, rps: Math.round(r.requests.average), p50: ms(r.exact.p50), p95: ms(r.exact.p95), p99: ms(r.exact.p99), max: r.latency.max,
    samples: r.exact.n, statusCodes: r.codes, errorRate: Number(errorRate.toFixed(4)), rateLimitedRate: attempts ? Number((limited / attempts).toFixed(4)) : 0, networkErrors: r.errors, timeouts: r.timeouts,
    target: { p95Ms: t.p95Ms, errorRate: t.errorRate, status: 'to be validated' },
  };
  // 429s are reported separately: they mean the per-IP limiter protected the API, not that the API failed (but a run dominated by them measured nothing useful)
  row.verdict = attempts === 0 ? 'NO DATA' : row.rateLimitedRate > 0.2 ? 'INCONCLUSIVE (rate limited: see docs/PERFORMANCE.md)' : row.p95 <= t.p95Ms && row.errorRate <= t.errorRate ? 'within target' : 'MISSES target';
  return row;
}

/* ------------------------------ target selection ------------------------------ */
let api; let stop = async () => {};
let base;
if (target) {
  base = `${target.replace(/\/+$/, '')}/api/v1`;
  console.log(`[load] remote target ${target} (no process or database is started locally)`);
} else {
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  const PORT = 4360;
  if (!existsSync('apps/api/dist/main.js') && spawnSync('npm', ['run', 'build', '-w', '@orvia/api'], { stdio: 'inherit' }).status !== 0) process.exit(1);
  const dbPath = mkdtempSync(join(tmpdir(), 'orvia-load-'));
  const mongo = await MongoMemoryServer.create({ instance: { dbName: 'orvia_load', dbPath, storageEngine: 'wiredTiger' } });
  const env = { ...process.env, NODE_ENV: 'development', MONGODB_URI: mongo.getUri('orvia_load'), API_PORT: String(PORT), API_URL: `http://localhost:${PORT}`, WEB_URL: 'http://localhost:3100', CORS_ORIGINS: 'http://localhost:3100', LOG_LEVEL: 'error', RATE_LIMIT_PER_MINUTE: '10000000', TRUST_PROXY: 'true', MOCK_TIME_SCALE: '1' };
  stop = async () => { try { api && process.kill(-api.pid, 'SIGTERM'); } catch { /* gone */ } await mongo.stop(); rmSync(dbPath, { recursive: true, force: true }); };
  const seedCode = await new Promise((res) => { const c = spawn('npx', ['tsx', 'scripts/seed.ts'], { env, stdio: 'ignore' }); c.on('exit', (code) => res(code ?? 1)); });
  if (seedCode !== 0) { console.error('[load] seed failed'); await stop(); process.exit(1); }
  api = spawn('node', ['apps/api/dist/main.js'], { env, stdio: 'ignore', detached: true });
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`http://localhost:${PORT}/ready`)).ok) break; } catch { /* retry */ } await new Promise((r) => setTimeout(r, 500)); }
  base = `http://localhost:${PORT}/api/v1`;
}

const headers = { 'x-requested-with': 'orvia', 'content-type': 'application/json' };
const origin = new URL(base).origin;
const pick = (a) => a[(Math.random() * a.length) | 0];
const randIp = () => `10.${(Math.random() * 250 + 1) | 0}.${(Math.random() * 250 + 1) | 0}.${(Math.random() * 250 + 1) | 0}`;
/** Per-connection cookie jar (guest cart cookie) + a stable fake client IP per simulated shopper. */
const withJar = (q) => ({
  ...q,
  onResponse: (status, body, context, resHeaders) => { const sc = resHeaders['set-cookie']; if (sc) context.cookie = [].concat(sc).map((c) => c.split(';')[0]).join('; '); q.onResponse?.(status, body, context, resHeaders); },
  setupRequest: (req, context) => {
    const r = q.setupRequest ? q.setupRequest(req, context) : req;
    context.ip ??= randIp();
    return { ...r, headers: { ...headers, ...(r.headers ?? {}), ...(spoofIp ? { 'x-forwarded-for': context.ip } : {}), ...(context.cookie ? { cookie: context.cookie } : {}) } };
  },
});

const results = [];
let exitCode = 0;
try {
  const readyRes = await fetch(`${origin}/ready`).catch(() => null);
  if (!readyRes?.ok) throw new Error(`${origin}/ready did not answer 200: is the API reachable?`);
  const list = await (await fetch(`${base}/products?pageSize=48&country=US`)).json();
  const pool = (list.items ?? []).filter((x) => x.available);
  if (pool.length < 2) throw new Error('target has fewer than 2 available products: seed it first (npm run seed) or point --target at a seeded staging stack');
  const details = [];
  for (const p of pool.slice(0, 6)) { const d = await (await fetch(`${base}/products/${p.slug}?country=US`)).json(); if (d.variants?.length) details.push({ id: p.id, slug: p.slug, sku: d.variants[0].sku }); }
  if (!details.length) throw new Error('no product detail with variants could be read');

  if (wanted.includes('checkout')) {
    const meta = await (await fetch(`${base}/meta`)).json().catch(() => ({}));
    if (meta?.payment?.mode && meta.payment.mode !== 'mock') {
      throw new Error(`refusing the checkout scenario: payment mode is "${meta.payment.mode}", not "mock". It would create real, unpaid orders against a live payment configuration.`);
    }
  }

  console.log(`[load] ${wanted.join(', ')} · ${connections} connections × ${duration}s each (+${warmup}s warm-up) · target ${target || 'local ephemeral stack'}`);
  const terms = ['pet', 'dog toy', 'snufle', 'kids', 'desk organizer', 'water bottle', 'gift', 'lamp', 'travel', 'cat'];
  const findQueries = ['Best value gift for my dog under $40', 'Screen-free toys for a 5 year old before Friday', 'Cheapest desk organizer', 'Top rated travel gadgets', 'compare cat toys', 'durable chew toy for a large dog under $25'];
  const supportMsgs = ['How long does shipping take?', 'What is your return policy?', 'Where is my order?', 'Is the dog toy safe for puppies?'];

  const scenarios = {
    search: () => ({ url: base, requests: [withJar({ method: 'GET', setupRequest: (req) => ({ ...req, path: `/api/v1/products?q=${encodeURIComponent(pick(terms))}&pageSize=24&country=US` }) })] }),
    browse: () => ({ url: base, requests: [
      withJar({ method: 'GET', setupRequest: (req) => ({ ...req, path: `/api/v1/products?pageSize=24&page=${1 + ((Math.random() * 3) | 0)}&country=US` }) }),
      withJar({ method: 'GET', setupRequest: (req) => ({ ...req, path: `/api/v1/products/${pick(details).slug}?country=US` }) }),
    ] }),
    find: () => ({ url: base, requests: [withJar({ method: 'POST', setupRequest: (req) => ({ ...req, path: '/api/v1/find', body: JSON.stringify({ query: pick(findQueries), country: 'US' }) }) })] }),
    cart: () => ({ url: base, requests: [
      withJar({ method: 'POST', setupRequest: (req, ctx) => { ctx.item = pick(details); return { ...req, path: '/api/v1/cart/items?country=US', body: JSON.stringify({ productId: ctx.item.id, variantSku: ctx.item.sku, quantity: 1 }) }; } }),
      withJar({ method: 'GET', setupRequest: (req) => ({ ...req, path: '/api/v1/cart' }) }),
      withJar({ method: 'PATCH', setupRequest: (req, ctx) => ({ ...req, path: '/api/v1/cart/items', body: JSON.stringify({ productId: ctx.item.id, sku: ctx.item.sku, quantity: 2 }) }) }),
      withJar({ method: 'PATCH', setupRequest: (req, ctx) => ({ ...req, path: '/api/v1/cart/items', body: JSON.stringify({ productId: ctx.item.id, sku: ctx.item.sku, quantity: 0 }) }) }),
    ] }),
    checkout: () => ({ url: base, requests: [
      withJar({ method: 'POST', setupRequest: (req, ctx) => { ctx.item = pick(details); return { ...req, path: '/api/v1/cart/items?country=US', body: JSON.stringify({ productId: ctx.item.id, variantSku: ctx.item.sku, quantity: 1 }) }; } }),
      withJar({ method: 'POST', setupRequest: (req) => ({ ...req, path: '/api/v1/checkout', body: JSON.stringify({ email: `load${Math.random().toString(36).slice(2, 10)}@example.com`, address: { fullName: 'Load Test', line1: '1 Main St', city: 'Austin', region: 'TX', postalCode: '78701', country: 'US', phone: '+15125550100' }, shippingMethod: 'standard', idempotencyKey: `load-${Date.now()}-${Math.random()}` }) }) }),
    ] }),
    support: () => ({ url: base, requests: [withJar({ method: 'POST', setupRequest: (req) => ({ ...req, path: '/api/v1/support/chat', body: JSON.stringify({ message: pick(supportMsgs), country: 'US' }) }) })] }),
  };

  for (const name of wanted) {
    const cfg = scenarios[name]();
    // autocannon wants an absolute url; requests carry /api/v1 paths relative to the origin
    const common = { ...cfg, url: origin };
    process.stdout.write(`[load] ${name}: warm-up… `);
    await run(common, Math.min(connections, 5), warmup);
    process.stdout.write('measuring… ');
    const r = await run(common);
    const row = summarize(name, r);
    results.push(row);
    console.log(`${row.rps} req/s · p50 ${row.p50} ms · p95 ${row.p95} ms · p99 ${row.p99} ms · error rate ${(row.errorRate * 100).toFixed(2)}% · 429s ${(row.rateLimitedRate * 100).toFixed(1)}% → ${row.verdict}`);
  }

  let existing = {};
  try { existing = JSON.parse(readFileSync(out, 'utf8')); } catch { /* new file */ }
  const doc = {
    ...existing,
    load: {
      at: new Date().toISOString(), tool: 'scripts/load-scenarios.mjs', status: 'MEASURED ON THIS RUN ONLY: numbers describe this environment, not the product', environment: target || 'local ephemeral stack (API + in-process mongodb-memory-server + load generator on one host)',
      host: { cpus: cpus().length, model: cpus()[0]?.model, memGB: Math.round(totalmem() / 1e9), node: process.version }, connections, durationS: duration, spoofedClientIps: spoofIp, results,
    },
  };
  writeFileSync(out, JSON.stringify(doc, null, 2));
  console.table(results.map(({ scenario, rps, p50, p95, p99, errorRate, rateLimitedRate, verdict }) => ({ scenario, 'req/s': rps, 'p50 ms': p50, 'p95 ms': p95, 'p99 ms': p99, 'error %': +(errorRate * 100).toFixed(2), '429 %': +(rateLimitedRate * 100).toFixed(1), verdict })));
  console.log(`[load] wrote ${out}`);
  if (flag('strict') && results.some((r) => r.verdict !== 'within target')) exitCode = 1; // opt-in gate for a dedicated perf environment
} catch (e) { console.error('[load]', e.message); exitCode = 1; } finally { await stop(); }
process.exit(exitCode);
