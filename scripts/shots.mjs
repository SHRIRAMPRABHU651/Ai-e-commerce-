import { chromium } from '@playwright/test';
const base = process.env.BASE ?? 'http://localhost:3000';
const out = process.env.OUT ?? '/tmp/claude-0/shots';
const pages = (process.env.PAGES ?? '/').split(',');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
for (const [name, vp, mobile] of [['d', { width: 1440, height: 900 }, false], ['m', { width: 390, height: 844 }, true]]) {
  const ctx = await browser.newContext({ viewport: vp, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('PAGEERR ' + e.message));
  page.on('console', (m) => m.type() === 'error' && errs.push('CONSOLE ' + m.text().slice(0, 200)));
  for (const p of pages) {
    await page.goto(base + p, { waitUntil: 'networkidle' });
    const slug = p.replace(/[^a-z0-9]+/gi, '_') || 'home';
    await page.screenshot({ path: `${out}/${slug}_${name}.png`, fullPage: process.env.FULL === '1' });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    console.log(name, p, overflow ? 'HORIZONTAL OVERFLOW' : 'ok');
  }
  if (errs.length) console.log([...new Set(errs)].join('\n'));
  await ctx.close();
}
await browser.close();
