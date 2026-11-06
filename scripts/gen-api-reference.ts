/**
 * Generates docs/ORVIA_API_REFERENCE.md from the real route table (no database needed).
 * Builds the API like scripts/boot-check.ts, then reads the metadata `route()` records (apps/api/src/http.ts).
 * Raw `app.get(...)` routes are not recorded by `route()`; they are listed in RAW below (auth read by hand) and the
 * total is cross-checked against Fastify's router so a newly added raw route fails the run instead of going undocumented.
 * Regenerate: `npm run docs:api`.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { PERMISSIONS, ROLE_PERMISSIONS } from '@orvia/auth';
import { loadConfig } from '@orvia/config';
import { buildCtx } from '@orvia/core';
import { buildServer } from '../apps/api/src/server';
import { registeredRoutes } from '../apps/api/src/http';
import type { RouteMeta } from '../apps/api/src/http';

process.env.NODE_ENV ??= 'test';
const cfg = loadConfig();
const ctx = buildCtx({ cfg, service: 'api' });
const app = await buildServer(ctx, { withJobHandlers: true });
await app.close();

const metas = [...registeredRoutes()];

/** Raw (non-route()) routes: auth read from the handlers in apps/api/src/routes and plugins. */
const RAW: { method: string; url: string; auth: string; summary: string; rateLimit?: string; note?: string }[] = [
  { method: 'GET', url: '/live', auth: 'none', summary: 'Process liveness' },
  { method: 'GET', url: '/health', auth: 'none', summary: 'Health summary (env, version, uptime)' },
  { method: 'GET', url: '/ready', auth: 'none', summary: 'Readiness (Mongo reachable; Redis reported as degraded)' },
  { method: 'GET', url: '/metrics', auth: 'none; bearer `METRICS_TOKEN` when set; 404 in production without a token', summary: 'Prometheus metrics' },
  { method: 'GET', url: '/openapi.json', auth: 'none', summary: 'OpenAPI document (`/docs` UI only outside production)' },
  { method: 'GET', url: '/api/v1/media/*', auth: 'none', summary: 'Serve a stored media object (only registered with the local storage provider; production uses the CDN/object store)' },
  { method: 'GET', url: '/api/v1/launch-gate', auth: 'bearer `METRICS_TOKEN`; 404 in production without a token', summary: 'Machine-readable launch gate for CI/CD', rateLimit: '10 / 1 minute' },
  { method: 'GET', url: '/api/v1/aftersales/returns/:id/evidence/:evidenceId', auth: 'user (owner of the return)', summary: 'Download return evidence image' },
  { method: 'GET', url: '/api/v1/admin/aftersales/returns/:id/evidence/:evidenceId', auth: 'staff: `returns:read`', summary: 'Download return evidence image (staff)' },
];

const authLabel = (m: RouteMeta): string => {
  if (m.auth === 'staff') return m.permission ? `staff: \`${m.permission}\`` : 'staff (any non-customer role)';
  return m.auth;
};
const esc = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const fields = (schema?: Record<string, unknown>): string => {
  if (!schema) return '';
  const props = (schema['properties'] ?? {}) as Record<string, unknown>;
  const req = new Set((schema['required'] as string[] | undefined) ?? []);
  const names = Object.keys(props).map((k) => (req.has(k) ? `${k}*` : k));
  const out = names.length > 14 ? `${names.slice(0, 14).join(', ')}, +${names.length - 14}` : names.join(', ');
  return out ? `\`${out}\`` : '';
};
const area = (m: RouteMeta): string => m.tags[0] ?? 'Untagged';

const groups = new Map<string, RouteMeta[]>();
for (const m of metas) {
  const g = groups.get(area(m)) ?? [];
  g.push(m);
  groups.set(area(m), g);
}
const count = (f: (m: RouteMeta) => boolean): number => metas.filter(f).length;
const anchor = (g: string): string => g.toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/ +/g, '-');

// Cross-check: every raw `app.<verb>(` in the API source must be listed in RAW (a new undocumented raw route fails the run).
const rawInSource = ['plugins.ts', ...readdirSync('apps/api/src/routes').map((f) => `routes/${f}`)]
  .map((f) => readFileSync(`apps/api/src/${f}`, 'utf8'))
  .reduce((n, src) => n + (src.match(/\bapp\.(get|post|put|patch|delete)\(\s*'/g)?.length ?? 0), 0);
if (rawInSource !== RAW.length) throw new Error(`raw Fastify routes in source (${rawInSource}) differ from RAW table (${RAW.length}); update scripts/gen-api-reference.ts`);

let md = `# ORVIA API reference

> **Generated file. Do not edit by hand.** Regenerate with \`npm run docs:api\` (builds the API with no database and reads the route table; source: \`scripts/gen-api-reference.ts\`, metadata recorded by \`route()\` in \`apps/api/src/http.ts\`).
> Conventions (auth, CSRF, errors, idempotency, rate limits) are in [API.md](API.md). Interactive OpenAPI is served at \`/docs\` outside production.

Base path \`/api/v1\`. Body/query columns list property names from each route's zod schema (converted to JSON schema); \`*\` marks a required property. Auth modes: \`none\` public; \`optional\` works anonymous or signed-in; \`user\` any signed-in account (ownership is enforced inside the handler, see [ORVIA_SECURITY_AND_PRIVACY.md](ORVIA_SECURITY_AND_PRIVACY.md)); \`staff\` a non-customer, non-supplier role, plus the named permission from \`packages/auth\` where shown. "Rate limit" appears only when the route declares its own limit; every route is also covered by the global per-IP limit (\`RATE_LIMIT_PER_MINUTE\`). Cookie-authenticated mutations additionally need the \`x-requested-with: orvia\` header.

Totals: **${metas.length}** routes declared via \`route()\` (${count((m) => m.auth === 'none')} none, ${count((m) => m.auth === 'optional')} optional, ${count((m) => m.auth === 'user')} user, ${count((m) => m.auth === 'staff')} staff) plus ${RAW.length} raw Fastify routes. Dev/test-only helper routes (\`/dev/*\`) are registered only when \`APP_ENV\` is not production/staging; this build ran as \`${cfg.APP_ENV}\`, so the list below ${metas.some((m) => m.url.includes('/dev/')) ? 'includes' : 'excludes'} them.

`;
md += `## Areas\n\n${[...groups.keys()].sort().map((g) => `- [${g}](#${anchor(g)}) (${groups.get(g)!.length})`).join('\n')}\n- [Raw Fastify routes](#raw-fastify-routes) (${RAW.length})\n`;
for (const g of [...groups.keys()].sort()) {
  md += `\n## ${g}\n\n| Method | Path | Auth | Summary | Rate limit | Body | Query |\n|---|---|---|---|---|---|---|\n`;
  const rows = groups.get(g)!.sort((a, b) => a.url.localeCompare(b.url) || a.method.localeCompare(b.method));
  for (const m of rows) {
    md += `| ${m.method} | \`${m.url}\` | ${authLabel(m)} | ${esc(m.summary)} | ${m.rateLimit ? `${m.rateLimit.max} / ${m.rateLimit.timeWindow}` : ''} | ${fields(m.bodySchema)} | ${fields(m.querySchema)} |\n`;
  }
}
md += `\n## Raw Fastify routes\n\nRegistered directly with \`app.get\` rather than \`route()\`, so they carry no zod schema and are hidden from OpenAPI. Auth was read from the handlers.\n\n| Method | Path | Auth | Summary | Rate limit |\n|---|---|---|---|---|\n`;
for (const r of RAW) md += `| ${r.method} | \`${r.url}\` | ${r.auth} | ${esc(r.summary)} | ${r.rateLimit ?? ''} |\n`;
const ROLES = Object.keys(ROLE_PERMISSIONS) as (keyof typeof ROLE_PERMISSIONS)[];
const uses = new Map<string, number>();
for (const m of metas) if (m.permission) uses.set(m.permission, (uses.get(m.permission) ?? 0) + 1);
md += `\n## Permission by role matrix\n\nGenerated from \`PERMISSIONS\` and \`ROLE_PERMISSIONS\` in \`packages/auth/src/index.ts\`. "Routes" is how many \`route()\` definitions require the permission. Roles without any staff permission (CUSTOMER) are shown for completeness; SUPPLIER only holds the supplier-portal permissions and \`staff\` routes reject CUSTOMER and SUPPLIER before the permission check.\n\n| Permission | Routes | ${ROLES.join(' | ')} |\n|---|---|${ROLES.map(() => ':-:').join('|')}|\n`;
for (const perm of PERMISSIONS) md += `| \`${perm}\` | ${uses.get(perm) ?? 0} | ${ROLES.map((r) => (ROLE_PERMISSIONS[r].includes(perm) ? 'x' : '')).join(' | ')} |\n`;
md += `\nPermissions defined: ${PERMISSIONS.length}. Permissions with no route requiring them: ${PERMISSIONS.filter((p) => !uses.has(p)).map((p) => `\`${p}\``).join(', ') || 'none'}. Permissions used by routes but not in the list: ${[...uses.keys()].filter((p) => !(PERMISSIONS as readonly string[]).includes(p)).join(', ') || 'none'}.\n`;
writeFileSync('docs/ORVIA_API_REFERENCE.md', md);
console.warn(`wrote docs/ORVIA_API_REFERENCE.md (${metas.length} route() routes, ${RAW.length} raw)`);
process.exit(0);
