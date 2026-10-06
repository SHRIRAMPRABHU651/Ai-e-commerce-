// Static structure check for infra/terraform. This is NOT `terraform validate`: it only catches obvious
// mistakes without the binary. Run `terraform init && terraform validate && terraform plan` for real validation.
import { readFileSync, readdirSync } from 'node:fs';
const dir = 'infra/terraform';
const files = readdirSync(dir).filter((f) => f.endsWith('.tf'));
const src = files.map((f) => readFileSync(`${dir}/${f}`, 'utf8')).join('\n');
const problems = [];
let depth = 0;
for (const ch of src.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/#.*$/gm, '')) { if (ch === '{') depth++; if (ch === '}') depth--; if (depth < 0) break; }
if (depth !== 0) problems.push(`unbalanced braces (${depth})`);
const declared = new Set([...src.matchAll(/^variable\s+"(\w+)"/gm)].map((m) => m[1]));
for (const m of src.matchAll(/\bvar\.(\w+)/g)) if (!declared.has(m[1])) problems.push(`var.${m[1]} is not declared`);
const resources = new Set([...src.matchAll(/^resource\s+"(\w+)"\s+"(\w+)"/gm)].map((m) => `${m[1]}.${m[2]}`));
const datas = new Set([...src.matchAll(/^data\s+"(\w+)"\s+"(\w+)"/gm)].map((m) => `${m[1]}.${m[2]}`));
for (const m of src.matchAll(/\b(aws_\w+)\.(\w+)\b[.\[]/g)) { if (datas.has(`${m[1]}.${m[2]}`)) continue; const id = `${m[1]}.${m[2]}`; if (!resources.has(id) && !/^aws_(caller_identity|availability_zones|region)/.test(m[1])) problems.push(`reference to undeclared resource ${id}`); }
for (const req of ['OBJECT_STORAGE_PROVIDER', 'OBJECT_STORAGE_BUCKET', 'CDN_BASE_URL']) if (!src.includes(req)) problems.push(`task environment is missing ${req}`);
console.log(`terraform static check: ${files.length} files, ${resources.size} resources, ${declared.size} variables`);
if (problems.length) { for (const p of [...new Set(problems)]) console.log(`  FAIL ${p}`); process.exit(1); }
console.log('  PASS structure looks consistent (terraform validate has NOT been run)');
