// Performance baseline: ephemeral MongoDB → seed → built API → autocannon at N concurrent connections.
// Usage: npm run perf [-- --connections 50 --duration 20]
// Numbers are only meaningful for the machine they ran on: commit them with the hardware noted (docs/PERFORMANCE.md).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import autocannon from 'autocannon';
import { MongoMemoryServer } from 'mongodb-memory-server';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? Number(process.argv[i + 1]) : d; };
const connections = arg('connections', 50), duration = arg('duration', 20);
const PORT = 4350;
if (!existsSync('apps/api/dist/main.js') && spawnSync('npm', ['run', 'build', '-w', '@orvia/api'], { stdio: 'inherit' }).status !== 0) process.exit(1);
const dbPath = mkdtempSync(join(tmpdir(), 'orvia-perf-'));
const mongo = await MongoMemoryServer.create({ instance: { dbName: 'orvia_perf', dbPath, storageEngine: 'wiredTiger' } });
const env = { ...process.env, NODE_ENV: 'development', MONGODB_URI: mongo.getUri('orvia_perf'), API_PORT: String(PORT), API_URL: `http://localhost:${PORT}`, WEB_URL: 'http://localhost:3100', CORS_ORIGINS: 'http://localhost:3100', LOG_LEVEL: 'error', RATE_LIMIT_PER_MINUTE: '10000000', TRUST_PROXY: 'true', MOCK_TIME_SCALE: '1' };
let api;
const cleanup = async () => { try { api && process.kill(-api.pid, 'SIGTERM'); } catch { /* gone */ } await mongo.stop(); rmSync(dbPath, { recursive: true, force: true }); };
const base = `http://localhost:${PORT}/api/v1`;
const pct = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] : 0);
// autocannon's summary has no p95, so collect every response time and compute exact percentiles ourselves.
const run = (opts) => new Promise((res, rej) => {
  const times = []; const codes = {};
  const inst = autocannon({ connections, duration, ...opts }, (e, r) => {
    if (e) return rej(e);
    times.sort((a, b) => a - b);
    res({ ...r, exact: { p50: pct(times, 0.5), p95: pct(times, 0.95), p99: pct(times, 0.99), n: times.length }, codes });
  });
  inst.on('response', (_c, status, _b, ms) => { times.push(ms); codes[status] = (codes[status] ?? 0) + 1; });
});
const row = (name, r) => ({ name, connections, durationS: duration, rps: Math.round(r.requests.average), p50: r.exact.p50, p95: r.exact.p95, p99: r.exact.p99, max: r.latency.max, samples: r.exact.n, statusCodes: r.codes, errors: r.errors, timeouts: r.timeouts });
const results = [];
try {
  // async spawn: a blocking spawnSync stops us draining mongod's stdio pipe and the database stalls
  const seedCode = await new Promise((res) => { const c = spawn('npx', ['tsx', 'scripts/seed.ts'], { env, stdio: 'ignore' }); c.on('exit', (code) => res(code ?? 1)); });
  if (seedCode !== 0) throw new Error('seed failed');
  api = spawn('node', ['apps/api/dist/main.js'], { env, stdio: 'ignore', detached: true });
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`http://localhost:${PORT}/ready`)).ok) break; } catch { /* retry */ } await new Promise((r) => setTimeout(r, 500)); }
  const list = await (await fetch(`${base}/products?pageSize=24&country=US`)).json();
  const p = list.items.find((x) => x.available);
  const detail = await (await fetch(`${base}/products/${p.slug}?country=US`)).json();
  const headers = { 'x-requested-with': 'orvia', 'content-type': 'application/json' };
  console.log(`warm-up + ${connections} connections × ${duration}s per endpoint`);
  await run({ url: `${base}/products?pageSize=24&country=US`, duration: 3 });
  results.push(row('GET /api/v1/products', await run({ url: `${base}/products?pageSize=24&country=US`, headers })));
  results.push(row('GET /api/v1/products/:slug', await run({ url: `${base}/products/${p.slug}?country=US`, headers })));
  // checkout journey per connection: add to cart → checkout (unique idempotency key each time, cart cookie carried by the connection)
  const requests = [
    { method: 'POST', path: '/api/v1/cart/items?country=US', headers, setupRequest: (req) => ({ ...req, body: JSON.stringify({ productId: p.id, variantSku: detail.variants[0].sku, quantity: 1 }) }) },
    { method: 'POST', path: '/api/v1/checkout', headers, setupRequest: (req) => ({ ...req, body: JSON.stringify({ email: `perf${Math.random().toString(36).slice(2, 10)}@example.com`, address: { fullName: 'Perf Test', line1: '1 Main St', city: 'Austin', region: 'TX', postalCode: '78701', country: 'US', phone: '+15125550100' }, shippingMethod: 'standard', idempotencyKey: `perf-${Date.now()}-${Math.random()}` }) }) },
  ];
  // per-connection cookie jar via autocannon's client context
  const jar = { onResponse: (_status, _body, context, resHeaders) => { const sc = resHeaders['set-cookie']; if (sc) context.cookie = [].concat(sc).map((c) => c.split(';')[0]).join('; '); } };
  const withJar = (q) => ({ ...q, ...jar, setupRequest: (req, context) => { const r = q.setupRequest(req); context.ip ??= `10.${(Math.random() * 250 + 1) | 0}.${(Math.random() * 250 + 1) | 0}.${(Math.random() * 250 + 1) | 0}`; // checkout is rate-limited per client IP (20/min) by design; real shoppers come from many IPs
      return { ...r, headers: { ...r.headers, 'x-forwarded-for': context.ip, ...(context.cookie ? { cookie: context.cookie } : {}) } }; } });
  const r = await run({ url: `http://localhost:${PORT}`, requests: requests.map(withJar) });
  results.push({ ...row('POST /api/v1/cart/items + POST /api/v1/checkout (journey)', r), note: 'two requests per iteration; statusCodes covers both' });
  const out = { at: new Date().toISOString(), host: { cpus: cpus().length, model: cpus()[0]?.model, memGB: Math.round(totalmem() / 1e9), node: process.version }, mongo: 'mongodb-memory-server (in-process, same host)', results };
  writeFileSync('perf-results.json', JSON.stringify(out, null, 2));
  console.table(results.map(({ name, rps, p50, p95, p99, max, statusCodes, errors, timeouts }) => ({ name, rps, 'p50 ms': p50, 'p95 ms': p95, 'p99 ms': p99, 'max ms': max, statusCodes: JSON.stringify(statusCodes), errors, timeouts })));
} catch (e) { console.error('[perf]', e.message); process.exitCode = 1; } finally { await cleanup(); }
