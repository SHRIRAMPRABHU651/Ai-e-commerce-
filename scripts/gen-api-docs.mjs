// Regenerates the endpoint tables in docs/API.md from the running API's OpenAPI document (dev server on :4000).
import { writeFileSync, readFileSync } from 'node:fs';
const base = process.env.API_URL ?? 'http://localhost:4000';
const spec = await (await fetch(`${base}/docs/json`)).json();
const groups = {};
for (const [path, ms] of Object.entries(spec.paths))
  for (const [m, o] of Object.entries(ms)) (groups[o.tags?.[0] ?? 'Other'] ??= []).push([m.toUpperCase(), path, o.summary ?? '']);
let md = '';
for (const [g, rows] of Object.entries(groups).sort()) {
  md += `\n### ${g}\n\n| Method | Path | Summary |\n|---|---|---|\n`;
  for (const [m, p, s] of rows.sort((a, b) => a[1].localeCompare(b[1]))) md += `| ${m} | \`${p.startsWith('/api/v1') ? p : `/api/v1${p}`}\` | ${s.replace(/\|/g, '/')} |\n`;
}
const file = 'docs/API.md';
const cur = readFileSync(file, 'utf8');
const [head] = cur.split('<!-- endpoints:start -->');
writeFileSync(file, `${head}<!-- endpoints:start -->${md}<!-- endpoints:end -->\n`);
console.log(`wrote ${Object.values(groups).flat().length} endpoints`);
