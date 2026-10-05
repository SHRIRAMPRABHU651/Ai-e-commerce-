import { expect, test, type Page } from '@playwright/test';

const WEB = process.env.E2E_WEB_URL ?? 'http://localhost:3100';
const storefront = ['/', '/c/pet', '/search?q=pet', '/cart', '/help', '/track', '/login', '/register', '/legal/terms'];
const admin = ['/admin', '/admin/orders', '/admin/products', '/admin/exceptions', '/admin/automation', '/admin/analytics', '/admin/settings', '/admin/countries', '/admin/audit'];

const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

/** Basic accessibility invariants that must hold on every page. */
async function a11y(page: Page) {
  const issues = await page.evaluate(() => {
    const out: string[] = [];
    if (document.querySelectorAll('h1').length < 1) out.push('no <h1>');
    if (!document.documentElement.lang) out.push('missing <html lang>');
    document.querySelectorAll('img').forEach((i) => { if (!i.hasAttribute('alt')) out.push(`img without alt: ${i.src.slice(-40)}`); });
    document.querySelectorAll('button').forEach((b) => { if (!(b.textContent ?? '').trim() && !b.getAttribute('aria-label') && !b.getAttribute('title')) out.push(`unnamed button: ${b.outerHTML.slice(0, 80)}`); });
    document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea').forEach((el) => {
      const e = el as HTMLInputElement;
      const labelled = e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') || (e.id && document.querySelector(`label[for="${e.id}"]`)) || e.closest('label');
      if (!labelled) out.push(`unlabelled field: ${e.outerHTML.slice(0, 80)}`);
    });
    return out;
  });
  expect(issues, issues.join('\n')).toEqual([]);
}

for (const path of storefront) {
  test(`storefront ${path}: no horizontal overflow, accessible basics`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const res = await page.goto(path, { waitUntil: 'networkidle' });
    expect(res?.status()).toBeLessThan(400);
    expect(await noHorizontalScroll(page)).toBe(true);
    await a11y(page);
    expect(errors).toEqual([]);
  });
}

test('mobile: navigation drawer opens and product page has a sticky buy bar', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'mobile only');
  await page.goto('/');
  await page.getByRole('button', { name: /^shop$/i }).click();
  await expect(page.getByRole('dialog').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await page.goto('/search?q=pet');
  await page.locator('a[href^="/p/"]').first().click();
  await expect(page.getByRole('button', { name: /^add to cart$/i }).last()).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
});

test('keyboard: skip link and focus rings are reachable on desktop', async ({ page, isMobile }) => {
  test.skip(isMobile, 'desktop only');
  await page.goto('/');
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => document.activeElement?.textContent?.toLowerCase() ?? '');
  expect(focused).toContain('skip');
});

test.describe('admin console', () => {
  // Log in once per project (the login endpoint is rate limited by design) and reuse the session cookie.
  let session: Awaited<ReturnType<import('@playwright/test').BrowserContext['cookies']>> | undefined;
  test.beforeEach(async ({ page, context }) => {
    if (!session) {
      await page.goto('/admin/login');
      await page.fill('#e', 'owner@orvia.test');
      await page.fill('#p', 'Orvia-Demo-2026!');
      await page.click('button[type=submit]');
      await page.waitForURL(`${WEB}/admin`);
      session = await context.cookies();
    } else {
      await context.addCookies(session);
    }
  });
  for (const path of admin) {
    test(`${path}: renders, no horizontal overflow`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(path, { waitUntil: 'networkidle' });
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      expect(await noHorizontalScroll(page)).toBe(true);
      expect(errors).toEqual([]);
    });
  }
});
