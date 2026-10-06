// Renders apps/web/public/products into contact-sheet PNGs for visual review: node scripts/contact-sheet.mjs [prefix]
import { chromium } from '@playwright/test';
import { readdirSync, writeFileSync } from 'node:fs';
const dir = 'apps/web/public/products';
const files = readdirSync(dir).filter((f) => /\.(jpg|png)$/.test(f)).sort();
const ids = [...new Set(files.map((f) => f.replace(/-\d+\.(jpg|png)$/, '')))];
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const per = 10;
for (let i = 0; i < ids.length; i += per) {
  const chunk = ids.slice(i, i + per);
  const html = `<body style="margin:0;font:12px sans-serif;background:#fff"><div style="display:grid;grid-template-columns:repeat(2,1fr);gap:6px;padding:6px;width:1500px">${chunk.map((id) => `<div><b>${id}</b><div style="display:flex;gap:4px">${files.filter((f) => f.startsWith(id + '-')).map((f) => `<img src="file://${process.cwd()}/${dir}/${f}" style="width:240px;height:150px;object-fit:cover">`).join('')}</div></div>`).join('')}</div>`;
  const p = await b.newPage({ viewport: { width: 1500, height: 900 } });
  writeFileSync('/tmp/claude-0/sheet.html', html); await p.goto('file:///tmp/claude-0/sheet.html'); await p.waitForTimeout(800);
  await p.screenshot({ path: `/tmp/claude-0/sheet-${i / per}.png`, fullPage: true });
  await p.close();
}
await b.close();
console.log(Math.ceil(ids.length / per), 'sheets');
