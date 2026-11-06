/**
 * Generates the per-model reference tables of docs/ORVIA_DATABASE_DESIGN.md from the Mongoose models actually registered
 * (no database connection needed). The hand-written review sections live in
 * docs/ORVIA_DATABASE_DESIGN.handwritten.md
 * and are concatenated after the generated part, so regenerating never loses them.
 * Regenerate: `npm run docs:db`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import mongoose from 'mongoose';
import type { Schema, SchemaType } from 'mongoose';

// Import each models file in turn and attribute newly registered models to it (the owning workstream is the file).
const FILES: { file: string; domain: string; load: () => Promise<unknown> }[] = [
  { file: 'models.ts', domain: 'Core commerce, suppliers and platform', load: () => import('../packages/database/src/models') },
  { file: 'models.aftersales.ts', domain: 'After-sales', load: () => import('../packages/database/src/models.aftersales') },
  { file: 'models.trust.ts', domain: 'TrustGraph', load: () => import('../packages/database/src/models.trust') },
  { file: 'models.rescue.ts', domain: 'Delivery Rescue', load: () => import('../packages/database/src/models.rescue') },
  { file: 'models.customer360.ts', domain: 'Customer 360', load: () => import('../packages/database/src/models.customer360') },
  { file: 'models.find.ts', domain: 'Find (search and discovery)', load: () => import('../packages/database/src/models.find') },
  { file: 'models.finance.ts', domain: 'Finance ledger', load: () => import('../packages/database/src/models.finance') },
  { file: 'models.creators.ts', domain: 'Creators and loyalty', load: () => import('../packages/database/src/models.creators') },
  { file: 'models.events.ts', domain: 'Events and marketing outbox', load: () => import('../packages/database/src/models.events') },
  { file: 'models.suppliernet.ts', domain: 'Supplier network and portal', load: () => import('../packages/database/src/models.suppliernet') },
  { file: 'models.agents.ts', domain: 'AI agents', load: () => import('../packages/database/src/models.agents') },
];

/** Sub-grouping of the legacy core file (models.ts) by model name; anything unlisted falls under core commerce. */
const CORE_GROUPS: Record<string, string[]> = {
  'Identity, audit and platform': ['User', 'Session', 'Role', 'AuditLog', 'Notification', 'Job', 'SystemSetting', 'WebhookEvent', 'MockStore', 'Report'],
  'Suppliers (core)': ['Supplier', 'SupplierOffer', 'SupplierProduct'],
  'Ads, growth and analytics': ['AdAccount', 'AdCreative', 'AdMetric', 'Campaign', 'MeasuredCpa', 'MeasuredRefund', 'AnalyticsEvent'],
  'Market intelligence and AI operations': ['MarketDocument', 'MarketSource', 'MarketTopic', 'AiDecision', 'AiTask'],
};

interface ModelInfo { name: string; collection: string; schema: Schema }
const byFile = new Map<string, ModelInfo[]>();
const seen = new Set<string>();
for (const f of FILES) {
  await f.load();
  const added: ModelInfo[] = [];
  for (const name of mongoose.modelNames()) {
    if (seen.has(name)) continue;
    seen.add(name);
    const m = mongoose.models[name]!;
    added.push({ name, collection: m.collection.name, schema: m.schema });
  }
  byFile.set(f.file, added.sort((a, b) => a.name.localeCompare(b.name)));
}

const esc = (s: string): string => s.replace(/\|/g, '\\|');
const typeOf = (p: SchemaType): string => {
  const o = p as unknown as { instance: string; options: { ref?: unknown }; schema?: Schema; caster?: { instance?: string; options?: { ref?: unknown } } };
  if (o.instance === 'Array' || o.instance === 'DocumentArray') {
    if (o.schema) return `[subdoc: ${Object.keys(o.schema.paths).filter((k) => k !== '_id').slice(0, 8).join(', ')}${Object.keys(o.schema.paths).length > 9 ? ', ...' : ''}]`;
    const inner = o.caster?.instance ?? 'Mixed';
    const ref = o.caster?.options?.ref;
    return `[${inner}${ref ? `->${typeof ref === 'string' ? ref : 'ref'}` : ''}]`;
  }
  const ref = o.options.ref;
  return `${o.instance}${ref ? `->${typeof ref === 'string' ? ref : 'ref'}` : ''}`;
};
const flags = (p: SchemaType): string => {
  const o = p as unknown as { isRequired?: boolean; enumValues?: unknown[]; options: { default?: unknown; unique?: boolean; min?: number; max?: number } };
  const out: string[] = [];
  if (o.isRequired) out.push('required');
  if (o.enumValues && o.enumValues.length) out.push(`enum(${o.enumValues.filter((v) => v !== null && v !== undefined).join('/')})`);
  if (o.options.min !== undefined) out.push(`min ${o.options.min}`);
  if (o.options.max !== undefined) out.push(`max ${o.options.max}`);
  const d = o.options.default;
  if (d !== undefined && typeof d !== 'function') out.push(`default ${JSON.stringify(d)}`);
  return out.join('; ');
};
const idx = (schema: Schema): string[] =>
  schema.indexes().map(([keys, opt]) => {
    const k = Object.entries(keys).map(([f, d]) => `${f}:${d}`).join(', ');
    const o = (opt ?? {}) as Record<string, unknown>;
    const tags: string[] = [];
    if (o['unique']) tags.push('UNIQUE');
    if (o['sparse']) tags.push('sparse');
    if (o['expireAfterSeconds'] !== undefined) tags.push(`TTL ${String(o['expireAfterSeconds'])}s`);
    if (o['partialFilterExpression']) tags.push(`partial ${JSON.stringify(o['partialFilterExpression'])}`);
    return `\`{ ${k} }\`${tags.length ? ` ${tags.join(', ')}` : ''}`;
  });

const GROUPS: { file: string; domain: string; models: ModelInfo[] }[] = [];
for (const f of FILES) {
  const models = byFile.get(f.file) ?? [];
  if (f.file !== 'models.ts') { GROUPS.push({ file: f.file, domain: f.domain, models }); continue; }
  const claimed = new Set(Object.values(CORE_GROUPS).flat());
  GROUPS.push({ file: f.file, domain: 'Core commerce', models: models.filter((m) => !claimed.has(m.name)) });
  for (const [g, names] of Object.entries(CORE_GROUPS)) GROUPS.push({ file: f.file, domain: g, models: models.filter((m) => names.includes(m.name)) });
}

let total = 0;
let body = '';
let toc = '';
const uniq: string[] = [];
const ttl: string[] = [];
for (const f of GROUPS) {
  const models = f.models;
  if (!models.length) continue;
  toc += `- ${f.domain} (\`packages/database/src/${f.file}\`): ${models.map((m) => m.name).join(', ')}\n`;
  body += `\n### ${f.domain}\n\nOwner file: \`packages/database/src/${f.file}\`\n`;
  for (const m of models) {
    total++;
    const s = m.schema;
    const ts = s.options.timestamps ? 'timestamps (createdAt/updatedAt)' : 'no automatic timestamps';
    body += `\n#### ${m.name}  (collection \`${m.collection}\`)\n\n${ts}; version key \`${String(s.options.versionKey)}\`${s.options.strict === false ? '; strict: false' : ''}\n\n| Field | Type | Constraints |\n|---|---|---|\n`;
    for (const [path, p] of Object.entries(s.paths)) {
      if (path === '_id' || path === s.options.versionKey || path === 'createdAt' || path === 'updatedAt') continue;
      body += `| \`${path}\` | ${esc(typeOf(p))} | ${esc(flags(p))} |\n`;
    }
    const ix = idx(s);
    for (const [keys, opt] of s.indexes()) {
      const o = (opt ?? {}) as Record<string, unknown>;
      const k = Object.keys(keys).join(', ');
      if (o['unique']) uniq.push(`| ${m.name} | \`{ ${k} }\` | ${o['partialFilterExpression'] ? `partial ${esc(JSON.stringify(o['partialFilterExpression']))}` : ''}${o['sparse'] ? 'sparse' : ''} |`);
      if (o['expireAfterSeconds'] !== undefined) ttl.push(`| ${m.name} | \`{ ${k} }\` | ${String(o['expireAfterSeconds'])}s (${(Number(o['expireAfterSeconds']) / 86400).toFixed(0)} d) | ${o['partialFilterExpression'] ? esc(JSON.stringify(o['partialFilterExpression'])) : ''} |`);
    }
    body += ix.length ? `\nIndexes:\n${ix.map((i) => `- ${i}`).join('\n')}\n` : '\nIndexes: none declared (only `_id`).\n';
  }
}

const hwPath = 'docs/ORVIA_DATABASE_DESIGN.handwritten.md';
const hand = existsSync(hwPath) ? readFileSync(hwPath, 'utf8') : '## Review notes\n\n(not written yet)\n';
const md = `# ORVIA database design

> The model reference below (sections "Model index" and "Model reference") is **generated** from the registered Mongoose models by \`scripts/gen-db-design.ts\`. Regenerate with \`npm run docs:db\`. The review sections after it are hand-written from the code (source file: \`docs/ORVIA_DATABASE_DESIGN.handwritten.md\`) and every claim cites a file; they are not regenerated.
>
> ${total} models across ${FILES.length} model files (${GROUPS.filter((g) => g.models.length).length} domains). MongoDB via Mongoose; money is integer minor units (\`money\`/\`signedMoney\` helpers in \`packages/database/src/helpers.ts\`). Index lists include field-level \`index/unique\` options as Mongoose reports them through \`schema.indexes()\`; whether they exist in a live cluster depends on \`autoIndex\`/\`syncIndexes\` (see \`packages/database/src/connect.ts\` and \`scripts/migrate.ts\`).

## Model index

${toc}
## Unique indexes (idempotency and integrity keys)

| Model | Unique key | Condition |
|---|---|---|
${uniq.join('\n')}

## TTL indexes (automatic expiry)

| Model | Field | Expires after | Only when |
|---|---|---|---|
${ttl.join('\n')}

## Model reference
${body}
---

${hand}`;
writeFileSync('docs/ORVIA_DATABASE_DESIGN.md', md);
console.warn(`wrote docs/ORVIA_DATABASE_DESIGN.md (${total} models)`);
process.exit(0);
