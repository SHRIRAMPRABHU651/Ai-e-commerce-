/**
 * Customer lifecycle in one serial run (desktop project only; it creates real orders, so running it twice per CI run adds nothing):
 *   register → add to cart / cart operations → checkout (validation, duplicate submit) → payment failure → payment sandbox success
 *   → order page + tracking → support assistant → return refused before delivery → delivered → return wizard → staff refund → refund visibility.
 *
 * Selectors verified against: auth-forms.tsx, pdp.tsx, (store)/cart/page.tsx, (store)/checkout/page.tsx (MockPay), order-view.tsx,
 * (store)/track/page.tsx, chrome.tsx (ChatWidget), aftersales.tsx (ReturnWizard, RefundTimeline), packages/ui core.tsx (Field/Modal/Drawer).
 * NOTE: ui `Field` does not wire label→control unless `htmlFor` is passed, so the wizard's selects are located by their adjacent label text.
 * Dev-only: needs the mock payment provider and /dev/* endpoints (APP_ENV development/test), as started by `npm run e2e`.
 * NOT executed in the authoring sandbox (no MongoDB binary); runs in CI via `npm run e2e`.
 */
import { expect, test } from '@playwright/test';
import { API, HEADERS, STRONG_PASSWORD, WEB, fillCheckout, lookupStatus, placeOrderViaApi, staffApi, waitForStatus } from './support';

test.describe.configure({ mode: 'serial' });
test.skip(({ isMobile }) => isMobile, 'long serial journey: desktop project only (mobile layout is covered by responsive.spec.ts)');

const email = `e2e.shopper+${Date.now()}@example.com`;
let orderNumber = '';
let returnId = '';

test('1. registration: weak password is blocked, a strong one creates the account and signs in; a duplicate email is refused', async ({ page, request }) => {
  await page.goto('/register');
  await page.waitForLoadState('networkidle');
  await page.getByLabel('Full name').fill('E2E Shopper');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill('short');
  await expect(page.getByRole('button', { name: 'Create account' })).toBeDisabled();
  await page.getByLabel('Password', { exact: true }).fill(STRONG_PASSWORD);
  await expect(page.getByRole('button', { name: 'Create account' })).toBeEnabled();
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.locator('#pe')).toHaveValue(email); // profile shows the new account's email

  const dup = await request.post(`${API}/api/v1/auth/register`, { headers: HEADERS, data: { email, password: STRONG_PASSWORD, name: 'Again' } });
  expect(dup.status()).toBe(409);
  expect(((await dup.json()) as { error: { code: string } }).error.code).toBe('EMAIL_TAKEN');
});

test('2. add to cart from a product page; quantity, remove and re-add work; the cart total follows', async ({ page }) => {
  await page.goto('/search?q=pet');
  await page.locator('a[href^="/p/"]').first().click();
  await expect(page).toHaveURL(/\/p\//);
  const title = await page.getByRole('heading', { level: 1 }).first().innerText();
  await page.waitForLoadState('networkidle'); // handlers attached
  const add = () => Promise.all([
    page.waitForResponse((r) => /\/cart\/items/.test(r.url()) && r.ok(), { timeout: 20_000 }),
    page.getByRole('button', { name: /^add to cart$/i }).first().click(),
  ]);
  await add();
  await page.goto('/cart');
  await expect(page.getByRole('heading', { level: 1, name: 'Your cart' })).toBeVisible();
  await expect(page.getByText(title, { exact: false }).first()).toBeVisible();

  const stepper = page.getByRole('group', { name: 'Quantity' }).first();
  const inc = stepper.getByRole('button', { name: 'Increase quantity' });
  if (await inc.isEnabled()) { // some products only have one unit available: then the control must be disabled, never silently over-sell
    await inc.click();
    await expect(stepper).toContainText('2');
    await stepper.getByRole('button', { name: 'Decrease quantity' }).click();
    await expect(stepper).toContainText('1');
  }
  await page.getByRole('button', { name: 'Remove', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Your cart is empty' })).toBeVisible();

  await page.goBack(); // product page again
  await page.waitForLoadState('networkidle');
  await add();
  await page.goto('/cart');
  await expect(page.getByText(title, { exact: false }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: /checkout/i }).first()).toBeVisible();
});

test('3. checkout: empty form is rejected field by field', async ({ page }) => {
  await page.goto('/checkout');
  await expect(page.getByRole('heading', { level: 1, name: 'Checkout' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  // (the signed-in user's email and name are prefilled, so the address fields are what fail)
  await page.getByRole('button', { name: /continue to payment/i }).click();
  await expect(page.getByText('Enter your street address')).toBeVisible();
  await expect(page.getByText('Enter your city')).toBeVisible();
  await expect(page.getByText('ZIP code must be 5 digits')).toBeVisible();
  await expect(page.getByRole('button', { name: /pay now/i })).toHaveCount(0); // no order was created
});

test('4. duplicate submit creates exactly one order; a declined card leaves it unpaid; retrying succeeds (payment sandbox)', async ({ page }) => {
  test.slow();
  await page.goto('/checkout');
  await page.waitForLoadState('networkidle');
  await fillCheckout(page, email);
  // double-click "Continue to payment": the idempotency key must collapse this into one order
  await page.getByRole('button', { name: /continue to payment/i }).dblclick();
  await expect(page.getByRole('button', { name: /pay now/i })).toBeVisible();
  const label = await page.getByText(/^Order ORV-[A-Z0-9-]+$/).first().innerText();
  orderNumber = /ORV-[A-Z0-9-]+/.exec(label)![0];

  const staff = await staffApi();
  const list = await staff.get(`${API}/api/v1/admin/orders?page=1&pageSize=20&q=${encodeURIComponent(email)}`);
  expect(list.ok()).toBeTruthy();
  const rows = ((await list.json()) as { items: { orderNumber: string }[] }).items;
  expect(rows.map((r) => r.orderNumber)).toEqual([orderNumber]); // exactly one order for this email

  // payment failure: the provider reports a decline via a signed webhook; the order must stay unpaid and the shopper can retry
  await page.getByRole('button', { name: 'Simulate a declined card' }).click();
  await expect(page.getByText(/card was declined/i)).toBeVisible();
  expect(await lookupStatus(orderNumber, email)).toBe('PENDING_PAYMENT');
  await expect(page.getByRole('button', { name: /pay now/i })).toBeEnabled();

  await page.getByRole('button', { name: /pay now/i }).click();
  await expect(page).toHaveURL(new RegExp(`/orders/${orderNumber}`));
  await expect(page.getByRole('heading', { level: 1, name: orderNumber })).toBeVisible();
  await expect(page.getByText('Thank you — your order is confirmed')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Payment:/)).toContainText('succeeded');
});

test('5. a replayed payment webhook is idempotent (no second payment, status unchanged)', async ({ request }) => {
  const o = await placeOrderViaApi({ pay: true });
  // the worker may legitimately advance the order meanwhile, so assert "still on the paid path", not equality
  const paidPath = ['PAID', 'SUPPLIER_PROCESSING', 'SHIPPED', 'IN_TRANSIT', 'DELIVERED'];
  expect(paidPath).toContain(await lookupStatus(o.orderNumber, o.email));
  const replay = await request.post(`${API}/api/v1/dev/payments/${o.intentId}/simulate`, { headers: HEADERS, data: { outcome: 'succeeded' } });
  expect(replay.ok()).toBeTruthy();
  expect(['duplicate', 'processed']).toContain(((await replay.json()) as { outcome: string }).outcome);
  expect(paidPath).toContain(await lookupStatus(o.orderNumber, o.email));
  const staff = await staffApi();
  const list = await staff.get(`${API}/api/v1/admin/orders?page=1&pageSize=20&q=${encodeURIComponent(o.email)}`);
  expect(((await list.json()) as { items: unknown[] }).items).toHaveLength(1);
});

test('6. support assistant answers a refund-status question about the signed-in customer’s own order, grounded in the order record', async ({ page }) => {
  await page.goto(`/orders/${orderNumber}`);
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Open support chat' }).click();
  const chat = page.getByRole('dialog', { name: 'Orvia support' });
  await expect(chat).toBeVisible();
  await expect(chat.getByText(/Hi! I can track an order/)).toBeVisible();
  await chat.getByRole('textbox', { name: 'Message' }).fill(`Where is my refund for ${orderNumber}?`);
  await chat.getByRole('button', { name: 'Send' }).click();
  await expect(chat.getByText(/There is no refund recorded for|A refund of/)).toBeVisible({ timeout: 20_000 });
});

test('7. order tracking by number + email shows the order and its tracking panel', async ({ page }) => {
  await page.goto('/track');
  await page.waitForLoadState('networkidle');
  await page.fill('#n', orderNumber.toLowerCase()); // the page normalises case
  await page.fill('#e', email);
  await page.getByRole('button', { name: /track order/i }).click();
  await expect(page).toHaveURL(new RegExp(`/orders/${orderNumber}`));
  await expect(page.getByRole('heading', { level: 1, name: orderNumber })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Tracking' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Progress' })).toBeVisible();
});

test('8. a return is refused with an explanation while the order has not been delivered', async ({ page }) => {
  test.skip((await lookupStatus(orderNumber, email)) === 'DELIVERED', 'mock supplier already delivered the order (accelerated time)');
  await page.goto(`/account/returns/new?order=${orderNumber}`);
  await expect(page.getByRole('heading', { name: new RegExp(`Start a return · order ${orderNumber}`) })).toBeVisible();
  await expect(page.getByText('This order cannot be returned right now')).toBeVisible();
});

test('9. fulfilment completes (mock supplier, accelerated time) and the order reaches DELIVERED', async () => {
  test.setTimeout(150_000);
  await waitForStatus(orderNumber, email, 'DELIVERED', 100_000);
});

test('10. return wizard: choose a reason and an item, submit, see the RMA and its status page', async ({ page }) => {
  await page.goto(`/orders/${orderNumber}`);
  await page.getByRole('link', { name: 'Start a return' }).click();
  await expect(page).toHaveURL(/\/account\/returns\/new\?order=/);
  await expect(page.getByRole('heading', { name: new RegExp(`Start a return · order ${orderNumber}`) })).toBeVisible();

  await page.locator('label:has-text("What went wrong?") + select').selectOption({ label: 'Changed my mind' });
  const items = page.getByRole('group', { name: 'Which items?' });
  await expect(items).toBeVisible();
  await items.getByRole('checkbox').first().check();
  await page.getByRole('button', { name: /submit return request/i }).click();

  const done = page.getByRole('status').filter({ hasText: /submitted/ });
  await expect(done).toBeVisible({ timeout: 20_000 });
  await expect(done).toContainText(/Return RMA-\S+ submitted/);
  await page.getByRole('link', { name: 'Track this return' }).click();
  await expect(page).toHaveURL(/\/account\/returns\/[a-f0-9]{24}$/);
  returnId = /returns\/([a-f0-9]{24})/.exec(page.url())![1]!;
  await expect(page.getByRole('heading', { name: 'Waiting for review' })).toBeVisible();
});

test('11. staff authorise, receive, inspect and refund the return; the customer sees the refund progress', async ({ page }) => {
  const staff = await staffApi();
  const step = async (path: string, data: object) => {
    const r = await staff.post(`${API}/api/v1/admin/aftersales/returns/${returnId}/${path}`, { headers: HEADERS, data });
    expect(r.ok(), `${path}: ${r.status()} ${await r.text()}`).toBeTruthy();
    return (await r.json()) as { state?: string; refundStatus?: string };
  };
  expect((await step('authorize', { note: 'e2e' })).state).toBe('authorized');
  expect((await step('received', { note: '' })).state).toBe('received');
  expect((await step('inspect', { outcome: 'accepted', note: 'e2e: item as described' })).state).toBe('inspected');
  const refund = await step('refund', { note: 'e2e' });
  expect(refund.refundStatus).toBe('succeeded');

  // refund status visibility: order page card + return page timeline come from the real refund record
  await page.goto(`/orders/${orderNumber}`);
  const card = page.getByRole('heading', { name: 'Returns & refunds' });
  await expect(card).toBeVisible();
  await expect(page.getByRole('list', { name: 'Refund progress' })).toBeVisible();
  await page.goto(`/account/returns/${returnId}`);
  await expect(page.getByRole('heading', { name: 'Completed' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Refund progress' })).toBeVisible();

  // a second refund attempt is refused by the API (no double refund)
  const again = await staff.post(`${API}/api/v1/admin/aftersales/returns/${returnId}/refund`, { headers: HEADERS, data: { note: 'again' } });
  expect(again.status()).toBe(409);
});

test('12. a signed-out guest: the wrong email reveals no order, and the assistant asks for an order number instead of guessing one', async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: WEB });
  const page = await ctx.newPage();
  await page.goto('/track');
  await page.waitForLoadState('networkidle');
  await page.fill('#n', orderNumber);
  await page.fill('#e', 'someone.else@example.com');
  await page.getByRole('button', { name: /track order/i }).click();
  await expect(page.getByText(/could not find|couldn.t find/i).first()).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: orderNumber })).toHaveCount(0);
  await page.goto('/help');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Chat with us' }).click();
  const chat = page.getByRole('dialog', { name: 'Orvia support' });
  await expect(chat).toBeVisible();
  await chat.getByRole('textbox', { name: 'Message' }).fill('Where is my order?');
  await chat.getByRole('button', { name: 'Send' }).click();
  await expect(chat.getByText(/Please send your order number/)).toBeVisible({ timeout: 20_000 });
  await ctx.close();
});
