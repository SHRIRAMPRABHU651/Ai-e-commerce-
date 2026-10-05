// One command local stack: MongoDB (no Docker needed) → seed (first run) → API → worker → web.
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';

const env = { ...process.env };
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
env.NODE_ENV ??= 'development';
env.API_INLINE_WORKER = 'false';

const kids = [];
const run = (name, cmd, args, extra = {}) => {
  const p = spawn(cmd, args, { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  const tag = `[${name}]`.padEnd(9);
  for (const s of [p.stdout, p.stderr]) s.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((l) => console.log(tag, l.slice(0, 400))));
  p.on('exit', (c) => console.log(tag, `exited (${c})`));
  kids.push(p);
  return p;
};
const once = (name, cmd, args) => new Promise((res, rej) => { const p = run(name, cmd, args); p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`${name} failed`)))); });
const portOpen = (port) => new Promise((res) => { const s = createConnection({ port, host: '127.0.0.1' }); s.on('connect', () => { s.destroy(); res(true); }); s.on('error', () => res(false)); });
const waitFor = async (url, ms = 60000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if ((await fetch(url)).ok) return; } catch { /* retry */ } await new Promise((r) => setTimeout(r, 500)); } throw new Error(`timeout waiting for ${url}`); };

const stop = () => { kids.forEach((k) => k.kill('SIGTERM')); setTimeout(() => process.exit(0), 500); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

const uri = env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/orvia';
if (/127\.0\.0\.1|localhost/.test(uri) && !(await portOpen(27017))) {
  run('mongo', 'node', ['scripts/dev-mongo.mjs']);
  while (!(await portOpen(27017))) await new Promise((r) => setTimeout(r, 300));
}
await once('seed', 'npx', ['tsx', 'scripts/seed.ts']);
run('api', 'npx', ['tsx', 'watch', '--clear-screen=false', 'apps/api/src/main.ts']);
run('worker', 'npx', ['tsx', 'watch', '--clear-screen=false', 'apps/worker/src/main.ts']);
await waitFor(`http://localhost:${env.API_PORT ?? 4000}/live`);
run('web', 'npm', ['run', 'dev', '-w', '@orvia/web']);
console.log('\n  Storefront  http://localhost:3000\n  Admin       http://localhost:3000/admin  (owner@orvia.test / Orvia-Demo-2026!)\n  API docs    http://localhost:4000/docs\n');
