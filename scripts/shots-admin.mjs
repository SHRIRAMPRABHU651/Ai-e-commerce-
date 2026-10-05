import { chromium } from '@playwright/test';
const base = process.env.BASE ?? 'http://localhost:3000';
const out = process.env.OUT ?? '/tmp/claude-0/shots';
const pages = (process.env.PAGES ?? '/admin').split(',');
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
for (const [name, vp, mobile] of [['d', { width: 1440, height: 900 }, false], ['m', { width: 390, height: 844 }, true]]) {
  if (process.env.ONLY && process.env.ONLY !== name) continue;
  const ctx = await browser.newContext({ viewport: vp, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('PAGEERR ' + e.message));
  page.on('console', (m) => m.type() === 'error' && errs.push('CONSOLE ' + m.text().slice(0, 200)));
  await page.goto(base + '/admin/login');
  await page.fill('#e', 'owner@orvia.test');
  await page.fill('#p', 'Orvia-Demo-2026!');
  await page.click('button[type=submit]');
  await page.waitForURL('**/admin');
  for (const p of pages) {
    await page.goto(base + p, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    const slug = (p.replace(/[^a-z0-9]+/gi, '_') || 'x') + '_a' + name;
    await page.screenshot({ path: `${out}/${slug}.png`, fullPage: process.env.FULL !== '0' });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    console.log(name, p, overflow ? 'HORIZONTAL OVERFLOW' : 'ok');
  }
  if (errs.length) console.log([...new Set(errs)].join('\n'));
  await ctx.close();
}
await browser.close();
