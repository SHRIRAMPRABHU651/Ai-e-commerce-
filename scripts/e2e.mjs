// Self-contained E2E: ephemeral MongoDB → seed → built API + worker + web → Playwright (desktop + mobile).
// Requires `npm run build` first (the script runs it if the bundles are missing).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';

const API_PORT = 4300, WEB_PORT = 3100, WORKER_PORT = 4400;
if (!existsSync('apps/api/dist/main.js') || !existsSync('apps/web/.next/BUILD_ID')) {
  console.log('[e2e] building…');
  if (spawnSync('npm', ['run', 'build'], { stdio: 'inherit' }).status !== 0) process.exit(1);
}
const dbPath = mkdtempSync(join(tmpdir(), 'orvia-e2e-'));
const mongo = await MongoMemoryServer.create({ instance: { dbName: 'orvia_e2e', dbPath, storageEngine: 'wiredTiger' } });
const env = {
  ...process.env, NODE_ENV: 'development', MONGODB_URI: mongo.getUri('orvia_e2e'), API_PORT: String(API_PORT), WORKER_PORT: String(WORKER_PORT),
  API_URL: `http://localhost:${API_PORT}`, WEB_URL: `http://localhost:${WEB_PORT}`, CORS_ORIGINS: `http://localhost:${WEB_PORT}`,
  MOCK_TIME_SCALE: '86400', LOG_LEVEL: 'warn', RATE_LIMIT_PER_MINUTE: '100000',
};
const kids = [];
const start = (cmd, args, extra = {}, cwd = process.cwd()) => { const p = spawn(cmd, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'inherit', 'inherit'], detached: true }); kids.push(p); return p; };
const runAsync = (cmd, args, e) => new Promise((res) => { const p = spawn(cmd, args, { env: e, stdio: 'inherit' }); p.on('exit', (c) => res(c ?? 1)); });
const cleanup = async () => { kids.forEach((k) => { try { process.kill(-k.pid, 'SIGTERM'); } catch { /* already gone */ } }); await mongo.stop(); rmSync(dbPath, { recursive: true, force: true }); };
const wait = async (url) => { for (let i = 0; i < 120; i++) { try { if ((await fetch(url)).ok) return; } catch { /* retry */ } await new Promise((r) => setTimeout(r, 500)); } throw new Error(`timeout: ${url}`); };

let code = 1;
try {
  if ((await runAsync('npx', ['tsx', 'scripts/seed.ts'], env)) !== 0) throw new Error('seed failed');
  start('node', ['apps/api/dist/main.js']);
  start('node', ['apps/worker/dist/main.js']);
  await wait(`http://localhost:${API_PORT}/ready`);
  start('npx', ['next', 'start', '-p', String(WEB_PORT)], {}, 'apps/web');
  await wait(`http://localhost:${WEB_PORT}/`);
  if (process.env.E2E_SERVE_ONLY) { console.log('[e2e] stack up (E2E_SERVE_ONLY): web :3100, api :4300'); await new Promise(() => {}); }
  code = await runAsync('npx', ['playwright', 'test', ...process.argv.slice(2)], { ...env, E2E_WEB_URL: `http://localhost:${WEB_PORT}`, E2E_API_URL: `http://localhost:${API_PORT}` });
} catch (e) { console.error('[e2e]', e.message); } finally { await cleanup(); }
process.exit(code);
