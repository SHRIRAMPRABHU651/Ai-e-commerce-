import { expect, test, type Page } from '@playwright/test';

const API = process.env.E2E_API_URL ?? 'http://localhost:4300';
const WEB = process.env.E2E_WEB_URL ?? 'http://localhost:3100';

async function staffApi(request: import('@playwright/test').APIRequestContext) {
  const login = await request.post(`${API}/api/v1/auth/login`, { headers: { 'x-requested-with': 'orvia', origin: WEB }, data: { email: 'ops@orvia.test', password: 'Orvia-Demo-2026!' } });
  expect(login.ok()).toBeTruthy();
}

async function fillCheckout(page: Page, email: string) {
  await page.fill('#email', email);
  await page.fill('#fullName', 'Taylor Tester');
  await page.fill('#line1', '1 Market Street');
  await page.fill('#city', 'San Francisco');
  await page.selectOption('#region', 'CA');
  await page.fill('#postalCode', '94105');
  await page.fill('#phone', '4155550100');
}

test('customer journey: discover → product → cart → checkout → pay → order → fulfilment → tracking → delivered', async ({ page, request }) => {
  test.slow();
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();

  // discover via search (typo tolerant), then open a product
  await page.goto('/search?q=snufle');
  const card = page.locator('a[href^="/p/"]').first();
  await expect(card).toBeVisible();
  await card.click();
  await expect(page).toHaveURL(/\/p\//);
  const title = await page.getByRole('heading', { level: 1 }).first().innerText();

  // add to cart (wait for hydration so the click handler is attached)
  await page.waitForLoadState('networkidle');
  await Promise.all([
    page.waitForResponse((r) => /\/cart\/items/.test(r.url()) && r.ok(), { timeout: 20_000 }),
    page.getByRole('button', { name: /^add to cart$/i }).first().click(),
  ]);
  await page.goto('/cart');
  await expect(page.getByText(title, { exact: false }).first()).toBeVisible();
  await page.getByRole('link', { name: /checkout/i }).first().click();
  await expect(page).toHaveURL(/\/checkout/);

  // checkout + payment (mock provider delivers a signed webhook, just like a real PSP)
  const email = `e2e+${Date.now()}@example.com`;
  await fillCheckout(page, email);
  await page.getByRole('button', { name: /continue to payment/i }).click();
  await expect(page.getByRole('button', { name: /pay now/i })).toBeVisible();
  await page.getByRole('button', { name: /pay now/i }).click();

  // order confirmation
  await expect(page).toHaveURL(/\/orders\/ORV-/);
  const orderNumber = /\/orders\/(ORV-[A-Z0-9-]+)/.exec(page.url())![1]!;
  await expect(page.getByText(orderNumber).first()).toBeVisible();

  // fulfilment is automatic: the worker places the supplier order, tracking appears only once the supplier issues it
  await staffApi(request);
  await expect
    .poll(async () => {
      await request.post(`${API}/api/v1/admin/shipping/sync`, { headers: { 'x-requested-with': 'orvia', origin: WEB }, data: {} });
      const r = await request.get(`${API}/api/v1/orders/lookup?orderNumber=${orderNumber}&email=${encodeURIComponent(email)}`);
      const j = (await r.json()) as { status?: string };
      return j.status;
    }, { timeout: 70_000, intervals: [2000] })
    .toBe('DELIVERED');

  await page.goto('/track');
  await page.fill('#n', orderNumber);
  await page.fill('#e', email);
  await page.getByRole('button', { name: /track/i }).click();
  await expect(page.getByText(/delivered/i).first()).toBeVisible();
});

test('mismatched email never reveals an order', async ({ page }) => {
  await page.goto('/track');
  await page.fill('#n', 'ORV-AAAAAAAA-000000');
  await page.fill('#e', 'nobody@example.com');
  await page.getByRole('button', { name: /track/i }).click();
  await expect(page.getByText(/could not find|couldn.t find/i).first()).toBeVisible();
});
